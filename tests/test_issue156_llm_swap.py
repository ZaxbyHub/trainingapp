"""Arm's-length acceptance check for issue #156 (row C1) — LLM model swap.

Frozen-bytes check spec authored from the issue contract (02-reproduction.md
`## Acceptance checks` row C1 and 01-issue-summary.md AC1). The implementer
codes the fix AGAINST these assertions and never edits this file: these bytes
are the acceptance check, not the implementation.

Pinned surface (AC1):
  - desktop/main/backend/inference/llama-engine.ts declares the new tier
    subpath literals `lfm2.5-2.6b/model.gguf` (quality) and
    `lfm2-1.2b-rag/model.gguf` (fast), and no longer declares the retired
    subpaths.
  - desktop/scripts/stage-installer-resources.mjs STAGED_MODELS: the
    llm-quality group carries id `lfm2.5-2.6b`, the llm-fast group carries id
    `lfm2-1.2b-rag`, and `mmproj.gguf` is absent from both desktop LLM
    groups' file lists (node-llama-cpp has no image support).
  - RENDERER_EXCLUDED_MODEL_IDS still excludes `gemma-4-e2b-it` after the
    exclusion is decoupled from STAGED_MODELS (the deliberate packaging pin).
  - ADR-0002's decision rows name the same ids as the engine/stager.
  - bench/RESULTS.md carries machine-tagged rows for BOTH new models
    (quant Q4_K_M, machine devstation).

Plain pytest only: pathlib reads relative to this file (tests/ sits at the
repo root), no network, no imports of application code.
"""

from pathlib import Path
import re

REPO_ROOT = Path(__file__).resolve().parent.parent

ENGINE_TS = REPO_ROOT / "desktop" / "main" / "backend" / "inference" / "llama-engine.ts"
STAGER_MJS = REPO_ROOT / "desktop" / "scripts" / "stage-installer-resources.mjs"
ADR_0002 = REPO_ROOT / "docs" / "adr" / "0002-llm-profiles.md"
BENCH_RESULTS = REPO_ROOT / "bench" / "RESULTS.md"

QUALITY_SUBPATH = "lfm2.5-2.6b/model.gguf"
FAST_SUBPATH = "lfm2-1.2b-rag/model.gguf"
RETIRED_SUBPATHS = ("gemma-4-e2b-it/model.gguf", "lfm2.5-vl-450m/model.gguf")
QUALITY_ID = "lfm2.5-2.6b"
FAST_ID = "lfm2-1.2b-rag"


def _read(path: Path) -> str:
    assert path.is_file(), f"required surface missing: {path.relative_to(REPO_ROOT)}"
    return path.read_text(encoding="utf-8")


def _staged_models_entries(stager_text: str):
    """Parse the exported STAGED_MODELS array into (group, id, files) tuples.

    Entries are flat object literals (no nested braces), so a non-greedy
    brace scan is exact regardless of key order inside an entry.
    """
    block_match = re.search(r"export const STAGED_MODELS\s*=\s*\[", stager_text)
    assert block_match, "STAGED_MODELS export not found in stage-installer-resources.mjs"
    rest = stager_text[block_match.end():]
    close = rest.find("];")
    assert close != -1, "STAGED_MODELS array is not terminated by ];"
    block = rest[:close]
    entries = []
    for raw in re.findall(r"\{[^{}]*\}", block):
        group = re.search(r"group\s*:\s*'([^']+)'", raw)
        model_id = re.search(r"id\s*:\s*'([^']+)'", raw)
        files_match = re.search(r"files\s*:\s*\[([^\]]*)\]", raw)
        assert group and model_id and files_match, (
            f"STAGED_MODELS entry is not parseable (group/id/files keys): {raw[:80]!r}"
        )
        files = [f.strip().strip("'\"") for f in files_match.group(1).split(",") if f.strip()]
        entries.append((group.group(1), model_id.group(1), files))
    assert entries, "STAGED_MODELS exported an empty array"
    return entries


def _renderer_excluded_declaration(stager_text: str) -> str:
    """The RENDERER_EXCLUDED_MODEL_IDS declaration statement, up to its ';'."""
    decl = re.search(r"RENDERER_EXCLUDED_MODEL_IDS\s*=", stager_text)
    assert decl, "RENDERER_EXCLUDED_MODEL_IDS declaration not found in stage-installer-resources.mjs"
    end = stager_text.find(";", decl.end())
    assert end != -1, "RENDERER_EXCLUDED_MODEL_IDS declaration is not terminated by ';'"
    return stager_text[decl.start():end]


def _md_section(text: str, heading_pattern: str):
    heading = re.search(heading_pattern, text, re.MULTILINE)
    assert heading is not None, f"heading not found: {heading_pattern!r}"
    rest = text[heading.end():]
    nxt = re.search(r"^## ", rest, re.MULTILINE)
    return rest[: nxt.start()] if nxt else rest


def test_engine_declares_lfm_tier_subpaths():
    """AC1: the desktop engine's tiers load the new LFM models (C1 first leg).

    The first failing assertion at the pre-fix tree carries the
    ISSUE156-SWAP-NOT-LANDED sentinel so the base failure line is stable.
    """
    engine = _read(ENGINE_TS)
    assert QUALITY_SUBPATH in engine, (
        "ISSUE156-SWAP-NOT-LANDED: llama-engine.ts does not declare the quality tier subpath lfm2.5-2.6b/model.gguf"
    )
    assert FAST_SUBPATH in engine, (
        f"llama-engine.ts does not declare the fast tier subpath {FAST_SUBPATH}"
    )


def test_engine_retired_subpaths_removed():
    engine = _read(ENGINE_TS)
    for retired in RETIRED_SUBPATHS:
        assert retired not in engine, (
            f"llama-engine.ts still declares retired subpath {retired}"
        )


def test_staged_models_llm_groups_carry_new_ids():
    entries = _staged_models_entries(_read(STAGER_MJS))
    by_group = {}
    for group, model_id, _files in entries:
        by_group.setdefault(group, []).append(model_id)
    assert by_group.get("llm-quality") == [QUALITY_ID], (
        f"STAGED_MODELS llm-quality group must be exactly [{QUALITY_ID!r}], got {by_group.get('llm-quality')}"
    )
    assert by_group.get("llm-fast") == [FAST_ID], (
        f"STAGED_MODELS llm-fast group must be exactly [{FAST_ID!r}], got {by_group.get('llm-fast')}"
    )


def test_staged_models_drop_mmproj_from_llm_groups():
    for group, model_id, files in _staged_models_entries(_read(STAGER_MJS)):
        if group in ("llm-quality", "llm-fast"):
            assert "mmproj.gguf" not in files, (
                f"STAGED_MODELS {group} ({model_id}) still stages mmproj.gguf; "
                "node-llama-cpp has no image support so the mmproj files are dropped"
            )


def test_renderer_exclusion_still_pins_gemma_after_decoupling():
    """The renderer-copy exclusion keeps gemma-4-e2b-it once it stops being
    derived from STAGED_MODELS (the deliberate decoupled packaging pin)."""
    declaration = _renderer_excluded_declaration(_read(STAGER_MJS))
    assert "gemma-4-e2b-it" in declaration, (
        "RENDERER_EXCLUDED_MODEL_IDS no longer names gemma-4-e2b-it; the decoupled "
        "declaration must still exclude the retired (but historically shipped) id "
        "so stale renderer copies stay excluded"
    )


def test_adr_decision_rows_name_new_ids():
    table = _md_section(_read(ADR_0002), r"^## Decision table[ \t]*$")
    assert QUALITY_ID in table, (
        f"ADR-0002 Decision table rows do not name the quality id {QUALITY_ID}"
    )
    assert FAST_ID in table, (
        f"ADR-0002 Decision table rows do not name the fast id {FAST_ID}"
    )


def test_bench_results_have_devstation_q4_rows_for_both_new_models():
    results = _read(BENCH_RESULTS)
    for model_id in (QUALITY_ID, FAST_ID):
        row = re.compile(
            r"^\|\s*devstation\s*\|\s*" + re.escape(model_id) + r"\s*\|\s*Q4_K_M\s*\|",
            re.MULTILINE,
        )
        assert row.search(results), (
            f"bench/RESULTS.md has no machine-tagged row (machine=devstation, "
            f"quant=Q4_K_M) for {model_id}; ADR figures must cite recorded rows"
        )
