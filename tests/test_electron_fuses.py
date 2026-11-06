"""Electron fuse declarations (issue #276 AC5).

electron-builder flips Electron fuses at package time from the top-level
``electronFuses`` block of ``desktop/electron-builder.yml``. The shell must
ship with the Node-exposure fuses off: ``runAsNode`` (ELECTRON_RUN_AS_NODE),
``enableNodeCliInspectArguments`` (--inspect and friends) and
``enableNodeOptionsEnvironmentVariable`` (NODE_OPTIONS). This guard loads the
YAML and asserts each key is present and literally ``false``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILDER_CONFIG = REPO_ROOT / "desktop" / "electron-builder.yml"
REQUIRED_OFF = (
    "runAsNode",
    "enableNodeCliInspectArguments",
    "enableNodeOptionsEnvironmentVariable",
)


def _fuses() -> dict:
    config = yaml.safe_load(BUILDER_CONFIG.read_text(encoding="utf-8"))
    assert isinstance(config, dict), "desktop/electron-builder.yml is not a mapping"
    fuses = config.get("electronFuses")
    assert isinstance(
        fuses, dict
    ), "desktop/electron-builder.yml declares no top-level electronFuses mapping"
    return fuses


@pytest.mark.parametrize("fuse", REQUIRED_OFF)
def test_fuse_declared_off(fuse):
    fuses = _fuses()
    assert fuse in fuses, f"electronFuses does not declare {fuse}"
    # `is False`: a missing value, a string "false" or 0 must not pass.
    assert (
        fuses[fuse] is False
    ), f"electronFuses.{fuse} is {fuses[fuse]!r}, expected false"
