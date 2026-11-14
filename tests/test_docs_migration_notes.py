"""Guard for the store migration notes (issue #325 AC1).

docs/updates.md's app-binary rollback runbook points at a migration-notes home
under docs/. That pointer was dead until the v4->v5 store migration (schema v5,
PR #323) made it live-relevant: a prior release cannot read a v5 store, so a
user following the runbook needs the notes to exist and to state the
forward-only fact and the downgrade recipe. The dead-doc scanner's LIVE_ROOTS
do not cover docs/, so this targeted guard keeps the class closed.

The issue's argv runs `python -m pytest tests/test_docs_migration_notes.py -q`.
"""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UPDATES = REPO_ROOT / "docs" / "updates.md"
NOTES = REPO_ROOT / "docs" / "migration-notes.md"

# Facts the notes must state (verified by the AC's 'state the v4->v5
# forward-only fact and the downgrade recipe' clause).


def test_updates_md_docs_pointers_resolve():
    text = UPDATES.read_text(encoding="utf-8")
    # Every backtick-quoted docs/ path referenced in updates.md must exist.
    referenced = set(re.findall(r"`(docs/[\w./-]+)`", text))
    assert (
        referenced
    ), "updates.md references no docs/ paths (pointer removed? keep the guard honest)"
    for rel in referenced:
        assert (REPO_ROOT / rel).exists(), f"updates.md points at missing {rel}"


def test_updates_md_points_at_migration_notes():
    text = UPDATES.read_text(encoding="utf-8")
    assert (
        "docs/migration-notes.md" in text
    ), "updates.md rollback runbook no longer names the migration notes home"


def test_notes_state_forward_only_fact():
    text = NOTES.read_text(encoding="utf-8")
    # The current schema version named as forward-only.
    assert (
        re.search(r"schema (?:version is )?\**5\**", text)
        or "schema version is **5**" in text
    ), "migration notes must name the current schema version"
    assert "forward-only" in text, "migration notes must state the forward-only fact"
    assert (
        "cannot open a v5 store" in text or "cannot read a v5 store" in text
    ), "migration notes must state that a prior release cannot open a v5 store"


def test_notes_state_downgrade_recipe():
    text = NOTES.read_text(encoding="utf-8")
    assert (
        "Downgrade recipe" in text
    ), "migration notes must carry the downgrade recipe section"
    assert (
        "reinstall" in text.lower()
    ), "recipe must say to reinstall the prior installer"
    assert (
        "pre-upgrade store" in text
    ), "recipe must say to restore the pre-upgrade store"
    # The no-backup consequence must be stated (fail-closed, no silent loss).
    assert (
        "no pre-upgrade backup exists" in text
    ), "recipe must state the no-backup consequence"
