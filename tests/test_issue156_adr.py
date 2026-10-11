"""Arm's-length acceptance check for issue #156 (row C15) — ADR-0002 amendment.

Frozen-bytes check spec authored from the issue contract (02-reproduction.md
`## Acceptance checks` row C15 and 01-issue-summary.md AC6). The implementer
codes the fix AGAINST these assertions and never edits this file.

Pinned surface (AC6):
  - ADR-0002's Decision PROSE binds both new ids (lfm2.5-2.6b quality,
    lfm2-1.2b-rag fast), as do its decision rows.
  - The license-review outcome records LFM Open License v1.0 for BOTH tiers.
  - The fast tier records 5 chunks with the D1 deviation noted adjacent
    (the issue asked for 3 chunks; its own precondition — measured recall@3
    vs recall@5 — could not be satisfied, so 5 chunks is the recorded
    deviation, not a silent deferral).
  - The Gemma-terms citation literals the historical test suite asserts on
    are RETAINED (the ADR is amended, not deleted: ai.google.dev/gemma/terms,
    'For Gemma 4 terms', ai.google.dev/gemma/apache_2).

Plain pytest only: pathlib reads relative to this file, no network, no
imports of application code.
"""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ADR_0002 = REPO_ROOT / "docs" / "adr" / "0002-llm-profiles.md"

QUALITY_ID = "lfm2.5-2.6b"
FAST_ID = "lfm2-1.2b-rag"
LICENSE_NAME = "LFM Open License v1.0"

GEMMA_TERMS_CITATIONS = [
    "ai.google.dev/gemma/terms",
    "For Gemma 4 terms",
    "ai.google.dev/gemma/apache_2",
]

# The 'D1' deviation note must sit adjacent to the 5-chunks statement, not
# pages away from it.
ADJACENCY_WINDOW_CHARS = 600


def _read(path: Path) -> str:
    assert path.is_file(), f"required surface missing: {path.relative_to(REPO_ROOT)}"
    return path.read_text(encoding="utf-8")


def _md_section(text: str, heading_pattern: str, what: str) -> str:
    heading = re.search(heading_pattern, text, re.MULTILINE)
    assert (
        heading is not None
    ), f"ADR-0002 heading not found for {what}: {heading_pattern!r}"
    rest = text[heading.end() :]
    nxt = re.search(r"^## ", rest, re.MULTILINE)
    return rest[: nxt.start()] if nxt else rest


def test_decision_prose_binds_both_new_ids():
    """AC6: the Decision prose names the new tiers (C15 first leg).

    The first failing assertion at the pre-fix tree carries the
    ISSUE156-SWAP-NOT-LANDED sentinel so the base failure line is stable.
    """
    decision = _md_section(_read(ADR_0002), r"^## Decision[ \t]*$", "Decision prose")
    assert (
        QUALITY_ID in decision
    ), "ISSUE156-SWAP-NOT-LANDED: ADR-0002 Decision prose does not bind the new quality id lfm2.5-2.6b"
    assert (
        FAST_ID in decision
    ), f"ADR-0002 Decision prose does not bind the new fast id {FAST_ID}"


def test_decision_table_rows_name_new_ids():
    table = _md_section(_read(ADR_0002), r"^## Decision table[ \t]*$", "Decision table")
    assert (
        QUALITY_ID in table
    ), f"ADR-0002 Decision table rows do not name the quality id {QUALITY_ID}"
    assert (
        FAST_ID in table
    ), f"ADR-0002 Decision table rows do not name the fast id {FAST_ID}"


def test_license_review_outcome_covers_both_tiers():
    outcome = _md_section(
        _read(ADR_0002), r"^## License review outcome[^\n]*$", "License review outcome"
    )
    assert (
        QUALITY_ID in outcome
    ), f"ADR-0002 license-review outcome does not record the quality tier ({QUALITY_ID})"
    assert (
        FAST_ID in outcome
    ), f"ADR-0002 license-review outcome does not record the fast tier ({FAST_ID})"
    assert (
        LICENSE_NAME in outcome
    ), f"ADR-0002 license-review outcome does not record {LICENSE_NAME}"


def test_fast_tier_keeps_five_chunks_with_d1_deviation_noted():
    adr = _read(ADR_0002)
    five_chunk_matches = list(re.finditer(r"(?i)\b5[\s-]+chunks?\b", adr))
    assert (
        five_chunk_matches
    ), "ADR-0002 does not record the fast tier's chunk count (5 chunks)"
    adjacent = any(
        "D1"
        in adr[
            max(0, m.start() - ADJACENCY_WINDOW_CHARS) : m.end()
            + ADJACENCY_WINDOW_CHARS
        ]
        for m in five_chunk_matches
    )
    assert adjacent, (
        "ADR-0002 records 5 chunks for the fast tier but does not note the D1 "
        "deviation adjacent to it (the issue asked for 3 chunks; the unmet "
        "recall precondition must be recorded, not silently deferred)"
    )


def test_gemma_terms_citation_literals_retained():
    adr = _read(ADR_0002)
    for literal in GEMMA_TERMS_CITATIONS:
        assert literal in adr, (
            f"ADR-0002 dropped the Gemma-terms citation literal {literal!r}; "
            "the ADR is amended, not deleted — historical citation anchors stay"
        )
