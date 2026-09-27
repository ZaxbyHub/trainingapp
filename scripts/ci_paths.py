#!/usr/bin/env python3
"""CI path-scope classifier for GitHub Actions job gating (issue #87).

Single source of truth for "which CI jobs should a diff trigger". The
`changes` job in test.yml / web-ui.yml / conformance.yml pipes the diff's
changed-file list through this script once per bucket and gates each job on
the bucket output; tests/test_ci_paths.py pins both the decisions and the
workflow wiring.

Contract (frozen by the issue-87 acceptance checks, repro/scope_eval.py):
    python scripts/ci_paths.py --bucket <name> --files f1 f2 ...
    python scripts/ci_paths.py --bucket <name> --stdin
Prints exactly one line: `true` (run the gated jobs) or `false` (skip).
Exit 0 on a decision, 2 on usage error. Bucket set semantics: `true` iff ANY
listed file is in the bucket.

The `python` bucket is three-way, fail-open:
  - positive list  -> true (verified pytest-matrix dependencies)
  - safe-false list-> false only when EVERY file is on it
  - unknown file   -> true (a new module or new tree must never silently
                      skip the matrix; only enumerated, verified-irrelevant
                      paths skip)
`conformance` follows the python bucket's three-way semantics (lockstep
fail-open) plus the contract surface.
"""

from __future__ import annotations

import argparse
import re
import sys

BUCKETS = ("python", "webui", "conformance", "pack", "eval")


def _translate(pattern: str) -> re.Pattern[str]:
    """Compile a lowercase path glob: `**` spans dirs, `*` stays in one.

    Patterns are lowercased here so matching is case-insensitive end to end
    (paths are lowercased in _normalize; the only mixed-case constant,
    INSTALL.md, normalizes to install.md).
    """
    pattern = pattern.lower()
    escaped = re.escape(pattern)
    # re.escape leaves '*' as '\*'; replace the double-star first so the
    # single-star rule cannot consume half of it.
    escaped = escaped.replace(r"\*\*", "\x00")
    escaped = escaped.replace(r"\*", "[^/]*")
    escaped = escaped.replace("\x00", ".*")
    return re.compile("^" + escaped + "$")


# --- python bucket: three-way ------------------------------------------------

PYTHON_POSITIVE = [
    "tests/**",
    "pytest.ini",
    "requirements.txt",
    # top-level application modules (*.py at repo root)
    "*.py",
    # scripts with pytest coverage (03-localization Step 3)
    "scripts/build_installer.py",
    "scripts/precache_models.py",
    "scripts/version_bump.py",
    "bench/**",
    "eval/**",
    "contracts/fixtures/packs/**",
    "contracts/api.openapi.yaml",
    # runtime-loaded by pack_manager.py (plan-critic round-1 F2)
    "contracts/pack.schema.json",
    # docs the test suite reads (tests/test_adr_0002_llm_profiles.py,
    # tests/test_a8_training_player_evidence.py)
    "docs/adr/**",
    "docs/licenses.md",
    "docs/training-player.md",
    "INSTALL.md",
    # desktop files the pytest matrix content-asserts (test_adr_0002_llm
    # profiles.py _load()s both; implementation-review round 1 F2)
    "desktop/main/index.ts",
    "desktop/electron-builder.yml",
    "desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md",
    # file-loaded by tests/test_storyline_transcribe.py
    "packtool/storyline/transcribe.py",
    # the matrix's own gating infrastructure: workflow-only PRs pay the
    # matrix so the structural guardrail always runs on these files
    ".github/workflows/test.yml",
    ".github/workflows/web-ui.yml",
    ".github/workflows/conformance.yml",
    # the required-checks table the provenance guardrail reads
    # (implementation-review round 1 F3)
    ".github/workflows/README.md",
    "scripts/ci_paths.py",
    "tests/test_ci_paths.py",
]

PYTHON_SAFE_FALSE = [
    "web_ui/**",
    "desktop/**",
    "packtool/**",
    "docs/**",
    "audit/**",
    "models/**",
    "specs/**",
    "contracts/tests/**",
    # root markdown (except INSTALL.md, which is python-positive)
    "*.md",
    "*.spec",
    "*.bat",
    ".github/**",
]

# Exact-path exceptions inside the safe-false trees (positive wins).
# Keys are lowercase — paths are lowercased in _normalize before lookup.
_PYTHON_EXCEPTIONS = {
    "desktop/e2e/fixtures/storyline-nav/fixture_contract.md",
    "packtool/storyline/transcribe.py",
    "install.md",
    ".github/workflows/test.yml",
    ".github/workflows/web-ui.yml",
    ".github/workflows/conformance.yml",
    # the required-checks table the provenance guardrail reads
    # (implementation-review round 1 F3)
    ".github/workflows/readme.md",
}

# --- scoped buckets: plain any-match -----------------------------------------

_CONFORMANCE_EXTRAS = [
    "contracts/**",
    "api_server.py",
    "scripts/check_test_collection.py",
    ".github/workflows/conformance.yml",
]

_WEBUI = [
    "web_ui/**",
    "contracts/**",
    ".github/workflows/web-ui.yml",
]

_PACK = [
    "packtool/**",
    "contracts/pack.schema.json",
    "contracts/fixtures/**",
    "contracts/validate_pack.py",
    # inputs the pack-fixture-build job assembles its storyline publish dir
    # from (PRR-001: a fixture-only diff must run the required job that
    # builds+verifies it)
    "tests/fixtures/storyline-mini/**",
    "tests/fixtures/storyline-mini-story-html-stub.html",
    ".github/workflows/conformance.yml",
]

_EVAL = [
    "eval/**",
    "rag_engine.py",
    "vector_store.py",
    "document_processor.py",
    "query_transformer.py",
    "reranking.py",
    "recency.py",
]

_PYTHON_POSITIVE_RE = [_translate(p) for p in PYTHON_POSITIVE]
_PYTHON_SAFE_FALSE_RE = [_translate(p) for p in PYTHON_SAFE_FALSE]
_CONFORMANCE_EXTRAS_RE = [_translate(p) for p in _CONFORMANCE_EXTRAS]
_WEBUI_RE = [_translate(p) for p in _WEBUI]
_PACK_RE = [_translate(p) for p in _PACK]
_EVAL_RE = [_translate(p) for p in _EVAL]


def _normalize(path: str) -> str:
    # Matching is case-insensitive: every pattern below is lowercase, and a
    # case-only rename away from canonical casing (e.g. web_ui -> Web_UI)
    # must not silently drop the scoped-bucket signal (PRR-013).
    path = path.strip().replace("\\", "/").lower()
    if path.startswith("./"):
        path = path[2:]
    return path


def _python_file_state(path: str) -> str:
    if path in _PYTHON_EXCEPTIONS:
        return "positive"
    if any(rx.match(path) for rx in _PYTHON_POSITIVE_RE):
        return "positive"
    if any(rx.match(path) for rx in _PYTHON_SAFE_FALSE_RE):
        return "safe-false"
    return "unknown"


def python_bucket(files: list[str]) -> bool:
    """TRUE iff any file is positive OR unknown; FALSE iff every file is safe-false."""
    if not files:
        return True  # fail-open: an empty diff must never skip the matrix
    states = [_python_file_state(f) for f in files]
    return any(s in ("positive", "unknown") for s in states)


def _any_match(files: list[str], compiled: list[re.Pattern[str]]) -> bool:
    return any(rx.match(f) for f in files for rx in compiled)


def decide(bucket: str, files: list[str]) -> bool:
    files = [f for f in (_normalize(p) for p in files) if f]
    if bucket == "python":
        return python_bucket(files)
    if bucket == "conformance":
        # Lockstep with the python bucket's three-way semantics (incl.
        # unknown->true), plus the explicit contract surface.
        return python_bucket(files) or _any_match(files, _CONFORMANCE_EXTRAS_RE)
    if bucket == "webui":
        return _any_match(files, _WEBUI_RE)
    if bucket == "pack":
        return _any_match(files, _PACK_RE)
    if bucket == "eval":
        return _any_match(files, _EVAL_RE)
    raise ValueError(f"unknown bucket: {bucket}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True, choices=BUCKETS)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--files", nargs="+", default=[], metavar="PATH")
    source.add_argument("--stdin", action="store_true")
    args = parser.parse_args(argv)

    if args.stdin:
        files = sys.stdin.read().splitlines()
    else:
        files = args.files

    print("true" if decide(args.bucket, files) else "false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
