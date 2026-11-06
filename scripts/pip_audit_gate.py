#!/usr/bin/env python3
"""Owned, expiring package-level ignore wrapper for pip-audit (issue #277 AC5).

Runs pip-audit over the INSTALLED environment in JSON mode (never -r
resolution: that ran past ten minutes on the reference host, and auditing
what CI actually installed is the honest scan), then drops every finding
whose PACKAGE has an unexpired, owner-named entry in
.github/pip-audit-ignore.json, and exits nonzero if any finding survives.

Why package-keyed (not per-advisory-id): the first CI run of this gate
surfaced 129 open advisories across 7 packages in the legacy Python
harness's resolution (pypdf 67, pillow 50, chromadb 3, transformers 6,
python-jose 1, ecdsa 1, diskcache 1). The proportionate OWNED decision is
per-package accepted-risk windows with an expiry that forces the upgrade
decision - not a 129-line wall of per-advisory silence and not invisible
suppression. Each entry names the owner, the owner issue carrying the
upgrade decision (epic #284), and an expiry after which the required
context goes red. (The JavaScript dependency-audit gate keeps per-advisory
(id, package) precision: its residual is five advisories, where precision
is cheap. The asymmetry is deliberate and disclosed.)

Exit codes: 0 clean (or every finding's package owned+unexpired); 1 when
unowned findings remain or pip-audit fails/unparsable; 2 malformed ignore
config (missing field, bad date - an unowned silence fails CLOSED); an
expired entry is simply not honored (its package's findings resurface and
fail the context).

Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path


def load_owned_packages(path: Path, today: date) -> dict[str, str]:
    """package -> owner, for unexpired entries. Expired entries are ABSENT
    (their packages' findings resurface - the expiry forces the decision)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        print(f"pip-audit-gate: CONFIG: ignore file missing at {path}", file=sys.stderr)
        raise SystemExit(2) from exc
    except json.JSONDecodeError as exc:
        print(
            f"pip-audit-gate: CONFIG: {path} is not valid JSON: {exc}", file=sys.stderr
        )
        raise SystemExit(2) from exc
    entries = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        print(
            "pip-audit-gate: CONFIG: ignore file must be an array or {entries: []}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    owned: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            print(
                f"pip-audit-gate: CONFIG: ignore entry {entry!r} is not an object",
                file=sys.stderr,
            )
            raise SystemExit(2)
        for field in ("package", "owner", "expiry"):
            value = entry.get(field)
            if not isinstance(value, str) or not value.strip():
                print(
                    f"pip-audit-gate: CONFIG: ignore entry {entry!r} missing {field!r} "
                    "(every ignore must be owner-named and dated)",
                    file=sys.stderr,
                )
                raise SystemExit(2)
        try:
            expiry = datetime.strptime(entry["expiry"], "%Y-%m-%d").date()
        except ValueError as exc:
            print(
                f"pip-audit-gate: CONFIG: ignore entry for {entry['package']!r} has expiry "
                f"{entry['expiry']!r}, want YYYY-MM-DD",
                file=sys.stderr,
            )
            raise SystemExit(2) from exc
        if expiry < today:
            print(
                f"pip-audit-gate: ignore entry for {entry['package']} EXPIRED "
                f"({entry['expiry']}) - its findings are no longer ignored",
                file=sys.stderr,
            )
            continue
        owned[entry["package"].lower()] = entry["owner"]
    return owned


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--ignore-file", type=Path, default=Path(".github/pip-audit-ignore.json")
    )
    parser.add_argument(
        "--today",
        default=None,
        help="override today (YYYY-MM-DD) for expiry checks (tests)",
    )
    parser.add_argument(
        "--audit-json",
        type=Path,
        default=None,
        help="evaluate this saved `pip-audit --format json` output instead "
        "of running pip-audit (tests)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the owned-package list without running pip-audit",
    )
    args = parser.parse_args(argv)
    today = (
        date.today()
        if args.today is None
        else datetime.strptime(args.today, "%Y-%m-%d").date()
    )
    owned = load_owned_packages(args.ignore_file, today)
    if args.dry_run:
        print(json.dumps({"owned_packages": sorted(owned)}))
        return 0

    if args.audit_json is not None:
        try:
            report = json.loads(args.audit_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"pip-audit-gate: saved report unreadable: {exc}", file=sys.stderr)
            return 1
    else:
        proc = subprocess.run(
            ["pip-audit", "--format", "json", "--progress-spinner", "off"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        try:
            report = json.loads(proc.stdout or "")
        except json.JSONDecodeError:
            print(
                f"pip-audit-gate: pip-audit produced no JSON (exit {proc.returncode}); "
                f"stderr: {(proc.stderr or '')[:300]}",
                file=sys.stderr,
            )
            return 1

    # pip-audit JSON shape: {"dependencies": [{"name", "version", "vulns": [...]}]}
    deps = report.get("dependencies") if isinstance(report, dict) else None
    if not isinstance(deps, list):
        print("pip-audit-gate: report has no dependencies list", file=sys.stderr)
        return 1
    survivors: list[str] = []
    for dep in deps:
        if not isinstance(dep, dict):
            continue
        name = str(dep.get("name", ""))
        vulns = dep.get("vulns") or []
        if not vulns:
            continue
        owner = owned.get(name.lower())
        if owner is not None:
            print(
                f"pip-audit-gate: {name}: {len(vulns)} finding(s) covered by the owned "
                f"accepted-risk entry (owner {owner})"
            )
            continue
        ids = ", ".join(str(v.get("id")) for v in vulns if isinstance(v, dict))
        survivors.append(f"{name}: {len(vulns)} finding(s) [{ids}]")
    if survivors:
        print(
            f"pip-audit-gate: {len(survivors)} package(s) with UNOWNED advisories:",
            file=sys.stderr,
        )
        for line in survivors:
            print(f"  - {line}", file=sys.stderr)
        return 1
    print("pip-audit-gate: clean (0 unowned advisory findings)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
