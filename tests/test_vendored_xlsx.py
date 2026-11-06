"""Vendored SheetJS tarball parity guard (issue #276 AC1).

`xlsx` resolves, in web_ui, desktop and packtool, to the committed
``vendor/sheetjs/xlsx-0.20.3.tgz``. ``package.json`` cannot carry an integrity
hash and ``npm ci`` with a warm cache installs the previously locked bytes
without re-reading the tarball on disk, so a tarball swap without a lockfile
refresh would go unnoticed. This guard closes that gap: it hashes the tarball
and asserts every lockfile's ``node_modules/xlsx`` row records version 0.20.3,
a ``resolved`` pointing at the vendor path, and an ``integrity`` equal to
``sha512-<base64 of the tarball hash>``; it also pins the ``file:`` spec in each
manifest and the ``binary`` attribute in ``.gitattributes``.

Stdlib only (runs in the security job's Audit guards step).
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR_REL = "vendor/sheetjs/xlsx-0.20.3.tgz"
TARBALL = REPO_ROOT / VENDOR_REL
EXPECTED_VERSION = "0.20.3"
EXPECTED_SPEC = "file:../" + VENDOR_REL
PACKAGES = ("web_ui", "desktop", "packtool")


def _sri_sha512(path: Path) -> str:
    digest = hashlib.sha512(path.read_bytes()).digest()
    return "sha512-" + base64.b64encode(digest).decode("ascii")


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _xlsx_lock_row(pkg: str) -> dict:
    lock = _load_json(REPO_ROOT / pkg / "package-lock.json")
    row = lock.get("packages", {}).get("node_modules/xlsx")
    assert row is not None, f"{pkg}/package-lock.json has no node_modules/xlsx entry"
    return row


def test_tarball_is_committed():
    assert TARBALL.is_file(), f"{VENDOR_REL} is missing"
    assert TARBALL.stat().st_size > 0, f"{VENDOR_REL} is empty"


@pytest.mark.parametrize("pkg", PACKAGES)
def test_lockfile_xlsx_version(pkg):
    assert _xlsx_lock_row(pkg).get("version") == EXPECTED_VERSION


@pytest.mark.parametrize("pkg", PACKAGES)
def test_lockfile_xlsx_resolves_to_vendor_path(pkg):
    resolved = _xlsx_lock_row(pkg).get("resolved", "")
    normalized = resolved.replace("\\", "/")
    assert normalized.startswith(
        "file:"
    ), f"{pkg}: xlsx resolved={resolved!r} is not a file: tarball"
    assert normalized.endswith(
        VENDOR_REL
    ), f"{pkg}: xlsx resolved={resolved!r} does not point at {VENDOR_REL}"
    # The recorded relative path must land on the committed tarball itself.
    target = (REPO_ROOT / pkg / normalized[len("file:") :]).resolve()
    assert (
        target == TARBALL.resolve()
    ), f"{pkg}: xlsx resolved={resolved!r} resolves to {target}, not {TARBALL}"


@pytest.mark.parametrize("pkg", PACKAGES)
def test_lockfile_xlsx_integrity_matches_tarball(pkg):
    expected = _sri_sha512(TARBALL)
    actual = _xlsx_lock_row(pkg).get("integrity")
    assert actual == expected, (
        f"{pkg}: lockfile xlsx integrity {actual!r} != tarball sha512 {expected!r}; "
        "refresh the lockfile (npm install) after changing the vendored tarball"
    )


@pytest.mark.parametrize("pkg", PACKAGES)
def test_manifest_declares_file_spec(pkg):
    manifest = _load_json(REPO_ROOT / pkg / "package.json")
    assert manifest.get("dependencies", {}).get("xlsx") == EXPECTED_SPEC
    lock_root = _load_json(REPO_ROOT / pkg / "package-lock.json")["packages"][""]
    assert (
        lock_root.get("dependencies", {}).get("xlsx") == EXPECTED_SPEC
    ), f"{pkg}: lockfile root spec for xlsx is stale"


def test_gitattributes_marks_tarball_binary():
    lines = (REPO_ROOT / ".gitattributes").read_text(encoding="utf-8").splitlines()
    rows = [
        ln.split() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")
    ]
    assert any(
        row[0] == "vendor/sheetjs/*.tgz" and "binary" in row[1:] for row in rows
    ), ".gitattributes must mark vendor/sheetjs/*.tgz binary"
