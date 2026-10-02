"""Guardrail tests for CI path scoping (issue #87, Phase 4.2).

Pins three things the frozen acceptance checks cannot see on their own
(plan-critic round-1 F7 / round-2 M1-M2):

1. Classifier decisions, including the three-way python semantics
   (positive / safe-false / unknown->true) and the mixed-set rule.
2. Workflow wiring: every non-``changes`` job in test.yml, web-ui.yml and
   conformance.yml carries the fail-safe condition
   ``if: always() && needs.changes.outputs.<exact bucket> != 'false'``
   with the bucket this map expects.
3. Required-context provenance: every context listed in the README's
   required-checks table equals a job name in one of the unfiltered
   workflows, and no job name carries the truncated ``(issue`` tail an
   unquoted ``#`` produces.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CI_PATHS = REPO_ROOT / "scripts" / "ci_paths.py"
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
import ci_paths  # noqa: E402


def _decide(bucket: str, files: list[str]) -> bool:
    return ci_paths.decide(bucket, files)


# ---------------------------------------------------------------------------
# 1. Classifier decision pins
# ---------------------------------------------------------------------------

PYTHON_TRUE = [
    # plan-critic round-1 F2: verified matrix inputs the original map missed
    "docs/training-player.md",
    "INSTALL.md",
    "desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md",
    "contracts/pack.schema.json",
    # implementation-review round-1 F2: desktop files the ADR-0002 guardrail
    # tests _load() directly
    "desktop/main/index.ts",
    "desktop/electron-builder.yml",
    # implementation-review round-1 F3: the required-checks table the
    # provenance pin reads
    ".github/workflows/README.md",
    # core surface
    "api_server.py",
    "rag_engine.py",
    "tests/test_a.py",
    "tests/integration/test_api_integration.py",
    "bench/RESULTS.md",
    "bench/floors.py",
    "eval/runner.py",
    "eval/bakeoff/results/bakeoff-results.json",
    "pytest.ini",
    "requirements.txt",
    "contracts/fixtures/packs/bundled-min/pack.json",
    "contracts/api.openapi.yaml",
    "docs/adr/0002-llm-profiles.md",
    "docs/licenses.md",
    "packtool/storyline/transcribe.py",
    # gating infrastructure: workflow-only diffs pay the matrix so this
    # guardrail always runs on the files it inspects (round-2 M2)
    ".github/workflows/test.yml",
    ".github/workflows/web-ui.yml",
    ".github/workflows/conformance.yml",
    "scripts/ci_paths.py",
    "tests/test_ci_paths.py",
    # unknown files fail open, alone or mixed with safe-false files (M1)
    "newpkg/mod.py",
    "brand-new-tree/anything.txt",
    # PRR-001: storyline fixture inputs the required pack-fixture-build job
    # assembles its publish dir from (also python-positive via tests/**)
    "tests/fixtures/storyline-mini/meta.xml",
    "tests/fixtures/storyline-mini-story-html-stub.html",
]

PYTHON_FALSE = [
    "web_ui/src/lib/x.ts",
    "web_ui/package.json",
    # PRR-013: case-insensitive matching — a case-variant of a safe-false
    # tree must stay python-false
    "Web_UI/src/lib/x.ts",
    "DOCS/foo.md",
    # desktop files verified UNREAD by any pytest (impl-review round-1 audit:
    # only main/index.ts + electron-builder.yml are _load()ed, both positive)
    "desktop/preload/index.ts",
    "desktop/scripts/run-conformance-host.mjs",
    "packtool/src/y.ts",
    "packtool/docs/build-docs.md",
    "docs/foo.md",
    "CHANGELOG.md",
    "README.md",
    "audit/report.txt",
    "models/bge-small-en-v1.5/model.safetensors",
    "specs/draft.md",
    "contracts/tests/run_conformance.py",
    "app_gui.spec",
    "build.bat",
    ".github/workflows/desktop-build.yml",
    ".github/workflows/security.yml",
    ".github/ISSUE_TEMPLATE/bug.md",
]

PYTHON_SETS_TRUE = [
    # (label, files)
    ("mixed safe-false + unknown", ["docs/foo.md", "newpkg/mod.py"]),
    (
        "mixed desktop-read + python",
        ["desktop/electron-builder.yml", "api_server.py"],
    ),
    (
        "C1 RUN set",
        ["api_server.py", "tests/test_a.py", "bench/RESULTS.md", "eval/runner.py"],
    ),
]

PYTHON_SETS_FALSE = [
    ("docs-only", ["docs/foo.md", "docs/guide.md"]),
    (
        "desktop-only",
        ["desktop/preload/index.ts", "desktop/scripts/run-conformance-host.mjs"],
    ),
    ("webui-only", ["web_ui/src/lib/x.ts", "web_ui/src/app.ts"]),
    (
        "C1 SKIP set",
        [
            "web_ui/src/lib/x.ts",
            "desktop/preload/index.ts",
            "packtool/src/y.ts",
            "docs/foo.md",
        ],
    ),
]


@pytest.mark.parametrize("path", PYTHON_TRUE)
def test_python_positive_or_unknown(path):
    assert _decide("python", [path]) is True


@pytest.mark.parametrize("path", PYTHON_FALSE)
def test_python_safe_false(path):
    assert _decide("python", [path]) is False


@pytest.mark.parametrize("label,files", PYTHON_SETS_TRUE)
def test_python_sets_true(label, files):
    assert _decide("python", files) is True, label


@pytest.mark.parametrize("label,files", PYTHON_SETS_FALSE)
def test_python_sets_false(label, files):
    assert _decide("python", files) is False, label


def test_python_empty_diff_fails_open():
    assert _decide("python", []) is True


@pytest.mark.parametrize(
    "bucket,files,expected",
    [
        ("webui", ["web_ui/src/lib/x.ts"], True),
        ("webui", ["contracts/api.openapi.yaml"], True),
        ("webui", [".github/workflows/web-ui.yml"], True),
        ("webui", ["api_server.py", "tests/test_a.py"], False),
        # FC9: the desktop twins desktop-twin-drift.test.ts pins (run by the
        # required web-ui job) must trigger it on a desktop-only diff
        ("webui", ["desktop/main/security/csp.ts"], True),
        ("webui", ["desktop/main/protocol.ts"], True),
        ("webui", ["desktop/main/backend/packs/pack-archive-rules.ts"], True),
        ("webui", ["desktop/main/index.ts", "desktop/main/backend/server.ts"], False),
        ("conformance", ["contracts/api.openapi.yaml", "api_server.py"], True),
        ("conformance", ["contracts/tests/run_conformance.py"], True),
        ("conformance", ["web_ui/src/lib/x.ts"], False),
        # lockstep fail-open with the python bucket (round-2 note 4)
        ("conformance", ["newpkg/mod.py"], True),
        ("pack", ["packtool/src/x.ts", "contracts/pack.schema.json"], True),
        ("pack", ["contracts/fixtures/source-docs/a.md"], True),
        ("pack", ["web_ui/src/lib/x.ts"], False),
        ("pack", ["tests/test_a.py"], False),
        # PRR-001: the pack job's storyline fixture inputs must trigger it
        ("pack", ["tests/fixtures/storyline-mini/meta.xml"], True),
        ("pack", ["tests/fixtures/storyline-mini-story-html-stub.html"], True),
        # PRR-007: scoped buckets do NOT fail open on unknown paths —
        # unknown -> false is the pinned contract for webui/pack/eval
        ("webui", ["newpkg/mod.py"], False),
        ("pack", ["newpkg/mod.py"], False),
        ("eval", ["newpkg/mod.py"], False),
        # PRR-013: case variants must classify identically to their
        # lowercase forms (matching is case-insensitive)
        ("webui", ["Web_UI/src/lib/x.ts"], True),
        ("eval", ["EVAL/runner.py"], True),
        ("eval", ["eval/runner.py", "rag_engine.py"], True),
        ("eval", ["web_ui/src/lib/x.ts"], False),
    ],
)
def test_scoped_buckets(bucket, files, expected):
    assert _decide(bucket, files) is expected


def test_cli_contract():
    """The frozen checks invoke the script as a CLI; keep that shape."""
    result = subprocess.run(
        [
            sys.executable,
            str(CI_PATHS),
            "--bucket",
            "python",
            "--files",
            "api_server.py",
        ],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 0
    assert result.stdout.strip().splitlines()[-1] == "true"


def test_cli_stdin_contract():
    """The workflows invoke the classifier EXCLUSIVELY via --stdin (PRR-003):
    the stdin input mode is the production path and must stay covered."""
    for bucket, payload, expected in [
        ("python", "api_server.py\ntests/test_a.py\n", "true"),
        ("pack", "web_ui/src/lib/x.ts\n", "false"),
        ("pack", "tests/fixtures/storyline-mini/meta.xml\n", "true"),
    ]:
        result = subprocess.run(
            [sys.executable, str(CI_PATHS), "--bucket", bucket, "--stdin"],
            input=payload,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        assert result.returncode == 0, (bucket, payload, result.stderr)
        assert result.stdout.strip().splitlines()[-1] == expected, (bucket, payload)


def test_case_insensitive_matching():
    """PRR-013: a case-only rename away from canonical casing must keep the
    scoped-bucket signal (webui true) and keep safe-false trees python-false."""
    assert _decide("webui", ["Web_UI/src/lib/x.ts"]) is True
    assert _decide("python", ["Web_UI/src/lib/x.ts"]) is False
    assert _decide("python", ["install.md"]) is True


def test_cli_rejects_unknown_bucket():
    result = subprocess.run(
        [sys.executable, str(CI_PATHS), "--bucket", "bogus", "--files", "x"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 2


# ---------------------------------------------------------------------------
# 2. Workflow wiring pins
# ---------------------------------------------------------------------------

FAIL_SAFE = "always() && needs.changes.outputs."

# workflow file -> job id -> single bucket, or a tuple of buckets joined by
# an OR the wiring must carry verbatim.
EXPECTED_WIRING = {
    "test.yml": {
        "test": "python",
        "eval-report": "eval",
        "perf-thresholds": ("python", "pack"),
    },
    "web-ui.yml": {
        "web-ui": "webui",
        "web-ui-e2e": "webui",
    },
    "conformance.yml": {
        "python-conformance": "conformance",
        "pack-fixture-build": "pack",
    },
}

import yaml  # noqa: E402


def _load_workflow(name: str) -> dict:
    with open(WORKFLOWS / name, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _condition(job: dict) -> str:
    return str(job.get("if", ""))


def test_changes_job_exists_and_invokes_classifier():
    for name in EXPECTED_WIRING:
        wf = _load_workflow(name)
        assert "changes" in wf["jobs"], f"{name}: no changes job"
        run_steps = "\n".join(
            str(step.get("run", "")) for step in wf["jobs"]["changes"].get("steps", [])
        )
        assert (
            "scripts/ci_paths.py" in run_steps
        ), f"{name}: changes job never calls the classifier"
        # The buckets are emitted through a loop variable ("--bucket \"$b\"");
        # pin that shape and that every bucket name appears in the loop list.
        assert '--bucket "$b"' in run_steps, f"{name}: no per-bucket classifier loop"
        for bucket in ci_paths.BUCKETS:
            assert re.search(
                rf"\b{bucket}\b", run_steps
            ), f"{name}: bucket {bucket} not in the bucket list"
        # Fail-open pins (impl-review rounds 1+2): a CRASHING classifier must
        # emit true, not false. Pin markers UNIQUE to the classifier-crash
        # branch — the generic phrase "failing open" also appears in the
        # pre-existing diff-unavailable branch and does not discriminate.
        assert (
            "ci_paths.py failed for bucket" in run_steps
        ), f"{name}: changes job lacks the classifier-failure fail-open branch"
        assert (
            'verdict="$(printf' in run_steps and "rc=$?" in run_steps
        ), f"{name}: changes job does not capture the classifier's exit status"


@pytest.mark.parametrize("name", sorted(EXPECTED_WIRING))
def test_workflow_triggers_are_unfiltered(name):
    """Required checks must live behind unfiltered triggers (localization
    Step 5: a workflow-level paths filter leaves required checks Pending)."""
    wf = _load_workflow(name)
    for event in ("push", "pull_request"):
        trigger = wf[True][event]
        # A bare `pull_request:` (or `push:`) parses to None — no filter at
        # all, which is what we want.
        if trigger is None:
            continue
        assert isinstance(trigger, dict), f"{name}: {event} trigger is not a mapping"
        assert (
            "paths" not in trigger and "paths-ignore" not in trigger
        ), f"{name}: {event} carries a path filter"


@pytest.mark.parametrize("name", sorted(EXPECTED_WIRING))
def test_job_wiring_and_polarity(name):
    wf = _load_workflow(name)
    for job_id, bucket in EXPECTED_WIRING[name].items():
        assert job_id in wf["jobs"], f"{name}: missing job {job_id}"
        job = wf["jobs"][job_id]
        needs = job.get("needs")
        needs_list = needs if isinstance(needs, list) else [needs]
        assert "changes" in needs_list, f"{name}/{job_id}: does not need changes"
        cond = _condition(job).replace(" ", "")
        assert cond.startswith(
            "always()&&"
        ), f"{name}/{job_id}: condition is not fail-safe (missing always())"
        if isinstance(bucket, tuple):
            ors = [f"needs.changes.outputs.{b}!='false'" for b in bucket]
            assert (
                all(part in cond for part in ors) and "||" in cond
            ), f"{name}/{job_id}: expected OR of {bucket}"
        else:
            expected = f"needs.changes.outputs.{bucket}!='false'"
            assert (
                expected in cond and "||" not in cond
            ), f"{name}/{job_id}: expected exactly {expected}"


# ---------------------------------------------------------------------------
# 3. Required-context provenance
# ---------------------------------------------------------------------------

README = WORKFLOWS / "README.md"

UNFILTERED_WORKFLOWS = ("test.yml", "web-ui.yml", "conformance.yml", "security.yml")


def _job_display_names(workflow: dict) -> set[str]:
    names = set()
    for job_id, job in workflow["jobs"].items():
        if "name" in job:
            names.add(str(job["name"]))
        else:
            names.add(str(job_id))
    return names


def test_readme_required_contexts_resolve_to_unfiltered_jobs():
    text = README.read_text(encoding="utf-8")
    section = re.search(r"## Required checks.*?```text\n(.*?)```", text, re.DOTALL)
    assert section, "README.md: no '## Required checks' fenced list"
    contexts = [ln.strip() for ln in section.group(1).splitlines() if ln.strip()]
    assert contexts, "README.md: required-checks list is empty"
    reporting = set()
    for name in UNFILTERED_WORKFLOWS:
        reporting |= _job_display_names(_load_workflow(name))
    for context in contexts:
        assert context in reporting, (
            f"required context {context!r} matches no job name in the "
            f"unfiltered workflows {UNFILTERED_WORKFLOWS}"
        )


@pytest.mark.parametrize(
    "name", sorted(set(UNFILTERED_WORKFLOWS) | {"desktop-build.yml"})
)
def test_no_truncated_issue_job_names(name):
    """Unquoted '#' in a job name truncates the reported check-run name at
    '(issue' (plan-critic round-1 F1 evidence); every name must parse whole."""
    wf = _load_workflow(name)
    for job_id, job in wf["jobs"].items():
        display = str(job.get("name", job_id))
        assert not display.rstrip().endswith(
            "(issue"
        ), f"{name}/{job_id}: display name truncated at '(issue' — quote it"
