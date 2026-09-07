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
}

# surface -> header cells of the table that accepts the surface's rows. The
# ONNX section hosts two tables (embed, rerank); matching on header cells is
# what routes rows to the right one.
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
    ],
    "onnx-embed": ["machine", "model", "encode_ms", "embeddings_per_second", "outcome"],
    "onnx-rerank": ["machine", "model", "top15_ms", "top30_ms", "outcome"],
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
    "wllama": (0, 1, 2, 3, 4),  # machine, model, mode, threads, prompt_tokens
    "onnx-embed": (0, 1),  # machine, model
    "onnx-rerank": (0, 1),  # machine, model
}

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
                insert_at = i + 1
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

    ident_idx = IDENTITY_CELLS[surface]
    outcome_idx = HEADER_CELLS[surface].index("outcome")
    cells = row_cells(row)
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
