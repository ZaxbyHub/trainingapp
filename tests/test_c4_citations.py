"""C4 (issue #71) citation tests: /ask responses carry pack-attributed
citations; unpackaged documents yield null pack fields.

Frozen check driver repro/check-c10.sh runs this file (plus a grep pinning
pack_published_at in contracts/api.openapi.yaml).
"""

import sys
import types
import unittest.mock as mock
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

sys.modules.setdefault("llama_cpp", mock.MagicMock())

from fastapi.testclient import TestClient  # noqa: E402

import api_server  # noqa: E402
from api_server import app  # noqa: E402

client = TestClient(app)


def make_result(pack_fields, source="docs/pack-doc.json"):
    """A QueryResult stand-in whose retrieved_chunks carry pack fields."""
    chunk = {
        "source_display": source,
        "doc_id": "sha-1",
        "source_path": None,
        "page": 3,
        "chunk_index": 0,
        "snippet": "alpha beta gamma",
        **pack_fields,
    }
    return types.SimpleNamespace(
        question="q",
        answer="a",
        sources=[source],
        context_length=10,
        inference_time=0.5,
        learn=[],
        retrieved_chunks=[chunk],
    )


def ask(monkeypatch, result):
    engine = types.SimpleNamespace(llm=object(), query=lambda *a, **k: result)
    monkeypatch.setattr(api_server, "engine", engine, raising=False)
    return client.post("/ask", json={"question": "alpha beta"})


def test_ask_citations_carry_pack_fields(monkeypatch):
    result = make_result(
        {
            "pack_id": "versioned-a",
            "pack_version": "2.0.0",
            "pack_published_at": "2026-09-16T00:00:00Z",
        }
    )
    response = ask(monkeypatch, result)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["citations"], "citations missing from /ask response"
    top = body["citations"][0]
    assert top["source"] == "docs/pack-doc.json"
    assert top["page"] == 3
    assert top["pack_id"] == "versioned-a"
    assert top["pack_version"] == "2.0.0"
    assert top["pack_published_at"] == "2026-09-16T00:00:00Z"


def test_ask_citations_null_for_unpackaged(monkeypatch):
    response = ask(
        monkeypatch,
        make_result(
            {"pack_id": None, "pack_version": None, "pack_published_at": None},
            source="notes.txt",
        ),
    )
    assert response.status_code == 200
    top = response.json()["citations"][0]
    assert top["source"] == "notes.txt"
    assert top["pack_id"] is None
    assert top["pack_version"] is None
    assert top["pack_published_at"] is None


def test_ask_without_chunks_omits_or_empties_citations(monkeypatch):
    result = make_result(
        {"pack_id": None, "pack_version": None, "pack_published_at": None}
    )
    result.retrieved_chunks = []
    response = ask(monkeypatch, result)
    assert response.status_code == 200
    assert response.json().get("citations") in ([], None)


def test_stream_done_payload_carries_citations(monkeypatch):
    """The /ask/stream terminal done event carries the citations key
    (additive) alongside the frozen sources/context_length keys."""
    result = make_result(
        {
            "pack_id": "p-train",
            "pack_version": "1.0.0",
            "pack_published_at": "2026-09-14T00:00:00Z",
        }
    )
    engine = types.SimpleNamespace(llm=object(), query=lambda *a, **k: result)
    monkeypatch.setattr(api_server, "engine", engine, raising=False)

    seen_done = []
    with client.stream(
        "POST", "/ask/stream", json={"question": "alpha beta"}
    ) as response:
        assert response.status_code == 200
        for line in response.iter_lines():
            if not line.startswith("data:"):
                continue
            import json

            payload = json.loads(line[len("data:") :].strip())
            if isinstance(payload, dict) and payload.get("done"):
                seen_done.append(payload)
    assert seen_done, "no done event observed"
    done = seen_done[-1]
    assert done["sources"] == ["docs/pack-doc.json"]
    assert done["citations"][0]["pack_id"] == "p-train"


def test_openapi_declares_citation_schema():
    """contracts/ stays authoritative: the Citation schema with
    pack_published_at is declared and referenced by QuestionResponse."""
    import re

    yaml_text = (
        Path(__file__).resolve().parents[1] / "contracts" / "api.openapi.yaml"
    ).read_text(encoding="utf-8")
    assert "pack_published_at" in yaml_text
    assert re.search(r"Citation:", yaml_text)
    assert "citations" in yaml_text
