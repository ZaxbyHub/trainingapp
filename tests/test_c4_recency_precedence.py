"""C4 (issue #71) ranking-layer precedence tests: AC1, AC2, reranker interplay.

Frozen check drivers repro/check-c1.sh (``-k ac1``) and repro/check-c2.sh
(``-k ac2``) select the tests here by keyword.
"""

import json
import shutil
import sys
import unittest.mock as mock
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import vector_store as vector_store_module  # noqa: E402
from pack_manager import PackManager  # noqa: E402

# Bind through the SAME module object we patch below: tests/conftest.py's
# mock_embedding_model teardown does `del sys.modules["vector_store"]`, so a
# string-based mock.patch would re-import a fresh module and miss the class
# this file's VectorStore binding actually uses.
VectorStore = vector_store_module.VectorStore

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "contracts" / "fixtures" / "packs"


class StubEmbeddingModel:
    def __init__(self, model_name=None):
        self.model_name = model_name or "stub"

    def encode(self, texts):
        return [[0.1] * 384 for _ in texts]

    def encode_single(self, text):
        return [0.1] * 384


def make_store(tmp_path: Path) -> VectorStore:
    with mock.patch.object(vector_store_module, "EmbeddingModel", StubEmbeddingModel):
        return VectorStore(db_path=str(tmp_path / "db"), embedding_model="stub")


def make_manager(tmp_path: Path) -> PackManager:
    store = make_store(tmp_path)
    pm = PackManager(store, packs_root=tmp_path / "packs")
    # Wire the C4 pack-status provider exactly as RAGEngine does in
    # production (rag_engine._pack_status_provider).
    store.pack_status_provider = lambda: pm.active_pack_claims()
    return pm


def copy_fixture(name: str, dest: Path) -> Path:
    target = dest / name
    shutil.copytree(FIXTURES / name, target)
    return target


def fixture_query_text(pack_name: str) -> str:
    manifest = json.loads(
        (FIXTURES / pack_name / "pack.json").read_text(encoding="utf-8")
    )
    doc_rel = manifest["docs"][0]["path"]
    mime = manifest["docs"][0].get("mime", "text/plain")
    raw = (FIXTURES / pack_name / doc_rel).read_text(encoding="utf-8")
    if mime == "application/json":
        return json.loads(raw)["text"]
    return raw


def set_all_rows_active(pm: PackManager) -> None:
    rows = pm._rows()
    for row in rows:
        row["active"] = True
    pm._save_rows(rows)


def active_versions(pm: PackManager, pack_id: str):
    return sorted(
        row["version"]
        for row in pm._rows()
        if row["pack_id"] == pack_id and row.get("active")
    )


def citations_of(store: VectorStore, query: str):
    _context, _sources, chunks = store.get_context(
        query, n_results=5, hybrid_search=True
    )
    return chunks


# ------------------------------------------------------------------ #
# AC1 — newer version wins with BOTH versions installed as active
# ------------------------------------------------------------------ #


def test_ac1_semver_tie_break_returns_v2_top_citation(tmp_path, monkeypatch):
    """versioned-a v1+v2 both engineered active: the top result must carry
    pack_version 2.0.0 even though the fixtures share one published_at (the
    semver tie-break decides)."""
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    v1 = copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)
    set_all_rows_active(pm)
    assert active_versions(pm, "versioned-a") == ["1.0.0", "2.0.0"]

    query = fixture_query_text("versioned-a-2.0.0")[:200]
    chunks = citations_of(pm.store, query)
    assert chunks, "expected retrieval results for fixture content"
    top = chunks[0]
    assert top.pack_version == "2.0.0"
    assert top.pack_id == "versioned-a"


def test_ac1_install_order_independence_via_winner_attribution(tmp_path):
    """Flipping the physical row's metadata to the OLD version must not
    change the citation: attribution comes from the precedence winner among
    the ACTIVE registry claims, not from possibly-stale chunk metadata."""
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    v1 = copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)
    set_all_rows_active(pm)

    # Simulate the row having been (re)written under v1: the naive ranking
    # would then cite 1.0.0; the claims-based winner must still say 2.0.0.
    store = pm.store
    store.collection.update(
        ids=store.collection.get()["ids"],
        metadatas=[
            dict(meta, pack_version="1.0.0")
            for meta in store.collection.get(include=["metadatas"])["metadatas"]
        ],
    )

    query = fixture_query_text("versioned-a-2.0.0")[:200]
    chunks = citations_of(store, query)
    assert chunks
    assert chunks[0].pack_version == "2.0.0"


# ------------------------------------------------------------------ #
# AC2 — inactive-pack chunks excluded (defense-in-depth at ranking)
# ------------------------------------------------------------------ #


def test_ac2_orphan_of_superseded_version_excluded(tmp_path):
    """After supersede v1 -> v2, a hand-re-added stale chunk carrying v1
    metadata whose doc NO active version claims must never surface."""
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    v1 = copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)
    store = pm.store

    stale_text = "quasar abacus superseded-v1-only zebra quantum ledger falcon"
    stale_doc = "sha-of-doc-removed-in-v2"
    store.add_chunks_with_embeddings(
        [
            {
                "chunk_id": "stale-orphan-chunk-0001",
                "text": stale_text,
                "embedding": StubEmbeddingModel().encode_single(stale_text),
                "metadata": {
                    "source": "versioned-a/removed-v1.json",
                    "doc_id": stale_doc,
                    "chunk_index": 0,
                    "pack_id": "versioned-a",
                    "pack_version": "1.0.0",
                    "content_hash": "deadbeef",
                },
            }
        ],
        on_conflict="replace",
    )

    _ctx, _sources, chunks = store.get_context(
        stale_text, n_results=5, hybrid_search=True
    )
    for chunk in chunks:
        assert not (
            chunk.pack_version == "1.0.0" and chunk.text == stale_text
        ), "stale v1-attributed chunk surfaced through ranking"


def test_ac2_stale_shared_content_reattributed_to_active_version(tmp_path):
    """A stale duplicate of content the ACTIVE version also ships is
    re-attributed to the active claim: the citation never shows the stale
    version string."""
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    v1 = copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)
    store = pm.store

    manifest = json.loads(
        (FIXTURES / "versioned-a-2.0.0" / "pack.json").read_text(encoding="utf-8")
    )
    active_doc_sha = manifest["docs"][0]["sha256"]
    stale_text = "duplikat limpet override stale v1 helium candle tungsten"
    store.add_chunks_with_embeddings(
        [
            {
                "chunk_id": "stale-dup-chunk-0002",
                "text": stale_text,
                "embedding": StubEmbeddingModel().encode_single(stale_text),
                "metadata": {
                    "source": "versioned-a/overlap.json",
                    "doc_id": active_doc_sha,
                    "chunk_index": 0,
                    "pack_id": "versioned-a",
                    "pack_version": "1.0.0",
                    "content_hash": "feedface",
                },
            }
        ],
        on_conflict="replace",
    )

    _ctx, _sources, chunks = store.get_context(
        stale_text, n_results=5, hybrid_search=True
    )
    assert chunks
    for chunk in chunks:
        if chunk.text == stale_text:
            assert chunk.pack_version == "2.0.0"


# ------------------------------------------------------------------ #
# Reranker interplay (plan R9): prior must not double-multiply
# ------------------------------------------------------------------ #


def test_hybrid_reranker_overrides_prior_no_double_mul(tmp_path):
    """With a reranker attached, reranker scores REPLACE prior-adjusted
    scores (no multiplication leakage into the reranker scale)."""
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    v1 = copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)
    set_all_rows_active(pm)

    class LinearReranker:
        def rerank(self, question, chunks, top_k):
            # Reversal score: first chunk gets the LOWEST score so a
            # double-multiplied prior would visibly change the order.
            ordered = list(chunks)
            scores = [
                0.1 * (index + 1) / len(ordered) for index in range(len(ordered))
            ][::-1]
            pairs = list(zip(ordered, scores))
            pairs.sort(key=lambda pair: pair[1], reverse=True)
            return pairs[:top_k]

    engine_like = {"reranker": LinearReranker()}
    from rag_engine import RAGConfig, RAGEngine

    with mock.patch("vector_store.EmbeddingModel", StubEmbeddingModel):
        config = RAGConfig(
            db_path=str(pm.store.db_path),
            reranking_enabled=True,
            reranker_model="stub",
        )
        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.gguf_path = None
        engine.llm = None  # answer falls back; only retrieved_chunks matter
        engine.llm_init_error = "test stub"
        engine._query_transformer = None
        engine._query_transformer_failed = False
        engine._init_lock = __import__("threading").Lock()

        class FakeLLM:
            def generate(self, prompt, **kwargs):
                return {
                    "response": "stub answer",
                    "prompt_eval_count": 1,
                    "eval_count": 1,
                }

            def answer_question(self, *args, **kwargs):
                return "stub answer"

        engine.llm = FakeLLM()
        engine.reranker = engine_like["reranker"]
        engine.vector_store = pm.store
        engine._pack_status_provider = lambda: pm.active_pack_claims()
        result = engine.query(fixture_query_text("versioned-a-2.0.0")[:200])
    assert result.retrieved_chunks, "reranked query returned no chunks"
    # The reranker's scale (<= 0.1) must appear verbatim in the chunk scores.
    scores = [chunk["score"] for chunk in result.retrieved_chunks if "score" in chunk]
    assert scores and all(0.0 < s <= 0.1000001 for s in scores)


@pytest.mark.parametrize("query_len", [3, 200], ids=["short-query", "full-query"])
def test_hybrid_prior_smoke_with_claims(tmp_path, query_len):
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    v1 = copy_fixture("versioned-a-1.0.0", ws / "src")
    v2 = copy_fixture("versioned-a-2.0.0", ws / "src")
    pm.install(v1)
    pm.install(v2)
    set_all_rows_active(pm)
    query = fixture_query_text("versioned-a-2.0.0")[:query_len]
    chunks = citations_of(pm.store, query)
    assert all(chunk.pack_id in (None, "versioned-a") for chunk in chunks)


# ------------------------------------------------------------------ #
# Phase 4.2 guardrail: the BM25 leg must carry pack metadata at BOTH
# build sites (incremental add + lazy rebuild) and through the
# retrieval-window neighbor expansion. This is the regression family for
# the defect class "a retrieval leg reconstructs result objects from
# stored metadata and silently drops fields added to the metadata
# schema" — the exact bug the pre-C4 BM25 leg had.
# ------------------------------------------------------------------ #


def test_hybrid_bm25_leg_carries_pack_metadata(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    pm.install(copy_fixture("versioned-a-1.0.0", ws / "src"))
    store = pm.store

    # Incremental-add site: chunks added via add_chunks_with_embeddings
    # must reach the BM25 index with their pack attribution intact.
    incremental = [c for c in store.bm25_index.chunks if c.pack_id == "versioned-a"]
    assert incremental, "incremental BM25 add dropped pack metadata"
    sample = incremental[0]
    assert sample.pack_version == "1.0.0"
    assert sample.pack_published_at == "2026-09-16T00:00:00Z"
    assert sample.chunk_id

    # Lazy-rebuild site: forcing the full rebuild must preserve the fields.
    store._bm25_needs_rebuild = True
    store._rebuild_bm25_if_needed()
    rebuilt = [c for c in store.bm25_index.chunks if c.pack_id == "versioned-a"]
    assert rebuilt, "lazy BM25 rebuild dropped pack metadata"
    assert rebuilt[0].pack_version == "1.0.0"
    assert rebuilt[0].pack_published_at == "2026-09-16T00:00:00Z"


def test_hybrid_window_neighbors_inherit_pack_attribution(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    pm = make_manager(ws)
    pm.install(copy_fixture("versioned-a-1.0.0", ws / "src"))
    store = pm.store
    query = fixture_query_text("versioned-a-1.0.0")[:200]
    _ctx, _sources, chunks = store.get_context(
        query, n_results=3, hybrid_search=True, retrieval_window=1
    )
    assert chunks
    for chunk in chunks:
        if chunk.source.startswith("versioned-a/"):
            assert chunk.pack_id == "versioned-a"
            assert chunk.pack_version == "1.0.0"
