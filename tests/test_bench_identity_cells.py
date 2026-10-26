"""Issue #223 AC5 — the native results identity is engine-aware.

Pins, against the real `bench/append_results.py` module and throwaway RESULTS.md
files (never the real registry):

- node-llama-cpp rows: `prompt_tokens` is a LABEL (the measured prompt is sized
  from `--max-tokens`), so it must NOT split an identity cell; `max_tokens`
  (the decode budget) MUST — two runs differing only in budget are distinct
  measurements (recorded maintainer decision, comment 6280336819).
- legacy native producers (`llama-cpp-python`, `llama-bench`): the prompt
  length IS a real input (the prompt is sized from `--prompt-tokens` and
  passed as `-p`), so it stays an identity cell alongside the budget.
- `max_tokens` is required on native PASS rows (fail-closed provenance).
- Identical-configuration duplicate refusal is preserved; historical 10-cell
  rows (pre-#223 schema) never collide with new 11-cell rows.

Every scenario is a parametrize id of `test_max_tokens_identity` so the frozen
acceptance filter (`-k max-tokens-identity`, hyphens literal) selects the whole
contract: pytest -k matches test IDs, and only parametrize ids can carry the
hyphenated token.
"""

import importlib
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

append_results = importlib.import_module("bench.append_results")

# The table header is DERIVED from the schema so it can neither drift from
# HEADER_CELLS nor trip flake8's 100-column limit (11 columns are >100 chars).
_NATIVE_HEADER = "| " + " | ".join(append_results.HEADER_CELLS["native"]) + " |"
_NATIVE_SEPARATOR = "|" + "---|" * len(append_results.HEADER_CELLS["native"])

RESULTS_SKELETON = f"""# Benchmarks

## Machine registry

### celltest
identity-contract test host (issue #223)

## Native llama.cpp CPU results

{_NATIVE_HEADER}
{_NATIVE_SEPARATOR}
"""


def make_row(engine="node-llama-cpp", prompt_tokens=64, max_tokens=128, decode=12.5):
    return {
        "surface": "native",
        "machine": "celltest",
        "model": "m.gguf",
        "quant": "Q4_K_M",
        "threads": 8,
        "prompt_tokens": prompt_tokens,
        "decode_tokens_per_second": decode,
        "first_token_ms": 100.0,
        "peak_rss_mb": 500,
        "engine": engine,
        "outcome": "pass",
        "max_tokens": max_tokens,
    }


def append(tmp_path, row):
    results = tmp_path / "RESULTS.md"
    if not results.exists():
        results.write_text(RESULTS_SKELETON, encoding="utf-8", newline="\n")
    append_results.append_row(row, results)


def native_rows(tmp_path):
    text = (tmp_path / "RESULTS.md").read_text(encoding="utf-8")
    section = text.split("## Native llama.cpp CPU results", 1)[1]
    return [
        ln
        for ln in section.splitlines()
        if ln.startswith("|") and not ln.startswith("|--") and "machine" not in ln
    ]


def expect_duplicate(raised):
    assert raised is not None and "row already recorded" in raised


def sc_node_tuple(tmp_path):
    assert append_results.identity_cells_for(
        "native",
        ["m", "mo", "q", "8", "64", "1", "1", "1", "node-llama-cpp", "pass", "128"],
    ) == (0, 1, 2, 3, 8, 10)


def sc_legacy_tuple(tmp_path):
    assert append_results.identity_cells_for(
        "native",
        ["m", "mo", "q", "8", "64", "1", "1", "1", "llama-cpp-python", "pass", "128"],
    ) == (0, 1, 2, 3, 4, 8, 10)
    assert append_results.identity_cells_for(
        "native",
        ["m", "mo", "q", "8", "64", "1", "1", "1", "llama-bench", "pass", "128"],
    ) == (0, 1, 2, 3, 4, 8, 10)


def sc_other_surfaces(tmp_path):
    assert (
        append_results.identity_cells_for("wllama", [])
        == append_results.IDENTITY_CELLS["wllama"]
    )
    assert append_results.identity_cells_for("onnx-embed", []) == (0, 1)


def sc_node_label_no_split(tmp_path):
    append(tmp_path, make_row(prompt_tokens=64))
    raised = None
    try:
        append(tmp_path, make_row(prompt_tokens=65, decode=44.4))
    except SystemExit as exc:
        raised = str(exc)
    expect_duplicate(raised)
    assert len(native_rows(tmp_path)) == 1


def sc_budget_splits(tmp_path):
    append(tmp_path, make_row(max_tokens=128))
    append(tmp_path, make_row(max_tokens=4096, decode=33.3))
    rows = native_rows(tmp_path)
    assert len(rows) == 2
    assert "4096" in rows[1]


def sc_legacy_prompt_distinct(tmp_path):
    append(tmp_path, make_row(engine="llama-cpp-python", prompt_tokens=64))
    append(
        tmp_path, make_row(engine="llama-cpp-python", prompt_tokens=1024, decode=9.9)
    )
    assert len(native_rows(tmp_path)) == 2


def sc_legacy_budget_distinct(tmp_path):
    append(tmp_path, make_row(engine="llama-bench", prompt_tokens=512, max_tokens=256))
    append(
        tmp_path,
        make_row(engine="llama-bench", prompt_tokens=512, max_tokens=512, decode=7.7),
    )
    assert len(native_rows(tmp_path)) == 2


def sc_duplicate_refusal(tmp_path):
    append(tmp_path, make_row())
    raised = None
    try:
        append(tmp_path, make_row(decode=55.5))
    except SystemExit as exc:
        raised = str(exc)
    expect_duplicate(raised)


def sc_missing_budget_fails_closed(tmp_path):
    row = make_row()
    del row["max_tokens"]
    raised = None
    try:
        append(tmp_path, row)
    except SystemExit as exc:
        raised = str(exc)
    assert raised is not None and "max_tokens" in raised


def sc_historical_boundary(tmp_path):
    results = tmp_path / "RESULTS.md"
    results.write_text(RESULTS_SKELETON, encoding="utf-8", newline="\n")
    legacy_line = (
        "| celltest | m.gguf | Q4_K_M | 8 | 1024 | 9.9 | 100.0 | 500 "
        "| llama-cpp-python | pass |\n"
    )
    text = results.read_text(encoding="utf-8")
    text = text.replace(
        "|---|---|---|---|---|---|---|---|---|---|---|\n",
        "|---|---|---|---|---|---|---|---|---|---|---|\n" + legacy_line,
    )
    results.write_text(text, encoding="utf-8", newline="\n")
    # A new-schema row for the SAME logical cell appends rather than matching
    # the historical 10-cell row (the length guard separates the schemas).
    append(
        tmp_path,
        make_row(engine="llama-cpp-python", prompt_tokens=1024, max_tokens=512),
    )
    rows = native_rows(tmp_path)
    assert len(rows) == 2
    assert rows[0].count("|") == 11  # historical: 10 cells
    assert rows[1].count("|") == 12  # new schema: 11 cells


def sc_empty_table_first_append_after_separator(tmp_path):
    # First append into an EMPTY table (header + separator only) must land
    # after the separator, keeping the GFM table well-formed (the pre-#223
    # code inserted between header and separator, corrupting the table).
    append(tmp_path, make_row())
    lines = (tmp_path / "RESULTS.md").read_text(encoding="utf-8").splitlines()
    header_idx = next(i for i, ln in enumerate(lines) if ln.startswith("| machine"))
    assert lines[header_idx + 1].startswith("|--")
    assert lines[header_idx + 2].startswith("| celltest")


SCENARIOS = [
    ("max-tokens-identity-node-tuple-drops-prompt", sc_node_tuple),
    ("max-tokens-identity-legacy-tuple-keeps-prompt", sc_legacy_tuple),
    ("max-tokens-identity-other-surfaces-unchanged", sc_other_surfaces),
    ("max-tokens-identity-node-label-no-split", sc_node_label_no_split),
    ("max-tokens-identity-budget-splits", sc_budget_splits),
    ("max-tokens-identity-legacy-prompt-distinct", sc_legacy_prompt_distinct),
    ("max-tokens-identity-legacy-budget-distinct", sc_legacy_budget_distinct),
    ("max-tokens-identity-duplicate-refusal", sc_duplicate_refusal),
    ("max-tokens-identity-missing-budget-fails-closed", sc_missing_budget_fails_closed),
    ("max-tokens-identity-historical-boundary", sc_historical_boundary),
    (
        "max-tokens-identity-empty-table-placement",
        sc_empty_table_first_append_after_separator,
    ),
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_max_tokens_identity(scenario, tmp_path):
    scenario[1](tmp_path)
