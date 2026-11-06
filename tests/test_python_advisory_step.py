"""Frozen-check C12 (issue #277 AC5): the required python-conformance job
audits the installed environment with pip-audit (pinned install + gate
script, no continue-on-error, no -r resolution), Safety is gone from the
security job, and .github/pip-audit-ignore.json entries are owner-named and
unexpired (initial entry: CVE-2026-68770).
"""
from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"
IGNORE = REPO_ROOT / ".github" / "pip-audit-ignore.json"
GATE_SCRIPT = REPO_ROOT / "scripts" / "pip_audit_gate.py"


def _conformance_job() -> dict:
    data = yaml.safe_load((WORKFLOWS / "conformance.yml").read_text(encoding="utf-8"))
    return data["jobs"]["python-conformance"]


def _run_lines(job: dict) -> list[str]:
    return [str(step.get("run", "")) for step in job.get("steps", [])]


def test_pip_audit_step_after_requirements_install():
    job = _conformance_job()
    steps = job.get("steps", [])
    install_at = audit_at = None
    for i, step in enumerate(steps):
        run = str(step.get("run", ""))
        if "pip install -r requirements.txt" in run and install_at is None:
            install_at = i
        if "pip_audit_gate.py" in run and audit_at is None:
            audit_at = i
    assert install_at is not None, "requirements install step vanished"
    assert audit_at is not None, "no pip-audit step in python-conformance"
    assert (
        audit_at > install_at
    ), "the advisory scan must run on the INSTALLED environment"


def test_pip_audit_step_shape():
    job = _conformance_job()
    step = next(s for s in job["steps"] if "pip_audit_gate.py" in str(s.get("run", "")))
    run = str(step["run"])
    assert "pip-audit==" in run, "pip-audit must be pinned"
    assert not step.get("continue-on-error"), "the advisory scan must be merge-blocking"
    # audit the installed environment: never -r resolution (timed out past
    # 10 minutes on the reference host — issue #277 AC5)
    audit_lines = [
        ln for ln in run.splitlines() if "pip-audit" in ln or "pip_audit" in ln
    ]
    assert audit_lines, "no pip-audit invocation line"
    for ln in audit_lines:
        stripped = ln.strip()
        if stripped.startswith("#"):
            continue
        assert (
            " -r " not in f" {stripped} " and "--requirement" not in stripped
        ), f"pip-audit invoked with -r resolution: {stripped!r}"
    source = GATE_SCRIPT.read_text(encoding="utf-8")
    assert '"-r"' not in source and "'-r'" not in source, "the gate script passes -r"


def test_safety_removed_from_security_job():
    data = yaml.safe_load((WORKFLOWS / "security.yml").read_text(encoding="utf-8"))
    for job_id, job in (data.get("jobs") or {}).items():
        for step in job.get("steps", []) or []:
            run = str(step.get("run", ""))
            executable = "\n".join(
                ln for ln in run.splitlines() if not ln.strip().startswith("#")
            )
            assert (
                "safety check" not in executable
            ), f"{job_id}: Safety returned — its bundled database cannot see CVE-2026-68770"


def test_ignore_entries_owned_dated_and_initial_present():
    data = json.loads(IGNORE.read_text(encoding="utf-8"))
    entries = data.get("entries") if isinstance(data, dict) else data
    assert isinstance(entries, list) and entries, "ignore file must list owned entries"
    today = date.today()
    ids = set()
    for entry in entries:
        for field in ("id", "owner", "expiry"):
            value = entry.get(field)
            assert (
                isinstance(value, str) and value.strip()
            ), f"entry {entry!r} missing {field!r}"
        expiry = datetime.strptime(entry["expiry"], "%Y-%m-%d").date()
        assert (
            expiry >= today
        ), f"ignore entry {entry['id']} is EXPIRED ({entry['expiry']})"
        ids.add(entry["id"])
    assert (
        "CVE-2026-68770" in ids
    ), "the initial sentence-transformers ignore entry is missing"
