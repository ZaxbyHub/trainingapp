#!/usr/bin/env python3
"""Append driver result rows into bench/RESULTS.md (issue #52 bench harness).

Rows are inserted as markdown table lines in the section matching the row's
surface, into the table whose header cells match that surface's schema, tagged
with their machine tag. The append is fail-closed:

  - the row must carry its provenance keys (surface, machine, outcome), and a
    PASS row must additionally carry every measured key its surface requires
    (per-surface schema);
  - the row's machine tag must exist in the "## Machine registry" section;
  - a row whose identity cells (machine + configuration columns) already exist
    in the target table aborts the append - existing recorded measurements are
    never silently overwritten or duplicated. The one exception: an
    exact-identity match against a PENDING placeholder row fills the slot in
    place, which is the runbook flow for the pre-seeded reference-i5 cells.
    Issue #223 schema boundary: rows recorded before a surface's schema gained
    columns (native and wllama gained trailing `max_tokens` at #223) carry the
    OLD cell count, and the length guard means a new row can never
    duplicate-refuse against a historical one (and vice versa) - read
    historical sections under their recorded schema.

Usage:
  python bench/append_results.py --row-file out.json
  python bench/append_results.py --row-json '{"surface": "native", ...}'
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS = REPO_ROOT / "bench" / "RESULTS.md"

# surface -> heading text in RESULTS.md
SECTION_HEADINGS = {
    "native": "## Native llama.cpp CPU results",
    "native-vulkan": "## Vulkan attempt",
    "wllama": "## wllama (browser WASM) results",
    "onnx-embed": "## ONNX embed/rerank cost",
    "onnx-rerank": "## ONNX embed/rerank cost",
    "desktop-ingest": "## Desktop ingest (B6)",
    "desktop-retrieval": "## Desktop retrieval (B7)",
}

# surface -> header cells of the table that accepts the surface's rows. The
# ONNX section hosts two tables (embed, rerank); matching on header cells is
# what routes rows to the right one. Issue #223 AC5: the native table gains a
# trailing `max_tokens` column (index 10) — appended, never inserted, so the
# pre-schema historical rows (10 cells) keep their column meaning and can
# never false-match a new 11-cell row.
HEADER_CELLS = {
    "native": [
        "machine",
        "model",
        "quant",
        "threads",
        "prompt_tokens",
        "decode_tok_s",
        "first_token_ms",
        "peak_rss_mb",
        "engine",
        "outcome",
        "max_tokens",
    ],
    "native-vulkan": ["machine", "model", "bin", "decode_tok_s", "outcome", "crash"],
    "wllama": [
        "machine",
        "model",
        "mode",
        "threads",
        "prompt_tokens",
        "decode_tok_s",
        "first_token_ms",
        "outcome",
        # Issue #223 AC5 (implementation-review round 1): the wllama decode
        # budget is a REAL measurement input (n_ctx sizing + generation
        # budget) — appended at index 8 like the native column, so historical
        # 8-cell rows keep their meaning under the length guard.
        "max_tokens",
    ],
    "onnx-embed": ["machine", "model", "encode_ms", "embeddings_per_second", "outcome"],
    "onnx-rerank": ["machine", "model", "top15_ms", "top30_ms", "outcome"],
    "desktop-ingest": [
        "machine",
        "model",
        "pages",
        "chunks",
        "total_s",
        "embeddings_per_second",
        "outcome",
    ],
    "desktop-retrieval": [
        "machine",
        "embedder",
        "reranker",
        "topk",
        "multiplier",
        "p50_ms",
        "p95_ms",
        "max_ms",
        "outcome",
    ],
}

# surface -> keys a recorded PASS row must carry. Fail rows carry the crash,
# not measurements (crash-as-data, RESULTS.md provenance rule 3): only
# ALWAYS_REQUIRED provenance keys are required of them.
REQUIRED_KEYS = {
    "native": (
        "surface",
        "model",
        "quant",
        "threads",
        "prompt_tokens",
        "decode_tokens_per_second",
        "machine",
        "outcome",
        # Issue #223 AC5: the decode budget is part of the native identity and
        # every in-repo producer records it (llama_bench_driver.py already
        # did; node_bench_driver.mjs gained it with this issue), so a native
        # PASS row without it fails closed instead of colliding as "-".
        "max_tokens",
    ),
    "native-vulkan": ("surface", "model", "bin", "machine", "outcome"),
    "wllama": (
        "surface",
        "model",
        "mode",
        "threads",
        "prompt_tokens",
        "decode_tokens_per_second",
        "first_token_ms",
        "machine",
        "outcome",
        "max_tokens",
    ),
    "onnx-embed": (
        "surface",
        "model",
        "encode_ms",
        "embeddings_per_second",
        "machine",
        "outcome",
    ),
    "onnx-rerank": ("surface", "model", "top15_ms", "top30_ms", "machine", "outcome"),
    "desktop-ingest": (
        "surface",
        "machine",
        "model",
        "pages",
        "chunks",
        "total_s",
        "outcome",
    ),
    "desktop-retrieval": (
        "surface",
        "machine",
        "embedder",
        "reranker",
        "topk",
        "multiplier",
        "p50_ms",
        "p95_ms",
        "outcome",
    ),
}

# Provenance keys every row (pass or fail) must carry.
ALWAYS_REQUIRED = ("surface", "machine", "outcome")

# surface -> indices of the rendered cells that form the row's identity (the
# columns two runs must agree on to count as the same measurement). Measured
# value columns are excluded: re-measuring the same cell must append-or-fail,
# not silently overwrite.
IDENTITY_CELLS = {
    "native": (0, 1, 2, 3, 4, 8),  # machine, model, quant, threads, prompt, engine
    "native-vulkan": (0, 1, 2),  # machine, model, bin
    "wllama": (0, 1, 2, 3, 4, 8),
    # machine, model, mode, threads, prompt_tokens, max_tokens — prompt
    # length AND decode budget are both real inputs on the wllama surface
    "onnx-embed": (0, 1),  # machine, model
    "onnx-rerank": (0, 1),  # machine, model
    "desktop-ingest": (0, 1),  # machine, model (mirrors onnx-embed)
    "desktop-retrieval": (
        0,
        1,
        2,
        3,
        4,
    ),  # machine, embedder, reranker, topk, multiplier
}

# Issue #223 AC5 (recorded maintainer decision, comment 6280336819): the
# NATIVE surface's identity is ENGINE-AWARE. For the node producer
# (`node-llama-cpp`) `--prompt-tokens` never sizes the measured prompt — the
# prompt is sized from `--max-tokens` — so the label LEAVES the identity and
# the decode budget (`max_tokens`, appended column index 10) enters it: two
# runs of one workload with different labels stop splitting into two cells,
# and two runs with different budgets become distinct. For the legacy
# producers (`llama-cpp-python`, `llama-bench`) the prompt length IS a real
# measurement input (the prompt is sized from `--prompt-tokens` and passed as
# `-p`), so it stays an identity cell alongside the budget. Other surfaces
# keep their static tuples.
NATIVE_NODE_ENGINE = "node-llama-cpp"
NATIVE_IDENTITY_NODE = (
    0,
    1,
    2,
    3,
    8,
    10,
)  # machine, model, quant, threads, engine, max_tokens
NATIVE_IDENTITY_LEGACY = (0, 1, 2, 3, 4, 8, 10)  # + prompt length (a real input there)


def identity_cells_for(surface: str, cells: list) -> tuple:
    """Identity cell indices for a row, engine-aware on the native surface."""
    if surface != "native":
        return IDENTITY_CELLS[surface]
    engine = str(cells[8]) if len(cells) > 8 else ""
    if engine == NATIVE_NODE_ENGINE:
        return NATIVE_IDENTITY_NODE
    return NATIVE_IDENTITY_LEGACY


REGISTRY_HEADING = "## Machine registry"


def fmt(v):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def split_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def row_cells(row: dict) -> list:
    if row.get("surface") == "native-vulkan":
        cells = [
            row.get("machine", ""),
            row.get("model") or "-",
            row.get("bin") or "-",
            fmt(row.get("decode_tokens_per_second")),
            row.get("outcome", ""),
            "yes" if row.get("outcome") == "crash" else "-",
        ]
    elif row.get("surface") == "onnx-embed":
        cells = [
            row.get("machine", ""),
            row.get("model", ""),
            fmt(row.get("encode_ms")),
            fmt(row.get("embeddings_per_second")),
            row.get("outcome", ""),
        ]
    elif row.get("surface") == "onnx-rerank":
        cells = [
            row.get("machine", ""),
            row.get("model", ""),
            fmt(row.get("top15_ms")),
            fmt(row.get("top30_ms")),
            row.get("outcome", ""),
        ]
    if row.get("surface") == "desktop-retrieval":
        cells = [
            row.get("machine", ""),
            row.get("embedder", ""),
            row.get("reranker", ""),
            fmt(row.get("topk")),
            fmt(row.get("multiplier")),
            fmt(row.get("p50_ms")),
            fmt(row.get("p95_ms")),
            fmt(row.get("max_ms")),
            row.get("outcome", ""),
        ]
    elif row.get("surface") == "desktop-ingest":
        cells = [
            row.get("machine", ""),
            row.get("model", ""),
            fmt(row.get("pages")),
            fmt(row.get("chunks")),
            fmt(row.get("total_s")),
            fmt(row.get("embeddings_per_second")),
            row.get("outcome", ""),
        ]
    elif row.get("surface") == "wllama":
        cells = [
            row.get("machine", ""),
            row.get("model", ""),
            row.get("mode", ""),
            fmt(row.get("threads")),
            fmt(row.get("prompt_tokens")),
            fmt(row.get("decode_tokens_per_second")),
            fmt(row.get("first_token_ms")),
            row.get("outcome", ""),
            fmt(row.get("max_tokens")),
        ]
    else:  # native
        cells = [
            row.get("machine", ""),
            row.get("model", ""),
            row.get("quant", ""),
            fmt(row.get("threads")),
            fmt(row.get("prompt_tokens")),
            fmt(row.get("decode_tokens_per_second")),
            fmt(row.get("first_token_ms")),
            fmt(row.get("peak_rss_mb")),
            row.get("engine", row.get("outcome", "")),
            row.get("outcome", ""),
            fmt(row.get("max_tokens")),
        ]
    return cells


def row_to_markdown(row: dict) -> str:
    return "| " + " | ".join(str(c) for c in row_cells(row)) + " |"


def validate_row(row: dict) -> None:
    surface = str(row.get("surface", ""))
    if surface not in SECTION_HEADINGS:
        raise SystemExit(f"unknown surface: {surface!r}")
    required = ALWAYS_REQUIRED
    if str(row.get("outcome", "")).strip().lower() == "pass":
        required = REQUIRED_KEYS[surface]
        # Accepted debt (ledger W-M4): a 1-token generation has no decodable
        # span, so the driver records outcome=pass with a null decode rate.
        if row.get("tokens_generated") == 1:
            required = tuple(k for k in required if k != "decode_tokens_per_second")
    missing = [k for k in required if row.get(k) in (None, "")]
    if missing:
        raise SystemExit(
            f"row for surface {surface!r} missing required keys: {', '.join(missing)}"
        )


def registered_machines(text: str) -> set[str]:
    """Machine tags declared as '### <tag>' under the machine registry."""
    tags = set()
    in_registry = False
    for ln in text.splitlines():
        if ln.startswith("## "):
            in_registry = ln.strip() == REGISTRY_HEADING
            continue
        if in_registry and ln.startswith("### "):
            tags.add(ln[4:].strip())
    return tags


def find_target_table(lines: list[str], heading: str, surface: str):
    """Locate the table under `heading` whose header matches the surface.

    Returns (insert_at, body_row_indexes): the line index a new row inserts
    at (after the table's last body row) and the indexes of existing body
    rows, for identity comparison. Raises SystemExit when no matching table
    exists.
    """
    want = HEADER_CELLS[surface]
    try:
        heading_idx = next(i for i, ln in enumerate(lines) if ln.strip() == heading)
    except StopIteration:
        raise SystemExit(f"section heading missing: {heading}")
    insert_at = None
    body_rows = []
    i = heading_idx + 1
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("## "):
            break
        is_table_start = (
            ln.startswith("|") and i + 1 < len(lines) and lines[i + 1].startswith("|-")
        )
        if is_table_start:
            header = split_row(ln)
            if header == want:
                # First body insert lands AFTER the separator row (i+2), never
                # between header and separator — an empty table used to get its
                # first appended row placed at i+1, corrupting the GFM table
                # (found by the #223 identity tests; the PENDING-placeholder
                # flow masked it because production tables always carry body
                # rows).
                insert_at = i + 2
                body_rows = []
                j = i + 2
                while j < len(lines) and lines[j].startswith("|"):
                    body_rows.append(j)
                    insert_at = j + 1
                    j += 1
                return insert_at, body_rows
        i += 1
    raise SystemExit(f"no table with header {want} found under section: {heading}")


def append_row(row: dict, results_path: Path = RESULTS) -> None:
    validate_row(row)
    surface = str(row.get("surface", ""))
    heading = SECTION_HEADINGS[surface]
    text = results_path.read_text(encoding="utf-8")

    machines = registered_machines(text)
    tag = str(row.get("machine", ""))
    if tag not in machines:
        raise SystemExit(
            f"machine tag {tag!r} is not registered under '{REGISTRY_HEADING}' "
            f"(registered: {', '.join(sorted(machines)) or 'none'})"
        )

    lines = text.splitlines()
    insert_at, body_rows = find_target_table(lines, heading, surface)

    cells = row_cells(row)
    ident_idx = identity_cells_for(surface, cells)
    outcome_idx = HEADER_CELLS[surface].index("outcome")
    identity = [str(cells[i]) for i in ident_idx]
    new_line = row_to_markdown(row)
    for ridx in body_rows:
        existing = split_row(lines[ridx])
        if len(existing) != len(cells) or [existing[i] for i in ident_idx] != identity:
            continue
        if existing[outcome_idx].strip() == "PENDING":
            # A PENDING placeholder occupies this identity slot: filling it in
            # is the runbook flow, not an overwrite of a recorded measurement.
            lines[ridx] = new_line
            results_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            print(
                f"replaced PENDING placeholder in '{heading}': " + " | ".join(identity)
            )
            return
        raise SystemExit(
            "row already recorded (append-or-fail): " + " | ".join(identity)
        )

    lines.insert(insert_at, new_line)
    results_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"appended row into '{heading}': " + " | ".join(identity))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--row-file", type=str)
    src.add_argument("--row-json", type=str)
    parser.add_argument("--results", type=str, default=str(RESULTS))
    args = parser.parse_args(argv)

    if args.row_file:
        row = json.loads(Path(args.row_file).read_text(encoding="utf-8"))
    else:
        row = json.loads(args.row_json)
    if isinstance(row, list):
        for r in row:
            append_row(r, Path(args.results))
    else:
        append_row(row, Path(args.results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
