"""Extractor twin-version guard (issue #276 AC3).

The document extractors run in three places: packtool (pack build), the
desktop main process (runtime upload) and web_ui (browser upload). ADR-0004
chunk ids derive from the extracted text, so the same file must extract
identically everywhere, which requires every package to resolve each
extractor library to ONE identical version. This guard parses the three
lockfiles and asserts equality per library.

Stdlib only (runs in the security job's Audit guards step).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ("web_ui", "desktop", "packtool")
EXTRACTORS = ("mammoth", "pdfjs-dist")


def _locked_version(pkg: str, lib: str) -> str:
    lock = json.loads(
        (REPO_ROOT / pkg / "package-lock.json").read_text(encoding="utf-8")
    )
    row = lock.get("packages", {}).get(f"node_modules/{lib}")
    assert row is not None, f"{pkg}/package-lock.json does not resolve {lib}"
    version = row.get("version")
    assert version, f"{pkg}/package-lock.json node_modules/{lib} has no version"
    return version


@pytest.mark.parametrize("lib", EXTRACTORS)
def test_extractor_resolves_to_one_version(lib):
    versions = {pkg: _locked_version(pkg, lib) for pkg in PACKAGES}
    assert len(set(versions.values())) == 1, (
        f"{lib} drifts across packages: {versions}; align the package.json specs "
        "and refresh the lockfiles so every package resolves the same version"
    )
