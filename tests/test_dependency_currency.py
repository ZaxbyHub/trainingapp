"""Electron currency floor (issue #276 AC2).

The desktop shell ships the Electron runtime it is developed against (a
development dependency that electron-builder packages into the installer).
Electron below 44.9.1 carries GHSA-jr5w-w6x2-84p9 (HIGH, eMudhra certificate
mitigation) plus the 44.x permission-attribution and SameSite advisories, and
because it is a devDependency a deterministic floor keeps it visible regardless
of audit flags. This guard parses the desktop lockfile and compares the
resolved version with ``packaging.version``.
"""

from __future__ import annotations

import json
from pathlib import Path

from packaging.version import Version

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_LOCK = REPO_ROOT / "desktop" / "package-lock.json"
ELECTRON_FLOOR = Version("44.9.1")


def _locked_electron() -> str:
    lock = json.loads(DESKTOP_LOCK.read_text(encoding="utf-8"))
    row = lock.get("packages", {}).get("node_modules/electron")
    assert row is not None, "desktop/package-lock.json does not resolve electron"
    version = row.get("version")
    assert version, "desktop/package-lock.json node_modules/electron has no version"
    return version


def test_desktop_electron_at_or_past_floor():
    resolved = Version(_locked_electron())
    assert resolved >= ELECTRON_FLOOR, (
        f"desktop resolves electron {resolved}, below the {ELECTRON_FLOOR} floor "
        "(GHSA-jr5w-w6x2-84p9 and the 44.x permission advisories)"
    )


def test_desktop_electron_spec_carries_floor():
    manifest = json.loads(
        (REPO_ROOT / "desktop" / "package.json").read_text(encoding="utf-8")
    )
    spec = manifest.get("devDependencies", {}).get("electron", "")
    floor = spec.lstrip("^~>=")
    assert floor, "desktop/package.json declares no electron devDependency"
    assert (
        Version(floor) >= ELECTRON_FLOOR
    ), f"desktop/package.json electron spec {spec!r} admits versions below {ELECTRON_FLOOR}"
