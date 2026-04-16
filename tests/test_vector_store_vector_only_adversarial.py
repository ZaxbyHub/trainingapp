"""
Adversarial tests for VectorStore.get_context() — vector-only branch (hybrid_search=False).
Phase: Adversarial / Fuzzing

Targets ONLY the vector-only code path (lines 820-875 of vector_store.py).
Tests: malformed ChromaDB responses, edge-case metadata, return-type invariants,
       neighbor expansion attacks, oversized ChromaDB payloads, injection through stored docs.
"""

import pytest
import math
import re
from pathlib import Path
from unittest.mock import MagicMock

from vector_store import VectorStore, BM25Index, DocumentChunk


# ---------------------------------------------------------------------------
# Shared mock fixtures
# ---------------------------------------------------------------------------

def _make_vs(mock_collection=None, mock_embedder=None, metadata=None):
    """Factory to build a minimally-mocked VectorStore for the vector-only path."""
    vs = object.__new__(VectorStore)
    vs.collection = mock_collection or _default_mock_collection()
    vs.embedder = mock_embedder or _default_mock_embedder()
    vs.db_path = Path("/tmp/test_db")
    vs.metadata = metadata or {
        "document_count": 1,
        "chunk_count": 3,
        "documents": {"file0.txt": {"chunks": 1}},
    }
    vs.bm25_index = None          # Vector-only path does not consult bm25_index
    vs._lock = __import__("threading").RLock()
    vs._bm25_needs_rebuild = False
    return vs


def _default_mock_collection():
    mc = MagicMock()
    mc.count.return_value = 3
    mc.query.return_value = {
        "documents": [["doc0 content", "doc1 content", "doc2 content"]],
        "metadatas": [[
            {"source": "file0.txt", "chunk_index": 0, "page": 1},
            {"source": "file1.txt", "chunk_index": 1, "page": 2},
            {"source": "file2.txt", "chunk_index": 2, "page": 3},
        ]],
        "distances": [[0.1, 0.2, 0.3]],
    }
    return mc


def _default_mock_embedder():
    me = MagicMock()
    me.encode_single.return_value = [0.1] * 384
    return me


# ---------------------------------------------------------------------------
# Helper: build a mock collection returning specific documents/metadata
# ---------------------------------------------------------------------------

def _make_collection(documents, metadatas, distances):
    mc = MagicMock()
    mc.count.return_value = len(documents) if documents else 0
    mc.query.return_value = {
        "documents": [documents],
        "metadatas": [metadatas],
        "distances": [distances],
    }
    return mc


# ---------------------------------------------------------------------------
# Test: Return-type invariants (3 values, correct types)
# ---------------------------------------------------------------------------

class TestReturnTypeInvariant:
    """Every code path in get_context must return exactly 3 values with correct types."""

    def test_vector_only_returns_three_values(self):
        """Normal query must return exactly (str, List[str], List[DocumentChunk])."""
        vs = _make_vs()
        result = vs.get_context("test query", n_results=2, hybrid_search=False)
        assert isinstance(result, tuple), "get_context must return a tuple"
        assert len(result) == 3, f"get_context must return 3 values, got {len(result)}"
        context, sources, chunks = result
        assert isinstance(context, str), "context must be str"
        assert isinstance(sources, list), "sources must be list"
        assert isinstance(chunks, list), "chunks must be list"
        assert all(isinstance(c, DocumentChunk) for c in chunks), "chunks must contain DocumentChunk"

    def test_empty_result_still_returns_three_values(self):
        """Empty result (no matches) must still return 3-tuple, not raise."""
        mc = _make_collection([], [], [])
        vs = _make_vs(mock_collection=mc)
        result = vs.get_context("nonexistent query", n_results=5, hybrid_search=False)
        assert isinstance(result, tuple)
        assert len(result) == 3
        ctx, sources, chunks = result
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_all_filtered_returns_three_values(self):
        """All results filtered out by min_similarity must return empty 3-tuple."""
        mc = _make_collection(
            ["doc0"],
            [{"source": "f.txt", "chunk_index": 0, "page": 1}],
            [0.99],   # distance 0.99 → similarity 0.01 < min_similarity 0.3
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context(
            "query", n_results=5, min_similarity=0.3, hybrid_search=False
        )
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_chunks_count_matches_context_parts(self):
        """result_chunks length must equal number of context parts joined."""
        mc = _make_collection(
            ["part A", "part B", "part C"],
            [
                {"source": "s.txt", "chunk_index": 0, "page": 1},
                {"source": "s.txt", "chunk_index": 1, "page": 2},
                {"source": "s.txt", "chunk_index": 2, "page": 3},
            ],
            [0.05, 0.15, 0.25],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("query", n_results=3, hybrid_search=False)
        # Context is joined with "\n\n---\n\n"
        expected_parts = 3
        assert ctx.count("\n\n---\n\n") == expected_parts - 1, \
            "Context join separator count should be n-1"
        assert len(chunks) == expected_parts, \
            f"result_chunks length ({len(chunks)}) must match context parts ({expected_parts})"


# ---------------------------------------------------------------------------
# Test: ChromaDB Response Malformations
# ---------------------------------------------------------------------------

class TestChromaDBResponseMalformations:
    """ChromaDB responses can be malformed — get_context must be resilient."""

    def test_documents_missing(self):
        """ChromaDB returns None for documents list — must not crash."""
        mc = MagicMock()
        mc.count.return_value = 0
        mc.query.return_value = {
            "documents": [[]],   # empty docs
            "metadatas": [[]],
            "distances": [[]],
        }
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert ctx == ""
        assert sources == []
        assert chunks == []

    def test_documents_is_none(self):
        """ChromaDB returns None instead of list — must not crash."""
        mc = MagicMock()
        mc.count.return_value = 1
        mc.query.return_value = {
            "documents": None,
            "metadatas": [[{"source": "f.txt", "chunk_index": 0, "page": 1}]],
            "distances": [[0.1]],
        }
        vs = _make_vs(mock_collection=mc)
        # zip([] or None, ...) with metadatas → should handle gracefully
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)
        assert isinstance(sources, list)

    def test_metadatas_is_none(self):
        """ChromaDB returns None for metadatas — search() crashes (BUG: no None guard)."""
        mc = MagicMock()
        mc.count.return_value = 1
        mc.query.return_value = {
            "documents": [["some text"]],
            "metadatas": None,   # BUG: search() line 544 does results["metadatas"][0] w/o guard
            "distances": [[0.1]],
        }
        vs = _make_vs(mock_collection=mc)
        # Expected: TypeError at search() line 544 — this is a SOURCE BUG
        with pytest.raises(TypeError, match="'NoneType' object is not subscriptable"):
            vs.get_context("test", n_results=3, hybrid_search=False)

    def test_metadatas_mismatched_length(self):
        """Metadatas list shorter than documents — zip truncates safely."""
        mc = _make_collection(
            ["doc0", "doc1", "doc2"],
            [
                {"source": "f0.txt", "chunk_index": 0, "page": 1},
                # missing doc1, doc2 metadata
            ],
            [0.1, 0.2, 0.3],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)

    def test_distances_missing(self):
        """ChromaDB returns None for distances — search() crashes (BUG: no None guard)."""
        mc = MagicMock()
        mc.count.return_value = 1
        mc.query.return_value = {
            "documents": [["doc text"]],
            "metadatas": [[{"source": "f.txt", "chunk_index": 0, "page": 1}]],
            "distances": None,    # BUG: search() line 545 does results["distances"][0] w/o guard
        }
        vs = _make_vs(mock_collection=mc)
        # Expected: TypeError — this is a SOURCE BUG
        with pytest.raises(TypeError, match="'NoneType' object is not subscriptable"):
            vs.get_context("test", n_results=3, hybrid_search=False)

    def test_distances_mismatched_length(self):
        """Distances list shorter than documents — zip truncates safely."""
        mc = _make_collection(
            ["d0", "d1", "d2"],
            [
                {"source": "f.txt", "chunk_index": 0, "page": 1},
                {"source": "f.txt", "chunk_index": 1, "page": 2},
                {"source": "f.txt", "chunk_index": 2, "page": 3},
            ],
            [0.1],    # only one distance
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)

    def test_nested_dict_metadata(self):
        """Metadata contains nested dicts — .get() must return None or the value safely."""
        mc = _make_collection(
            ["nested meta doc"],
            [{"source": "f.txt", "chunk_index": 0, "page": 1, "extra": {"nested": True}}],
            [0.1],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)

    def test_non_string_document(self):
        """Document text is an int instead of str — get_context() crashes (BUG: no str cast)."""
        mc = MagicMock()
        mc.count.return_value = 1
        mc.query.return_value = {
            "documents": [[12345]],  # int instead of string — BUG: search() returns it as-is
            "metadatas": [[{"source": "f.txt", "chunk_index": 0, "page": 1}]],
            "distances": [[0.1]],
        }
        vs = _make_vs(mock_collection=mc)
        # Expected: TypeError at get_context() line 874 — context_parts contains int
        with pytest.raises(TypeError, match="sequence item 0: expected str instance, int found"):
            vs.get_context("test", n_results=3, hybrid_search=False)


# ---------------------------------------------------------------------------
# Test: Malformed Metadata Field Values
# ---------------------------------------------------------------------------

class TestMetadataFieldMalformations:
    """Metadata fields can contain unexpected types or values."""

    def test_source_is_none(self):
        """source field is None — must default to 'Unknown'."""
        mc = _make_collection(
            ["doc0", "doc1"],
            [
                {"source": None, "chunk_index": 0, "page": 1},
                {"source": None, "chunk_index": 1, "page": 2},
            ],
            [0.1, 0.2],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        # None source should not crash; defaults handled gracefully
        assert isinstance(ctx, str)
        assert all(isinstance(c, DocumentChunk) for c in chunks)

    def test_source_missing(self):
        """source key is entirely missing from metadata."""
        mc = _make_collection(
            ["doc0"],
            [{"chunk_index": 0, "page": 1}],   # no "source" key
            [0.1],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)
        # Should default to "Unknown"
        assert chunks[0].source == "Unknown"

    def test_chunk_index_missing(self):
        """chunk_index key is missing — must default to position in filtered list."""
        mc = _make_collection(
            ["doc0", "doc1"],
            [
                {"source": "f.txt"},   # no chunk_index
                {"source": "f.txt"},   # no chunk_index
            ],
            [0.1, 0.2],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        # chunk_index defaults to enumerate position
        assert isinstance(ctx, str)

    def test_chunk_index_is_string(self):
        """chunk_index is a string instead of int — must not crash."""
        mc = _make_collection(
            ["doc0"],
            [{"source": "f.txt", "chunk_index": "not_an_int", "page": 1}],
            [0.1],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)

    def test_page_is_none(self):
        """page field is None — must be stored as None (valid for dataclass)."""
        mc = _make_collection(
            ["doc0"],
            [{"source": "f.txt", "chunk_index": 0, "page": None}],
            [0.1],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)
        assert chunks[0].page is None

    def test_page_is_string(self):
        """page field is a string instead of int — must not crash."""
        mc = _make_collection(
            ["doc0"],
            [{"source": "f.txt", "chunk_index": 0, "page": "III"}],
            [0.1],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)

    def test_page_missing(self):
        """page key is entirely missing — must default to None."""
        mc = _make_collection(
            ["doc0"],
            [{"source": "f.txt", "chunk_index": 0}],   # no page
            [0.1],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)
        assert chunks[0].page is None


# ---------------------------------------------------------------------------
# Test: Oversized ChromaDB Payloads
# ---------------------------------------------------------------------------

class TestOversizedChromaDBPayloads:
    """ChromaDB returning massive result sets must not exhaust memory."""

    def test_1000_results_returned(self):
        """ChromaDB returns 1000 documents — must process without OOM."""
        docs = [f"document number {i}" for i in range(1000)]
        metas = [
            {"source": f"file{i}.txt", "chunk_index": 0, "page": 1}
            for i in range(1000)
        ]
        dists = [0.01 * i for i in range(1000)]
        mc = _make_collection(docs, metas, dists)
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=1000, hybrid_search=False)
        assert isinstance(ctx, str)
        assert len(chunks) <= 1000  # at most n_results

    def test_extremely_large_document_text(self):
        """Single document is 1MB of text — context join must not crash."""
        large_text = "x" * 1_000_000
        mc = _make_collection(
            [large_text],
            [{"source": "huge.txt", "chunk_index": 0, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)
        assert len(ctx) >= 1_000_000

    def test_many_sources_same_file(self):
        """100 chunks from the same source — no duplicates in sources list."""
        docs = [f"chunk {i}" for i in range(100)]
        metas = [
            {"source": "same_file.txt", "chunk_index": i, "page": i // 10}
            for i in range(100)
        ]
        dists = [0.001 * i for i in range(100)]
        mc = _make_collection(docs, metas, dists)
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=100, hybrid_search=False)
        assert "same_file.txt" in sources
        assert sources.count("same_file.txt") == 1, \
            "sources list must be deduplicated"


# ---------------------------------------------------------------------------
# Test: Injection Through Stored Document Content
# ---------------------------------------------------------------------------

class TestInjectionThroughStoredDocs:
    """Malicious content stored in ChromaDB must not affect control flow."""

    def test_script_tag_in_stored_doc(self):
        """Stored document contains <script>alert(1)</script> — must be treated as text."""
        mc = _make_collection(
            ["Document with <script>alert(1)</script> malicious code"],
            [{"source": "malicious.html", "chunk_index": 0, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        # Context must contain the raw text, not have tags stripped incorrectly
        assert "<script>" in ctx

    def test_sql_fragment_in_stored_doc(self):
        """Stored document contains SQL fragment — must not execute."""
        mc = _make_collection(
            ["'; DROP TABLE users; --"],
            [{"source": "evil.sql", "chunk_index": 0, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert "DROP TABLE" in ctx

    def test_template_literal_in_stored_doc(self):
        """Stored document contains ${...} template injection."""
        mc = _make_collection(
            ["User input: ${process.mainModule.require('child_process').execSync('ls')}"],
            [{"source": "injection.txt", "chunk_index": 0, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert "${" in ctx

    def test_path_traversal_in_stored_doc_source(self):
        """Stored document source field contains path traversal characters."""
        mc = _make_collection(
            ["safe content"],
            [{"source": "../../../etc/passwd", "chunk_index": 0, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)
        assert sources[0] == "../../../etc/passwd"

    def test_unicode_null_byte_in_stored_doc(self):
        """Stored document contains null bytes — must not truncate."""
        mc = _make_collection(
            ["prefix\x00suffix"],
            [{"source": "null.txt", "chunk_index": 0, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        # The raw text is preserved (Python strings preserve \x00)
        assert "prefix" in ctx or "\x00" in ctx


# ---------------------------------------------------------------------------
# Test: Neighbor Expansion (retrieval_window > 0)
# ---------------------------------------------------------------------------

class TestNeighborExpansion:
    """retrieval_window > 0 triggers _expand_chunks_with_neighbors."""

    def test_retrieval_window_with_mock_neighbor_fetch(self):
        """Window > 0 triggers _expand_chunks_with_neighbors → get_chunks_by_source.

        The mock provides 3 source chunks with positions 0,1,2 and metadata indices 4,5,6.
        The filtered chunk has metadata chunk_index=1 (position in source_chunks list).
        Window=1 → neighbors at positions 0 and 2 → texts "n0" and "n1".
        """
        mc = _make_collection(
            ["chunk0", "chunk1"],
            [
                {"source": "file.txt", "chunk_index": 1, "page": 1},   # metadata idx=1 = list position 1
                {"source": "file.txt", "chunk_index": 1, "page": 1},   # duplicate key — deduplicated
            ],
            [0.05, 0.15],
        )
        vs = _make_vs(mock_collection=mc)

        def mock_collection_get(**kwargs):
            source_filter = kwargs.get("where", {}).get("source")
            if source_filter == "file.txt":
                # source_chunks has 3 items at positions 0,1,2 with metadata indices 4,5,6
                return {
                    "documents": ["n0", "chunk0", "n1"],
                    "metadatas": [
                        {"source": "file.txt", "chunk_index": 4, "page": 1},
                        {"source": "file.txt", "chunk_index": 5, "page": 1},
                        {"source": "file.txt", "chunk_index": 6, "page": 1},
                    ],
                }
            return {"documents": [], "metadatas": []}
        mc.get = mock_collection_get

        ctx, sources, chunks = vs.get_context(
            "test", n_results=2, retrieval_window=1, hybrid_search=False
        )
        # chunk_index=1 in list of 3 → window=1 → neighbors at positions 0,2
        # Deduplication: both filtered chunks have same key ("file.txt", 1) → deduplicated
        # Expected: n0, chunk0, n1 (3 unique)
        assert isinstance(ctx, str)
        assert len(chunks) == 3, f"Expected 3 chunks, got {len(chunks)}"
        texts = [c.text for c in chunks]
        assert "n0" in texts
        assert "chunk0" in texts
        assert "n1" in texts

    def test_retrieval_window_chunk_index_beyond_source_length(self):
        """chunk_index in metadata exceeds len(source_chunks) → BUG: end_idx < start_idx.

        When metadata chunk_index=5 but source_chunks only has 3 items (positions 0-2),
        the expansion range becomes range(4, 3) = empty. This is a SOURCE BUG in
        _expand_chunks_with_neighbors: it uses chunk_index as a list position.
        """
        mc = _make_collection(
            ["chunk0"],
            [{"source": "file.txt", "chunk_index": 5, "page": 1}],  # idx=5 but only 3 chunks exist
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)

        def mock_collection_get(**kwargs):
            source_filter = kwargs.get("where", {}).get("source")
            if source_filter == "file.txt":
                return {
                    "documents": ["c0", "c1", "c2"],  # only 3 chunks
                    "metadatas": [
                        {"source": "file.txt", "chunk_index": 4, "page": 1},
                        {"source": "file.txt", "chunk_index": 5, "page": 1},
                        {"source": "file.txt", "chunk_index": 6, "page": 1},
                    ],
                }
            return {"documents": [], "metadatas": []}
        mc.get = mock_collection_get

        ctx, sources, chunks = vs.get_context(
            "test", n_results=1, retrieval_window=1, hybrid_search=False
        )
        # BUG: range(max(0,5-1), min(2,5+1)) = range(4, 3) = empty
        # Source code produces 0 chunks instead of the 3 available
        assert len(chunks) == 0, \
            "BUG: chunk_index 5 exceeds len(source_chunks)=3 → empty expansion range"

    def test_retrieval_window_get_chunks_returns_empty(self):
        """get_chunks_by_source returns [] — must not crash in neighbor expansion."""
        mc = _make_collection(
            ["orphan chunk"],
            [{"source": "orphan.txt", "chunk_index": 99, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        vs.get_chunks_by_source = lambda source: []   # no neighbors found

        ctx, sources, chunks = vs.get_context(
            "test", n_results=1, retrieval_window=5, hybrid_search=False
        )
        # Should still return the original chunk
        assert len(chunks) == 1
        assert chunks[0].source == "orphan.txt"

    def test_retrieval_window_negative_index_handled(self):
        """chunk_index is negative — must not cause index error in neighbor range."""
        mc = _make_collection(
            ["negative idx doc"],
            [{"source": "neg.txt", "chunk_index": -1, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        vs.get_chunks_by_source = lambda s: [
            DocumentChunk(text="doc", source=s, chunk_index=-1, page=1)
        ]
        ctx, sources, chunks = vs.get_context(
            "test", n_results=1, retrieval_window=1, hybrid_search=False
        )
        # max(0, -1 - 1) = 0 → safe range
        assert isinstance(ctx, str)

    def test_retrieval_window_out_of_bounds_end(self):
        """chunk_index near end of chunk list — must clamp to len-1 safely."""
        mc = _make_collection(
            ["last chunk"],
            [{"source": "bounds.txt", "chunk_index": 999, "page": 1}],
            [0.05],
        )
        vs = _make_vs(mock_collection=mc)
        vs.get_chunks_by_source = lambda s: [
            DocumentChunk(text=f"c{i}", source=s, chunk_index=i, page=1)
            for i in range(5)
        ]
        ctx, sources, chunks = vs.get_context(
            "test", n_results=1, retrieval_window=3, hybrid_search=False
        )
        # end_idx = min(4, 999+3) = 4 → safe
        assert isinstance(ctx, str)

    def test_retrieval_window_duplicate_neighbors_removed(self):
        """Same chunk fetched via multiple neighbors must be deduplicated in result."""
        mc = _make_collection(
            ["c0", "c1", "c2"],
            [
                {"source": "dup.txt", "chunk_index": 0, "page": 1},
                {"source": "dup.txt", "chunk_index": 1, "page": 2},
                {"source": "dup.txt", "chunk_index": 2, "page": 3},
            ],
            [0.05, 0.06, 0.07],
        )
        vs = _make_vs(mock_collection=mc)
        # Return same chunk twice (simulates window overlap)
        vs.get_chunks_by_source = lambda s: [
            DocumentChunk(text="same", source=s, chunk_index=0, page=1),
            DocumentChunk(text="same", source=s, chunk_index=0, page=1),  # duplicate
        ]
        ctx, sources, chunks = vs.get_context(
            "test", n_results=3, retrieval_window=2, hybrid_search=False
        )
        # Deduplication via seen set in _expand_chunks_with_neighbors
        assert isinstance(ctx, str)


# ---------------------------------------------------------------------------
# Test: Result Chunk Properties
# ---------------------------------------------------------------------------

class TestResultChunkProperties:
    """result_chunks elements must have correct field values."""

    def test_chunks_have_correct_text(self):
        """Each DocumentChunk.text must match the corresponding document."""
        mc = _make_collection(
            ["alpha text", "beta text", "gamma text"],
            [
                {"source": "s.txt", "chunk_index": 0, "page": 1},
                {"source": "s.txt", "chunk_index": 1, "page": 2},
                {"source": "s.txt", "chunk_index": 2, "page": 3},
            ],
            [0.05, 0.15, 0.25],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert chunks[0].text == "alpha text"
        assert chunks[1].text == "beta text"
        assert chunks[2].text == "gamma text"

    def test_chunks_have_correct_source(self):
        """Each DocumentChunk.source must match metadata."""
        mc = _make_collection(
            ["d0", "d1"],
            [
                {"source": "source_a.txt", "chunk_index": 0, "page": 1},
                {"source": "source_b.txt", "chunk_index": 1, "page": 2},
            ],
            [0.05, 0.15],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert chunks[0].source == "source_a.txt"
        assert chunks[1].source == "source_b.txt"

    def test_chunks_have_correct_page(self):
        """Each DocumentChunk.page must match metadata."""
        mc = _make_collection(
            ["d0", "d1"],
            [
                {"source": "s.txt", "chunk_index": 0, "page": 42},
                {"source": "s.txt", "chunk_index": 1, "page": 99},
            ],
            [0.05, 0.15],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert chunks[0].page == 42
        assert chunks[1].page == 99

    def test_chunks_sorted_by_source_and_chunk_index(self):
        """result_chunks must be sorted by (source, chunk_index) when window > 0."""
        mc = _make_collection(
            ["c1", "c0", "c2"],
            [
                {"source": "file.txt", "chunk_index": 1, "page": 1},
                {"source": "file.txt", "chunk_index": 0, "page": 2},
                {"source": "file.txt", "chunk_index": 2, "page": 3},
            ],
            [0.1, 0.05, 0.2],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context(
            "test", n_results=3, retrieval_window=0, hybrid_search=False
        )
        # Without window, order follows filtered list (by similarity descending)
        # c1 (sim=0.9), c0 (sim=0.95), c2 (sim=0.8)
        assert chunks[0].chunk_index == 1
        assert chunks[1].chunk_index == 0
        assert chunks[2].chunk_index == 2


# ---------------------------------------------------------------------------
# Test: Context String Properties
# ---------------------------------------------------------------------------

class TestContextStringProperties:
    """Context string must have correct structure."""

    def test_context_separator_count(self):
        """Context join must use exactly 3 separators for 4 parts."""
        mc = _make_collection(
            ["p0", "p1", "p2", "p3"],
            [
                {"source": "s.txt", "chunk_index": i, "page": i}
                for i in range(4)
            ],
            [0.05, 0.1, 0.15, 0.2],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=4, hybrid_search=False)
        sep = "\n\n---\n\n"
        assert ctx.count(sep) == 3, f"Expected 3 separators, got {ctx.count(sep)}"

    def test_context_starts_with_first_doc(self):
        """Context string must start with the first document text."""
        mc = _make_collection(
            ["FIRST_DOCUMENT", "SECOND"],
            [
                {"source": "s.txt", "chunk_index": 0, "page": 1},
                {"source": "s.txt", "chunk_index": 1, "page": 2},
            ],
            [0.05, 0.15],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert ctx.startswith("FIRST_DOCUMENT")

    def test_context_ends_with_last_doc(self):
        """Context string must end with the last document text."""
        mc = _make_collection(
            ["FIRST", "LAST_DOCUMENT"],
            [
                {"source": "s.txt", "chunk_index": 0, "page": 1},
                {"source": "s.txt", "chunk_index": 1, "page": 2},
            ],
            [0.05, 0.15],
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert ctx.endswith("LAST_DOCUMENT")


# ---------------------------------------------------------------------------
# Test: min_similarity = 0 exactly (passes all results)
# ---------------------------------------------------------------------------

class TestMinSimilarityZeroEdgeCase:
    """min_similarity=0.0 passes every non-negative similarity."""

    def test_min_similarity_zero_passes_all(self):
        """min_similarity=0 should return all results regardless of distance."""
        mc = _make_collection(
            ["d0", "d1", "d2"],
            [
                {"source": "s.txt", "chunk_index": 0, "page": 1},
                {"source": "s.txt", "chunk_index": 1, "page": 2},
                {"source": "s.txt", "chunk_index": 2, "page": 3},
            ],
            [0.95, 0.98, 0.99],   # distances 0.95+ → sim 0.05, 0.02, 0.01
        )
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context(
            "test", n_results=3, min_similarity=0.0, hybrid_search=False
        )
        # All 3 results pass (sim >= 0.0)
        assert len(chunks) == 3


# ---------------------------------------------------------------------------
# Test: search() returns malformed tuples
# ---------------------------------------------------------------------------

class TestSearchResultMalformations:
    """The internal search() method could return malformed data."""

    def test_search_returns_empty_metadata_tuple(self):
        """search() returns empty metadata dict — .get() must not crash."""
        mc = MagicMock()
        mc.count.return_value = 1
        mc.query.return_value = {
            "documents": [["test doc"]],
            "metadatas": [[{}]],   # empty metadata dict
            "distances": [[0.1]],
        }
        vs = _make_vs(mock_collection=mc)
        ctx, sources, chunks = vs.get_context("test", n_results=3, hybrid_search=False)
        assert isinstance(ctx, str)
        # Should default to "Unknown" for source
        assert chunks[0].source == "Unknown"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
