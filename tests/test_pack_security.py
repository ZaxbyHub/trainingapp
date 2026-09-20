"""C8 hardening tests (issue #75): extraction safety, limits, compatibility
gates, and opt-in signatures on the Python backend.

Fixture constants are SHARED with the frozen acceptance-check drivers
(.agents/issue-traces/75-harden-pack-installation/repro/py_driver.py) and the
Node mirror suite (desktop/src/__tests__/c8-pack-security.test.ts) so
repo-suite green and frozen-check green cannot diverge:
  bomb cap 4 MiB vs 6 MiB payload, ratio cap 10,
  entry cap 100 vs 150-entry archive, default 5000 vs 2500-entry acceptance.
"""

import base64
import hashlib
import io
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_pack_manager import make_store  # noqa: E402

from pack_extract import (  # noqa: E402
    PackExtractError,
    canonical_manifest_bytes,
    limits_from_settings,
    model_id_matches,
    safe_entry_name,
    safe_extract_pack_zip,
)
from pack_manager import PackManager, PackManagerError  # noqa: E402

BOMB_CAP_BYTES = 4 * 1024 * 1024
BOMB_DATA_BYTES = 6 * 1024 * 1024
RATIO_CAP = 10
ENTRY_CAP = 100
ENTRY_COUNT = 150
DEFAULT_ENTRY_COUNT = 2500
REMEDY = "packtool build-docs --embedding-model"


def make_manager(tmp_path: Path) -> PackManager:
    return PackManager(make_store(tmp_path), packs_root=tmp_path / "packs")


def make_pack_dir(
    workspace: Path,
    pack_id: str = "p75-sec",
    version: str = "1.0.0",
    model_id: str = "bge-small-en-v1.5",
    doc_text: str = '{"title": "doc", "text": "hello pack security"}',
    index: dict | None = None,
    entry_overrides: dict | None = None,
) -> Path:
    pack = workspace / f"{pack_id}-{version}"
    docs_dir = pack / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    doc = docs_dir / "doc-1.json"
    doc.write_text(doc_text, encoding="utf-8")
    manifest = {
        "id": pack_id,
        "name": "P75 Security Pack",
        "version": version,
        "published_at": "2026-09-19T00:00:00Z",
        "source_class": "user",
        "embedding": {"model_id": model_id, "dims": 384, "normalize": True},
        "chunking": {"strategy": "fixed-words", "size": 64, "overlap": 0},
        "docs": [
            {
                "path": "docs/doc-1.json",
                "sha256": hashlib.sha256(doc.read_bytes()).hexdigest(),
                "title": "doc",
                "mime": "application/json",
            }
        ],
    }
    if index is not None:
        manifest["index"] = index
    if entry_overrides:
        manifest.update(entry_overrides)
    (pack / "pack.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return pack


def set_limits(
    monkeypatch,
    settings_module,
    *,
    max_uncompressed=None,
    max_entries=None,
    max_ratio=None,
    require_signature=None,
    trusted_keys=None,
    embedding_model=None,
):
    settings = settings_module.get_settings()
    if max_uncompressed is not None:
        monkeypatch.setattr(
            settings, "rag_packs_security_max_uncompressed_bytes", max_uncompressed
        )
    if max_entries is not None:
        monkeypatch.setattr(settings, "rag_packs_security_max_entries", max_entries)
    if max_ratio is not None:
        monkeypatch.setattr(
            settings, "rag_packs_security_max_compression_ratio", max_ratio
        )
    if require_signature is not None:
        monkeypatch.setattr(
            settings, "rag_packs_security_require_signature", require_signature
        )
    if trusted_keys is not None:
        monkeypatch.setattr(
            settings, "rag_packs_security_trusted_keys", json.dumps(trusted_keys)
        )
    if embedding_model is not None:
        monkeypatch.setattr(settings, "rag_embedding_model", embedding_model)


def zip_bytes(entries: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def store_zip(entries: dict) -> bytes:
    """Store-only (uncompressed) zip with entry names preserved verbatim
    (zipfile keeps hostile names byte-for-byte; JSZip on the Node side does
    not, which is why the Node tests hand-roll their writer)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


# ----------------------------------------------------------------------- #
# AC1 — path traversal blocked
# ----------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "entry",
    [
        "E:../p75_py_escape.txt",
        "C:/p75_py_escape2.txt",
        "../../p75_py_escape3.txt",
        "docs\\..\\..\\p75_py_escape4.txt",
        "/abs/p75_py_escape5.txt",
    ],
)
def test_traversal_entries_rejected_and_contained(entry, monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    content = zip_bytes({"pack.json": "{}", entry: "escaped"})
    with pytest.raises(PackExtractError) as excinfo:
        safe_extract_pack_zip(content, "attack.zip", limits_from_settings())
    assert "unsafe archive entry path" in str(excinfo.value)
    assert not (tmp_path / "p75_py_escape.txt").exists()


def test_traversal_escape_target_absent_on_disk(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module)
    sentinel_name = "p75_py_containment.txt"
    content = store_zip({"pack.json": "{}", f"E:../{sentinel_name}": "x"})
    with pytest.raises(PackExtractError):
        safe_extract_pack_zip(content, "attack.zip", limits_from_settings())
    probe = Path(os.getcwd()).parent / sentinel_name
    assert not probe.exists(), f"escape artifact landed at {probe}"


def test_duplicate_entry_names_refused(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("pack.json", "{}")
        archive.writestr("docs/doc-1.json", '{"good": true}')
        archive.writestr("docs/doc-1.json", '{"evil": true}')
    with pytest.raises(PackExtractError) as excinfo:
        safe_extract_pack_zip(buffer.getvalue(), "dup.zip", limits_from_settings())
    assert "duplicate archive entry" in str(excinfo.value)


def test_ratio_floor_small_high_ratio_archive_accepted(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module, max_uncompressed=512 * 1024 * 1024)
    # 1 MiB of zeros at far beyond 100:1 declared ratio, but BELOW the
    # 16 MiB floor: the byte cap bounds it absolutely, so no refusal.
    payload = "0" * (1024 * 1024)
    content = zip_bytes({"pack.json": "{}", "docs/small.bin": payload})
    out = safe_extract_pack_zip(content, "small.zip", limits_from_settings())
    shutil.rmtree(out, ignore_errors=True)


def test_ratio_enforced_above_floor(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module, max_uncompressed=512 * 1024 * 1024)
    # 17 MiB declared (above the 16 MiB floor) at >100:1 declared ratio:
    # refused by the ratio gate, not the byte cap.
    payload = "0" * (17 * 1024 * 1024)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("pack.json", "{}")
        archive.writestr("docs/big.bin", payload)
    content = buffer.getvalue()
    with pytest.raises(PackExtractError) as excinfo:
        safe_extract_pack_zip(content, "floorbomb.zip", limits_from_settings())
    assert "ratio" in str(excinfo.value)


def test_signature_rejects_wrong_algorithm(monkeypatch):
    import base64
    import json

    import config as config_module
    from pack_extract import verify_pack_signature

    set_limits(monkeypatch, config_module, require_signature=True)
    _, der_b64 = _generate_trusted_key()
    set_limits(
        monkeypatch,
        config_module,
        require_signature=True,
        trusted_keys=[{"key_id": "test-key", "public_key": der_b64}],
    )
    limits = limits_from_settings()
    manifest = {
        "id": "x",
        "signature": {
            "algorithm": "RS256",
            "value": base64.b64encode(b"sig").decode("ascii"),
            "key_id": "test-key",
        },
    }
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(
            json.dumps(manifest).encode("utf-8"),
            manifest["signature"],
            limits.trusted_keys,
        )
    assert "algorithm" in str(excinfo.value)


def test_signature_rejects_malformed_base64(monkeypatch):
    import json

    import config as config_module
    from pack_extract import verify_pack_signature

    set_limits(monkeypatch, config_module, require_signature=True)
    _, der_b64 = _generate_trusted_key()
    set_limits(
        monkeypatch,
        config_module,
        require_signature=True,
        trusted_keys=[{"key_id": "test-key", "public_key": der_b64}],
    )
    limits = limits_from_settings()
    manifest = {
        "id": "x",
        "signature": {
            "algorithm": "ed25519",
            "value": "!!!not-base64!!!",
            "key_id": "test-key",
        },
    }
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(
            json.dumps(manifest).encode("utf-8"),
            manifest["signature"],
            limits.trusted_keys,
        )
    assert "base64" in str(excinfo.value).lower()


def test_folder_junction_refused(monkeypatch, tmp_path):
    import subprocess
    import sys

    import config as config_module

    if sys.platform != "win32":
        pytest.skip("junctions are Windows-only")
    set_limits(monkeypatch, config_module)
    secret = tmp_path / "outside"
    secret.mkdir()
    (secret / "stolen.txt").write_text("secret", encoding="utf-8")
    pack = make_pack_dir(tmp_path / "src")
    link = pack / "docs" / "junction"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(secret)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"junction creation unavailable: {result.stderr[:80]}")
    manager = make_manager(tmp_path / "ws")
    with pytest.raises(PackManagerError) as excinfo:
        manager.install(pack)
    assert "symlink/junction" in str(excinfo.value)


def test_symlink_entry_refused(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("pack.json", "{}")
        info = zipfile.ZipInfo("docs/link.json")
        info.external_attr = (0o120777 << 16) | 0x20
        archive.writestr(info, "target")
    with pytest.raises(PackExtractError) as excinfo:
        safe_extract_pack_zip(buffer.getvalue(), "attack.zip", limits_from_settings())
    assert "symlink archive entry" in str(excinfo.value)


def test_safe_entry_name_shapes():
    for bad in [
        "",
        "a\\b",
        "/abs",
        "E:..",
        "C:/x",
        "a/../b",
        "./x",
        "nul\x00x",
        "ctl\x1bx",
    ]:
        with pytest.raises(PackExtractError):
            safe_entry_name(bad)
    assert safe_entry_name("docs/doc-1.json") == "docs/doc-1.json"


def test_valid_zip_extracts_contained(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    out = safe_extract_pack_zip(
        zip_bytes({"pack.json": "{}", "docs/doc-1.json": "{}"}),
        "pack.zip",
        limits_from_settings(),
    )
    try:
        assert Path(out, "docs", "doc-1.json").exists()
    finally:
        shutil.rmtree(out, ignore_errors=True)


# ----------------------------------------------------------------------- #
# AC2 / AC3 / AC9 — limits and config surface
# ----------------------------------------------------------------------- #


def test_bomb_rejected_by_declared_size_and_ratio(monkeypatch):
    import config as config_module

    set_limits(
        monkeypatch, config_module, max_uncompressed=BOMB_CAP_BYTES, max_ratio=RATIO_CAP
    )
    payload = "0" * BOMB_DATA_BYTES  # compresses far below the cap, 10:1+ ratio
    content = zip_bytes({"pack.json": "{}", "docs/big.bin": payload})
    with pytest.raises(PackExtractError) as excinfo:
        safe_extract_pack_zip(content, "bomb.zip", limits_from_settings())
    message = str(excinfo.value)
    assert ("byte cap" in message) or ("ratio" in message)


def test_bomb_running_total_cutoff(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module, max_uncompressed=BOMB_CAP_BYTES)
    # Compressible zeros defeat the declared pre-filter only if the declared
    # size lies under the cap; zipfile writes true sizes, so instead drive the
    # streaming cap directly with a stored (uncompressed) oversized entry.
    content = store_zip({"pack.json": "{}", "docs/big.bin": "0" * (BOMB_CAP_BYTES + 1)})
    with pytest.raises(PackExtractError) as excinfo:
        safe_extract_pack_zip(content, "bomb.zip", limits_from_settings())
    assert "byte cap" in str(excinfo.value)


def test_entry_cap_env_override_honored(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module, max_entries=ENTRY_CAP)
    entries = {"pack.json": "{}"}
    entries.update({f"docs/f{i}.txt": "x" for i in range(ENTRY_COUNT)})
    with pytest.raises(PackExtractError) as excinfo:
        safe_extract_pack_zip(store_zip(entries), "entries.zip", limits_from_settings())
    assert "entry cap" in str(excinfo.value)


def test_default_entry_cap_accepts_2500(monkeypatch):
    import config as config_module

    set_limits(monkeypatch, config_module)
    entries = {"pack.json": "{}"}
    entries.update({f"docs/f{i}.txt": "x" for i in range(DEFAULT_ENTRY_COUNT)})
    out = safe_extract_pack_zip(store_zip(entries), "many.zip", limits_from_settings())
    shutil.rmtree(out, ignore_errors=True)


# ----------------------------------------------------------------------- #
# AC4 — tampering detected (preserving)
# ----------------------------------------------------------------------- #


def test_tampered_doc_refused_fail_closed(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    pack = make_pack_dir(tmp_path)
    doc = pack / "docs" / "doc-1.json"
    doc.write_text(doc.read_text(encoding="utf-8") + " tampered", encoding="utf-8")
    manager = make_manager(tmp_path / "ws")
    with pytest.raises(PackManagerError) as excinfo:
        manager.install(pack)
    assert "sha256" in str(excinfo.value)
    assert manager.list_installed() == []


# ----------------------------------------------------------------------- #
# AC5 / AC6 — compatibility gates
# ----------------------------------------------------------------------- #


def test_wrong_embedding_refused_with_remedy(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    pack = make_pack_dir(tmp_path, pack_id="p75-wrongmodel", model_id="wrong-model-75")
    manager = make_manager(tmp_path / "ws")
    with pytest.raises(PackManagerError) as excinfo:
        manager.install(pack)
    message = str(excinfo.value)
    assert "build-docs" in message and "embedding-model" in message
    assert manager.list_installed() == []


def test_org_prefixed_model_id_accepted(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module, embedding_model="BAAI/bge-small-en-v1.5")
    pack = make_pack_dir(tmp_path)
    manager = make_manager(tmp_path / "ws")
    manager.install(pack)
    assert [record.pack_id for record in manager.list_installed()] == ["p75-sec"]


def test_schema_version_mismatch_refused(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    pack = make_pack_dir(
        tmp_path,
        pack_id="p75-schema",
        index={
            "path": "index.sqlite",
            "schema_version": 4,
            "sqlite_vec_version": "0.1.9",
        },
    )
    manager = make_manager(tmp_path / "ws")
    with pytest.raises(PackManagerError) as excinfo:
        manager.install(pack)
    assert "schema_version" in str(excinfo.value)


def test_sqlite_vec_version_mismatch_refused(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    pack = make_pack_dir(
        tmp_path,
        pack_id="p75-vec",
        index={
            "path": "index.sqlite",
            "schema_version": 3,
            "sqlite_vec_version": "0.9.9",
        },
    )
    manager = make_manager(tmp_path / "ws")
    with pytest.raises(PackManagerError) as excinfo:
        manager.install(pack)
    assert "sqlite_vec_version" in str(excinfo.value)


def test_correct_stamps_install(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    pack = make_pack_dir(
        tmp_path,
        pack_id="p75-stamps",
        index={
            "path": "index.sqlite",
            "schema_version": 3,
            "sqlite_vec_version": "0.1.9",
        },
    )
    manager = make_manager(tmp_path / "ws")
    manager.install(pack)
    assert [record.pack_id for record in manager.list_installed()] == ["p75-stamps"]


def test_model_id_matches_canonicalization():
    assert model_id_matches("bge-small-en-v1.5", "BAAI/bge-small-en-v1.5")
    assert model_id_matches("Org/m", "org/m")
    assert not model_id_matches("wrong-model-75", "bge-small-en-v1.5")
    assert not model_id_matches("", "bge-small-en-v1.5")
    # By design, canonicalization strips the org prefix, so cross-org ids
    # with the same basename collide (documented in the C8 plan).
    assert model_id_matches("org1/m", "org2/m")


# ----------------------------------------------------------------------- #
# AC7 — opt-in signatures
# ----------------------------------------------------------------------- #


def _generate_trusted_key():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    private = Ed25519PrivateKey.generate()
    der = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return private, base64.b64encode(der).decode("ascii")


def _signed_manifest_bytes(pack: Path, private_key):
    from pack_extract import canonical_manifest_bytes

    raw = (pack / "pack.json").read_bytes()
    manifest = json.loads(raw)
    signature = {"algorithm": "ed25519", "value": "", "key_id": "test-key"}
    manifest["signature"] = signature
    payload = canonical_manifest_bytes(json.dumps(manifest).encode("utf-8"))
    value = base64.b64encode(private_key.sign(payload)).decode("ascii")
    manifest["signature"] = {**signature, "value": value}
    (pack / "pack.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def test_default_config_installs_unsigned(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module)
    pack = make_pack_dir(tmp_path, pack_id="p75-unsigned")
    manager = make_manager(tmp_path / "ws")
    manager.install(pack)
    assert [record.pack_id for record in manager.list_installed()] == ["p75-unsigned"]


def test_require_signature_refuses_unsigned(monkeypatch, tmp_path):
    import config as config_module

    set_limits(monkeypatch, config_module, require_signature=True, trusted_keys=[])
    pack = make_pack_dir(tmp_path, pack_id="p75-nosig")
    manager = make_manager(tmp_path / "ws")
    with pytest.raises(PackExtractError) as excinfo:
        manager.install(pack)
    assert "unsigned" in str(excinfo.value)


def test_require_signature_accepts_trusted_signature(monkeypatch, tmp_path):
    import config as config_module

    private, der_b64 = _generate_trusted_key()
    set_limits(
        monkeypatch,
        config_module,
        require_signature=True,
        trusted_keys=[{"key_id": "test-key", "public_key": der_b64}],
    )
    pack = make_pack_dir(tmp_path, pack_id="p75-signed")
    _signed_manifest_bytes(pack, private)
    manager = make_manager(tmp_path / "ws")
    manager.install(pack)
    assert [record.pack_id for record in manager.list_installed()] == ["p75-signed"]


def test_require_signature_refuses_untrusted_key(monkeypatch, tmp_path):
    import config as config_module

    private, _ = _generate_trusted_key()
    other_private, other_b64 = _generate_trusted_key()
    set_limits(
        monkeypatch,
        config_module,
        require_signature=True,
        trusted_keys=[{"key_id": "test-key", "public_key": other_b64}],
    )
    pack = make_pack_dir(tmp_path, pack_id="p75-badsig")
    _signed_manifest_bytes(pack, private)
    manager = make_manager(tmp_path / "ws")
    with pytest.raises(PackExtractError):
        manager.install(pack)


def test_canonical_manifest_bytes_contract():
    manifest = {
        "b": {"d": 1, "c": [2, {"a": 3}]},
        "a": "plain",
        "signature": {"algorithm": "ed25519", "value": "sig", "key_id": "k"},
    }
    canonical = canonical_manifest_bytes(json.dumps(manifest).encode("utf-8"))
    assert canonical == b'{"a":"plain","b":{"c":[2,{"a":3}],"d":1}}'


def test_canonical_manifest_refuses_floats():
    with pytest.raises(PackExtractError):
        canonical_manifest_bytes(json.dumps({"dims": 384.5}).encode("utf-8"))


# ----------------------------------------------------------------------- #
# zip-upload extractor wiring
# ----------------------------------------------------------------------- #


def test_api_server_extractor_rejects_traversal(monkeypatch):
    import api_server
    import config as config_module

    set_limits(monkeypatch, config_module)
    content = store_zip({"pack.json": "{}", "E:../p75_api_escape.txt": "x"})
    with pytest.raises(PackManagerError):
        api_server._extract_pack_zip(content, "attack.zip")
