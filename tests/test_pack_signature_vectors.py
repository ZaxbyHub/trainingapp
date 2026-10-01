"""Shared pack-signature vectors, Python leg (trace browser-training-parity AC2).

contracts/pack-signature-vectors.json is consumed identically by the desktop
(desktop/src/__tests__/pack-signature-vectors.test.ts, node:crypto) and the
browser (web_ui/src/lib/packs/__tests__/pack-signature-vectors.test.ts,
WebCrypto) suites: all three verifiers must reach the recorded verdict for
every vector and produce the recorded canonical bytes.
"""

import base64
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pack_extract import (  # noqa: E402
    PackExtractError,
    TrustedKey,
    canonical_manifest_bytes,
    verify_pack_signature,
)

VECTORS = json.loads((ROOT / "contracts" / "pack-signature-vectors.json").read_text(encoding="utf-8"))


def _verdict(vector) -> bool:
    keys = tuple(TrustedKey(key_id=k["key_id"], public_key=k["public_key"]) for k in vector["trusted"])
    try:
        verify_pack_signature(base64.b64decode(vector["manifest_b64"]), vector["signature"], keys)
    except PackExtractError:
        return False
    return True


def test_vectors_are_not_vacuous():
    oks = [v["ok"] for v in VECTORS["vectors"]]
    assert any(oks)
    assert oks.count(False) > 10


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["id"])
def test_signature_verdict_matches_shared_vector(vector):
    assert _verdict(vector) is vector["ok"]


@pytest.mark.parametrize("case", VECTORS["canonical"], ids=lambda c: c["id"])
def test_canonical_bytes_match_shared_vector(case):
    assert canonical_manifest_bytes(base64.b64decode(case["manifest_b64"])).hex() == case["canonical_hex"]
