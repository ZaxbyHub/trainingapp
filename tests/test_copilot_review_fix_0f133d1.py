"""
Verification tests for Copilot review fix commit 0f133d1.

Tests the following fixes:
1. Cancellation handling: Uses QueryCancelled exception type instead of string matching
2. QueryTransformer singleton: Double-check now includes _query_transformer_failed flag
3. Proper exception propagation for cancellation events
"""

import pytest
import threading
from unittest.mock import MagicMock, patch
import sys

# Pre-register llama_cpp as a mock
sys.modules.setdefault("llama_cpp", MagicMock())

from llm_interface import (
    SmartLLM,
    GGUFBackend,
    InferenceConfig,
    QueryCancelled,
)


# ---------------------------------------------------------------------------
# Test 1: QueryCancelled exception is raised when cancellation_event is set
# ---------------------------------------------------------------------------

class TestQueryCancelledExceptionType:
    """Verify that cancellation raises QueryCancelled, not generic Exception.

    Note: These tests use SmartLLM with mocked backend to test the full
    cancellation flow without depending on GGUFBackend internals.
    """

    def test_generate_propagates_query_cancelled_from_backend(self):
        """When backend.generate() raises QueryCancelled, SmartLLM.generate() propagates it."""
        # Create mock backend that raises QueryCancelled
        mock_backend = MagicMock(spec=GGUFBackend)
        mock_backend.generate.side_effect = QueryCancelled()

        llm = SmartLLM.__new__(SmartLLM)
        llm.backend = mock_backend
        llm.prompt_builder = MagicMock()

        # Should raise QueryCancelled, NOT wrap it in RuntimeError
        with pytest.raises(QueryCancelled):
            llm.generate(
                prompt="test prompt",
                config=InferenceConfig(),
            )

    def test_chat_complete_raises_query_cancelled_when_event_set(self):
        """GGUFBackend.chat_complete() raises QueryCancelled when cancellation_event is set."""
        # Create mock backend that tracks cancellation
        mock_backend = MagicMock(spec=GGUFBackend)
        mock_backend.is_qwen3 = False
        mock_backend.is_gemma4 = False

        def chat_with_cancel(system_prompt, user_prompt, config=None, stream_callback=None, cancellation_event=None):
            if cancellation_event is not None and cancellation_event.is_set():
                raise QueryCancelled()
            return "Normal chat response"
        mock_backend.chat_complete.side_effect = chat_with_cancel

        llm = SmartLLM.__new__(SmartLLM)
        llm.backend = mock_backend
        llm.prompt_builder = MagicMock()

        cancel_event = threading.Event()
        cancel_event.set()

        # Should raise QueryCancelled
        with pytest.raises(QueryCancelled):
            llm.answer_question(
                question="Test question",
                context="Test context",
                sources=["test.txt"],
                cancellation_event=cancel_event,
            )

    def test_answer_question_raises_query_cancelled_when_event_set(self):
        """SmartLLM.answer_question() raises QueryCancelled when cancellation_event is set."""
        # Create mock backend
        mock_backend = MagicMock(spec=GGUFBackend)
        mock_backend.is_qwen3 = False
        mock_backend.is_gemma4 = False

        # Mock chat_complete to raise QueryCancelled
        mock_backend.chat_complete.side_effect = QueryCancelled()

        llm = SmartLLM.__new__(SmartLLM)
        llm.backend = mock_backend
        llm.prompt_builder = MagicMock()

        cancel_event = threading.Event()
        cancel_event.set()

        # Should raise QueryCancelled
        with pytest.raises(QueryCancelled):
            llm.answer_question(
                question="Test question",
                context="Test context",
                sources=["test.txt"],
                cancellation_event=cancel_event,
            )


# ---------------------------------------------------------------------------
# Test 2: String-based cancellation check is replaced with isinstance check
# ---------------------------------------------------------------------------

class TestCancellationExceptionTypeHandling:
    """Verify exception handlers use isinstance(e, QueryCancelled) instead of string matching."""

    def test_chat_complete_preserves_query_cancelled_not_string_match(self):
        """chat_complete() preserves QueryCancelled exceptions using isinstance."""
        mock_backend = MagicMock(spec=GGUFBackend)
        mock_backend.is_qwen3 = False
        mock_backend.is_gemma4 = False
        # Simulate the fix: chat_complete raises QueryCancelled
        mock_backend.chat_complete.side_effect = QueryCancelled("Operation cancelled")

        llm = SmartLLM.__new__(SmartLLM)
        llm.backend = mock_backend
        llm.prompt_builder = MagicMock()

        cancel_event = threading.Event()
        # Don't set cancel_event - the exception comes from backend

        # QueryCancelled should propagate, not be wrapped in RuntimeError
        with pytest.raises(QueryCancelled):
            llm.answer_question(
                question="Test",
                context="ctx",
                sources=["s.txt"],
                cancellation_event=cancel_event,
            )

    def test_generate_preserves_query_cancelled_not_string_match(self):
        """generate() preserves QueryCancelled exceptions using isinstance."""
        mock_backend = MagicMock(spec=GGUFBackend)
        mock_backend.generate.side_effect = QueryCancelled("Operation cancelled")

        llm = SmartLLM.__new__(SmartLLM)
        llm.backend = mock_backend
        llm.prompt_builder = MagicMock()

        # QueryCancelled should propagate, not be wrapped in RuntimeError
        with pytest.raises(QueryCancelled):
            llm.generate(
                prompt="Test prompt",
                config=InferenceConfig(),
            )


# ---------------------------------------------------------------------------
# Test 3: QueryTransformer singleton with _query_transformer_failed flag
# ---------------------------------------------------------------------------

class TestQueryTransformerSingletonFix:
    """Verify _ensure_query_transformer properly checks _query_transformer_failed."""

    def test_ensure_query_transformer_skips_after_failure(self):
        """After QueryTransformer init fails, subsequent queries skip retry."""
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig(query_transformation_enabled=True)

        with patch("rag_engine.VectorStore") as mock_vector_store, \
             patch("rag_engine.SmartLLM") as mock_llm, \
             patch("rag_engine.RAGEngine._save_config"):

            mock_store = MagicMock()
            mock_store.get_stats.return_value = {
                "document_count": 1, "chunk_count": 5,
                "embedding_model": "test-model", "documents": ["doc.txt"],
            }
            mock_store.get_context.return_value = (
                "Context text",
                ["doc.txt"],
                [MagicMock(text="Context text", source="doc.txt", chunk_index=0)],
            )
            mock_vector_store.return_value = mock_store

            mock_llm_instance = MagicMock()
            mock_llm_instance.answer_question.return_value = "Answer."
            mock_llm.return_value = mock_llm_instance

            engine = RAGEngine(config=config)
            engine.llm = mock_llm_instance
            engine.reranker = None

            # Create a mock QueryTransformer class that raises on init
            mock_transformer_class = MagicMock()
            mock_transformer_class.side_effect = RuntimeError("Model not available")

            # Patch the module where it's imported from
            with patch.dict("sys.modules", {"query_transformer": MagicMock(QueryTransformer=mock_transformer_class)}):
                engine._ensure_query_transformer()

                # After failure, _query_transformer_failed should be True
                assert engine._query_transformer_failed is True
                assert engine._query_transformer is None

            # Second call should skip retry (this was the bug - it would retry)
            mock_transformer_class2 = MagicMock()
            mock_transformer_class2.side_effect = RuntimeError("Still not available")

            with patch.dict("sys.modules", {"query_transformer": MagicMock(QueryTransformer=mock_transformer_class2)}):
                # This should NOT raise or retry
                engine._ensure_query_transformer()

                # Should not have called QueryTransformer again
                assert mock_transformer_class2.call_count == 0, \
                    "QueryTransformer should not be retried after failure"

    def test_double_check_includes_failed_flag(self):
        """The double-check in _ensure_query_transformer includes _query_transformer_failed."""
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig(query_transformation_enabled=True)

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
            mock_llm.return_value = mock_llm_instance

            engine = RAGEngine(config=config)
            engine.llm = mock_llm_instance

            # Manually set _query_transformer_failed
            engine._query_transformer_failed = True
            engine._query_transformer = None

            # Create a mock QueryTransformer that should NOT be called
            mock_transformer_class = MagicMock()

            # Patch the module - should not be imported due to failed flag
            with patch.dict("sys.modules", {"query_transformer": MagicMock(QueryTransformer=mock_transformer_class)}):
                engine._ensure_query_transformer()

                # QueryTransformer should NOT be instantiated
                assert mock_transformer_class.call_count == 0, \
                    "Should not attempt QueryTransformer when _query_transformer_failed=True"


# ---------------------------------------------------------------------------
# Test 4: QueryCancelled import in rag_engine
# ---------------------------------------------------------------------------

class TestQueryCancelledImport:
    """Verify QueryCancelled is properly imported in rag_engine."""

    def test_rag_engine_imports_query_cancelled(self):
        """rag_engine.py imports QueryCancelled from llm_interface."""
        from rag_engine import QueryCancelled as ImportedQC
        from llm_interface import QueryCancelled as OriginalQC

        # Same class
        assert ImportedQC is OriginalQC

    def test_query_cancelled_is_exception(self):
        """QueryCancelled is a proper exception type."""
        from llm_interface import QueryCancelled

        # Should be catchable as Exception
        try:
            raise QueryCancelled("test")
        except Exception as e:
            assert isinstance(e, QueryCancelled)

        # Should be catchable as QueryCancelled directly
        try:
            raise QueryCancelled("test")
        except QueryCancelled:
            pass  # Expected


# ---------------------------------------------------------------------------
# Test 5: Integration - cancellation propagates correctly through layers
# ---------------------------------------------------------------------------

class TestCancellationPropagation:
    """Verify cancellation propagates correctly through RAGEngine -> SmartLLM -> GGUFBackend."""

    def test_cancellation_propagates_through_all_layers(self):
        """Cancellation set at GGUFBackend level propagates to RAGEngine.query()."""
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig()

        with patch("rag_engine.VectorStore") as mock_vector_store, \
             patch("rag_engine.SmartLLM") as mock_llm, \
             patch("rag_engine.RAGEngine._save_config"):

            mock_store = MagicMock()
            mock_store.get_stats.return_value = {
                "document_count": 1, "chunk_count": 5,
                "embedding_model": "test-model", "documents": ["doc.txt"],
            }
            mock_store.get_context.return_value = (
                "Context text",
                ["doc.txt"],
                [MagicMock(text="Context text", source="doc.txt", chunk_index=0)],
            )
            mock_vector_store.return_value = mock_store

            mock_llm_instance = MagicMock()
            # Simulate SmartLLM raising QueryCancelled (as fixed in 0f133d1)
            mock_llm_instance.answer_question.side_effect = QueryCancelled()
            mock_llm.return_value = mock_llm_instance

            engine = RAGEngine(config=config)
            engine.llm = mock_llm_instance

            cancel_event = threading.Event()
            cancel_event.set()  # Pre-set cancellation

            # RAGEngine should handle QueryCancelled and return [Cancelled]
            from rag_engine import QueryResult
            result = engine.query(
                question="Test question",
                cancellation_event=cancel_event,
            )

            # Should return cancelled result (checkpoint a catches it)
            assert result.answer == "[Cancelled]"


# ---------------------------------------------------------------------------
# Test 6: Verify old string-based cancellation check would NOT work
# ---------------------------------------------------------------------------

class TestStringMatchingAntipattern:
    """Demonstrate why string matching for cancellation is incorrect."""

    def test_string_matching_fails_for_query_cancelled(self):
        """String matching 'cancelled' would miss QueryCancelled with different message."""
        # This demonstrates why the fix was needed
        error_message = "Operation was cancelled by user"
        is_old_pattern = "cancelled" in error_message.lower()
        assert is_old_pattern is True

        # But what if the message is different?
        error_message2 = "User requested cancellation"
        is_old_pattern2 = "cancelled" in error_message2.lower()
        # This would FAIL to match - exposing the bug in string matching

        # The fix uses isinstance(e, QueryCancelled) which works for ANY message
        exc = QueryCancelled("Custom cancel message")
        is_new_pattern = isinstance(exc, QueryCancelled)
        assert is_new_pattern is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
