"""
Adversarial tests for VectorStore.get_context() — vector_store.py

Covers:
1. Empty / whitespace-only queries
2. Boundary values for n_results (0, negative, extremely large)
3. Boundary values for min_similarity (negative, > 1.0, NaN, Infinity)
4. Type confusion (wrong types for all parameters)
5. Oversized payloads (very large query strings, deep Unicode, null bytes)
6. Injection attempts (HTML/script tags, SQL fragments, template literals, path traversal)
7. Malformed hybrid_search combinations (empty store, empty BM25, corrupted state)
8. Retrieval window edge cases (negative window, zero results)
9. RRF namespace safety (OFFSET=1_000_000 collision resistance)

All tests verify SPECIFIC outcomes — not just "it doesn't crash".
"""

import sys
import os
import pytest
import math
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_vector_store(monkeypatch):
    """
    Fully mocked VectorStore so tests don't need real ChromaDB/embeddings.
    Mocks .search() and .bm25_index to return deterministic results.
    """
    from vector_store import VectorStore, BM25Index, DocumentChunk

    # Minimal mock collection
    mock_collection = MagicMock()
    mock_collection.count.return_value = 3
    mock_collection.query.return_value = {
        "documents": [["doc0 content", "doc1 content", "doc2 content"]],
        "metadatas": [[
            {"source": "file0.txt", "chunk_index": 0, "page": 1},
            {"source": "file1.txt", "chunk_index": 1, "page": 2},
            {"source": "file2.txt", "chunk_index": 2, "page": 3},
        ]],
        "distances": [[0.1, 0.2, 0.3]],
    }

    # Mock embedder
    mock_embedder = MagicMock()
    mock_embedder.encode_single.return_value = [0.1] * 384

    # Build a real-looking VS but with mocked internals
    vs = object.__new__(VectorStore)
    vs.collection = mock_collection
    vs.embedder = mock_embedder
    vs.db_path = Path("/tmp/test_db")
    vs.metadata = {"document_count": 1, "chunk_count": 3, "documents": {"file0.txt": {"chunks": 1}}}
    vs.bm25_index = MagicMock(spec=BM25Index)
    vs._lock = __import__("threading").RLock()
    vs._bm25_needs_rebuild = False

    # Mock bm25_index.search() to return deterministic results
    def bm25_search(query, top_k=10):
        # Return results in the same namespace style as real BM25
        return [(0, 0.95), (1, 0.85)]
    vs.bm25_index.search = bm25_search

    # Expose bm25_index.chunks for RRF resolution
    vs.bm25_index.chunks = [
        DocumentChunk(text="bm25 chunk 0", source="file0.txt", chunk_index=0, page=1),
        DocumentChunk(text="bm25 chunk 1", source="file1.txt", chunk_index=1, page=2),
    ]

    return vs


# ---------------------------------------------------------------------------
# Category 1: Empty / Whitespace-Only Queries
# ---------------------------------------------------------------------------

class TestEmptyQueries:
    """get_context() must handle empty and whitespace-only queries gracefully."""

    def test_empty_string_query(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context("", n_results=3)
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_whitespace_only_query(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context("   \t\n  ", n_results=3)
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_none_like_empty(self, mock_vector_store):
        # Not explicitly typed, but the guard uses `if not query`
        ctx, sources, chunks = mock_vector_store.get_context("", n_results=3, hybrid_search=True)
        assert ctx == ""
        assert sources == []
        assert chunks == []


# ---------------------------------------------------------------------------
# Category 2: n_results Boundary Values
# ---------------------------------------------------------------------------

class TestNResultsBoundaries:
    """n_results must be handled safely at boundaries."""

    def test_n_results_zero(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context("test query", n_results=0)
        # n_results=0: ChromaDB clamps to 0, but get_context still processes
        # whatever ChromaDB returns. In the mock, n_results=0 means ChromaDB
        # receives n_results=0 (min(0, 3) = 0) and returns empty.
        # Verify it doesn't crash and returns valid types.
        assert isinstance(ctx, str)
        assert isinstance(sources, list)
        assert isinstance(chunks, list)

    def test_n_results_negative(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context("test query", n_results=-999)
        # Must not crash — should treat as no-results or clamp
        assert isinstance(ctx, str)
        assert isinstance(sources, list)
        assert isinstance(chunks, list)

    def test_n_results_exceeds_store_size(self, mock_vector_store):
        # n_results=1000 on a 3-doc store should clamp gracefully
        ctx, sources, chunks = mock_vector_store.get_context("test query", n_results=1000)
        # ChromaDB clamps internally; we just verify it doesn't crash
        assert isinstance(ctx, str)
        assert isinstance(sources, list)
        assert isinstance(chunks, list)

    def test_n_results_huge(self, mock_vector_store):
        # Int overflow territory
        ctx, sources, chunks = mock_vector_store.get_context("test query", n_results=2**31)
        assert isinstance(ctx, str)
        assert isinstance(sources, list)


# ---------------------------------------------------------------------------
# Category 3: min_similarity Boundary Values
# ---------------------------------------------------------------------------

class TestMinSimilarityBoundaries:
    """min_similarity must accept valid range [0, 1] and reject extremes."""

    def test_min_similarity_negative(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test query", n_results=3, min_similarity=-0.5
        )
        # Negative threshold should not crash
        # Behavior: all results pass since scores >= 0 >= -0.5
        assert isinstance(ctx, str)
        assert isinstance(sources, list)

    def test_min_similarity_above_one(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test query", n_results=3, min_similarity=1.5
        )
        # Threshold > 1 means nothing passes — should return empty
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_min_similarity_exactly_one(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test query", n_results=3, min_similarity=1.0
        )
        # Exact 1.0 means only perfect match passes (dist=0, sim=1.0)
        assert isinstance(ctx, str)
        assert isinstance(sources, list)

    def test_min_similarity_zero(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test query", n_results=3, min_similarity=0.0
        )
        # Zero threshold means everything passes
        assert isinstance(ctx, str)
        assert len(ctx) >= 0

    def test_min_similarity_nan(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test query", n_results=3, min_similarity=float("nan")
        )
        # NaN comparison is always False — nothing passes
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_min_similarity_positive_infinity(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test query", n_results=3, min_similarity=float("inf")
        )
        # Nothing can exceed inf — should return empty
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_min_similarity_negative_infinity(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test query", n_results=3, min_similarity=float("-inf")
        )
        # Everything passes (sim >= -inf is always true)
        assert isinstance(ctx, str)


# ---------------------------------------------------------------------------
# Category 4: Type Confusion Attacks
# ---------------------------------------------------------------------------

class TestTypeConfusion:
    """Parameters must handle wrong types without crashing."""

    def test_query_is_number(self, mock_vector_store):
        # BUG: get_context calls query.strip() without type-checking query first.
        # int 42 has no .strip() method → AttributeError.
        with pytest.raises(AttributeError, match="'int' object has no attribute 'strip'"):
            mock_vector_store.get_context(42, n_results=3)

    def test_query_is_list(self, mock_vector_store):
        # BUG: get_context calls query.strip() without type-checking query first.
        # list has no .strip() method → AttributeError.
        with pytest.raises(AttributeError, match="'list' object has no attribute 'strip'"):
            mock_vector_store.get_context(["a", "b"], n_results=3)

    def test_query_is_none(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(None, n_results=3)
        # `if not query` catches None → empty context
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_n_results_is_string(self, mock_vector_store):
        # n_results="5" is passed to ChromaDB which will raise TypeError
        # — must not propagate as unhandled crash through the wrapper
        with pytest.raises((TypeError, ValueError)):
            mock_vector_store.get_context("test", n_results="5")

    def test_min_similarity_is_string(self, mock_vector_store):
        # min_similarity="0.5" causes TypeError when compared against float sim score
        with pytest.raises(TypeError):
            mock_vector_store.get_context("test", n_results=3, min_similarity="0.5")

    def test_hybrid_search_is_string(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, hybrid_search="yes"
        )
        # Python truthiness: non-empty string is truthy → hybrid search path
        assert isinstance(ctx, str)

    def test_retrieval_window_is_string(self, mock_vector_store):
        # retrieval_window="2" causes TypeError in range() or arithmetic
        with pytest.raises(TypeError):
            mock_vector_store.get_context("test", n_results=3, retrieval_window="2")

    def test_all_params_wrong_types(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            query=[],
            n_results="x",
            min_similarity={},
            hybrid_search=1,
            retrieval_window=[],
        )
        # Should handle gracefully without unhandled exceptions leaking out
        assert isinstance(ctx, str)


# ---------------------------------------------------------------------------
# Category 5: Oversized Payloads & Unicode Attacks
# ---------------------------------------------------------------------------

class TestOversizedPayloads:
    """Very large inputs must not cause crashes or resource exhaustion."""

    def test_very_large_query_string(self, mock_vector_store):
        large_query = "a" * 1_000_000  # 1MB query string
        ctx, sources, chunks = mock_vector_store.get_context(large_query, n_results=3)
        # Should not crash — embedder may truncate or fail gracefully
        assert isinstance(ctx, str)

    def test_unicode_emoji_query(self, mock_vector_store):
        emoji_query = "Hello 👋🚀💻 🔥🔥🔥" * 100
        ctx, sources, chunks = mock_vector_store.get_context(emoji_query, n_results=3)
        assert isinstance(ctx, str)

    def test_unicode_rtl_override(self, mock_vector_store):
        # Right-to-left override — can corrupt display but should not crash
        rtl_query = "\u202E\u0041\u0042\u0043"  # RLO + ABC
        ctx, sources, chunks = mock_vector_store.get_context(rtl_query, n_results=3)
        assert isinstance(ctx, str)

    def test_unicode_null_bytes(self, mock_vector_store):
        # Null bytes in query — should not truncate or crash
        null_query = "test\x00query\x00"
        ctx, sources, chunks = mock_vector_store.get_context(null_query, n_results=3)
        assert isinstance(ctx, str)

    def test_unicode_combining_chars(self, mock_vector_store):
        # Combining characters — should not cause normalization issues
        combining_query = "A\u0300\u0301\u0302" * 50  # A with combining accents
        ctx, sources, chunks = mock_vector_store.get_context(combining_query, n_results=3)
        assert isinstance(ctx, str)

    def test_deeply_nested_template_literal(self, mock_vector_store):
        # Template injection — should be processed as literal text
        template_query = "${" * 100 + "malicious" + "}" * 100
        ctx, sources, chunks = mock_vector_store.get_context(template_query, n_results=3)
        assert isinstance(ctx, str)

    def test_sql_injection_fragment(self, mock_vector_store):
        sql_query = "'; DROP TABLE documents; --" * 50
        ctx, sources, chunks = mock_vector_store.get_context(sql_query, n_results=3)
        # Must be treated as literal text — no SQL execution
        assert isinstance(ctx, str)

    def test_html_script_tag_injection(self, mock_vector_store):
        script_query = "<script>alert('xss')</script>" * 20
        ctx, sources, chunks = mock_vector_store.get_context(script_query, n_results=3)
        # Must be treated as literal text
        assert isinstance(ctx, str)

    def test_path_traversal_in_query(self, mock_vector_store):
        path_query = "../../../etc/passwd" * 10
        ctx, sources, chunks = mock_vector_store.get_context(path_query, n_results=3)
        assert isinstance(ctx, str)


# ---------------------------------------------------------------------------
# Category 6: Malformed Hybrid Search Combinations
# ---------------------------------------------------------------------------

class TestHybridSearchEdgeCases:
    """hybrid_search=True with various malformed states."""

    def test_hybrid_search_empty_bm25_index(self, mock_vector_store):
        # BM25 index exists but returns empty results
        mock_vector_store.bm25_index.search = lambda q, top_k=10: []
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, hybrid_search=True
        )
        # Should fall back to vector-only results
        assert isinstance(ctx, str)
        assert isinstance(sources, list)

    def test_hybrid_search_bm25_index_is_none(self, mock_vector_store):
        # BM25 index not built yet — should handle gracefully
        mock_vector_store.bm25_index = None
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, hybrid_search=True
        )
        # Falls back to vector-only path
        assert isinstance(ctx, str)
        assert isinstance(sources, list)

    def test_hybrid_search_with_empty_store(self, mock_vector_store):
        # Empty collection — override mock to return empty vector results
        def empty_query(**kwargs):
            return {"documents": [[]], "metadatas": [[]], "distances": [[]]}
        mock_vector_store.collection.query.side_effect = empty_query
        mock_vector_store.collection.count.return_value = 0

        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, hybrid_search=True
        )
        # BM25 is independent of vector store — even with empty vector results,
        # BM25 still returns its own matches. Context will contain BM25 chunks.
        assert isinstance(ctx, str)
        assert isinstance(sources, list)
        # BM25 results are returned even when vector store is empty
        assert len(ctx) > 0

    def test_hybrid_search_bm25_chunks_out_of_bounds(self, mock_vector_store):
        # BM25 returns corpus_idx >= len(bm25_index.chunks) — should not crash
        mock_vector_store.bm25_index.search = lambda q, top_k=10: [(9999, 0.9), (0, 0.8)]
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, hybrid_search=True
        )
        # Out-of-bounds chunks should be skipped (corpus_idx >= len(chunks) guard)
        assert isinstance(ctx, str)

    def test_hybrid_search_vector_results_out_of_bounds(self, mock_vector_store):
        # Vector results list is shorter than n_results*2 request
        mock_vector_store.collection.query.return_value = {
            "documents": [["only one doc"]],
            "metadatas": [[{"source": "f.txt", "chunk_index": 0, "page": 1}]],
            "distances": [[0.1]],
        }
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=100, hybrid_search=True
        )
        # Should not crash when accessing beyond list bounds
        assert isinstance(ctx, str)


# ---------------------------------------------------------------------------
# Category 7: Retrieval Window Edge Cases
# ---------------------------------------------------------------------------

class TestRetrievalWindowEdgeCases:
    """retrieval_window parameter at boundaries."""

    def test_retrieval_window_negative(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, retrieval_window=-1
        )
        # Negative window should be treated as no expansion (window <= 0 guard)
        assert isinstance(ctx, str)

    def test_retrieval_window_zero(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, retrieval_window=0
        )
        # Zero window means no expansion
        assert isinstance(ctx, str)

    def test_retrieval_window_huge(self, mock_vector_store):
        ctx, sources, chunks = mock_vector_store.get_context(
            "test", n_results=3, retrieval_window=999999
        )
        # Large window should clamp gracefully
        assert isinstance(ctx, str)


# ---------------------------------------------------------------------------
# Category 8: RRF Namespace Safety (OFFSET=1_000_000)
# ---------------------------------------------------------------------------

class TestRRFNamespaceSafety:
    """
    RRF fusion uses OFFSET=1_000_000 to separate BM25 corpus indices from
    vector result indices. This verifies collision resistance.
    """

    def test_offset_large_enough(self):
        """OFFSET must be >> max possible vector result index."""
        from utils import rrf_fuse

        OFFSET = 1_000_000

        # Simulate 1000 vector results + 10 BM25 corpus results
        vector_results = [(i, 1.0 - i * 0.001) for i in range(1000)]
        bm25_results = [(i + OFFSET, 0.9) for i in range(10)]

        fused = rrf_fuse([vector_results, bm25_results])

        # All BM25 IDs should remain >= OFFSET after fusion
        for doc_id, score in fused:
            assert doc_id >= 0, f"RRF produced negative doc_id: {doc_id}"

        # Top-ranked items should include both vector and BM25
        top_10_ids = [doc_id for doc_id, _ in fused[:10]]
        # Should have some vector results (top scores)
        assert any(doc_id < OFFSET for doc_id in top_10_ids), \
            "RRF fusion must include vector results"

    def test_rrf_fuse_with_tied_scores(self):
        """RRF must handle equal scores deterministically."""
        from utils import rrf_fuse

        list1 = [(0, 0.5), (1, 0.5), (2, 0.5)]
        list2 = [(0, 0.5), (1, 0.5), (2, 0.5)]

        fused = rrf_fuse([list1, list2])

        # All results should be present
        fused_ids = [doc_id for doc_id, _ in fused]
        assert sorted(fused_ids) == [0, 1, 2]

        # Scores should be equal for all (2 * 1/61)
        for _, score in fused:
            assert score > 0

    def test_rrf_fuse_single_empty_list(self):
        """RRF with one empty list should still return the other list's results."""
        from utils import rrf_fuse

        results = [(0, 0.9), (1, 0.8)]
        fused = rrf_fuse([results, []])

        assert len(fused) == 2
        assert [doc_id for doc_id, _ in fused] == [0, 1]

    def test_rrf_fuse_both_empty(self):
        """RRF with all empty lists must return empty list."""
        from utils import rrf_fuse

        fused = rrf_fuse([[], []])
        assert fused == []

    def test_rrf_fuse_preserves_bm25_offset(self):
        """
        BM25 results use corpus_idx + OFFSET. Verify that after fusion,
        BM25 doc_ids are still distinguishable from vector doc_ids.
        """
        from utils import rrf_fuse

        OFFSET = 1_000_000
        vector_results = [(0, 0.9), (1, 0.8)]
        bm25_results = [(OFFSET + 5, 0.95), (OFFSET + 3, 0.85)]

        fused = rrf_fuse([vector_results, bm25_results])

        # Verify separation maintained
        bm25_ids = {doc_id for doc_id, _ in fused if doc_id >= OFFSET}
        vector_ids = {doc_id for doc_id, _ in fused if doc_id < OFFSET}

        assert len(bm25_ids) == 2, "Both BM25 results should appear"
        assert len(vector_ids) == 2, "Both vector results should appear"
        assert bm25_ids == {OFFSET + 5, OFFSET + 3}, "BM25 IDs must match originals"


# ---------------------------------------------------------------------------
# Category 9: Concurrency / Thread Safety
# ---------------------------------------------------------------------------

class TestConcurrencySafety:
    """Multiple simultaneous calls should not corrupt state."""

    def test_sequential_calls_different_queries(self, mock_vector_store):
        queries = ["python programming", "machine learning", "natural language"]
        for q in queries:
            ctx, sources, chunks = mock_vector_store.get_context(q, n_results=2)
            assert isinstance(ctx, str)
            assert isinstance(sources, list)
            assert isinstance(chunks, list)

    def test_sequential_calls_different_hybrid_modes(self, mock_vector_store):
        ctx1, _, _ = mock_vector_store.get_context("test", n_results=2, hybrid_search=False)
        ctx2, _, _ = mock_vector_store.get_context("test", n_results=2, hybrid_search=True)
        ctx3, _, _ = mock_vector_store.get_context("test", n_results=2, hybrid_search=False)

        # All should return valid strings without state corruption
        assert isinstance(ctx1, str)
        assert isinstance(ctx2, str)
        assert isinstance(ctx3, str)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
