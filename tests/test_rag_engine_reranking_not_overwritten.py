"""
Tests for mid-query cancellation in RAG Engine — criterion 7 (retry).

Criterion 7: reranked results are NOT overwritten by non-reranking fallback
when reranking succeeds.

This tests the bug where the if/else block at lines 475-483 of rag_engine.py
incorrectly overwrites context/sources in the else branch even when reranking
succeeded (reranked was truthy but the else still ran due to logic error).
"""

import pytest
import threading
from unittest.mock import MagicMock, patch

from rag_engine import RAGEngine, RAGConfig, QueryResult


def make_engine(config=None):
    """
    Create a RAGEngine with external deps patched.
    engine.llm is directly assigned so that it survives the exit from
    the patch context manager (which only patches module-level imports).
    """
    with patch("rag_engine.VectorStore") as mock_vector_store, \
         patch("rag_engine.SmartLLM") as mock_llm, \
         patch("rag_engine.RAGEngine._save_config"):

        mock_store = MagicMock()
        mock_store.get_stats.return_value = {
            "document_count": 1, "chunk_count": 5,
            "embedding_model": "test-model", "documents": ["doc.txt"],
        }
        mock_vector_store.return_value = mock_store

        mock_llm_instance = MagicMock()
        mock_llm_instance.answer_question.return_value = "Final answer."
        mock_llm.return_value = mock_llm_instance

        engine = RAGEngine(config=config) if config else RAGEngine()
        # Directly assign so it survives patch context exit
        engine.llm = mock_llm_instance
        engine._query_transformer = None
        engine.reranker = None
        return engine, mock_store, mock_llm_instance


# ---------------------------------------------------------------------------
# Criterion 7: reranked results are NOT overwritten
# ---------------------------------------------------------------------------

class TestRerankingNotOverwritten:
    """Criterion 7: reranked results are NOT overwritten by non-reranking fallback when reranking succeeds."""

    def test_reranked_results_not_overwritten_when_reranking_succeeds(self):
        """
        When reranking succeeds (reranked list is non-empty), the reranked
        context and sources must be used — NOT the raw retrieval fallback.

        Bug: lines 475-483 use an if/else that overwrites context/sources
        in the else branch even when reranked was truthy, because the
        reranked variable was reassigned in the else block.
        """
        config = RAGConfig(
            reranking_enabled=True,
            # query_transformation_enabled=False to skip checkpoint (a)
        )
        engine, mock_store, mock_llm = make_engine(config=config)

        # Raw retrieval chunks — different from reranked chunks
        raw_chunk_a = MagicMock(
            text="Raw chunk A from retrieval — should NOT be in final context if reranking works",
            source="raw_doc.txt",
            chunk_index=0,
        )
        raw_chunk_b = MagicMock(
            text="Raw chunk B from retrieval — should NOT be in final context if reranking works",
            source="raw_doc.txt",
            chunk_index=1,
        )

        # Reranked chunks — these should WIN over raw chunks
        reranked_chunk_1 = MagicMock(
            text="Reranked chunk 1 — best match after cross-encoder scoring",
            source="reranked_doc.txt",
            chunk_index=0,
        )
        reranked_chunk_2 = MagicMock(
            text="Reranked chunk 2 — second best match after cross-encoder scoring",
            source="reranked_doc.txt",
            chunk_index=1,
        )

        # get_context returns raw chunks
        mock_store.get_context.return_value = (
            "Raw context text.",
            ["raw_doc.txt"],
            [raw_chunk_a, raw_chunk_b],
        )

        # Set up a mock reranker that succeeds with reranked results
        mock_reranker = MagicMock()
        # The reranker returns a non-empty list → reranking SUCCEEDED
        mock_reranker.rerank.return_value = [
            (reranked_chunk_1, 0.95),
            (reranked_chunk_2, 0.88),
        ]
        engine.reranker = mock_reranker

        result = engine.query(
            question="What is Python?",
            cancellation_event=None,
        )

        # Verify reranker was called (reranking was attempted)
        mock_reranker.rerank.assert_called_once()

        # THE KEY ASSERTION: context must contain reranked content, NOT raw content
        assert "Reranked chunk 1" in result.sources or "reranked_doc.txt" in result.sources, \
            f"Expected reranked content in sources, got: {result.sources!r}"

        # Verify raw doc is NOT in sources (it would be if fallback overwrote reranked)
        assert "raw_doc.txt" not in result.sources or "reranked_doc.txt" in result.sources, \
            f"Raw doc should not appear when reranking succeeded. Sources: {result.sources!r}"

        # Context must contain reranked chunk text, not raw chunk text
        # We need to check what was passed to answer_question — but we can infer
        # from sources since sources comes from the same reranked path
        assert result.chunks_retrieved == 2, \
            f"Expected 2 chunks from reranking, got {result.chunks_retrieved}"

    def test_reranked_context_text_preserved_not_raw_text(self):
        """
        Directly verify that the context string passed to answer_question
        contains reranked chunk text, not raw retrieval text.
        """
        config = RAGConfig(reranking_enabled=True)
        engine, mock_store, mock_llm = make_engine(config=config)

        raw_chunk = MagicMock(
            text="UNEXPECTED_RAW_CHUNK_TEXT should not appear",
            source="raw_source.txt",
            chunk_index=0,
        )
        reranked_chunk = MagicMock(
            text="EXPECTED_RERANKED_CHUNK_TEXT should definitely appear",
            source="reranked_source.txt",
            chunk_index=0,
        )

        mock_store.get_context.return_value = (
            "Raw context.",
            ["raw_source.txt"],
            [raw_chunk],
        )

        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [(reranked_chunk, 0.9)]
        engine.reranker = mock_reranker

        captured_context = None

        def capture_answer(question, context, sources, **kwargs):
            nonlocal captured_context
            captured_context = context
            return "Final answer."

        mock_llm.answer_question.side_effect = capture_answer

        result = engine.query(
            question="What is Python?",
            cancellation_event=None,
        )

        # The context passed to LLM must be from reranked chunks, not raw
        assert captured_context is not None, "answer_question was never called"
        assert "EXPECTED_RERANKED_CHUNK_TEXT" in captured_context, \
            f"Context should contain reranked text, got: {captured_context!r}"
        assert "UNEXPECTED_RAW_CHUNK_TEXT" not in captured_context, \
            f"Context should NOT contain raw retrieval text, got: {captured_context!r}"

    def test_reranked_sources_preserved_not_raw_sources(self):
        """
        Sources list must reflect reranked document sources, not raw retrieval sources.
        """
        config = RAGConfig(reranking_enabled=True)
        engine, mock_store, mock_llm = make_engine(config=config)

        raw_chunk = MagicMock(text="Raw text.", source="RAW_DOCUMENT.txt", chunk_index=0)
        reranked_chunk = MagicMock(text="Reranked text.", source="RERANKED_DOCUMENT.txt", chunk_index=0)

        mock_store.get_context.return_value = (
            "Raw context.",
            ["RAW_DOCUMENT.txt"],
            [raw_chunk],
        )

        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [(reranked_chunk, 0.9)]
        engine.reranker = mock_reranker

        result = engine.query(
            question="What is Python?",
            cancellation_event=None,
        )

        # Sources must contain reranked document, not raw document
        assert "RERANKED_DOCUMENT.txt" in result.sources, \
            f"Expected RERANKED_DOCUMENT in sources, got: {result.sources!r}"
        assert "RAW_DOCUMENT.txt" not in result.sources, \
            f"Raw document should NOT be in sources when reranking succeeded, got: {result.sources!r}"

    def test_fallback_only_used_when_reranked_is_empty(self):
        """
        When reranking returns an empty list (reranking "failed" / found nothing),
        the non-reranking fallback should be used.

        This verifies the correct behavior path: when reranked is empty,
        we use raw chunks instead.
        """
        config = RAGConfig(reranking_enabled=True)
        engine, mock_store, mock_llm = make_engine(config=config)

        raw_chunk_a = MagicMock(text="Raw chunk A.", source="raw_a.txt", chunk_index=0)
        raw_chunk_b = MagicMock(text="Raw chunk B.", source="raw_b.txt", chunk_index=1)

        mock_store.get_context.return_value = (
            "Raw context.",
            ["raw_a.txt", "raw_b.txt"],
            [raw_chunk_a, raw_chunk_b],
        )

        mock_reranker = MagicMock()
        # Reranking returns empty — fallback should be used
        mock_reranker.rerank.return_value = []
        engine.reranker = mock_reranker

        result = engine.query(
            question="What is Python?",
            cancellation_event=None,
        )

        # Reranker was still called (it just returned empty)
        mock_reranker.rerank.assert_called_once()

        # Should use raw chunks as fallback
        assert result.chunks_retrieved == 2, \
            f"Expected 2 chunks from fallback, got {result.chunks_retrieved}"
        assert "raw_a.txt" in result.sources or "raw_b.txt" in result.sources

    def test_reranking_succeeds_then_answer_question_returns_normal(self):
        """
        Full happy path: reranking succeeds, no cancellation, answer returned normally.
        This is the control test confirming reranking + normal flow works.
        """
        config = RAGConfig(reranking_enabled=True)
        engine, mock_store, mock_llm = make_engine(config=config)

        raw_chunk = MagicMock(text="Raw retrieval text.", source="raw.txt", chunk_index=0)
        reranked_chunk = MagicMock(text="Reranked best text.", source="reranked.txt", chunk_index=0)

        mock_store.get_context.return_value = (
            "Raw context.",
            ["raw.txt"],
            [raw_chunk],
        )

        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [(reranked_chunk, 0.95)]
        engine.reranker = mock_reranker

        mock_llm.answer_question.return_value = "The best reranked answer."

        result = engine.query(
            question="What is Python?",
            cancellation_event=None,
        )

        # Normal answer path
        assert result.answer == "The best reranked answer."
        assert result.chunks_retrieved == 1
        mock_llm.answer_question.assert_called_once()
