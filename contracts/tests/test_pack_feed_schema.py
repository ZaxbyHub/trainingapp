"""Feed-schema validation (E5, issue #88).

Paired contract test for contracts/pack-feed.schema.json, mirroring the house
pattern of test_pack_schema.py: the schema FILE is the single source of truth
and this suite only proves the fixtures satisfy/refuse it. CI runs it from the
store-interop job next to test_pack_schema.py.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

CONTRACTS = Path(__file__).resolve().parent.parent
SCHEMA_PATH = CONTRACTS / "pack-feed.schema.json"
FEED_FIXTURES = CONTRACTS / "fixtures" / "feeds"
VALID_FEED = FEED_FIXTURES / "valid-pack-feed.json"
INVALID_FEED = FEED_FIXTURES / "invalid-bad-sha256.json"


@pytest.fixture(scope="module")
def validator():
    from jsonschema import Draft202012Validator

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def test_schema_exists_and_compiles(validator) -> None:
    assert validator is not None


def test_valid_feed_fixture_satisfies_schema(validator) -> None:
    document = json.loads(VALID_FEED.read_text(encoding="utf-8"))
    problems = sorted(validator.iter_errors(document), key=lambda e: e.path)
    assert problems == []


def test_invalid_feed_fixture_is_refused(validator) -> None:
    document = json.loads(INVALID_FEED.read_text(encoding="utf-8"))
    assert list(validator.iter_errors(document)) != []


def test_unsigned_feed_entry_is_refused(validator) -> None:
    """The feed format itself cannot express an unsigned entry: the signature
    block is REQUIRED at the contract layer (no unsigned fallback, issue
    #88)."""
    document = json.loads(VALID_FEED.read_text(encoding="utf-8"))
    entry = document["packs"][0]["versions"][0]
    del entry["signature"]
    assert list(validator.iter_errors(document)) != []


def test_http_download_url_is_refused(validator) -> None:
    document = json.loads(VALID_FEED.read_text(encoding="utf-8"))
    document["packs"][0]["versions"][0][
        "download_url"
    ] = "http://example.invalid/pack.zip"
    assert list(validator.iter_errors(document)) != []
