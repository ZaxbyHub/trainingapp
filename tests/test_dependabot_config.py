"""Frozen-check C10 (issue #277 AC2): .github/dependabot.yml carries the five
(ecosystem, directory) pairs — npm for each of the three shipped packages,
pip at the root, github-actions at the root — each with a schedule.
"""
from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG = REPO_ROOT / ".github" / "dependabot.yml"

EXPECTED_PAIRS = {
    ("npm", "/web_ui"),
    ("npm", "/desktop"),
    ("npm", "/packtool"),
    ("pip", "/"),
    ("github-actions", "/"),
}


def _entries() -> list[dict]:
    data = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    assert data.get("version") == 2, "dependabot config must be version 2"
    entries = data.get("updates")
    assert isinstance(entries, list) and entries, "dependabot config has no updates"
    return entries


def test_five_ecosystem_directory_pairs():
    got = {(e.get("package-ecosystem"), e.get("directory")) for e in _entries()}
    assert got == EXPECTED_PAIRS, f"dependabot pairs mismatch: {got ^ EXPECTED_PAIRS}"


def test_every_entry_has_a_schedule():
    for entry in _entries():
        schedule = entry.get("schedule")
        ecosystem = entry.get("package-ecosystem")
        directory = entry.get("directory")
        assert isinstance(schedule, dict) and schedule.get(
            "interval"
        ), f"dependabot entry {ecosystem}@{directory} has no schedule"
