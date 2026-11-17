"""Issue #368 WI8 guard: the quality harness exists, its roster is ordered
fast-gates-first, its failure semantics work, and its report shape is honest.

Runs only the FAST paths (--list, --fail-at, a single lightweight gate) so the
guard stays seconds-scale in CI; the full-gate run is the developer's own
invocation and CI's job."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HARNESS = REPO / "scripts" / "quality-harness.mjs"

EXPECTED_ROSTER = [
    "packtool-build",
    "typecheck-web",
    "typecheck-web-test",
    "contract-battery",
    "interop-battery",
    "desktop-suite",
    "web-suite",
]


def _run(args: list[str]) -> subprocess.CompletedProcess:
    node = shutil.which("node")
    assert node, "node is required on PATH for the quality harness"
    return subprocess.run(
        [node, str(HARNESS), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=180,
    )


def test_harness_exists_and_roster_is_ordered() -> None:
    assert HARNESS.exists(), "scripts/quality-harness.mjs is missing"
    r = _run(["--list"])
    assert r.returncode == 0, r.stderr
    names = [
        line.split("\t")[0] for line in r.stdout.strip().splitlines() if line.strip()
    ]
    assert names == EXPECTED_ROSTER, f"roster drifted: {names}"


def test_fail_at_stops_at_the_named_gate_and_reports_nonzero() -> None:
    """Dependency-free legs: --only contract-battery keeps the guard off the
    install-dependent gates (CI's test job has no packtool/web_ui installs -
    the first CI run caught stoppedAt=packtool-build honestly failing there)."""
    # fail leg: simulate the failure at the only rostered gate
    r = _run(
        [
            "--only",
            "contract-battery",
            "--fail-at",
            "contract-battery",
            "--report",
            ".quality-guard-smoke.json",
        ]
    )
    assert (
        r.returncode == 1
    ), f"expected exit 1 on simulated failure, got {r.returncode}"
    report_path = REPO / ".quality-guard-smoke.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report_path.unlink()  # the guard leaves no litter behind
    assert report["stoppedAt"] == "contract-battery"
    assert report["allGreen"] is False
    assert len(report["gates"]) == 1
    assert report["gates"][0]["name"] == "contract-battery"
    assert report["gates"][0]["status"] == "failed"
    for extra in ("durationMs", "status", "name", "cmd"):
        assert extra in report["gates"][0], f"report gate missing {extra}"


def test_pass_shape_on_a_dependency_free_gate() -> None:
    """The pass-entry shape from a real run of the pytest-only gate."""
    r = _run(["--only", "contract-battery", "--report", ".quality-guard-pass.json"])
    assert r.returncode == 0, r.stdout[-2000:]
    report_path = REPO / ".quality-guard-pass.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report_path.unlink()
    assert report["allGreen"] is True and report["stoppedAt"] is None
    gates = {g["name"]: g["status"] for g in report["gates"]}
    assert gates == {"contract-battery": "pass"}


def test_fail_at_rejects_unknown_gate() -> None:
    r = _run(["--fail-at", "not-a-gate"])
    assert r.returncode == 2, f"usage error should exit 2, got {r.returncode}"
    assert "no rostered gate" in (r.stderr + r.stdout)


def test_only_rejects_unknown_gate() -> None:
    r = _run(["--only", "made-up-gate"])
    assert r.returncode == 2
    assert "unknown gate" in (r.stderr + r.stdout)
