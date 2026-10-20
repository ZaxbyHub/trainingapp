"""A trusted keyset with two entries under one key_id is refused (issue #225).

The maintainer decision on #225 rejects the alternative reading of the issue's
original AC. That AC asked the TS twins to adopt python's all-keys-per-key_id
loop, which would have traded the TS false-reject side for python's
false-accept side: a retired key that reuses a key_id would then VERIFY. The
decision instead makes a duplicated key_id a CONFIGURATION error, refused
wherever it is detected, so the ambiguous case never reaches a gate.

Two enforcement points, both covered here:

- CONFIG LOAD, in `limits_from_settings`, so a bad keyset cannot sit latent
  until the first signed pack arrives.
- The GATE, in `verify_pack_signature`, because `trusted_keys` is a parameter.
  A caller that builds the tuple itself bypasses the load-time refusal.

The PRESERVING half matters just as much: with unique key_ids nothing about
the verdict may move. `test_a_unique_key_id_still_verifies` reuses a real
signed vector from the committed corpus rather than a synthetic key, so it
fails if the refusal was ever placed after the point where it should have been
skipped, or if it leaked into the normal path.
"""

import base64
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pack_extract  # noqa: E402
from pack_extract import (  # noqa: E402
    PackExtractError,
    TrustedKey,
    duplicate_trusted_key_id,
    limits_from_settings,
    verify_pack_signature,
)

VECTORS = json.loads(
    (ROOT / "contracts" / "pack-signature-vectors.json").read_text(encoding="utf-8")
)

# A key_id that appears twice. The public_key values are deliberately NOT valid
# DER SPKI: the refusal must fire before any key material is parsed, and these
# tests prove that ordering rather than assuming it.
AMBIGUOUS = (
    TrustedKey(key_id="dup", public_key="not-a-key-1"),
    TrustedKey(key_id="dup", public_key="not-a-key-2"),
)


def _keys(*specs):
    return tuple(TrustedKey(key_id=k, public_key=p) for k, p in specs)


# --------------------------------------------------------------------------
# The helper itself
# --------------------------------------------------------------------------


def test_duplicate_helper_returns_the_repeated_id():
    assert duplicate_trusted_key_id(AMBIGUOUS) == "dup"


def test_duplicate_helper_returns_none_for_unique_ids():
    assert duplicate_trusted_key_id(_keys(("a", "x"), ("b", "y"))) is None


def test_duplicate_helper_returns_none_for_empty():
    assert duplicate_trusted_key_id(()) is None


def test_duplicate_helper_reports_the_second_occurrence_not_the_first():
    # Three entries, the repeat in the middle: the answer must be the id, not a
    # position, and not the first entry's key.
    keys = _keys(("a", "x"), ("b", "y"), ("b", "z"))
    assert duplicate_trusted_key_id(keys) == "b"


def test_duplicate_helper_is_not_vacuous_on_a_single_pair():
    # A guard that returned None for everything would pass the unique case; this
    # pins that the same shape with one character changed flips the answer.
    assert duplicate_trusted_key_id(_keys(("a", "x"), ("a", "x"))) == "a"
    assert duplicate_trusted_key_id(_keys(("a", "x"), ("b", "x"))) is None


def test_duplicate_helper_tolerates_a_keyset_with_no_duplicates_and_many_entries():
    keys = _keys(*[(f"k{i}", "v") for i in range(50)])
    assert duplicate_trusted_key_id(keys) is None


# --------------------------------------------------------------------------
# The gate refuses an ambiguous keyset
# --------------------------------------------------------------------------


def test_gate_refuses_an_ambiguous_keyset():
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(
            b"{}", {"algorithm": "ed25519", "key_id": "dup", "value": "AA=="}, AMBIGUOUS
        )
    message = str(excinfo.value)
    assert "dup" in message
    assert "ambiguous" in message


def test_gate_refusal_precedes_key_material_parsing():
    """The refusal is a CONFIGURATION fault, so it must not depend on - or be
    reported as - a problem with this signature. A keyset with a duplicate
    key_id AND unusable key material still yields the ambiguity message."""
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(
            b"{}",
            {"algorithm": "ed25519", "key_id": "dup", "value": "AA=="},
            AMBIGUOUS,
        )
    assert "ambiguous" in str(excinfo.value)


def test_gate_refuses_even_when_the_signature_names_no_known_key():
    # A signature naming an absent key_id would be refused anyway, but for a
    # different reason. The ambiguous keyset must be reported as the
    # configuration error it is, so the operator fixes the config rather than
    # hunting for a signing problem.
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(
            b"{}",
            {"algorithm": "ed25519", "key_id": "absent", "value": "AA=="},
            AMBIGUOUS,
        )
    assert "ambiguous" in str(excinfo.value)


def test_gate_refuses_even_for_a_malformed_signature_block():
    # Ordering in the other direction: the ambiguity check runs before the
    # signature block is inspected.
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(b"{}", "not-a-signature-block", AMBIGUOUS)
    assert "ambiguous" in str(excinfo.value)


def test_gate_accepts_a_unique_keyset_shape_untouched():
    """CONTROL: the ambiguity refusal must not fire on a well-formed keyset.

    Uses the same invalid public_key as the ambiguous cases, so this passing
    proves the refusal keys on the DUPLICATE and not on the key material.
    """
    unique = _keys(("dup", "not-a-key-1"))
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(
            b"{}", {"algorithm": "ed25519", "key_id": "dup", "value": "AA=="}, unique
        )
    assert "ambiguous" not in str(excinfo.value)


# --------------------------------------------------------------------------
# Config load refuses an ambiguous keyset
# --------------------------------------------------------------------------


class _Settings:
    """The narrow slice of settings `limits_from_settings` reads."""

    def __init__(self, raw_keys):
        self.rag_packs_security_trusted_keys = raw_keys
        self.rag_packs_security_require_signature = True
        self.rag_packs_security_max_uncompressed_bytes = 1
        self.rag_packs_security_max_entries = 1
        self.rag_packs_security_max_compression_ratio = 1.0


def _load(raw_keys, monkeypatch):
    import config

    monkeypatch.setattr(config, "get_settings", lambda: _Settings(raw_keys))
    return limits_from_settings()


def test_config_load_refuses_a_duplicated_key_id(monkeypatch):
    raw = json.dumps(
        [
            {"key_id": "k", "public_key": "AAA"},
            {"key_id": "k", "public_key": "BBB"},
        ]
    )
    with pytest.raises(PackExtractError) as excinfo:
        _load(raw, monkeypatch)
    message = str(excinfo.value)
    assert "RAG_PACKS_SECURITY_TRUSTED_KEYS" in message
    assert "'k'" in message


def test_config_load_refuses_a_duplicate_anywhere_in_the_list(monkeypatch):
    raw = json.dumps(
        [
            {"key_id": "a", "public_key": "AAA"},
            {"key_id": "b", "public_key": "BBB"},
            {"key_id": "a", "public_key": "CCC"},
        ]
    )
    with pytest.raises(PackExtractError):
        _load(raw, monkeypatch)


def test_config_load_still_accepts_unique_key_ids(monkeypatch):
    raw = json.dumps(
        [
            {"key_id": "a", "public_key": "AAA"},
            {"key_id": "b", "public_key": "BBB"},
        ]
    )
    limits = _load(raw, monkeypatch)
    assert [key.key_id for key in limits.trusted_keys] == ["a", "b"]


def test_config_load_refusal_is_a_typed_refusal_not_a_bare_exception(monkeypatch):
    """It must be PackExtractError so the install route maps it to the
    documented 409 rather than answering 500 (the #226 contract)."""
    raw = json.dumps(
        [{"key_id": "k", "public_key": "A"}, {"key_id": "k", "public_key": "B"}]
    )
    with pytest.raises(pack_extract.PackExtractError):
        _load(raw, monkeypatch)


# --------------------------------------------------------------------------
# PRESERVING: the normal case is unmoved
# --------------------------------------------------------------------------


def _ok_vector():
    for vector in VECTORS["vectors"]:
        if vector["ok"]:
            return vector
    raise AssertionError("the committed corpus has no accepting vector")


def test_a_unique_key_id_still_verifies():
    """Real signed data from the committed corpus, with the same key_id the
    corpus uses. If the duplicate refusal leaked into the normal path this
    fails."""
    vector = _ok_vector()
    keys = tuple(
        TrustedKey(key_id=k["key_id"], public_key=k["public_key"])
        for k in vector["trusted"]
    )
    assert len({k.key_id for k in keys}) == len(
        keys
    ), "the corpus vector must have unique ids"
    verify_pack_signature(
        base64.b64decode(vector["manifest_b64"]), vector["signature"], keys
    )


def test_an_untrusted_key_id_is_still_refused_as_before():
    vector = _ok_vector()
    keys = tuple(
        TrustedKey(key_id="some-other-id", public_key=k["public_key"])
        for k in vector["trusted"]
    )
    with pytest.raises(PackExtractError) as excinfo:
        verify_pack_signature(
            base64.b64decode(vector["manifest_b64"]), vector["signature"], keys
        )
    assert "ambiguous" not in str(excinfo.value)


def test_python_keeps_its_all_keys_loop():
    """The decision did NOT ask python to change its matching loop. With a
    duplicate refused upstream the loop can never see more than one match, so
    it is now unreachable-but-harmless, and leaving it in place preserves the
    property for any caller that builds trusted_keys directly."""
    source = (ROOT / "pack_extract.py").read_text(encoding="utf-8")
    assert "matching = [key for key in trusted_keys if key.key_id == key_id]" in source
    assert "for key in matching:" in source
