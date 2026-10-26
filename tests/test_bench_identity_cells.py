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
- wllama rows: budget AND prompt length are both real inputs — the budget is
  recorded (implementation-review round 1) and identity-bound.
- `max_tokens` is required on native and wllama PASS rows (fail-closed
  provenance).
- Identical-configuration duplicate refusal is preserved; historical rows
  recorded under a pre-#223 schema never collide with new rows; the runbook
  PENDING-placeholder fill survives the schema extension (pre-schema
  placeholders fill on their carried identity cells).

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

# The table headers are DERIVED from the schema so they can neither drift from
# HEADER_CELLS nor trip flake8's 100-column limit (11 columns are >100 chars).
_NATIVE_HEADER = "| " + " | ".join(append_results.HEADER_CELLS["native"]) + " |"
_NATIVE_SEPARATOR = "|" + "---|" * len(append_results.HEADER_CELLS["native"])
_WLLAMA_HEADER = "| " + " | ".join(append_results.HEADER_CELLS["wllama"]) + " |"
_WLLAMA_SEPARATOR = "|" + "---|" * len(append_results.HEADER_CELLS["wllama"])

RESULTS_SKELETON = (
    "# Benchmarks\n"
    "\n"
    "## Machine registry\n"
    "\n"
    "### celltest\n"
    "identity-contract test host (issue #223)\n"
    "\n"
    "## Native llama.cpp CPU results\n"
    "\n" + _NATIVE_HEADER + "\n" + _NATIVE_SEPARATOR + "\n"
)

WLLAMA_SKELETON = (
    "# Benchmarks\n"
    "\n"
    "## Machine registry\n"
    "\n"
    "### celltest\n"
    "host\n"
    "\n"
    "## wllama (browser WASM) results\n"
    "\n" + _WLLAMA_HEADER + "\n" + _WLLAMA_SEPARATOR + "\n"
)

# An 8-cell PRE-#223 wllama PENDING placeholder (the reference-i5 runbook row).
_WLLAMA_PENDING_LINE = (
    "| reference-i5 | lfm2.5-vl-450m | threaded | 4 | 256 "
    "| PENDING | PENDING | PENDING |\n"
)


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


def make_wllama_row(max_tokens=128, decode=51.8, threads=4):
    return {
        "surface": "wllama",
        "machine": "celltest",
        "model": "lfm2-1.2b-rag",
        "mode": "threaded",
        "threads": threads,
        "prompt_tokens": 256,
        "decode_tokens_per_second": decode,
        "first_token_ms": 650.0,
        "outcome": "pass",
        "max_tokens": max_tokens,
    }


def append(tmp_path, row):
    results = tmp_path / "RESULTS.md"
    if not results.exists():
        results.write_text(RESULTS_SKELETON, encoding="utf-8", newline="\n")
    append_results.append_row(row, results)


def append_wllama(tmp_path, row, skeleton=None):
    results = tmp_path / "RESULTS.md"
    if not results.exists():
        results.write_text(skeleton or WLLAMA_SKELETON, encoding="utf-8", newline="\n")
    append_results.append_row(row, results)


def expect_duplicate(raised):
    assert raised is not None and "row already recorded" in raised


def native_rows(tmp_path):
    text = (tmp_path / "RESULTS.md").read_text(encoding="utf-8")
    section = text.split("## Native llama.cpp CPU results", 1)[1]
    return [
        ln
        for ln in section.splitlines()
        if ln.startswith("|") and not ln.startswith("|--") and "machine" not in ln
    ]


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
    assert append_results.identity_cells_for("wllama", []) == (0, 1, 2, 3, 4, 8)
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
        _NATIVE_SEPARATOR + "\n",
        _NATIVE_SEPARATOR + "\n" + legacy_line,
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


def sc_wllama_budget_splits(tmp_path):
    # Implementation-review round 1: the wllama decode budget is a REAL input
    # (n_ctx sizing + generation cap) — two runs differing only in budget are
    # distinct measurements, never an append-or-fail collision.
    append_wllama(tmp_path, make_wllama_row(max_tokens=16))
    append_wllama(tmp_path, make_wllama_row(max_tokens=512, decode=48.2))
    text = (tmp_path / "RESULTS.md").read_text(encoding="utf-8")
    section = text.split("## wllama (browser WASM) results", 1)[1]
    rows = [ln for ln in section.splitlines() if ln.startswith("| celltest")]
    assert len(rows) == 2
    assert rows[0].rstrip().endswith("| 16 |")
    assert rows[1].rstrip().endswith("| 512 |")


def sc_real_results_tables_match_schema(tmp_path):
    # Implementation-review round 1: the REAL bench/RESULTS.md tables must
    # carry header + separator cell counts matching HEADER_CELLS (the GFM
    # rule — a mismatch silently un-tables the section for every renderer).
    real = (REPO_ROOT / "bench" / "RESULTS.md").read_text(encoding="utf-8")
    for surface in ("native", "wllama"):
        heading = append_results.SECTION_HEADINGS[surface]
        section = real.split(heading, 1)[1].split("\n## ", 1)[0]
        lines = section.splitlines()
        header_idx = next(i for i, ln in enumerate(lines) if ln.startswith("| machine"))
        header = [c.strip() for c in lines[header_idx].strip().strip("|").split("|")]
        separator = [
            c.strip() for c in lines[header_idx + 1].strip().strip("|").split("|")
        ]
        want = list(append_results.HEADER_CELLS[surface])
        assert header == want, f"{surface}: header {header} != schema {want}"
        assert len(separator) == len(
            header
        ), f"{surface}: separator has {len(separator)} cells for {len(header)} header cells"
        assert all(
            set(cell) <= {"-"} for cell in separator
        ), f"{surface}: malformed separator"


def sc_wllama_pending_placeholder_fills(tmp_path):
    # Implementation-review round 2: the runbook PENDING-fill flow survives
    # the schema extension — a PRE-schema (8-cell) wllama placeholder fills
    # in place when the identity cells it carries match, and the filled row
    # then refuses duplicates like any recorded measurement. (The placeholder
    # carries machine=celltest here so the registry gate passes; the real
    # reference-i5 tag is registered in the production registry.)
    pending_line = _WLLAMA_PENDING_LINE.replace("| reference-i5 |", "| celltest |")
    results = tmp_path / "RESULTS.md"
    results.write_text(WLLAMA_SKELETON + pending_line, encoding="utf-8", newline="\n")
    append_results.append_row(
        {
            "surface": "wllama",
            "machine": "celltest",
            "model": "lfm2.5-vl-450m",
            "mode": "threaded",
            "threads": 4,
            "prompt_tokens": 256,
            "decode_tokens_per_second": 51.83,
            "first_token_ms": 658.1,
            "outcome": "pass",
            "max_tokens": 16,
        },
        results,
    )
    lines = results.read_text(encoding="utf-8").splitlines()
    body = [ln for ln in lines if ln.startswith("| celltest")]
    assert len(body) == 1, f"expected in-place fill, got {len(body)} celltest rows"
    assert "PENDING" not in body[0]
    assert "51.83" in body[0] and "| 16 |" in body[0]
    # The filled row is a recorded measurement: a second identical append
    # refuses (the placeholder exception does not become a duplicate hole).
    raised = None
    try:
        append_results.append_row(
            {
                "surface": "wllama",
                "machine": "celltest",
                "model": "lfm2.5-vl-450m",
                "mode": "threaded",
                "threads": 4,
                "prompt_tokens": 256,
                "decode_tokens_per_second": 99.9,
                "first_token_ms": 111.0,
                "outcome": "pass",
                "max_tokens": 16,
            },
            results,
        )
    except SystemExit as exc:
        raised = str(exc)
    expect_duplicate(raised)


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
    ("max-tokens-identity-wllama-budget-splits", sc_wllama_budget_splits),
    (
        "max-tokens-identity-real-tables-match-schema",
        sc_real_results_tables_match_schema,
    ),
    ("max-tokens-identity-wllama-pending-fills", sc_wllama_pending_placeholder_fills),
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_max_tokens_identity(scenario, tmp_path):
    scenario[1](tmp_path)
