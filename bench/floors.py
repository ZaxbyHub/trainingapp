"""Machine-tagged performance floors parsed from bench/RESULTS.md.

The converted perf suites (tests/test_rag_performance.py,
tests/test_low_end_hardware.py) read their thresholds from the fenced
``bench-floors`` JSON block in bench/RESULTS.md so that every enforced number
traces to a recorded measurement (or a documented derivation from one).

Floors rows carry a machine tag; tests select rows for the current machine via
the BENCH_FLOORS_MACHINE environment variable (the reference laptop sets
BENCH_FLOORS_MACHINE=reference-i5). A machine with no recorded floors simply
falls back to the suites' legacy generous bounds - it is never skipped for
floors, and no floor is ever invented here.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_PATH = REPO_ROOT / "bench" / "RESULTS.md"
FENCES_RE = re.compile(r"```bench-floors\s*(\{.*?\})\s*```", re.DOTALL)


def current_machine_tag() -> str:
    return (os.environ.get("BENCH_FLOORS_MACHINE", "") or "").strip()


def parse_floors(results_path: Path | str = RESULTS_PATH) -> list:
    """Return the floors rows list from every bench-floors fence (merged)."""
    path = Path(results_path)
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    rows: list = []
    for match in FENCES_RE.finditer(text):
        try:
            data = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        found = data.get("floors", data if isinstance(data, list) else [])
        if isinstance(found, list):
            rows.extend(r for r in found if isinstance(r, dict))
    return rows


def get_floors(
    results_path: Path | str = RESULTS_PATH, machine_tag: str | None = None
) -> dict:
    """Floors rows for one machine, keyed (surface, model, metric)."""
    tag = machine_tag if machine_tag is not None else current_machine_tag()
    if not tag:
        return {}
    out: dict = {}
    for row in parse_floors(results_path):
        if str(row.get("machine", "")).strip() == tag:
            key = (
                str(row.get("surface", "")),
                str(row.get("model", "")),
                str(row.get("metric", "")),
            )
            out[key] = row
    return out


def threshold(
    results_path: Path | str,
    surface: str,
    model: str,
    metric: str,
    machine_tag: str | None = None,
):
    """Return (value, direction) for one floor row, or None when absent.

    direction is "floor" (metric must be >= value) or "ceiling"
    (metric must be <= value).
    """
    row = get_floors(results_path, machine_tag).get((surface, model, metric))
    if not row:
        return None
    try:
        value = float(row["value"])
    except (KeyError, TypeError, ValueError):
        return None
    direction = str(row.get("direction", "floor"))
    if direction not in ("floor", "ceiling"):
        return None
    return value, direction
