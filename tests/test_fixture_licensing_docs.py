"""Fixture licensing docs: the three licensing surfaces carry the identical
truth block (issue #282 F-AC2).

tests/test_fixture_licensing_docs.py — stdlib only (runs in the security job's
Audit guards step). Enforces: an identical `<!-- fixture-licensing:v1 -->` block
in docs/licenses.md, docs/training-player.md and the fixture contract; no
"git-excluded" description of the committed course; the pending-statement
fields stay disclosed (a future edit must not silently claim the pending
statements as given); and the tree-verified component facts stay named.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
DOCS = (
    "docs/licenses.md",
    "docs/training-player.md",
    "desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md",
)
START = "<!-- fixture-licensing:v1 -->"
END = "<!-- /fixture-licensing -->"

PENDING_MARKERS = (
    "pending maintainer statement",
    "issue #282 AC1",
)
VERIFIED_FACTS = (
    "GreenSock",
    "Underscore",
    "lodash",
    "regenerator",
    "Open Sans",
    "Not Licensed",
    "LICENSE-MANIFEST.json",
)


def _blocks() -> dict[str, str]:
    blocks = {}
    for rel in DOCS:
        text = (REPO_ROOT / rel).read_text(encoding="utf-8")
        i = text.find(START)
        j = text.find(END)
        assert (
            i >= 0 and j > i
        ), f"{rel}: fixture-licensing marker block missing or malformed"
        blocks[rel] = text[i : j + len(END)]
    return blocks


def test_marker_block_is_identical_in_all_three_docs():
    blocks = _blocks()
    distinct = set(blocks.values())
    assert len(distinct) == 1, (
        "the fixture-licensing marker block must be byte-identical in all three docs; "
        f"drift across: {list(blocks)}"
    )


def test_licenses_md_no_longer_says_the_course_is_git_excluded():
    text = (REPO_ROOT / "docs/licenses.md").read_text(encoding="utf-8")
    block = _blocks()["docs/licenses.md"]
    outside = text.replace(block, "")
    # The committed course paragraph must not claim the tracked 360 files are
    # git-excluded (issue #282 claim 1). The remaining occurrence (if any) may
    # only refer to non-course operator-side source material.
    for m in re.finditer(r"git-excluded", outside):
        context = outside[max(0, m.start() - 300) : m.start()]
        assert "opmed-cdp-mlc" not in context, (
            "docs/licenses.md still describes the committed course as git-excluded near: "
            + outside[m.start() - 100 : m.start() + 100]
        )


@pytest.mark.parametrize("marker", PENDING_MARKERS)
def test_pending_statement_fields_stay_disclosed(marker):
    block = next(iter(_blocks().values()))
    assert marker in block, (
        f"the fixture-licensing block must keep the pending-statement disclosure {marker!r} "
        "until AC1's statements (or a decline) are recorded on issue #282"
    )


@pytest.mark.parametrize("fact", VERIFIED_FACTS)
def test_tree_verified_component_facts_stay_named(fact):
    block = next(iter(_blocks().values()))
    assert fact in block, f"the fixture-licensing block must keep naming {fact!r}"
