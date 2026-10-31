"""Issue #86 (E3) — the `offline-matrix` capture surface registration.

Pins, against the real `bench/append_results.py` module and throwaway
RESULTS.md files (never the real registry):

- the surface is registered end to end: section heading, header cells,
  PASS-row required keys, and the IDENTITY_CELLS tuple (machine +
  scenario_id — one recorded row per scenario per machine);
- `row_cells` renders the capture-row schema in header order;
- an unknown surface still fails closed;
- a PASS row missing `measured` (the scenario verdict's evidence) fails
  closed;
- the machine-registry rule applies (an unregistered tag is refused);
- the identity-cell duplicate refusal: the same machine + scenario_id
  appends once and refuses the second append;
- a different scenario_id is a distinct measurement and appends;
- the runbook PENDING-placeholder fill: a seeded PENDING row fills in place
  with the operator's measured row, and the filled row then refuses
  duplicates like any recorded measurement;
- the REAL bench/RESULTS.md table matches the registered schema and carries
  the ten reference-i5 PENDING rows (S1..S10, the matrix's blocked marker).

Same discipline as tests/test_bench_identity_cells.py: direct import of the
real module, throwaway RESULTS.md skeletons only.
"""

import importlib
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

append_results = importlib.import_module("bench.append_results")

SURFACE = "offline-matrix"
HEADING = append_results.SECTION_HEADINGS[SURFACE]
HEADER = append_results.HEADER_CELLS[SURFACE]

_RESULTS_HEADER = "| " + " | ".join(HEADER) + " |"
_RESULTS_SEPARATOR = "|" + "---|" * len(HEADER)

RESULTS_SKELETON = (
    "# Benchmarks\n"
    "\n"
    "## Machine registry\n"
    "\n"
    "### celltest\n"
    "offline-matrix surface test host (issue #86)\n"
    "\n" + HEADING + "\n"
    "\nSome prose intro that must not matter.\n"
    "\n" + _RESULTS_HEADER + "\n" + _RESULTS_SEPARATOR + "\n"
)


def make_row(scenario_id="S3", outcome="pass", **overrides):
    row = {
        "surface": SURFACE,
        "machine": "celltest",
        "scenario_id": scenario_id,
        "scenario": "16 GB, <6 GB free",
        "outcome": outcome,
        "tuple_ref": "{{TUPLE}}",
        "automated_legs": "ram-filler:attained",
        "blocked_marker": "BLOCKED: reference laptop",
        "measured": "Fast auto-selected; 9.4 tok/s; no OOM",
        "notes": "unit row",
    }
    row.update(overrides)
    return row


def make_results(tmp_path):
    results = tmp_path / "RESULTS.md"
    results.write_text(RESULTS_SKELETON, encoding="utf-8", newline="\n")
    return results


def body_rows(results, machine="celltest"):
    text = results.read_text(encoding="utf-8")
    section = text.split(HEADING, 1)[1]
    return [ln for ln in section.splitlines() if ln.startswith(f"| {machine} ")]


def expect_exit(raised, needle):
    assert raised is not None and needle in str(raised), raised


def test_surface_registration_is_complete():
    # The section heading, header cells, required keys and identity tuple the
    # harness captures and RESULTS.md seed must agree on.
    assert HEADING == "## Offline validation matrix (E3/#86)"
    assert HEADER == [
        "machine",
        "scenario_id",
        "scenario",
        "outcome",
        "tuple_ref",
        "automated_legs",
        "blocked_marker",
        "measured",
        "notes",
    ]
    assert append_results.REQUIRED_KEYS[SURFACE] == (
        "surface",
        "machine",
        "scenario_id",
        "scenario",
        "outcome",
        "tuple_ref",
        "automated_legs",
        "blocked_marker",
        "measured",
        "notes",
    )
    assert append_results.identity_cells_for(SURFACE, HEADER) == (0, 1)
    cells = append_results.row_cells(make_row())
    assert cells == [
        "celltest",
        "S3",
        "16 GB, <6 GB free",
        "pass",
        "{{TUPLE}}",
        "ram-filler:attained",
        "BLOCKED: reference laptop",
        "Fast auto-selected; 9.4 tok/s; no OOM",
        "unit row",
    ]
    assert len(cells) == len(HEADER)  # GFM cell-count rule


def test_unknown_surface_refused(tmp_path):
    results = make_results(tmp_path)
    raised = None
    try:
        append_results.append_row(make_row(surface="offline-matrix-x"), results)
    except SystemExit as exc:
        raised = str(exc)
    expect_exit(raised, "unknown surface")


def test_pass_row_without_measured_refused(tmp_path):
    results = make_results(tmp_path)
    row = make_row()
    del row["measured"]
    raised = None
    try:
        append_results.append_row(row, results)
    except SystemExit as exc:
        raised = str(exc)
    expect_exit(raised, "missing required keys: measured")
    assert body_rows(results) == []


def test_machine_registry_rule_applies(tmp_path):
    results = make_results(tmp_path)
    raised = None
    try:
        append_results.append_row(make_row(machine="not-a-registered-tag"), results)
    except SystemExit as exc:
        raised = str(exc)
    expect_exit(raised, "is not registered")
    assert body_rows(results) == []


def test_identity_duplicate_refusal_and_distinct_scenarios(tmp_path):
    results = make_results(tmp_path)
    append_results.append_row(make_row(scenario_id="S3"), results)
    raised = None
    try:
        append_results.append_row(
            make_row(scenario_id="S3", measured="re-measured"), results
        )
    except SystemExit as exc:
        raised = str(exc)
    expect_exit(raised, "row already recorded")
    expect_exit(raised, "celltest | S3")
    # A different scenario_id is a different measurement and appends.
    append_results.append_row(make_row(scenario_id="S9"), results)
    rows = body_rows(results)
    assert len(rows) == 2
    assert rows[0].split("|")[2].strip() == "S3"
    assert rows[1].split("|")[2].strip() == "S9"


def test_pending_placeholder_fills_in_place_then_refuses(tmp_path):
    pending_line = (
        "| celltest | S3 | 16 GB, <6 GB free | PENDING | {{TUPLE}} "
        "| ram-filler | BLOCKED: reference laptop | PENDING | seeded |\n"
    )
    results = make_results(tmp_path)
    results.write_text(
        results.read_text(encoding="utf-8") + pending_line, encoding="utf-8"
    )
    append_results.append_row(make_row(scenario_id="S3"), results)
    rows = body_rows(results)
    assert len(rows) == 1, f"expected in-place fill, got {len(rows)} rows"
    assert "PENDING" not in rows[0]
    assert "9.4 tok/s" in rows[0]
    # The filled row is a recorded measurement: the placeholder exception does
    # not become a duplicate hole.
    raised = None
    try:
        append_results.append_row(make_row(scenario_id="S3", measured="again"), results)
    except SystemExit as exc:
        raised = str(exc)
    expect_exit(raised, "row already recorded")


def test_real_results_offline_matrix_section_matches_schema():
    # The REAL bench/RESULTS.md table carries the registered header, a
    # well-formed separator, and the ten seeded reference-i5 PENDING rows.
    real = (REPO_ROOT / "bench" / "RESULTS.md").read_text(encoding="utf-8")
    # Anchor on the heading LINE: the runbook pointer paragraph names the same
    # heading inline earlier in the file, and must not be mistaken for it.
    assert f"\n{HEADING}\n" in real, "the offline-matrix section heading is missing"
    section = real.split(f"\n{HEADING}\n", 1)[1].split("\n## ", 1)[0]
    lines = section.splitlines()
    header_idx = next(i for i, ln in enumerate(lines) if ln.startswith("| machine"))
    header = [c.strip() for c in lines[header_idx].strip().strip("|").split("|")]
    separator = [c.strip() for c in lines[header_idx + 1].strip().strip("|").split("|")]
    assert header == HEADER, f"header {header} != schema {HEADER}"
    assert len(separator) == len(header)
    assert all(set(cell) <= {"-"} for cell in separator)
    body = [ln for ln in lines[header_idx + 2 :] if ln.startswith("| reference-i5 ")]
    assert len(body) == 10, f"expected 10 reference-i5 PENDING rows, found {len(body)}"
    for row in body:
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        assert len(cells) == len(HEADER)
        assert cells[0] == "reference-i5"
        assert cells[3] == "PENDING"  # outcome cell stays PENDING until the run
        assert "{{TUPLE}}" in cells[4]
        assert cells[6] == "BLOCKED: reference laptop"
    ids = sorted(c.strip().strip("|").split("|")[1].strip() for c in body)
    assert ids == ["S1", "S10", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]
