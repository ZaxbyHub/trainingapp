"""Shared extraction-safety and install-gate core for Knowledge Packs (C8, #75).

Every Python pack-install path funnels through this module: the zip-upload
extractor in api_server.py, the install-time compatibility/signature gates in
pack_manager.py, and (via contracts/validate_pack.py) the C1 validator blocks
it reuses. The Node twin lives at desktop/main/backend/packs/pack-extract.ts
and packtool/build/pack-json.ts; behavior parity is pinned by the trace checks
and contracts/tests/test_pack_parity.py.

Guard matrix for zip extraction (G1-G6, mirrored by the Node twin):
  G1 manifest presence at the archive root,
  G2 per-entry path safety + resolved containment BEFORE any byte is written,
  G3 symlink-attribute entries refused,
  G4 declared uncompressed-size pre-filter,
  G5 declared compression-ratio pre-filter,
  G6 streaming copy with a running written-bytes cap (unspoofable backstop).

Import note: this module imports PackManagerError from pack_manager so that
extraction refusals share the route's 409 error mapping; pack_manager imports
this module lazily inside install() to keep the import graph acyclic.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import os
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Tuple

from pack_manager import PackManagerError

SQLITE_VEC_PIN = "0.1.9"
STORE_SCHEMA_VERSION = 3
DEFAULT_MAX_UNCOMPRESSED_BYTES = 2147483648
DEFAULT_MAX_ENTRIES = 5000
DEFAULT_MAX_COMPRESSION_RATIO = 100.0
_RATIO_FLOOR_BYTES = 16 * 1024 * 1024

_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")


class PackExtractError(PackManagerError):
    """A pack archive or manifest failed a C8 hardening gate."""


@dataclass(frozen=True)
class TrustedKey:
    key_id: str
    public_key: str  # base64 DER SubjectPublicKeyInfo


@dataclass(frozen=True)
class PackSecurityLimits:
    max_uncompressed_bytes: int = DEFAULT_MAX_UNCOMPRESSED_BYTES
    max_entries: int = DEFAULT_MAX_ENTRIES
    max_compression_ratio: float = DEFAULT_MAX_COMPRESSION_RATIO
    require_signature: bool = False
    trusted_keys: Tuple[TrustedKey, ...] = field(default_factory=tuple)


def limits_from_settings() -> PackSecurityLimits:
    """Build the active limits from the RAG_PACKS_SECURITY_* settings."""
    from config import get_settings

    settings = get_settings()
    raw_keys = getattr(settings, "rag_packs_security_trusted_keys", "[]") or "[]"
    try:
        parsed = json.loads(raw_keys)
    except json.JSONDecodeError as error:
        raise PackExtractError(
            f"RAG_PACKS_SECURITY_TRUSTED_KEYS is not valid JSON: {error}"
        ) from error
    if not isinstance(parsed, list):
        raise PackExtractError("RAG_PACKS_SECURITY_TRUSTED_KEYS must be a JSON array")
    keys: List[TrustedKey] = []
    for entry in parsed:
        if (
            not isinstance(entry, dict)
            or not entry.get("key_id")
            or not entry.get("public_key")
        ):
            raise PackExtractError(
                "RAG_PACKS_SECURITY_TRUSTED_KEYS entries need key_id and public_key"
            )
        keys.append(
            TrustedKey(key_id=str(entry["key_id"]), public_key=str(entry["public_key"]))
        )
    return PackSecurityLimits(
        max_uncompressed_bytes=int(
            getattr(
                settings,
                "rag_packs_security_max_uncompressed_bytes",
                DEFAULT_MAX_UNCOMPRESSED_BYTES,
            )
        ),
        max_entries=int(
            getattr(settings, "rag_packs_security_max_entries", DEFAULT_MAX_ENTRIES)
        ),
        max_compression_ratio=float(
            getattr(
                settings,
                "rag_packs_security_max_compression_ratio",
                DEFAULT_MAX_COMPRESSION_RATIO,
            )
        ),
        require_signature=bool(
            getattr(settings, "rag_packs_security_require_signature", False)
        ),
        trusted_keys=tuple(keys),
    )


def safe_entry_name(name: str) -> str:
    """Validate a zip entry name's shape and return it unchanged.

    Refuses empty names, backslashes, leading slashes, drive-relative and
    drive-absolute forms (the `E:..` class that bypasses element checks and
    resets ntpath.join anchors), `..`/`.` elements, and NUL/control bytes.
    """
    if not name:
        raise PackExtractError("unsafe archive entry path (empty)")
    if "\\" in name:
        raise PackExtractError(f"unsafe archive entry path {name}")
    if name.startswith("/"):
        raise PackExtractError(f"unsafe archive entry path {name}")
    if _DRIVE_PREFIX.match(name):
        raise PackExtractError(f"unsafe archive entry path {name}")
    for segment in name.split("/"):
        if segment in ("..", "."):
            raise PackExtractError(f"unsafe archive entry path {name}")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in name):
        raise PackExtractError(f"unsafe archive entry path {name}")
    return name


def ensure_contained(root: str, *parts: str) -> str:
    """Resolve root + parts and prove containment BEFORE anything is written.

    Trailing-separator-safe, case-normalized prefix comparison of the fully
    resolved target against the resolved extraction root — the invariant the
    token-shape checks alone cannot give (root cause RC1/RC2).
    """
    target = os.path.normpath(os.path.join(root, *parts))
    root_norm = os.path.normpath(root)
    target_case = os.path.normcase(target)
    root_case = os.path.normcase(root_norm)
    if target_case != root_case and not target_case.startswith(root_case + os.sep):
        raise PackExtractError(
            f"archive entry resolves outside the extraction root (refused): {parts!r}"
        )
    return target


def _is_symlink_entry(info: zipfile.ZipInfo) -> bool:
    return ((info.external_attr >> 16) & 0o170000) == 0o120000


def safe_extract_pack_zip(
    content: bytes, filename: str, limits: PackSecurityLimits
) -> str:
    """Extract an uploaded pack zip into a fresh temp dir under the G1-G6
    guard matrix. Returns the temp dir; the caller removes it."""
    if not filename.lower().endswith(".zip"):
        raise PackExtractError(f"{filename}: pack install accepts .zip archives only")
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as error:
        raise PackExtractError(
            f"{filename}: not a readable zip archive: {error}"
        ) from error

    names = archive.namelist()
    if len(names) > limits.max_entries:
        raise PackExtractError(
            f"{filename}: archive has {len(names)} entries, over the "
            f"{limits.max_entries} entry cap"
        )

    # Safest-first ordering: validate every entry path (G2/G3) before the
    # manifest-presence check (G1), so a hostile archive is refused on its
    # path shape regardless of what else it carries. Duplicate entry names
    # are refused: extraction is last-write-wins, so a benign first entry
    # must not be allowed to mask a hostile duplicate.
    seen_names = set()
    for info in archive.infolist():
        try:
            safe_entry_name(info.filename)
        except PackExtractError as error:
            raise PackExtractError(f"{filename}: {error}") from error
        if info.filename in seen_names:
            raise PackExtractError(
                f"{filename}: duplicate archive entry {info.filename} is not allowed"
            )
        seen_names.add(info.filename)
        if _is_symlink_entry(info):
            raise PackExtractError(
                f"{filename}: symlink archive entry {info.filename} is not allowed"
            )

    if "pack.json" not in names and "./pack.json" not in names:
        raise PackExtractError(f"{filename}: no pack.json manifest at the archive root")

    # Cheap pre-filters on declared central-directory metadata (G4/G5) —
    # spoofable, so G6's written-bytes cap below stays the real backstop.
    regular = [i for i in archive.infolist() if not i.is_dir()]
    declared_total = sum(i.file_size for i in regular)
    if declared_total > limits.max_uncompressed_bytes:
        raise PackExtractError(
            f"{filename}: archive expands beyond the "
            f"{limits.max_uncompressed_bytes} byte cap"
        )
    declared_compressed = sum(i.compress_size for i in regular)
    if declared_compressed <= 0:
        if declared_total > 0:
            raise PackExtractError(
                f"{filename}: archive declares compressed sizes of zero"
            )
    elif (
        declared_total >= _RATIO_FLOOR_BYTES
        and declared_total / declared_compressed > limits.max_compression_ratio
    ):
        # Ratio is enforced only above an absolute floor: the byte cap bounds
        # small archives absolutely, and legitimate sqlite vector pages
        # compress far beyond 100:1 on tiny indexes.
        raise PackExtractError(
            f"{filename}: archive compression ratio exceeds the "
            f"{limits.max_compression_ratio:g}:1 cap"
        )

    total = 0
    tmp_root = tempfile.mkdtemp(prefix="pack-install-")
    try:
        for info in archive.infolist():
            if info.is_dir():
                continue
            try:
                target = ensure_contained(tmp_root, *info.filename.split("/"))
            except PackExtractError as error:
                raise PackExtractError(f"{filename}: {error}") from error
            parent = os.path.dirname(target)
            if parent:
                ensure_contained(tmp_root, os.path.relpath(parent, tmp_root) or ".")
                os.makedirs(parent, exist_ok=True)
            with archive.open(info) as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limits.max_uncompressed_bytes:
                        raise PackExtractError(
                            f"{filename}: archive expands beyond the "
                            f"{limits.max_uncompressed_bytes} byte cap"
                        )
                    dst.write(chunk)
    except Exception:
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise
    return tmp_root


def canonical_manifest_bytes(manifest_bytes: bytes) -> bytes:
    """Canonical signature payload: pack.json with the signature block removed.

    Pinned cross-language contract (mirrored by the Node twin and the frozen
    C7 driver's accepted candidate): raw UTF-8 output (no \\uXXXX escapes),
    object keys recursively sorted at every depth, arrays preserving order,
    compact (",", ":") separators, and a FAIL-CLOSED refusal on any
    non-integer number (the pack schema permits integers only, so a float
    means the manifest is not canonicalizable).
    """
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PackExtractError(f"pack.json is not valid UTF-8 JSON: {error}") from error
    if not isinstance(manifest, dict):
        raise PackExtractError("pack.json must be a JSON object")
    if "signature" in manifest:
        manifest = {key: value for key, value in manifest.items() if key != "signature"}
    _refuse_non_integer_numbers(manifest)
    return json.dumps(
        manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _refuse_non_integer_numbers(node: Any) -> None:
    if isinstance(node, bool):
        return
    if isinstance(node, float):
        raise PackExtractError(
            "pack signature verification refuses non-integer numbers in pack.json"
        )
    if isinstance(node, dict):
        for value in node.values():
            _refuse_non_integer_numbers(value)
    elif isinstance(node, list):
        for value in node:
            _refuse_non_integer_numbers(value)


def verify_pack_signature(
    manifest_bytes: bytes, signature: Any, trusted_keys: Tuple[TrustedKey, ...]
) -> None:
    """Verify an ed25519 detached signature over the canonical manifest bytes."""
    if not isinstance(signature, dict):
        raise PackExtractError("pack signature block is missing or malformed")
    if signature.get("algorithm") != "ed25519":
        raise PackExtractError(
            f"unsupported pack signature algorithm {signature.get('algorithm')!r}"
        )
    key_id = signature.get("key_id")
    matching = [key for key in trusted_keys if key.key_id == key_id]
    if not matching:
        raise PackExtractError(
            f"pack signature key_id {key_id!r} is not in packs.security.trustedKeys"
        )
    try:
        signature_value = base64.b64decode(signature.get("value", ""), validate=True)
    except (binascii.Error, ValueError) as error:
        raise PackExtractError(
            f"pack signature value is not valid base64: {error}"
        ) from error
    payload = canonical_manifest_bytes(manifest_bytes)
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    last_error: Exception = InvalidSignature()
    for key in matching:
        try:
            public_key = serialization.load_der_public_key(
                base64.b64decode(key.public_key)
            )
            if not isinstance(public_key, Ed25519PublicKey):
                raise PackExtractError(
                    f"trusted key {key.key_id!r} is not an ed25519 public key"
                )
            public_key.verify(signature_value, payload)
            return
        except (InvalidSignature, ValueError, binascii.Error) as error:
            last_error = error
    raise PackExtractError(f"pack signature verification failed: {last_error}")


def check_signature_gate(
    manifest: Dict[str, Any], manifest_bytes: bytes, limits: PackSecurityLimits
) -> None:
    """Opt-in signature enforcement (packs.security.requireSignature)."""
    if not limits.require_signature:
        return
    signature = manifest.get("signature")
    if signature is None:
        raise PackExtractError(
            "pack is unsigned and packs.security.requireSignature is enabled; refusing install"
        )
    verify_pack_signature(manifest_bytes, signature, limits.trusted_keys)


def canonical_model_id(model_id: str) -> str:
    """Canonical embedding-model identity: the basename after the last '/',
    case-folded. packtool stamps basenames; the Python default
    'BAAI/bge-small-en-v1.5' and manifests declaring 'bge-small-en-v1.5' then
    agree without weakening the gate."""
    return model_id.rsplit("/", 1)[-1].strip().lower()


def model_id_matches(declared: str, current: str) -> bool:
    if not declared or not current:
        return False
    return canonical_model_id(declared) == canonical_model_id(current)


def check_pack_compat(
    manifest: Dict[str, Any],
    current_model_id: str,
    schema_version: int = STORE_SCHEMA_VERSION,
    vec_version: str = SQLITE_VEC_PIN,
) -> None:
    """Embedding/schema compatibility gates (fail-closed, before any insert)."""
    embedding = manifest.get("embedding") or {}
    declared = str(embedding.get("model_id", ""))
    if not model_id_matches(declared, current_model_id):
        raise PackManagerError(
            f"pack embedding model mismatch: pack built with '{declared}' but this "
            f"host runs '{current_model_id}'; refusing install — rebuild via "
            f"packtool build-docs --embedding-model <correct-id>"
        )
    index = manifest.get("index")
    if isinstance(index, dict):
        declared_schema = index.get("schema_version")
        if declared_schema != schema_version:
            raise PackManagerError(
                f"pack index schema_version {declared_schema} does not match the "
                f"pinned store schema_version {schema_version}; refusing install "
                "(rebuild via packtool build-docs rather than auto-migrating)"
            )
        declared_vec = index.get("sqlite_vec_version")
        if declared_vec != vec_version:
            raise PackManagerError(
                f"pack index sqlite_vec_version {declared_vec!r} does not match the "
                f"pinned {vec_version!r}; refusing install"
            )
