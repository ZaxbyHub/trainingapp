"""
Tests for rag_engine.py query() fix (Task 8.2).
Verifies:
1. When reranking_enabled=False, query() truncates to n_results and chunks_retrieved matches
2. When n_results=0, effective_top_k is clamped to 1
3. When n_results=-1, effective_top_k is clamped to 1
4. When reranking_enabled=True, existing behavior is unchanged
5. chunks_retrieved is accurate in both paths
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock, call

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rag_engine import RAGEngine, RAGConfig, QueryResult
from document_processor import DocumentChunk


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_chunks(count, source="doc1.txt"):
    """Create `count` distinct DocumentChunk objects for predictable testing."""
    return [
        DocumentChunk(
            text=f"Chunk {i} content for testing purposes.",
            source=source,
            chunk_index=i,
        )
        for i in range(count)
    ]


def _build_engine(reranking_enabled=True, n_results=6, rerank_top_k=6,
                  initial_retrieval_top_k=30, db_path=None, tmp_path=None):
    """Factory to build a RAGEngine with known config and fully-mocked dependencies."""
    from pathlib import Path
    if tmp_path is None:
        import tempfile
        tmp_path_obj = Path(tempfile.mkdtemp())
    else:
        tmp_path_obj = tmp_path / "db"

    if db_path:
        db = db_path
    else:
        db = str(tmp_path_obj)

    # Create 10 mock chunks returned by vector_store.get_context
    mock_chunks = _make_chunks(10)
    mock_context_str = "\n\n---\n\n".join(c.text for c in mock_chunks)

    mock_llm = MagicMock()
    mock_llm.answer_question.return_value = "Mocked answer from LLM."
    mock_llm.get_info.return_value = {"backend": "mock"}

    mock_vs = MagicMock()
    mock_vs.get_context.return_value = (mock_context_str, ["doc1.txt"], mock_chunks)
    mock_vs.get_stats.return_value = {
        "document_count": 1,
        "chunk_count": 10,
        "documents": ["doc1.txt"],
    }

    config = RAGConfig(
        db_path=db,
        reranking_enabled=reranking_enabled,
        n_results=n_results,
        rerank_top_k=rerank_top_k,
        initial_retrieval_top_k=initial_retrieval_top_k,
    )

    with patch("rag_engine.SmartLLM", return_value=mock_llm), \
         patch("rag_engine.VectorStore", return_value=mock_vs):
        engine = RAGEngine(config=config)
        engine.llm = mock_llm
        engine.vector_store = mock_vs

    return engine, mock_chunks


# ---------------------------------------------------------------------------
# CATEGORY 1: Non-reranking path — chunks_retrieved matches n_results
# ---------------------------------------------------------------------------

class TestNonRerankingChunksRetrieved:
    """
    When reranking_enabled=False, the non-reranking path (else branch) should:
    - Use n_results (from query param) if provided, else config.n_results
    - Truncate retrieved_chunks to that count
    - Set chunks_retrieved = len(truncated list)
    """

    def test_n_results_3_non_reranking_truncates_to_3(self, tmp_path):
        """n_results=3 → chunks_retrieved=3 in non-reranking path."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=6,       # config default
            tmp_path=tmp_path,
        )
        # Override config to ensure non-reranking
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=3)

        assert result.chunks_retrieved == 3, (
            f"Expected chunks_retrieved=3 when n_results=3, got {result.chunks_retrieved}"
        )

    def test_n_results_1_non_reranking_truncates_to_1(self, tmp_path):
        """n_results=1 → chunks_retrieved=1."""
        engine, _ = _build_engine(reranking_enabled=False, n_results=6, tmp_path=tmp_path)
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=1)

        assert result.chunks_retrieved == 1, (
            f"Expected chunks_retrieved=1 when n_results=1, got {result.chunks_retrieved}"
        )

    def test_n_results_none_uses_config_n_results(self, tmp_path):
        """n_results=None → falls back to config.n_results=4."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=4,
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=None)

        assert result.chunks_retrieved == 4, (
            f"Expected chunks_retrieved=4 when n_results=None and config.n_results=4, "
            f"got {result.chunks_retrieved}"
        )

    def test_n_results_exceeds_retrieved_chunks(self, tmp_path):
        """n_results=20 but only 10 chunks exist → chunks_retrieved=10 (no crash)."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=6,
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=20)

        assert result.chunks_retrieved == 10, (
            f"Expected chunks_retrieved=10 (capped by retrieved count), "
            f"got {result.chunks_retrieved}"
        )


# ---------------------------------------------------------------------------
# CATEGORY 2: effective_top_k clamping — n_results=0
# ---------------------------------------------------------------------------

class TestEffectiveTopKClamping:
    """
    When n_results=0 or n_results=-1:
    - effective_top_k should be clamped to 1 (guarded by `if effective_top_k <= 0`)
    - chunks_retrieved should reflect the clamped behavior
    """

    def test_n_results_0_reranking_clamped_to_1(self, tmp_path):
        """n_results=0 with reranking → effective_top_k=1 → chunks_retrieved=1."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=True,
            n_results=6,
            rerank_top_k=6,
            tmp_path=tmp_path,
        )
        # Simulate reranker returns fewer chunks than effective_top_k
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [(mock_chunks[0], 0.95)]
        engine.reranker = mock_reranker

        result = engine.query("What is Python?", n_results=0)

        # effective_top_k is clamped to 1; reranker returns 1 chunk
        assert result.chunks_retrieved == 1, (
            f"Expected chunks_retrieved=1 (reranker capped at effective_top_k=1), "
            f"got {result.chunks_retrieved}"
        )
        # Verify reranker was called with top_k=1
        mock_reranker.rerank.assert_called_once()
        call_args = mock_reranker.rerank.call_args
        assert call_args[1]["top_k"] == 1, (
            f"Expected reranker called with top_k=1, got top_k={call_args[1]['top_k']}"
        )

    def test_n_results_0_non_reranking_clamped_to_1(self, tmp_path):
        """n_results=0 with reranking disabled → final_top_k=1 → chunks_retrieved=1."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=6,
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=0)

        assert result.chunks_retrieved == 1, (
            f"Expected chunks_retrieved=1 (clamped from n_results=0), "
            f"got {result.chunks_retrieved}"
        )

    def test_n_results_negative_1_reranking_clamped_to_1(self, tmp_path):
        """n_results=-1 with reranking → effective_top_k=1 → chunks_retrieved=1."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=True,
            n_results=6,
            rerank_top_k=6,
            tmp_path=tmp_path,
        )
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [(mock_chunks[0], 0.95)]
        engine.reranker = mock_reranker

        result = engine.query("What is Python?", n_results=-1)

        assert result.chunks_retrieved == 1, (
            f"Expected chunks_retrieved=1 (clamped from n_results=-1), "
            f"got {result.chunks_retrieved}"
        )
        call_args = mock_reranker.rerank.call_args
        assert call_args[1]["top_k"] == 1

    def test_n_results_negative_1_non_reranking_clamped_to_1(self, tmp_path):
        """n_results=-1 with reranking disabled → final_top_k=1 → chunks_retrieved=1."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=6,
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=-1)

        assert result.chunks_retrieved == 1, (
            f"Expected chunks_retrieved=1 (clamped from n_results=-1), "
            f"got {result.chunks_retrieved}"
        )

    def test_config_rerank_top_k_zero_reranking_enabled(self, tmp_path):
        """config.rerank_top_k=0 with reranking → effective_top_k=1."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=True,
            n_results=None,       # use config
            rerank_top_k=0,       # zero in config
            tmp_path=tmp_path,
        )
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [(mock_chunks[0], 0.95)]
        engine.reranker = mock_reranker

        result = engine.query("What is Python?", n_results=None)

        assert result.chunks_retrieved == 1, (
            f"Expected chunks_retrieved=1 (config rerank_top_k=0 clamped to 1), "
            f"got {result.chunks_retrieved}"
        )
        call_args = mock_reranker.rerank.call_args
        assert call_args[1]["top_k"] == 1

    def test_config_n_results_zero_non_reranking(self, tmp_path):
        """config.n_results=0 with reranking disabled → final_top_k=1."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=0,         # zero in config
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=None)

        assert result.chunks_retrieved == 1, (
            f"Expected chunks_retrieved=1 (config n_results=0 clamped to 1), "
            f"got {result.chunks_retrieved}"
        )


# ---------------------------------------------------------------------------
# CATEGORY 3: Reranking path — existing behavior unchanged
# ---------------------------------------------------------------------------

class TestRerankingPathUnchanged:
    """
    When reranking_enabled=True:
    - chunks_retrieved should equal the length of the reranked list
    - The reranker is called with effective_top_k
    """

    def test_reranking_returns_exact_reranked_count(self, tmp_path):
        """Reranker returns 4 → chunks_retrieved=4 (not effective_top_k)."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=True,
            n_results=6,
            rerank_top_k=6,
            tmp_path=tmp_path,
        )
        # Simulate reranker returning exactly 4 chunks (less than top_k)
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [
            (mock_chunks[0], 0.95),
            (mock_chunks[2], 0.90),
            (mock_chunks[5], 0.85),
            (mock_chunks[7], 0.80),
        ]
        engine.reranker = mock_reranker

        result = engine.query("What is Python?", n_results=None)

        assert result.chunks_retrieved == 4, (
            f"Expected chunks_retrieved=4 (reranker returned 4), got {result.chunks_retrieved}"
        )

    def test_reranking_n_results_override_passed_to_reranker(self, tmp_path):
        """n_results=3 override is passed as effective_top_k to reranker."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=True,
            n_results=6,
            rerank_top_k=6,
            tmp_path=tmp_path,
        )
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [
            (mock_chunks[0], 0.95),
            (mock_chunks[1], 0.90),
        ]
        engine.reranker = mock_reranker

        result = engine.query("What is Python?", n_results=3)

        call_args = mock_reranker.rerank.call_args
        assert call_args[1]["top_k"] == 3, (
            f"Expected reranker called with top_k=3, got top_k={call_args[1]['top_k']}"
        )
        assert result.chunks_retrieved == 2

    def test_reranking_fallback_when_reranker_returns_nothing(self, tmp_path):
        """Reranker returns empty → falls back to retrieved_chunks[:effective_top_k]."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=True,
            n_results=6,
            rerank_top_k=6,
            tmp_path=tmp_path,
        )
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = []  # Empty reranked list
        engine.reranker = mock_reranker

        result = engine.query("What is Python?", n_results=None)

        # Fallback: retrieved_chunks[:effective_top_k=6] → 6 chunks
        assert result.chunks_retrieved == 6, (
            f"Expected chunks_retrieved=6 (fallback to retrieved_chunks[:6]), "
            f"got {result.chunks_retrieved}"
        )

    def test_reranking_disabled_n_results_override_uses_non_reranking_path(self, tmp_path):
        """reranking_enabled=False + n_results=3 → non-reranking path."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=6,
            tmp_path=tmp_path,
        )
        # Ensure reranking is disabled at config level
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=3)

        assert result.chunks_retrieved == 3, (
            f"Expected chunks_retrieved=3 (non-reranking path), got {result.chunks_retrieved}"
        )


# ---------------------------------------------------------------------------
# CATEGORY 4: chunks_retrieved accuracy in both paths
# ---------------------------------------------------------------------------

class TestChunksRetrievedAccuracy:
    """Verify chunks_retrieved always equals the actual number of chunks used."""

    def test_accuracy_non_reranking_exact_match(self, tmp_path):
        """chunks_retrieved == actual chunks used in non-reranking path."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=5,
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False

        result = engine.query("What is Python?", n_results=5)

        assert result.chunks_retrieved == 5, (
            f"chunks_retrieved should be 5, got {result.chunks_retrieved}"
        )

    def test_accuracy_non_reranking_empty_chunks_list(self, tmp_path):
        """get_context returns empty chunks list → chunks_retrieved=0."""
        engine, _ = _build_engine(
            reranking_enabled=False,
            n_results=6,
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False
        # Override to return empty chunks
        engine.vector_store.get_context.return_value = ("", [], [])

        result = engine.query("What is Python?", n_results=5)

        # Empty context returns early with chunks_retrieved=0
        assert result.chunks_retrieved == 0, (
            f"Expected chunks_retrieved=0 when no chunks retrieved, got {result.chunks_retrieved}"
        )

    def test_accuracy_reranking_matches_reranked_length(self, tmp_path):
        """chunks_retrieved == len(reranked) in reranking path."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=True,
            n_results=6,
            rerank_top_k=6,
            tmp_path=tmp_path,
        )
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [
            (mock_chunks[0], 0.95),
            (mock_chunks[1], 0.90),
            (mock_chunks[2], 0.85),
        ]
        engine.reranker = mock_reranker

        result = engine.query("What is Python?", n_results=None)

        assert result.chunks_retrieved == 3, (
            f"Expected chunks_retrieved=3 (len of reranked), got {result.chunks_retrieved}"
        )


# ---------------------------------------------------------------------------
# CATEGORY 5: Integration — both paths side by side
# ---------------------------------------------------------------------------

class TestBothPathsSideBySide:
    """Compare reranking vs non-reranking behavior with identical inputs."""

    def test_same_n_results_both_paths_produce_correct_counts(self, tmp_path):
        """Same n_results=4 → non-reranking=4, reranking=reranked count."""
        # Non-reranking
        engine_nr, _ = _build_engine(
            reranking_enabled=False,
            n_results=4,
            tmp_path=tmp_path,
        )
        engine_nr.config.reranking_enabled = False
        result_nr = engine_nr.query("What is Python?", n_results=4)

        # Reranking
        engine_r, mock_chunks_r = _build_engine(
            reranking_enabled=True,
            n_results=4,
            rerank_top_k=4,
            tmp_path=tmp_path,
        )
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [
            (mock_chunks_r[0], 0.95),
            (mock_chunks_r[2], 0.90),
        ]
        engine_r.reranker = mock_reranker
        result_r = engine_r.query("What is Python?", n_results=4)

        # Non-reranking: exactly 4 chunks
        assert result_nr.chunks_retrieved == 4, (
            f"Non-reranking: expected 4, got {result_nr.chunks_retrieved}"
        )
        # Reranking: 2 (what reranker returned)
        assert result_r.chunks_retrieved == 2, (
            f"Reranking: expected 2 (reranker returned 2), got {result_r.chunks_retrieved}"
        )


# ---------------------------------------------------------------------------
# CATEGORY 6: Property-based invariants
# ---------------------------------------------------------------------------

class TestQueryInvariants:
    """Property-based invariants for query() chunks_retrieved behavior."""

    def test_chunks_retrieved_never_negative(self, tmp_path):
        """chunks_retrieved should always be >= 0 regardless of inputs."""
        engine, _ = _build_engine(reranking_enabled=True, n_results=6, tmp_path=tmp_path)
        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = []
        engine.reranker = mock_reranker

        for n_results_val in [None, 0, 1, 3, -1, -100]:
            engine.config.reranking_enabled = True
            result = engine.query("What is Python?", n_results=n_results_val)
            assert result.chunks_retrieved >= 0, (
                f"chunks_retrieved={result.chunks_retrieved} is negative for n_results={n_results_val}"
            )

    def test_chunks_retrieved_at_most_retrieved(self, tmp_path):
        """chunks_retrieved should never exceed the number of chunks returned by get_context."""
        engine, mock_chunks = _build_engine(
            reranking_enabled=False,
            n_results=6,
            tmp_path=tmp_path,
        )
        engine.config.reranking_enabled = False

        # n_results=9999 exceeds available chunks (10)
        result = engine.query("What is Python?", n_results=9999)

        assert result.chunks_retrieved <= len(mock_chunks), (
            f"chunks_retrieved={result.chunks_retrieved} exceeds retrieved chunks={len(mock_chunks)}"
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
