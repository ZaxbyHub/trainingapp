"""Learn hit@3 eval-metric integration test (issue #82, D6).

Boots eval/ci_serve.py in Mode B (the same deterministic no-weights backend
used by the #54 harness) over the real ingestion path — including the
Storyline slide fixtures under eval/corpus/slides/ — and asserts the runner
reports the Learn hit@3 metric over the slide-target question set. Unlike
test_eval_harness_integration.py this test is intentionally NOT env-gated:
it is the frozen acceptance check C9 for issue #82 and a full Mode B run
costs only a few seconds with the stub encoder.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = REPO_ROOT / "eval"

# The ci_serve subprocess inherits this process's environment; some sibling
# tests mutate os.environ in-place (e.g. ENABLE_AUTH=true for their own auth
# scenarios) and that would boot the eval server with auth enabled, 401-ing
# every runner request. Strip auth-related overrides for this run — the
# deterministic eval backend runs unauthenticated by design.
_AUTH_ENV_KEYS = ("ENABLE_AUTH", "API_KEY", "AUTH_SECRET_KEY")


def test_learn_hit_at_3_reported_by_eval_runner(tmp_path):
    report_md = tmp_path / "REPORT.md"
    report_json = tmp_path / "report.json"
    env = {k: v for k, v in os.environ.items() if k not in _AUTH_ENV_KEYS}
    completed = subprocess.run(
        [
            sys.executable,
            str(EVAL_DIR / "ci_serve.py"),
            "--port",
            "8747",
            "--eval-report",
            str(report_md),
            "--eval-json",
            str(report_json),
        ],
        cwd=str(REPO_ROOT),
        env=env,
        timeout=420,
    )
    assert completed.returncode == 0, "ci_serve Mode B run failed"

    report = json.loads(report_json.read_text(encoding="utf-8"))
    assert report["error_count"] == 0
    metrics = report["metrics"]

    # The learn metric exists and is measured over a real question subset.
    assert isinstance(metrics["learn_hit_at_3"], (int, float))
    assert 0.0 <= metrics["learn_hit_at_3"] <= 1.0
    assert metrics["learn_slide_question_count"] >= 3

    # Every learn row that scored reports a rank shape consistent with hit@3.
    learn_rows = [
        r for r in report["results"] if r.get("expected_training_slide_id") is not None
    ]
    assert len(learn_rows) == metrics["learn_slide_question_count"]
    for row in learn_rows:
        assert row["learn_rank"] is not None
        assert isinstance(row["learn"], list)

    # The report surfaces the number (the "eval/RESULTS.md or equivalent"
    # requirement — #54's REPORT.md is the equivalent) for humans too.
    md = report_md.read_text(encoding="utf-8")
    assert "Learn hit@3" in md
    assert "0.70" in md
