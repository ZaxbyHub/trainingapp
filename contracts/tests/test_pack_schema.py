"""Knowledge Pack schema + validator tests (issue #68, C1).

Covers the acceptance table's rejection cases: missing required field, bad
semver, bad source_class enum value, malformed supersedes entry, sha256
mismatch against actual bytes — plus the path-traversal named error, the
cross-id/same-id supersedes pins (format accepts both; policy is
PackManager-level per docs/adr/0004-knowledge-packs.md), the full
optional-blocks manifest, zip mode, and missing-doc rejection.

These tests live under contracts/ (not pytest.ini testpaths) on purpose:
scripts/check_test_collection.py ignores contracts/ by design, and CI runs
this file via the dedicated contracts-triggered step in the store-interop
job (.github/workflows/desktop-build.yml), matching the store-interop
precedent.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

CONTRACTS = Path(__file__).resolve().parents[1]
VALIDATOR = CONTRACTS / "validate_pack.py"
FIXTURES = CONTRACTS / "fixtures" / "packs"
VALID_FIXTURES = [
    "bundled-min",
    "training-stub",
    "user-sample",
    "versioned-a-1.0.0",
    "versioned-a-2.0.0",
]


def run_validator(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(path)],
        capture_output=True,
        text=True,
        timeout=120,
    )


def output(proc: subprocess.CompletedProcess[str]) -> str:
    return proc.stdout + proc.stderr


def copy_fixture(name: str, tmp_path: Path) -> Path:
    target = tmp_path / name
    shutil.copytree(FIXTURES / name, target)
    return target


def edit_manifest(pack_dir: Path, mutate) -> None:
    manifest_path = pack_dir / "pack.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mutate(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def test_valid_fixtures_validate(tmp_path):
    for name in VALID_FIXTURES:
        proc = run_validator(FIXTURES / name)
        assert proc.returncode == 0, f"{name}: {output(proc)}"
        assert "OK:" in proc.stdout
        assert "FAIL:" not in output(proc)


def test_versioned_pair_share_id_and_differ_version():
    manifests = {}
    for name in ("versioned-a-1.0.0", "versioned-a-2.0.0"):
        manifests[name] = json.loads(
            (FIXTURES / name / "pack.json").read_text(encoding="utf-8")
        )
    ids = {m["id"] for m in manifests.values()}
    versions = {m["version"] for m in manifests.values()}
    assert len(ids) == 1, f"versioned pair must share id, got {ids}"
    assert len(versions) == 2, f"versioned pair must differ in version, got {versions}"


def test_missing_required_field_rejected(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    edit_manifest(pack, lambda m: m.pop("version"))
    proc = run_validator(pack)
    assert proc.returncode == 1
    out = output(proc)
    assert "FAIL: $:" in out
    assert "'version' is a required property" in out


def test_bad_semver_rejected(tmp_path):
    for bad in ("1.2", "1.2.3.4"):
        pack = copy_fixture("bundled-min", tmp_path / bad.replace(".", "_"))
        edit_manifest(pack, lambda m, b=bad: m.update(version=b))
        proc = run_validator(pack)
        assert proc.returncode == 1, f"version={bad}: {output(proc)}"
        assert "FAIL: $.version" in output(proc)


def test_bad_source_class_rejected(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    edit_manifest(pack, lambda m: m.update(source_class="internal"))
    proc = run_validator(pack)
    assert proc.returncode == 1
    assert "FAIL: $.source_class" in output(proc)


def test_malformed_supersedes_entry_rejected(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    edit_manifest(pack, lambda m: m.update(supersedes=["Bad-Id@1.0.0"]))
    proc = run_validator(pack)
    assert proc.returncode == 1
    assert "FAIL: $.supersedes" in output(proc)


def test_cross_id_supersedes_is_schema_valid(tmp_path):
    # Format-level pin (plan-critic round 1 / frozen C6 fixture): a supersedes
    # entry naming a DIFFERENT well-formed pack id is schema-legal. Whether to
    # honor or reject it at install time is PackManager policy (C2/#69, C3/#70).
    pack = copy_fixture("bundled-min", tmp_path)
    edit_manifest(pack, lambda m: m.update(supersedes=["opmed-some-other-pack@1.0.0"]))
    proc = run_validator(pack)
    assert proc.returncode == 0, output(proc)


def test_same_id_supersedes_is_schema_valid(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    edit_manifest(pack, lambda m: m.update(supersedes=["bundled-min@0.9.0"]))
    proc = run_validator(pack)
    assert proc.returncode == 0, output(proc)


def test_sha256_mismatch_rejected(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    doc = pack / "docs" / "welcome.json"
    doc.write_bytes(doc.read_bytes() + b"tampered\n")
    proc = run_validator(pack)
    assert proc.returncode == 1
    out = output(proc)
    assert "sha256 mismatch" in out
    assert "docs/welcome.json" in out


def test_traversal_doc_path_rejected_with_named_error(tmp_path):
    proc = run_validator(FIXTURES / "invalid-traversal")
    assert proc.returncode == 1
    out = output(proc)
    assert "../../etc/passwd" in out
    assert "FAIL:" in out


def test_full_optional_fields_validate(tmp_path):
    # The full draft-shape manifest (field set per PackManifest in
    # packtool/build/pack-json.ts): every optional block populated.
    pack = copy_fixture("bundled-min", tmp_path)

    def fill(m):
        m["supersedes"] = ["opmed-older-bundle@1.0.0"]
        m["index"] = {
            "path": "index.sqlite",
            "schema_version": 2,
            "sqlite_vec_version": "0.1.9",
        }
        m["signature"] = {"algorithm": "ed25519", "value": "c2ln", "key_id": "k1"}
        m["docs"][0]["published_at"] = "2026-01-01T00:00:00Z"

    edit_manifest(pack, fill)
    proc = run_validator(pack)
    assert proc.returncode == 0, output(proc)


def test_unknown_top_level_field_rejected(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    edit_manifest(pack, lambda m: m.update(future_field=True))
    proc = run_validator(pack)
    assert proc.returncode == 1
    out = output(proc)
    assert "FAIL: $:" in out
    assert "'future_field' was unexpected" in out


def test_missing_doc_file_rejected(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    (pack / "docs" / "welcome.json").unlink()
    proc = run_validator(pack)
    assert proc.returncode == 1
    out = output(proc)
    assert "doc missing from pack" in out
    assert "docs/welcome.json" in out


def test_backslash_doc_path_rejected(tmp_path):
    pack = copy_fixture("bundled-min", tmp_path)
    edit_manifest(pack, lambda m: m["docs"][0].update(path="docs\\welcome.json"))
    proc = run_validator(pack)
    assert proc.returncode == 1
    out = output(proc)
    assert "forward slashes" in out
    assert "docs\\\\welcome.json" in out or "docs\\welcome.json" in out


def test_zip_mode_validates(tmp_path):
    zip_path = tmp_path / "bundled-min.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in sorted((FIXTURES / "bundled-min").rglob("*")):
            if file.is_file():
                zf.write(file, file.relative_to(FIXTURES / "bundled-min").as_posix())
    proc = run_validator(zip_path)
    assert proc.returncode == 0, output(proc)
    assert "OK: 2 docs validated" in proc.stdout


def test_zip_mode_reports_missing_pack_json(tmp_path):
    zip_path = tmp_path / "empty.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("docs/only.json", "{}\n")
    proc = run_validator(zip_path)
    assert proc.returncode == 1
    assert "pack.json is missing from the pack" in output(proc)


def test_missing_pack_path_is_usage_error():
    proc = run_validator(FIXTURES.parent / "does-not-exist")
    assert proc.returncode == 2
