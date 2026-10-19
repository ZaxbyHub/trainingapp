"""The pack-extract refusal contract is closed: no builtin exception escapes it.

Issue #226. `verify_pack_signature` decoded a non-string `signature["value"]`
with `base64.b64decode`, which raises `TypeError` — outside the
`except (binascii.Error, ValueError)` that was there. `canonical_manifest_bytes`
called `.encode("utf-8")` outside any guard, and a lone surrogate in any manifest
string raises `UnicodeEncodeError` there. Neither is a `PackExtractError`, so the
install route — which maps only `PackManagerError` to HTTP 409 — let both reach
Starlette's default handling and answered 500 instead of the documented refusal.

These rows are behavioral, not source-string pins: each one drives the real
function and asserts the exception TYPE that reaches the caller, so a fix that
merely widened an `except` tuple would pass them while still mislabelling the
malformed field. The Node twin already behaved this way
(`desktop/main/backend/packs/pack-extract.ts:361-363` type-checks `value` before
decoding and wraps canonicalization in try/catch); this suite is what makes the
python leg agree with it.

The surrogate rows use the attacker-reachable input shape: a literal six-character
ASCII `\\ud800` escape inside the JSON bytes on the wire, which `json.loads`
decodes back into a real lone surrogate. A surrogate baked into a python source
literal would test a shape no pack can carry.
"""

import ast
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import api_server  # noqa: E402
from pack_extract import (  # noqa: E402
    PackExtractError,
    PackSecurityLimits,
    TrustedKey,
    canonical_manifest_bytes,
    check_signature_gate,
    verify_pack_signature,
)
from pack_manager import PackManagerError  # noqa: E402

SURROGATE = chr(0xD800)

#: The wire shape: json.dumps(ensure_ascii=True) emits the lone surrogate as the
#: literal escape sequence, so pack.json stays pure ASCII on the wire.
SURROGATE_ESCAPE = chr(92) + "ud800"


def manifest_bytes(manifest: dict) -> bytes:
    """pack.json bytes with the surrogate staged as the ASCII escape it is on the wire."""
    raw = json.dumps(manifest, indent=2).encode("ascii")
    assert SURROGATE_ESCAPE.encode("ascii") in raw
    return raw


def signed(**overrides) -> dict:
    manifest = {"id": "p226", "name": "Pack", "version": "1.0.0", "docs": []}
    manifest.update(overrides)
    manifest["signature"] = {"algorithm": "ed25519", "value": "AA==", "key_id": "k1"}
    return manifest


def limits() -> PackSecurityLimits:
    return PackSecurityLimits(
        require_signature=True,
        trusted_keys=(TrustedKey("k1", "AA=="),),
    )


# --------------------------------------------------------------------------- #
# The typed-refusal contract at the signature gate
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("value", [5, 1.5, True, None, [], {}, ["AA=="]])
def test_a_non_string_signature_value_is_refused_typed(value):
    """AC3. `b64decode` raises TypeError for every one of these; it must never
    reach the caller."""
    signature = {"algorithm": "ed25519", "key_id": "k1", "value": value}
    with pytest.raises(PackExtractError) as refusal:
        verify_pack_signature(b'{"id":"p226"}', signature, limits().trusted_keys)
    assert "value" in str(refusal.value)


def test_an_empty_signature_value_is_refused_typed():
    with pytest.raises(PackExtractError):
        verify_pack_signature(
            b'{"id":"p226"}',
            {"algorithm": "ed25519", "key_id": "k1", "value": ""},
            limits().trusted_keys,
        )


def test_a_lone_surrogate_in_the_manifest_is_refused_typed():
    """AC4. The canonical payload is `ensure_ascii=False`, which is exactly what
    makes the encode fail on a lone surrogate."""
    raw = manifest_bytes({"id": "p226", "name": "evil " + SURROGATE + " name"})
    with pytest.raises(PackExtractError) as refusal:
        canonical_manifest_bytes(raw)
    assert "UTF-8" in str(refusal.value)


def test_a_lone_surrogate_reaches_the_gate_through_check_signature_gate():
    manifest = {"id": "p226", "name": "evil " + SURROGATE + " name"}
    raw = manifest_bytes(manifest)
    manifest = json.loads(raw.decode("utf-8"))
    manifest["signature"] = {"algorithm": "ed25519", "value": "AA==", "key_id": "k1"}
    with pytest.raises(PackExtractError):
        check_signature_gate(manifest, raw, limits())


def test_a_signature_block_that_is_not_a_dict_is_still_refused_typed():
    for malformed in (None, [], "ed25519", 5):
        with pytest.raises(PackExtractError):
            verify_pack_signature(b'{"id":"p226"}', malformed, limits().trusted_keys)


# --------------------------------------------------------------------------- #
# Already-typed refusals must survive the widening (PRESERVING)
# --------------------------------------------------------------------------- #


def test_the_existing_typed_refusals_are_unchanged():
    raw = b'{"id":"p226"}'
    trusted = limits().trusted_keys
    cases = [
        {"algorithm": "rsa", "key_id": "k1", "value": "AA=="},  # unsupported algorithm
        {
            "algorithm": "ed25519",
            "key_id": "other",
            "value": "AA==",
        },  # untrusted key_id
        {"algorithm": "ed25519", "key_id": "k1", "value": "!!!"},  # invalid base64
    ]
    for signature in cases:
        with pytest.raises(PackExtractError):
            verify_pack_signature(raw, signature, trusted)


def test_a_valid_canonical_manifest_still_round_trips():
    manifest = {"id": "p226", "name": "Pack", "version": "1.0.0", "docs": []}
    payload = canonical_manifest_bytes(json.dumps(manifest).encode("utf-8"))
    assert json.loads(payload.decode("utf-8")) == manifest


def test_a_float_is_still_refused_typed():
    with pytest.raises(PackExtractError):
        canonical_manifest_bytes(b'{"id":"p226","count":1.5}')


# --------------------------------------------------------------------------- #
# The install route maps the refusal to 409 (AC6)
# --------------------------------------------------------------------------- #


def test_the_install_route_answers_409_for_a_surrogate_manifest(monkeypatch, tmp_path):
    """AC6. `PackExtractError` is a `PackManagerError`, which the route maps to
    409. At base the escaping `UnicodeEncodeError` produced a 500."""
    from fastapi.testclient import TestClient

    import config
    import vector_store as vector_store_module
    from pack_manager import PackManager

    class StubEmbeddingModel:
        def __init__(self, model_name=None):
            self.model_name = model_name or "stub"

        def encode(self, texts):
            return [[0.1] * 384 for _ in texts]

    doc_text = '{"title": "doc", "text": "hello"}'
    manifest = {
        "id": "p226-route",
        "name": "evil " + SURROGATE + " name",
        "version": "1.0.0",
        "published_at": "2026-10-19T00:00:00Z",
        "source_class": "user",
        "embedding": {"model_id": "bge-small-en-v1.5", "dims": 384, "normalize": True},
        "chunking": {"strategy": "fixed-words", "size": 64, "overlap": 0},
        "docs": [
            {
                "path": "docs/doc-1.json",
                "sha256": hashlib.sha256(doc_text.encode("utf-8")).hexdigest(),
                "title": "doc",
                "mime": "application/json",
            }
        ],
        "signature": {"algorithm": "ed25519", "value": "AA==", "key_id": "k1"},
    }
    payload = json.dumps(manifest, indent=2).encode("ascii")
    assert SURROGATE_ESCAPE.encode("ascii") in payload
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("pack.json", payload)
        archive.writestr("docs/doc-1.json", doc_text)

    settings = config.get_settings()
    monkeypatch.setattr(
        settings, "rag_packs_security_require_signature", True, raising=False
    )
    monkeypatch.setattr(
        settings,
        "rag_packs_security_trusted_keys",
        json.dumps([{"key_id": "k1", "public_key": "AA=="}]),
        raising=False,
    )
    monkeypatch.setattr(
        vector_store_module, "EmbeddingModel", StubEmbeddingModel, raising=False
    )
    store = vector_store_module.VectorStore(
        db_path=str(tmp_path / "db"), embedding_model="stub"
    )
    monkeypatch.setattr(
        api_server, "pack_manager", PackManager(store, packs_root=tmp_path / "packs")
    )

    client = TestClient(api_server.app, raise_server_exceptions=False)
    response = client.post(
        "/packs/install",
        files={"file": ("pack.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 409, response.text
    # A 500 here would carry the correlation-id envelope; a typed refusal does not.
    assert "correlation_id" not in response.json()


# --------------------------------------------------------------------------- #
# Recurrence-class guardrail (Phase 4.2)
# --------------------------------------------------------------------------- #


def test_json_doc_text_carrying_a_surrogate_is_refused_typed():
    """The sweep's second reachable site: `json.loads` decodes a `"\\ud800"`
    escape into a real surrogate, which then reaches `chunk_id_of` and
    `content_hash_of` — the two `.encode("utf-8")` boundaries below the gate."""
    from pack_manager import PackManagerError, extract_doc_text

    raw = json.dumps({"text": "evil " + SURROGATE + " text"}).encode("ascii")
    assert SURROGATE_ESCAPE.encode("ascii") in raw
    with pytest.raises(PackManagerError) as refusal:
        extract_doc_text(raw, "application/json")
    assert "UTF-8" in str(refusal.value)


def test_a_registry_row_carrying_a_surrogate_is_refused_typed(tmp_path):
    """The sweep's first reachable site: `_save_rows` serializes manifest-derived
    strings with `ensure_ascii=False` and caught only `OSError`."""
    from pack_manager import PackManager, PackManagerError
    from vector_store import VectorStore

    class StubEmbeddingModel:
        def __init__(self, model_name=None):
            self.model_name = model_name or "stub"

        def encode(self, texts):
            return [[0.1] * 384 for _ in texts]

    store = VectorStore(db_path=str(tmp_path / "db"), embedding_model="stub")
    manager = PackManager(store, packs_root=tmp_path / "packs")
    with pytest.raises(PackManagerError) as refusal:
        manager._save_rows([{"pack_id": "p", "version": "1.0.0", "name": SURROGATE}])
    assert "registry write failed" in str(refusal.value)


def test_no_python_security_gate_keys_on_the_rebuilt_url():
    """The #228 half of the recurrence class: a guard must not read
    `request.url.*` while the resource it guards resolves from the ASGI scope.

    Structural, not textual: the AST is walked so docstrings and comments — which
    legitimately mention `request.url.path` to explain why it is forbidden —
    cannot satisfy or trip the guard. No runtime input can distinguish the two
    strings under starlette < 1.9, so this property is only observable in the
    parsed tree."""
    tree = ast.parse((ROOT / "api_server.py").read_text(encoding="utf-8"))
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        if node.attr != "url" or not isinstance(node.value, ast.Name):
            continue
        if node.value.id != "request":
            continue
        offenders.append(f"api_server.py:{node.lineno} request.url")
    assert offenders == [], (
        "the player-origin refusal must key on _route_path(request.scope), "
        "the same string StaticFiles resolves; found: " + ", ".join(offenders)
    )


def test_route_path_matches_the_string_the_static_mount_resolves():
    """`_route_path` must agree with `starlette`'s own `get_route_path` for every
    root_path shape, because the refusal is only as good as that agreement."""
    from starlette.routing import get_route_path

    for root_path in ("", "/", "/prefix", "/prefix/"):
        for path in ("/training/sw.js", "/prefix/training/sw.js", "/prefix", "/", "/x"):
            scope = {"path": path, "root_path": root_path}
            assert api_server._route_path(scope) == get_route_path(scope), (
                f"root_path={root_path!r} path={path!r}: the gate would read a "
                "different string than the static mount resolves"
            )


# --------------------------------------------------------------------------- #
# Refusal messages must never carry a value they cannot encode
# --------------------------------------------------------------------------- #


def test_a_surrogate_in_a_manifest_string_is_refused_before_any_message_is_built():
    """The adversarial-review blocker. `docs[].path` carrying a lone surrogate
    made `_build_chunks` raise its typed `doc unreadable: {rel_path}` refusal —
    which interpolates the attacker string RAW. The route renders that detail with
    Starlette's `JSONResponse` (ensure_ascii=False), so the surrogate raised
    `UnicodeEncodeError` during rendering and the caller got an unhandled 500
    instead of the documented 409. Reachable on the DEFAULT configuration, where
    the signature gate is off, so the AC6 check does not cover it."""
    from pack_manager import _refuse_unencodable_manifest_strings

    manifest = {"id": "p", "docs": [{"path": "docs/" + SURROGATE + ".json"}]}
    with pytest.raises(PackManagerError) as refusal:
        _refuse_unencodable_manifest_strings(manifest)
    # The refusal names WHERE, never WHAT — echoing the value would reintroduce
    # the very encode failure it is reporting.
    assert "/docs/0/path" in str(refusal.value)
    assert SURROGATE not in str(refusal.value)
    assert "not encodable as UTF-8" in str(refusal.value)


def test_a_clean_manifest_passes_the_unencodable_string_check():
    from pack_manager import _refuse_unencodable_manifest_strings

    manifest = {
        "id": "p",
        "name": "Ordinary pack name",
        "docs": [{"path": "docs/a.json", "title": "t"}],
        "supersedes": ["p/0.1.0"],
    }
    assert _refuse_unencodable_manifest_strings(manifest) is None


def test_the_install_route_answers_409_for_a_surrogate_doc_path_on_the_default_config(
    monkeypatch, tmp_path
):
    """The blocker's route-level proof, on the configuration where it was
    reachable: `requireSignature` OFF, so the signature gate never runs."""
    from fastapi.testclient import TestClient

    import config
    import vector_store as vector_store_module
    from pack_manager import PackManager

    class StubEmbeddingModel:
        def __init__(self, model_name=None):
            self.model_name = model_name or "stub"

        def encode(self, texts):
            return [[0.1] * 384 for _ in texts]

    doc_text = '{"title": "doc", "text": "hello"}'
    manifest = {
        "id": "p226-blocker",
        "name": "Blocker Probe",
        "version": "1.0.0",
        "published_at": "2026-10-19T00:00:00Z",
        "source_class": "user",
        "embedding": {"model_id": "bge-small-en-v1.5", "dims": 384, "normalize": True},
        "chunking": {"strategy": "fixed-words", "size": 64, "overlap": 0},
        "docs": [
            {
                # absent from the archive, so `_build_chunks` raises its typed
                # refusal — which is exactly the message that used to echo it.
                "path": "docs/" + SURROGATE + ".json",
                "sha256": hashlib.sha256(doc_text.encode("utf-8")).hexdigest(),
                "title": "doc",
                "mime": "application/json",
            }
        ],
    }
    payload = json.dumps(manifest, indent=2).encode("ascii")
    assert SURROGATE_ESCAPE.encode("ascii") in payload
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("pack.json", payload)
        archive.writestr("docs/doc-1.json", doc_text)

    settings = config.get_settings()
    monkeypatch.setattr(
        settings, "rag_packs_security_require_signature", False, raising=False
    )
    monkeypatch.setattr(
        vector_store_module, "EmbeddingModel", StubEmbeddingModel, raising=False
    )
    store = vector_store_module.VectorStore(
        db_path=str(tmp_path / "db"), embedding_model="stub"
    )
    monkeypatch.setattr(
        api_server, "pack_manager", PackManager(store, packs_root=tmp_path / "packs")
    )

    client = TestClient(api_server.app, raise_server_exceptions=False)
    response = client.post(
        "/packs/install",
        files={"file": ("blocker.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 409, response.text
    assert "correlation_id" not in response.json()


# --------------------------------------------------------------------------- #
# Malformed shapes must refuse typed too, not crash into a 500
# --------------------------------------------------------------------------- #


def test_a_non_object_pack_json_is_refused_typed():
    """Round-2 blocker. `semantic_problems` dereferences `manifest["docs"]`, so a
    top-level list/scalar/null raised `AttributeError` and the route answered an
    unhandled 500 — the exact symptom #226 documents."""
    from pack_extract import canonical_manifest_bytes

    for raw in (b"[1,2,3]", b'"a string"', b"null", b"42"):
        with pytest.raises(PackExtractError, match="must be a JSON object"):
            canonical_manifest_bytes(raw)


def test_a_pathologically_nested_manifest_is_refused_typed():
    """Round-2 blocker. `json.loads` raises `RecursionError` past ~1000 nesting
    levels; only `(UnicodeDecodeError, JSONDecodeError)` was caught, so the route
    answered an unhandled 500."""
    from pack_extract import canonical_manifest_bytes

    deep = b'{"a":1}'
    for _ in range(1400):
        deep = b'{"x":' + deep + b"}"
    with pytest.raises(PackExtractError, match="nested too deeply"):
        canonical_manifest_bytes(deep)


@pytest.mark.parametrize(
    "raw",
    [b"[1,2,3]", b'"a string"', b"null"],
    ids=["array", "scalar", "null"],
)
def test_the_install_route_answers_409_for_a_non_object_pack_json(
    monkeypatch, tmp_path, raw
):
    """The route-level proof for the non-object shape, on the default config."""
    from fastapi.testclient import TestClient

    import config
    import vector_store as vector_store_module
    from pack_manager import PackManager

    class StubEmbeddingModel:
        def __init__(self, model_name=None):
            self.model_name = model_name or "stub"

        def encode(self, texts):
            return [[0.1] * 384 for _ in texts]

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("pack.json", raw)
        archive.writestr("docs/doc-1.json", '{"title": "doc", "text": "hello"}')

    settings = config.get_settings()
    monkeypatch.setattr(
        settings, "rag_packs_security_require_signature", False, raising=False
    )
    monkeypatch.setattr(
        vector_store_module, "EmbeddingModel", StubEmbeddingModel, raising=False
    )
    store = vector_store_module.VectorStore(
        db_path=str(tmp_path / "db"), embedding_model="stub"
    )
    monkeypatch.setattr(
        api_server, "pack_manager", PackManager(store, packs_root=tmp_path / "packs")
    )

    response = TestClient(api_server.app, raise_server_exceptions=False).post(
        "/packs/install",
        files={"file": ("pack.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 409, response.text
    assert "correlation_id" not in response.json()


def test_the_install_route_answers_409_for_a_pathologically_nested_pack_json(
    monkeypatch, tmp_path
):
    from fastapi.testclient import TestClient

    import config
    import vector_store as vector_store_module
    from pack_manager import PackManager

    class StubEmbeddingModel:
        def __init__(self, model_name=None):
            self.model_name = model_name or "stub"

        def encode(self, texts):
            return [[0.1] * 384 for _ in texts]

    deep = b'{"a":1}'
    for _ in range(1400):
        deep = b'{"x":' + deep + b"}"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("pack.json", deep)
        archive.writestr("docs/doc-1.json", '{"title": "doc", "text": "hello"}')

    settings = config.get_settings()
    monkeypatch.setattr(
        settings, "rag_packs_security_require_signature", False, raising=False
    )
    monkeypatch.setattr(
        vector_store_module, "EmbeddingModel", StubEmbeddingModel, raising=False
    )
    store = vector_store_module.VectorStore(
        db_path=str(tmp_path / "db"), embedding_model="stub"
    )
    monkeypatch.setattr(
        api_server, "pack_manager", PackManager(store, packs_root=tmp_path / "packs")
    )

    response = TestClient(api_server.app, raise_server_exceptions=False).post(
        "/packs/install",
        files={"file": ("pack.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 409, response.text
    assert "correlation_id" not in response.json()
