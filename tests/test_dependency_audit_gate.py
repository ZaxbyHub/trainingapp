"""Frozen-check C9 (issue #277 AC1): the dependency-audit required job, the
allowlist format, and scripts/audit_gate.py semantics (payload-classified
collection, (id, package) clearing with fail-closed via-chain recursion).

Workflow checks read PARSED YAML steps (executable `run` strings only), never
raw file text: a comment mentioning a deleted line must not keep the check
green (pr262 review lesson).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import audit_gate  # noqa: E402

WORKFLOWS = REPO_ROOT / ".github" / "workflows"
README = WORKFLOWS / "README.md"
ALLOWLIST = REPO_ROOT / ".github" / "audit-allowlist.json"
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "dependency-audit"
PACKAGES = ("web_ui", "desktop", "packtool")
TODAY = "2026-11-06"


def _load_workflow(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _run_lines(job: dict) -> list[str]:
    return [str(step.get("run", "")) for step in job.get("steps", [])]


def _fixture_report(pkg: str) -> dict:
    return json.loads(
        (FIXTURES / f"{pkg}-post-g-audit.json").read_text(encoding="utf-8")
    )


# --------------------------------------------------------------------------
# workflow shape
# --------------------------------------------------------------------------


def test_dependency_audit_job_exists_unfiltered_and_blocking():
    wf = _load_workflow("security.yml")
    # GitHub Actions' `on:` key loads as boolean True under YAML 1.1.
    on = wf.get("on", wf.get(True))
    assert (
        "pull_request" in on and "push" in on
    ), "dependency-audit workflow needs push+PR triggers"
    for event in ("push", "pull_request"):
        body = on.get(event)
        if isinstance(body, dict):
            assert (
                "paths" not in body and "paths-ignore" not in body
            ), f"{event} carries a paths filter — a required context would pend forever"
    job = wf["jobs"]["dependency-audit"]
    assert (
        "if" not in job
    ), "dependency-audit must run on every PR, not be conditionally skipped"
    gate_steps = [
        s for s in job.get("steps", []) if "audit_gate.py" in str(s.get("run", ""))
    ]
    assert len(gate_steps) == 3, "expected one gate invocation per package"
    for step in job.get("steps", []):
        assert not step.get(
            "continue-on-error"
        ), f"step {step.get('name')!r} has continue-on-error — the gate must be merge-blocking"
    for pkg in PACKAGES:
        assert any(
            f"--package-dir {pkg}" in str(s.get("run", "")) for s in job["steps"]
        ), f"dependency-audit never gates {pkg}"


def test_readme_required_contexts_list_dependency_audit():
    text = README.read_text(encoding="utf-8")
    import re

    section = re.search(r"## Required checks.*?```text\n(.*?)```", text, re.DOTALL)
    assert section, "README.md: no '## Required checks' fenced list"
    contexts = [ln.strip() for ln in section.group(1).splitlines() if ln.strip()]
    assert "dependency-audit" in contexts


# --------------------------------------------------------------------------
# gate semantics on fixtures
# --------------------------------------------------------------------------


def test_clean_post_g_fixtures_exit_zero():
    for pkg in PACKAGES:
        rc = audit_gate.main(
            [
                "--package-dir",
                pkg,
                "--allowlist",
                str(ALLOWLIST),
                "--report-file",
                str(FIXTURES / f"{pkg}-post-g-audit.json"),
                "--today",
                TODAY,
            ]
        )
        assert (
            rc == audit_gate.EXIT_CLEAN
        ), f"{pkg}: clean post-G report must exit 0, got {rc}"


def test_unlisted_high_advisory_exits_one():
    report = _fixture_report("desktop")
    report["vulnerabilities"]["axios"] = {
        "name": "axios",
        "severity": "high",
        "isDirect": True,
        "range": ">=1.0.0 <9.9.9",
        "via": [
            {
                "source": 1,
                "name": "axios",
                "severity": "high",
                "url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
            },
        ],
    }
    allowlisted = audit_gate.load_allowlist(ALLOWLIST, _today())
    offenders = audit_gate.evaluate_report(report, allowlisted)
    assert any("GHSA-AAAA-BBBB-CCCC" in line for line in offenders)
    with tmp_report(report) as path:
        rc = audit_gate.main(
            [
                "--package-dir",
                "desktop",
                "--allowlist",
                str(ALLOWLIST),
                "--report-file",
                str(path),
                "--today",
                TODAY,
            ]
        )
    assert rc == audit_gate.EXIT_ADVISORY


def test_expired_allowlist_entry_exits_one():
    rc = audit_gate.main(
        [
            "--package-dir",
            "web_ui",
            "--allowlist",
            str(ALLOWLIST),
            "--report-file",
            str(FIXTURES / "web_ui-post-g-audit.json"),
            "--today",
            "2028-01-01",
        ]
    )
    assert rc == audit_gate.EXIT_ADVISORY, "expired entries must NOT clear the findings"


def test_inherited_via_string_cleared_by_parent_entry_only():
    # transformers high, via [STR:sharp] only: cleared iff sharp's advisories
    # are (id,package)-allowlisted; removing those entries re-offends.
    report = {
        "vulnerabilities": {
            "@huggingface/transformers": {
                "name": "@huggingface/transformers",
                "severity": "high",
                "isDirect": True,
                "range": ">=3.0.0",
                "via": ["sharp"],
            },
            "sharp": {
                "name": "sharp",
                "severity": "high",
                "isDirect": False,
                "range": "0.x",
                "via": [
                    {
                        "source": 2,
                        "name": "sharp",
                        "severity": "high",
                        "url": "https://github.com/advisories/GHSA-f88m-g3jw-g9cj",
                    }
                ],
            },
        }
    }
    allowlisted = audit_gate.load_allowlist(ALLOWLIST, _today())
    assert audit_gate.evaluate_report(report, allowlisted) == []
    pruned = {k: v for k, v in allowlisted.items() if k[1] != "sharp"}
    offenders = audit_gate.evaluate_report(report, pruned)
    assert any("GHSA-F88M-G3JW-G9CJ" in line for line in offenders)


def test_missing_via_target_fails_closed():
    report = _fixture_report("desktop")
    report["vulnerabilities"]["@huggingface/transformers"]["via"] = ["ghost-package"]
    rc = audit_gate.main(
        [
            "--package-dir",
            "desktop",
            "--allowlist",
            str(ALLOWLIST),
            "--report-file",
            json_dump_tmp(report),
            "--today",
            TODAY,
        ]
    )
    assert (
        rc == audit_gate.EXIT_INFRA
    ), "missing via-chain target must fail closed, never vacuous"


def test_malformed_advisory_record_fails_closed():
    report = _fixture_report("desktop")
    via0 = report["vulnerabilities"]["sharp"]["via"][0]
    via0.pop("url", None)
    via0.pop("source", None)
    rc = audit_gate.main(
        [
            "--package-dir",
            "desktop",
            "--allowlist",
            str(ALLOWLIST),
            "--report-file",
            json_dump_tmp(report),
            "--today",
            TODAY,
        ]
    )
    assert rc == audit_gate.EXIT_INFRA


def test_malformed_allowlist_exits_two():
    bad = {
        "entries": [
            {
                "id": "GHSA-f88m-g3jw-g9cj",
                "package": "sharp",
                "owner": "someone",
                "expiry": "not-a-date",
            }
        ]
    }
    rc = audit_gate.main(
        [
            "--package-dir",
            "web_ui",
            "--allowlist",
            json_dump_tmp(bad),
            "--report-file",
            str(FIXTURES / "web_ui-post-g-audit.json"),
            "--today",
            TODAY,
        ]
    )
    assert rc == audit_gate.EXIT_CONFIG


def test_outage_payload_can_never_be_clean():
    # npm exits 1 with {error, message} and NO vulnerabilities map.
    rc = audit_gate.main(
        [
            "--package-dir",
            "web_ui",
            "--allowlist",
            str(ALLOWLIST),
            "--report-file",
            json_dump_tmp(
                {"error": "404", "message": "audit endpoint returned an error"}
            ),
            "--today",
            TODAY,
        ]
    )
    assert rc == audit_gate.EXIT_INFRA, "an outage payload must never exit 0"


def test_transient_registry_outage_retries_then_succeeds(monkeypatch):
    clean = json.dumps(_fixture_report("web_ui"))
    calls: list = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if len(calls) < 3:
            return _Completed(
                1, json.dumps({"error": "ECONNREFUSED", "message": "registry down"})
            )
        return _Completed(1, clean)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(audit_gate.time, "sleep", lambda _s: None)
    report = audit_gate.collect(REPO_ROOT / "web_ui")
    assert "vulnerabilities" in report and len(calls) == 3


def test_persistent_registry_outage_fails_closed(monkeypatch):
    calls: list = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return _Completed(
            1, json.dumps({"error": "ECONNREFUSED", "message": "registry down"})
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(audit_gate.time, "sleep", lambda _s: None)
    rc = audit_gate.main(["--package-dir", "web_ui", "--allowlist", str(ALLOWLIST)])
    assert rc == audit_gate.EXIT_INFRA and len(calls) == 3


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


class _Completed:
    def __init__(self, returncode, stdout, stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def _today():
    from datetime import date, datetime

    return (
        datetime.strptime(TODAY, "%Y-%m-%d").date() if TODAY != "live" else date.today()
    )


import contextlib  # noqa: E402


@contextlib.contextmanager
def tmp_report(report: dict):
    path = Path(json_dump_tmp(report))
    try:
        yield path
    finally:
        path.unlink(missing_ok=True)


def json_dump_tmp(obj) -> str:
    import tempfile

    fd = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    )
    json.dump(obj, fd)
    fd.close()
    return fd.name
