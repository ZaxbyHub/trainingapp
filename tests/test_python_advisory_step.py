"""Frozen-check C12 (issue #277 AC5): the required python-conformance job
audits the installed environment with pip-audit (pinned install + gate
script, no continue-on-error, no -r resolution), Safety is gone from the
security job, and .github/pip-audit-ignore.json entries are owner-named and
unexpired; entries are PACKAGE-keyed accepted-risk windows (owner + expiry), not per-advisory ids.
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


def test_ignore_entries_owned_dated_and_packages_present():
    """Package-keyed accepted-risk entries: the gate's first CI run surfaced
    129 advisories across 7 packages in the legacy harness resolution -
    per-package owned windows with an expiry that forces the upgrade
    decision (scripts/pip_audit_gate.py discloses the asymmetry vs the JS
    gate's per-advisory ids)."""
    data = json.loads(IGNORE.read_text(encoding="utf-8"))
    entries = data.get("entries") if isinstance(data, dict) else data
    assert isinstance(entries, list) and entries, "ignore file must list owned entries"
    today = date.today()
    packages = set()
    for entry in entries:
        for field in ("package", "owner", "expiry"):
            value = entry.get(field)
            assert (
                isinstance(value, str) and value.strip()
            ), f"entry {entry!r} missing {field!r}"
        expiry = datetime.strptime(entry["expiry"], "%Y-%m-%d").date()
        assert (
            expiry >= today
        ), f"ignore entry for {entry['package']} is EXPIRED ({entry['expiry']})"
        packages.add(entry["package"].lower())
    expected = {
        "sentence-transformers",
        "pypdf",
        "pillow",
        "chromadb",
        "transformers",
        "python-jose",
        "ecdsa",
        "diskcache",
    }
    assert (
        expected <= packages
    ), f"ignore file lost accepted-risk packages: {expected - packages}"


# --------------------------------------------------------------------------
# gate JSON-filter legs (saved pip-audit --format json fixtures; no pip-audit
# run needed - the filter semantics are the contract)
# --------------------------------------------------------------------------

GATE = REPO_ROOT / "scripts" / "pip_audit_gate.py"


def _fixture_report():
    return {
        "dependencies": [
            {"name": "pypdf", "version": "4.3.1", "vulns": [{"id": "PYSEC-2026-3911"}]},
            {
                "name": "some-unknown-package",
                "version": "1.0",
                "vulns": [{"id": "PYSEC-X"}],
            },
            {"name": "clean-pkg", "version": "2.0", "vulns": []},
        ]
    }


def _run_gate(argv):
    import subprocess
    import sys as _sys

    return subprocess.run(
        [_sys.executable, str(GATE), *argv],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(REPO_ROOT),
    )


def test_gate_ignores_owned_packages_and_flags_unowned(tmp_path):
    fixture = tmp_path / "audit.json"
    fixture.write_text(json.dumps(_fixture_report()), encoding="utf-8")
    rc = _run_gate(
        ["--ignore-file", str(IGNORE), "--audit-json", str(fixture)]
    ).returncode
    assert rc == 1, "an unowned package with findings must fail the gate"
    owned_only = {
        "dependencies": [
            d
            for d in _fixture_report()["dependencies"]
            if d["name"] != "some-unknown-package"
        ]
    }
    fixture.write_text(json.dumps(owned_only), encoding="utf-8")
    rc = _run_gate(
        ["--ignore-file", str(IGNORE), "--audit-json", str(fixture)]
    ).returncode
    assert rc == 0, "owned packages' findings are accepted-risk until expiry"


def test_gate_expired_entry_resurfaces_findings(tmp_path):
    expired = tmp_path / "expired.json"
    data = json.loads(IGNORE.read_text(encoding="utf-8"))
    for entry in data["entries"]:
        entry["expiry"] = "2020-01-01"
    expired.write_text(json.dumps(data), encoding="utf-8")
    owned_only = {
        "dependencies": [
            {"name": "pypdf", "version": "4.3.1", "vulns": [{"id": "PYSEC-2026-3911"}]},
        ]
    }
    fixture = tmp_path / "audit.json"
    fixture.write_text(json.dumps(owned_only), encoding="utf-8")
    rc = _run_gate(
        ["--ignore-file", str(expired), "--audit-json", str(fixture)]
    ).returncode
    assert rc == 1, "an expired entry must resurface its package's findings"


def test_gate_malformed_ignore_fails_closed(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(
        json.dumps({"entries": [{"package": "pypdf", "owner": "x"}]}), encoding="utf-8"
    )
    fixture = tmp_path / "audit.json"
    fixture.write_text(json.dumps({"dependencies": []}), encoding="utf-8")
    proc = _run_gate(["--ignore-file", str(bad), "--audit-json", str(fixture)])
    assert proc.returncode == 2, "an entry without expiry fails CLOSED"
