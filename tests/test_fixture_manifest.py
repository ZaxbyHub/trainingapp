"""Fixture licensing manifest: per-file classification is complete and current (issue #282 F-AC3).

tests/test_fixture_manifest.py — stdlib only (runs in the security job's Audit
guards step). Enforces: two-way set equality between the tracked fixture files
and LICENSE-MANIFEST.json entries, license presence on every entry, the exact
class vocabulary, no duplicate paths, and a rights statement on every entry.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_REL = "desktop/e2e/fixtures/storyline-nav"
MANIFEST_REL = f"{FIXTURE_REL}/LICENSE-MANIFEST.json"
CLASS_VOCABULARY_PREFIXES = ("maintainer-content", "articulate-runtime", "generated")
THIRD_PARTY_PREFIX = "third-party:"


def _tracked_fixture_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", FIXTURE_REL],
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
        text=True,
    )
    return sorted(line for line in out.stdout.splitlines() if line)


def _manifest() -> dict:
    return json.loads((REPO_ROOT / MANIFEST_REL).read_text(encoding="utf-8"))


def test_every_tracked_fixture_file_is_classified_two_way():
    manifest = _manifest()
    classified = sorted(entry["path"] for entry in manifest["files"])
    tracked = _tracked_fixture_files()
    unclassified = sorted(set(tracked) - set(classified))
    phantom = sorted(set(classified) - set(tracked))
    assert (
        unclassified == []
    ), f"tracked fixture files missing from LICENSE-MANIFEST.json: {unclassified}"
    assert (
        phantom == []
    ), f"LICENSE-MANIFEST.json entries with no tracked file: {phantom}"


def test_manifest_entries_carry_license_rights_and_known_classes():
    manifest = _manifest()
    entries = manifest["files"]
    paths = [e["path"] for e in entries]
    assert len(paths) == len(
        set(paths)
    ), "duplicate manifest paths would double-count a file"
    for entry in entries:
        cls = entry["class"]
        ok_class = cls in CLASS_VOCABULARY_PREFIXES or cls.startswith(
            THIRD_PARTY_PREFIX
        )
        assert ok_class, f"{entry['path']}: unknown class {cls!r}"
        assert entry.get("license"), f"{entry['path']}: missing license"
        assert entry.get("rights"), f"{entry['path']}: missing rights statement"
    # Self-classification (the manifest is itself a tracked fixture file).
    self_entries = [e for e in entries if e["path"] == MANIFEST_REL]
    assert (
        len(self_entries) == 1 and self_entries[0]["class"] == "generated"
    ), "LICENSE-MANIFEST.json must classify itself as generated"


def test_third_party_entries_name_a_license_and_components():
    manifest = _manifest()
    for entry in manifest["files"]:
        if entry["class"].startswith(THIRD_PARTY_PREFIX):
            assert (
                entry["class"] != THIRD_PARTY_PREFIX
            ), "third-party class must name the party"
            assert (
                "license" in entry and entry["license"]
            ), f"{entry['path']}: third-party entry needs a license"
            assert entry.get(
                "components"
            ), f"{entry['path']}: third-party entry should list its components"


def test_articulate_runtime_entries_disclose_the_not_licensed_header():
    manifest = _manifest()
    scripts = [
        e
        for e in manifest["files"]
        if e["path"].startswith(f"{FIXTURE_REL}/html5/lib/scripts/")
    ]
    assert scripts, "the four runtime scripts must be classified"
    for entry in scripts:
        assert "Not Licensed" in entry["rights"], (
            f"{entry['path']}: the Articulate Not-Licensed header"
            + " must stay disclosed in the rights statement"
        )


@pytest.mark.parametrize(
    "rel",
    [
        "desktop/e2e/fixtures/storyline-nav/html5/lib/scripts/bootstrapper.min.js",
        "desktop/e2e/fixtures/storyline-nav/html5/lib/stylesheets"
        "/mobile-fonts/open-sans-regular.woff",
        "desktop/e2e/fixtures/storyline-nav/story_content/trainingapp-bridge.js",
        "desktop/e2e/fixtures/storyline-nav/mobile",
    ],
)
def test_known_anchor_classifications_hold(rel):
    manifest = _manifest()
    by_path = {e["path"]: e for e in manifest["files"]}
    if rel.endswith("/mobile"):
        classes = {e["class"] for p, e in by_path.items() if p.startswith(rel + "/")}
        assert classes == {
            "maintainer-content"
        }, f"mobile/* must all be maintainer-content, got {classes}"
        return
    entry = by_path.get(rel)
    assert entry is not None, f"{rel} missing from manifest"
    if rel.endswith("bootstrapper.min.js"):
        assert entry["class"] == "articulate-runtime"
        assert any("GreenSock" in c for c in entry.get("components", []))
        assert any("lodash" in c for c in entry.get("components", []))
        assert any("Underscore" in c for c in entry.get("components", []))
    if rel.endswith("open-sans-regular.woff"):
        assert entry["class"] == "third-party:Open Sans"
        assert "Apache" in entry["license"]
    if rel.endswith("trainingapp-bridge.js"):
        assert entry["class"] == "generated"
