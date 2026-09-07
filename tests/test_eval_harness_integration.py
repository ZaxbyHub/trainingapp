"""End-to-end integration test for the tier-0 eval harness (issue #54).

Boots eval/ci_serve.py in Mode B (deterministic no-weights backend, one
eval run over real HTTP, then exit) and asserts the produced report.
Gated on RUN_EVAL_INTEGRATION=1 — an inline, environment-guarded skip (no
blanket skip): the default pytest suite stays fast, and the eval-report CI
job sets the variable so this runs there.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = REPO_ROOT / "eval"

if os.environ.get("RUN_EVAL_INTEGRATION") != "1":
    pytest = None  # sentinel: guarded below without importing pytest cost
    import pytest  # noqa: E402  (still needed for the skip marker)

    pytest.skip(
        "RUN_EVAL_INTEGRATION != 1 - end-to-end eval run is env-gated; "
        "set RUN_EVAL_INTEGRATION=1 (the eval-report CI job does)",
        allow_module_level=True,
    )

import pytest  # noqa: E402,F811


def test_runner_end_to_end_against_deterministic_backend(tmp_path):
    report_md = tmp_path / "REPORT.md"
    report_json = tmp_path / "report.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(EVAL_DIR / "ci_serve.py"),
            "--port",
            "8731",
            "--eval-report",
            str(report_md),
            "--eval-json",
            str(report_json),
        ],
        cwd=str(REPO_ROOT),
        timeout=420,
    )
    assert completed.returncode == 0, "ci_serve Mode B run failed"

    report = json.loads(report_json.read_text(encoding="utf-8"))
    assert report["question_count"] >= 50
    assert report["error_count"] == 0
    metrics = report["metrics"]
    assert set(metrics["recall_at_k"]) == {"1", "3", "5"}
    assert isinstance(metrics["mrr"], (int, float))
    assert metrics["abstain_total"] >= 5
    assert 0.0 <= metrics["abstain_accuracy"] <= 1.0
    assert metrics["latency_ms"]["p50"] > 0
    assert metrics["latency_ms"]["p95"] >= metrics["latency_ms"]["p50"]
    assert report["label"] == "deterministic-stub"

    md = report_md.read_text(encoding="utf-8")
    lowered = md.lower()
    for token in ("recall", "mrr", "abstain", "latency", "http://127.0.0.1:8731"):
        assert token in lowered
