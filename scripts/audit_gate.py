#!/usr/bin/env python3
"""Advisory gate for the shipped JavaScript dependency graphs (issue #277 AC1).

Collects `npm audit --json` for one package directory (the collector lives
HERE, not in the workflow YAML: GitHub Actions' default `bash -e` step would
abort on npm's vulnerability exit 1 before any gate ran, and npm exit 1 does
NOT distinguish findings from a registry outage — an unreachable registry
exits 1 with a valid JSON payload of only {error, message}).

Classification is therefore PAYLOAD-based, never exit-based:

  exit 0  clean — no HIGH/CRITICAL advisory, or every one is allowlisted
  exit 1  an unallowlisted (or expired-allowlist) HIGH/CRITICAL advisory
  exit 2  malformed allowlist configuration (missing field, bad date)
  exit 3  infrastructure failure after two retries (registry outage,
          unparsable output, missing/malformed report data) — FAILED CLOSED;
          an outage can NEVER classify to exit 0.

A HIGH/CRITICAL finding on an entry is cleared only when EVERY gate-relevant
advisory id reachable from it — the entry's own via advisory objects plus,
recursively, every advisory of any package named by its via STRINGS (the
shape npm emits for inherited findings, e.g. @huggingface/transformers
via:["sharp"]) — has an unexpired allowlist entry matching BOTH the advisory
id and the package. Entries never reach the evaluator with malformed data:
a via-string naming a package absent from the vulnerabilities map, or an
advisory object without an extractable id, is an infrastructure error (fail
closed), never vacuously satisfied.

Stdlib only (json, argparse, datetime, re, subprocess) so it runs in the
security job with a bare setup-python.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

EXIT_CLEAN = 0
EXIT_ADVISORY = 1
EXIT_CONFIG = 2
EXIT_INFRA = 3

GATE_RELEVANT = ("high", "critical")
_NPM_AUDIT_RETRIES = 2
_RETRY_BACKOFF_S = 5
_GHSA_RE = re.compile(r"GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}", re.IGNORECASE)


class InfraError(Exception):
    """The report cannot be trusted: outage, unparsable output, or malformed data."""


class ConfigError(Exception):
    """The allowlist itself is malformed."""


def _extract_advisory_id(advisory: dict[str, Any], package: str) -> str:
    """A GHSA id from the advisory url/source fields, fail-closed when absent."""
    for field in ("url", "github_advisory_id"):
        value = advisory.get(field)
        if isinstance(value, str):
            match = _GHSA_RE.search(value)
            if match:
                return match.group(0).upper()
    source = advisory.get("source")
    if isinstance(source, str):
        match = _GHSA_RE.search(source)
        if match:
            return match.group(0).upper()
    raise InfraError(f"advisory on package {package!r} carries no extractable GHSA id")


def _entry_of(vulnerabilities: dict[str, Any], name: str) -> dict[str, Any]:
    """Resolve a via-string target — a missing target FAILS CLOSED (critic r2)."""
    entry = vulnerabilities.get(name)
    if not isinstance(entry, dict) or not isinstance(entry.get("via"), list):
        raise InfraError(
            f"via-chain references package {name!r} absent from the audit report"
        )
    return entry


def _reachable_advisory_ids(
    vulnerabilities: dict[str, Any],
    entry_name: str,
    entry: dict[str, Any],
    visiting: frozenset[str],
) -> set[tuple[str, str]]:
    """Every (GHSA id, package) pair reachable from this entry — own advisory
    objects of any severity plus the recursive closure of via-string targets.
    The CALLER filters to gate-relevant severities; collecting all and
    filtering means a moderate parent never vacuously clears a critical
    descendant."""
    if entry_name in visiting:
        return set()  # cycle-guarded
    pairs: set[tuple[str, str]] = set()
    for via in entry.get("via", []):
        if isinstance(via, dict):
            severity = via.get("severity")
            if isinstance(severity, str) and severity.lower() in GATE_RELEVANT:
                pkg = via.get("name") or entry_name
                pairs.add((_extract_advisory_id(via, pkg), pkg))
        elif isinstance(via, str):
            child = _entry_of(vulnerabilities, via)
            child_severity = child.get("severity")
            if (
                isinstance(child_severity, str)
                and child_severity.lower() in GATE_RELEVANT
            ):
                # the named package is itself a HIGH/CRITICAL entry: its own
                # advisory objects are gate-relevant findings on THAT package
                for via2 in child.get("via", []):
                    if isinstance(via2, dict):
                        sev2 = via2.get("severity")
                        if isinstance(sev2, str) and sev2.lower() in GATE_RELEVANT:
                            pkg2 = via2.get("name") or via
                            pairs.add((_extract_advisory_id(via2, pkg2), via))
            pairs |= _reachable_advisory_ids(
                vulnerabilities, via, child, visiting | {entry_name}
            )
    return pairs


def _parse_expiry(entry: dict[str, Any], package: str) -> date:
    raw = entry.get("expiry")
    if not isinstance(raw, str):
        raise ConfigError(f"allowlist entry for {package!r} has no expiry date")
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ConfigError(
            f"allowlist entry for {package!r} has expiry {raw!r}, want YYYY-MM-DD"
        ) from exc


def load_allowlist(path: Path, today: date) -> dict[tuple[str, str], str]:
    """(id, package) -> owner, for unexpired entries only. Expired entries
    are simply ABSENT (the gate treats them as not allowlisted — expiry
    forces the decisions, issue #277 AC1)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"allowlist not found at {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"allowlist at {path} is not valid JSON: {exc}") from exc
    entries = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise ConfigError(
            "allowlist must be a JSON array, or an object with an 'entries' array"
        )
    allowlisted: dict[tuple[str, str], str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ConfigError("allowlist entries must be objects")
        for field in ("id", "package", "owner", "expiry"):
            if not isinstance(entry.get(field), str) or not entry[field].strip():
                raise ConfigError(f"allowlist entry {entry!r} is missing {field!r}")
        ghsa = _GHSA_RE.search(entry["id"])
        if not ghsa:
            raise ConfigError(f"allowlist entry {entry['id']!r} is not a GHSA id")
        expiry = _parse_expiry(entry, entry["package"])
        if expiry < today:
            continue
        allowlisted[(ghsa.group(0).upper(), entry["package"].lower())] = entry["owner"]
    return allowlisted


def evaluate_report(report: Any, allowlisted: dict[tuple[str, str], str]) -> list[str]:
    """Return offender descriptions; empty means CLEAN. Raises InfraError on
    a report that cannot be trusted."""
    if not isinstance(report, dict):
        raise InfraError("npm audit output is not a JSON object")
    if "vulnerabilities" not in report:
        # npm's registry-outage shape: {error, message} and nothing else.
        raise InfraError(
            f"npm audit produced no vulnerabilities report "
            f"(error={report.get('error')!r})"
        )
    vulnerabilities = report["vulnerabilities"]
    if isinstance(vulnerabilities, list):
        folded: dict[str, Any] = {}
        for entry in vulnerabilities:
            if isinstance(entry, dict) and isinstance(entry.get("name"), str):
                folded[entry["name"]] = entry
        vulnerabilities = folded
    if not isinstance(vulnerabilities, dict):
        raise InfraError("npm audit 'vulnerabilities' is neither a map nor a list")
    offenders: list[str] = []
    for name, entry in vulnerabilities.items():
        if not isinstance(entry, dict):
            continue
        severity = entry.get("severity")
        if not (isinstance(severity, str) and severity.lower() in GATE_RELEVANT):
            continue
        required = _reachable_advisory_ids(vulnerabilities, name, entry, frozenset())
        for ghsa, pkg in sorted(required):
            if (ghsa, pkg.lower()) not in allowlisted:
                offenders.append(
                    f"{name}: {ghsa} on {pkg} ({severity}) not allowlisted"
                )
    return offenders


def run_npm_audit(package_dir: Path) -> dict[str, Any]:
    """Run npm audit --json in package_dir, classified by PAYLOAD (critic r3):
    exit 0/1 with a parseable vulnerabilities report → evaluate; any other
    exit, or an {error,message}/unparsable payload → infrastructure failure
    (the caller retries)."""
    proc = subprocess.run(
        ["npm", "audit", "--json"],
        cwd=str(package_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=(sys.platform == "win32"),  # npm on Windows is a .cmd shim
    )
    stdout = (proc.stdout or "").strip()
    if stdout == "":
        raise InfraError(f"npm audit produced no output (exit {proc.returncode})")
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise InfraError(
            f"npm audit output is not valid JSON (exit {proc.returncode}): {exc}"
        ) from exc
    if proc.returncode not in (0, 1):
        raise InfraError(
            f"npm audit exited {proc.returncode}: {(proc.stderr or '').strip()[:300]}"
        )
    if not isinstance(report, dict) or "vulnerabilities" not in report:
        keys = sorted(report) if isinstance(report, dict) else type(report).__name__
        raise InfraError(
            f"npm audit (exit {proc.returncode}) returned no vulnerabilities "
            f"report: keys={keys}"
        )
    return report


def collect(package_dir: Path, retries: int = _NPM_AUDIT_RETRIES) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return run_npm_audit(package_dir)
        except (OSError, InfraError) as exc:  # registry outage, unparsable payload
            last = exc
            if attempt < retries:
                time.sleep(_RETRY_BACKOFF_S)
    raise InfraError(
        f"npm audit infrastructure failure after {retries + 1} attempts: {last}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--package-dir", required=True, type=Path, help="package directory to audit"
    )
    parser.add_argument(
        "--allowlist", required=True, type=Path, help=".github/audit-allowlist.json"
    )
    parser.add_argument(
        "--today",
        default=None,
        help="override today (YYYY-MM-DD) for expiry checks (tests)",
    )
    parser.add_argument(
        "--report-file",
        default=None,
        type=Path,
        help="evaluate this saved audit JSON instead of collecting",
    )
    args = parser.parse_args(argv)
    today = (
        date.today()
        if args.today is None
        else datetime.strptime(args.today, "%Y-%m-%d").date()
    )
    try:
        allowlisted = load_allowlist(args.allowlist, today)
    except ConfigError as exc:
        print(f"audit-gate: CONFIG: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    try:
        report = (
            json.loads(args.report_file.read_text(encoding="utf-8"))
            if args.report_file
            else collect(args.package_dir)
        )
    except (OSError, json.JSONDecodeError, InfraError) as exc:
        print(f"audit-gate: INFRA: {exc}", file=sys.stderr)
        return EXIT_INFRA
    try:
        offenders = evaluate_report(report, allowlisted)
    except (InfraError, ConfigError) as exc:
        kind = "CONFIG" if isinstance(exc, ConfigError) else "INFRA"
        print(f"audit-gate: {kind}: {exc}", file=sys.stderr)
        return EXIT_CONFIG if kind == "CONFIG" else EXIT_INFRA
    name = args.package_dir.name
    if offenders:
        print(
            f"audit-gate: {name}: {len(offenders)} unallowlisted "
            f"HIGH/CRITICAL advisories:",
            file=sys.stderr,
        )
        for line in offenders:
            print(f"  - {line}", file=sys.stderr)
        return EXIT_ADVISORY
    print(f"audit-gate: {name}: clean (0 unallowlisted HIGH/CRITICAL)")
    return EXIT_CLEAN


if __name__ == "__main__":
    sys.exit(main())
