"""C5 (issue #72) grounded/general provenance tests.

Covers the /ask and /ask/stream `grounding` field on the Python backend, the
grounding_for_result resolution rule (engine stamp vs evidence-emptiness
derivation for stub engines), and the AC3 regression: a chunk excluded by C4
version precedence must not count toward "grounded" even though it would
clear the relevance floor in isolation.
"""

import asyncio
import json
import shutil
import sys
import unittest.mock as mock
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api_server  # noqa: E402
import vector_store as vector_store_module  # noqa: E402
from pack_manager import PackManager  # noqa: E402
from rag_engine import (  # noqa: E402
    GROUNDING_GENERAL,
    GROUNDING_GROUNDED,
    QueryResult,
    grounding_for_result,
)

pytestmark = pytest.mark.unit

VectorStore = vector_store_module.VectorStore

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "contracts" / "fixtures" / "packs"


# ------------------------------------------------------------------ #
# Stub engines (bypass rag_engine.query — same technique the frozen
# acceptance checks use, so this also pins the api_server derivation
# path the conformance suite depends on).
# ------------------------------------------------------------------ #


class _StubEngineBase:
    llm = mock.MagicMock()

    def __init__(self, result: QueryResult, tokens=()):
        self._result = result
        self._tokens = tokens

    def query(
        self,
        question,
        n_results=6,
        stream_callback=None,
        conversation_history=None,
        cancellation_event=None,
    ):
        if stream_callback:
            for tok in self._tokens:
                stream_callback(tok)
        return self._result


def _grounded_result() -> QueryResult:
    return QueryResult(
        question="What is the travel meal cap?",
        answer="Meals are capped at 50 per day.",
        sources=["travel-policy.md"],
        context_length=128,
        inference_time=0.25,
        chunks_retrieved=1,
        retrieved_chunks=[
            {"source_display": "travel-policy.md", "page": 1, "score": 0.81}
        ],
    )


def _empty_result() -> QueryResult:
    return QueryResult(
        question="What is the capital of Meridia?",
        answer="I couldn't find any relevant information in the documents.",
        sources=[],
        context_length=0,
        inference_time=0.1,
        chunks_retrieved=0,
    )


def _post_ask(engine, question="What is the travel meal cap?"):
    old = api_server.engine
    api_server.engine = engine
    try:
        client = TestClient(api_server.app)
        return client.post("/ask", json={"question": question})
    finally:
        api_server.engine = old


def _post_stream(engine, question="What is the travel meal cap?"):
    import httpx

    old = api_server.engine
    api_server.engine = engine
    try:

        async def _run():
            transport = httpx.ASGITransport(app=api_server.app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                return await client.post("/ask/stream", json={"question": question})

        return asyncio.run(_run())
    finally:
        api_server.engine = old


def _parse_sse(raw: str):
    events = []
    for block in raw.replace("\r\n", "\n").split("\n\n"):
        block = block.strip()
        if not block:
            continue
        data = None
        for line in block.splitlines():
            if line.startswith("data:"):
                data = line.split(":", 1)[1].strip()
        if data is not None:
            try:
                data = json.loads(data)
            except (ValueError, TypeError):
                pass
        events.append(data)
    return [p for p in events if isinstance(p, dict)]


def _single_done(events):
    terminals = [p for p in events if "done" in p or "error" in p]
    assert len(terminals) == 1, f"expected one terminal, got {len(terminals)}"
    return terminals[0]


# ------------------------------------------------------------------ #
# API surface: grounded / general / cancelled
# ------------------------------------------------------------------ #


def test_ask_grounded_result_emits_grounding_grounded():
    resp = _post_ask(_StubEngineBase(_grounded_result(), tokens=("hello ",)))
    assert resp.status_code == 200
    assert resp.json()["grounding"] == "grounded"


def test_ask_empty_evidence_emits_grounding_general():
    resp = _post_ask(_StubEngineBase(_empty_result(), tokens=("hmm ",)))
    assert resp.status_code == 200
    assert resp.json()["grounding"] == "general"


def test_ask_stream_done_emits_grounded():
    engine = _StubEngineBase(_grounded_result(), tokens=("Meals ", "capped."))
    done = _single_done([p for p in _parse_sse(_post_stream(engine).text)])
    assert done.get("done") is True
    assert done["grounding"] == "grounded"


def test_ask_stream_done_emits_general_when_no_evidence():
    engine = _StubEngineBase(_empty_result(), tokens=("Nothing ", "found."))
    done = _single_done([p for p in _parse_sse(_post_stream(engine).text)])
    assert done.get("done") is True
    assert done["grounding"] == "general"


def test_ask_stream_cancelled_terminal_emits_general():
    from llm_interface import QueryCancelled

    class CancelEngine(_StubEngineBase):
        def query(self, *args, **kwargs):
            cb = kwargs.get("stream_callback")
            if cb:
                cb("partial ")
            raise QueryCancelled()

    done = _single_done(
        [p for p in _parse_sse(_post_stream(CancelEngine(_grounded_result())).text)]
    )
    assert done.get("cancelled") is True
    assert done["grounding"] == "general"


def test_cancelled_sentinel_result_resolves_general():
    """rag_engine swallows QueryCancelled into a sentinel QueryResult with
    sources=[] — the resolved grounding must be "general" (nothing reached
    the answer as qualifying evidence)."""
    sentinel = QueryResult(
        question="q",
        answer="[Cancelled]",
        sources=[],
        context_length=0,
        inference_time=0.0,
        chunks_retrieved=3,
    )
    assert grounding_for_result(sentinel) == "general"


# ------------------------------------------------------------------ #
# grounding_for_result resolution rule
# ------------------------------------------------------------------ #


def test_resolution_stamped_value_wins():
    result = _grounded_result()
    result.grounding = GROUNDING_GENERAL
    assert grounding_for_result(result) == "general"


def test_resolution_invalid_stamp_falls_back_to_evidence():
    result = _grounded_result()
    result.grounding = "maybe"
    assert grounding_for_result(result) == "grounded"


def test_resolution_derives_from_retrieved_chunks_without_sources():
    result = QueryResult(
        question="q",
        answer="a",
        sources=[],
        context_length=5,
        inference_time=0.0,
        chunks_retrieved=1,
        retrieved_chunks=[{"source_display": "x.md"}],
    )
    assert grounding_for_result(result) == "grounded"


def test_resolution_constants_are_the_contract_enum():
    assert {GROUNDING_GROUNDED, GROUNDING_GENERAL} == {"grounded", "general"}


# ------------------------------------------------------------------ #
# AC3 — a C4-excluded (superseded) chunk must not count toward
# "grounded" even though it would clear the floor in isolation.
# ------------------------------------------------------------------ #


class _QueryOrthogonalEmbedding:
    """Content-keyed embedding stub: text containing a probe marker maps to
    a unit probe vector; everything else (the fixture chunks installed by
    PackManager) maps to an orthogonal background vector. similarity is
    ``1 - L2dist``, so background chunks score ~1-1.414 < 0.3 (below the
    floor) and probe-text chunks score 1.0 — the ONLY candidate above the
    floor is the hand-injected chunk whose text carries the marker."""

    def __init__(self, model_name=None):
        self.model_name = model_name or "stub"

    def _vec(self, text: str):
        if "quasar" in text or "epsilon" in text:
            return [1.0] + [0.0] * 383
        return [0.0, 1.0] + [0.0] * 382

    def encode(self, texts):
        return [self._vec(t) for t in texts]

    def encode_single(self, text):
        return self._vec(text)


def _make_store(tmp_path: Path, embedding_cls) -> VectorStore:
    with mock.patch.object(vector_store_module, "EmbeddingModel", embedding_cls):
        return VectorStore(db_path=str(tmp_path / "db"), embedding_model="stub")


def _copy_fixture(name: str, dest: Path) -> Path:
    target = dest / name
    shutil.copytree(FIXTURES / name, target)
    return target


def test_ac3_superseded_chunk_does_not_ground(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    store = _make_store(ws, _QueryOrthogonalEmbedding)
    pm = PackManager(store, packs_root=ws / "packs")
    store.pack_status_provider = lambda: pm.active_pack_claims()
    v1 = _copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = _copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)

    stale_text = "quasar abacus superseded-v1-only zebra quantum ledger falcon"
    stale_embedding = _QueryOrthogonalEmbedding().encode_single(stale_text)
    store.add_chunks_with_embeddings(
        [
            {
                "chunk_id": "stale-orphan-chunk-c5-0001",
                "text": stale_text,
                "embedding": stale_embedding,
                "metadata": {
                    "source": "versioned-a/removed-v1.json",
                    "doc_id": "sha-of-doc-removed-in-v2-c5",
                    "chunk_index": 0,
                    "pack_id": "versioned-a",
                    "pack_version": "1.0.0",
                    "content_hash": "deadbeef",
                },
            }
        ],
        on_conflict="replace",
    )

    # Counterfactual: in isolation (raw similarity search, before C4 pack
    # screening) the stale chunk clears the active relevance floor — it is
    # not excluded for relevance reasons.
    matches = store.search(stale_text, n_results=5)
    assert any(
        meta.get("doc_id") == "sha-of-doc-removed-in-v2-c5" and sim >= 0.3
        for _doc, meta, sim in matches
    ), "stale chunk should clear the floor before C4 screening"

    # Through the post-C4 evidence path the superseded chunk is excluded and
    # nothing else clears the floor, so the evidence set is empty and the
    # resolved provenance MUST be "general" — the excluded chunk did not
    # count toward grounded.
    context, sources, chunks = store.get_context(
        stale_text, n_results=5, hybrid_search=True
    )
    surfaced_ids = {getattr(chunk, "doc_id", None) for chunk in chunks}
    assert "sha-of-doc-removed-in-v2-c5" not in surfaced_ids
    result = QueryResult(
        question=stale_text,
        answer="answer",
        sources=sources,
        context_length=len(context or ""),
        inference_time=0.0,
        chunks_retrieved=len(chunks),
        retrieved_chunks=[{"source_display": chunk.source} for chunk in chunks],
    )
    assert grounding_for_result(result) == GROUNDING_GENERAL


def test_ac3_active_chunk_still_grounds(tmp_path):
    """Same store shape but the surviving ACTIVE chunk (same embedding as the
    query) must count toward grounded — guards against the exclusion rule
    over-suppressing."""
    ws = tmp_path / "ws"
    ws.mkdir()
    store = _make_store(ws, _QueryOrthogonalEmbedding)
    pm = PackManager(store, packs_root=ws / "packs")
    store.pack_status_provider = lambda: pm.active_pack_claims()
    v1 = _copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = _copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)

    active_text = "active v2 chunk clearance probe epsilon vector nomad"
    # The chunk must be claimed by an ACTIVE pack version to survive C4
    # screening, so it reuses the doc_id the installed v2 fixture actually
    # claims (read back from the store) rather than an invented one.
    claimed_doc_ids = {
        m.get("doc_id")
        for m in store.collection.get(include=["metadatas"])["metadatas"]
        if m.get("pack_id") == "versioned-a"
    }
    assert claimed_doc_ids, "fixture pack should have claimed docs"
    active_doc_id = sorted(claimed_doc_ids)[0]
    store.add_chunks_with_embeddings(
        [
            {
                "chunk_id": "active-v2-chunk-c5-0001",
                "text": active_text,
                "embedding": _QueryOrthogonalEmbedding().encode_single(active_text),
                "metadata": {
                    "source": "versioned-a/docs-v2.json",
                    "doc_id": active_doc_id,
                    "chunk_index": 99,
                    "pack_id": "versioned-a",
                    "pack_version": "2.0.0",
                    "content_hash": "cafe",
                },
            }
        ],
        on_conflict="replace",
    )

    _ctx, sources, chunks = store.get_context(
        active_text, n_results=5, hybrid_search=True
    )
    assert any(
        getattr(chunk, "doc_id", None) == active_doc_id
        and getattr(chunk, "pack_version", None) == "2.0.0"
        and getattr(chunk, "chunk_index", None) == 99
        for chunk in chunks
    ), "active v2 chunk should survive C4 screening"
    result = QueryResult(
        question=active_text,
        answer="answer",
        sources=sources,
        context_length=10,
        inference_time=0.0,
        chunks_retrieved=len(chunks),
        retrieved_chunks=[{"source_display": chunk.source} for chunk in chunks],
    )
    assert grounding_for_result(result) == GROUNDING_GROUNDED
