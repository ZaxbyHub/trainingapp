#!/usr/bin/env python3
"""Owned, expiring ignore wrapper for pip-audit (issue #277 AC5).

Runs pip-audit over the INSTALLED environment (no -r: resolving the unpinned
requirement ranges ran past ten minutes on the reference host, and the audit
must see what CI actually installed) and passes one --ignore-vuln flag per
unexpired, owner-named entry in .github/pip-audit-ignore.json.

Exit codes: 0 pip-audit clean (or every finding ignored); pip-audit's own
exit code on a real advisory hit; 2 malformed ignore config (missing
owner/expiry — an unowned silence is what this gate removes, so a bad entry
fails CLOSED); an expired entry is simply not ignored (the required context
goes red and the expiry forces the decision).

Stdlib only. pip-audit is installed by the workflow step (pinned) before this
runs.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path


def load_ignore_ids(path: Path, today: date) -> list[str]:
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
    ids: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            print(
                f"pip-audit-gate: CONFIG: ignore entry {entry!r} is not an object",
                file=sys.stderr,
            )
            raise SystemExit(2)
        for field in ("id", "owner", "expiry"):
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
                f"pip-audit-gate: CONFIG: ignore entry {entry['id']!r} has expiry "
                f"{entry['expiry']!r}, want YYYY-MM-DD",
                file=sys.stderr,
            )
            raise SystemExit(2) from exc
        if expiry < today:
            print(
                f"pip-audit-gate: ignore entry {entry['id']} EXPIRED "
                f"({entry['expiry']}) — no longer ignored",
                file=sys.stderr,
            )
            continue
        ids.append(entry["id"])
    return ids


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
        "--dry-run",
        action="store_true",
        help="print the resolved ignore list without running pip-audit",
    )
    args = parser.parse_args(argv)
    today = (
        date.today()
        if args.today is None
        else datetime.strptime(args.today, "%Y-%m-%d").date()
    )
    ids = load_ignore_ids(args.ignore_file, today)
    cmd = ["pip-audit"]
    for vuln_id in sorted(set(ids)):
        cmd += ["--ignore-vuln", vuln_id]
    if args.dry_run:
        print(json.dumps({"command": cmd, "ignored": sorted(set(ids))}))
        return 0
    # -r is deliberately absent: the environment is already installed in this
    # job (the requirements step ran first); auditing it is faster and sees
    # what shipped. A newly published Python advisory surfaces on
    # Python-bucket PRs and on every push to master.
    proc = subprocess.run(cmd, check=False)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
