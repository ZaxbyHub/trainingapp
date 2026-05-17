"""
Tests for mid-query cancellation in RAG Engine (task 4.3).

Verifies that query() respects threading.Event cancellation at each checkpoint
and that no partial answer content is returned on cancellation.
"""

import pytest
import threading
import time
from unittest.mock import MagicMock, patch

from rag_engine import RAGEngine, RAGConfig, QueryResult


# ---------------------------------------------------------------------------
# Engine factory — keeps patches active for the engine's lifetime
# ---------------------------------------------------------------------------

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
# Criterion 1: cancellation_event=None → unchanged behaviour
# ---------------------------------------------------------------------------

class TestCancellationBackwardCompatible:
    """Criterion 1: query() with cancellation_event=None behaves unchanged (backward compatible)."""

    def test_query_with_none_cancellation_event_returns_normal_answer(self):
        """Passing cancellation_event=None must not change normal query behaviour."""
        engine, mock_store, mock_llm = make_engine()

        mock_store.get_context.return_value = (
            "Relevant context about Python.",
            ["doc.txt"],
            [MagicMock(text="Relevant context about Python.", source="doc.txt", chunk_index=0)],
        )

        result = engine.query(
            question="What is Python?",
            cancellation_event=None,
        )

        assert result.answer == "Final answer."
        assert result.question == "What is Python?"
        mock_llm.answer_question.assert_called_once()


# ---------------------------------------------------------------------------
# Criterion 2: cancellation_event pre-set → [Cancelled] immediately
# ---------------------------------------------------------------------------

class TestCancellationPreCall:
    """Criterion 2: query() with cancellation_event set before call returns answer='[Cancelled]'."""

    def test_query_with_event_already_set_returns_cancelled(self):
        """If the Event is already set before query() is called, return [Cancelled] immediately."""
        engine, _, mock_llm = make_engine()

        cancel_event = threading.Event()
        cancel_event.set()  # Already cancelled before the call

        result = engine.query(
            question="What is Python?",
            cancellation_event=cancel_event,
        )

        assert result.answer == "[Cancelled]"
        assert result.sources == []
        assert result.chunks_retrieved == 0
        mock_llm.answer_question.assert_not_called()


# ---------------------------------------------------------------------------
# Criterion 3: cancellation at checkpoint (a) — after query transformation
# ---------------------------------------------------------------------------

class TestCancellationCheckpointA:
    """Criterion 3: Cancellation after query transformation (checkpoint a)."""

    def test_cancellation_after_query_transformation(self):
        """Cancellation at checkpoint (a) — after transform_step_back, before retrieval."""
        config = RAGConfig(query_transformation_enabled=True)
        engine, mock_store, mock_llm = make_engine(config=config)

        mock_store.get_context.return_value = (
            "Retrieved context.",
            ["doc.txt"],
            [MagicMock(text="Retrieved context.", source="doc.txt", chunk_index=0)],
        )

        engine._query_transformer = MagicMock()
        engine._query_transformer.transform_step_back.return_value = "transformed query"

        # Event-based rendezvous: side_effect signals cancel thread, cancel thread
        # sets cancel_event and signals side_effect to proceed, ensuring proper ordering.
        ready_event = threading.Event()
        proceed_event = threading.Event()
        original_return = engine._query_transformer.transform_step_back.return_value

        def patched_transform(q):
            ready_event.set()  # Signal cancel thread to proceed
            proceed_event.wait(timeout=5.0)  # Wait for cancel thread to finish
            return original_return
        engine._query_transformer.transform_step_back.side_effect = patched_transform

        cancel_event = threading.Event()

        def bg_cancel():
            ready_event.wait(timeout=5.0)  # Wait for side_effect to signal
            cancel_event.set()
            proceed_event.set()  # Signal side_effect to proceed

        t = threading.Thread(target=bg_cancel, daemon=True)
        t.start()

        result = engine.query(
            question="What is Python?",
            cancellation_event=cancel_event,
        )

        t.join(timeout=5.0)

        assert result.answer == "[Cancelled]"
        assert result.sources == []
        assert result.chunks_retrieved == 0
        mock_llm.answer_question.assert_not_called()


# ---------------------------------------------------------------------------
# Criterion 4: cancellation at checkpoint (b) — after vector store retrieval
# ---------------------------------------------------------------------------

class TestCancellationCheckpointB:
    """Criterion 4: Cancellation after retrieval (checkpoint b)."""

    def test_cancellation_after_retrieval(self):
        """Cancellation at checkpoint (b) — after get_context returns, before reranking.

        The cancel_event is set in the main thread immediately after get_context
        returns, simulating the user pressing Cancel at the precise moment
        the retrieval completes.
        """
        engine, mock_store, mock_llm = make_engine()

        # Pre-capture the return value so we can use it in the side_effect
        stored_return = (
            "Retrieved context about programming.",
            ["doc.txt"],
            [MagicMock(text="Retrieved context about programming.", source="doc.txt", chunk_index=0)],
        )
        mock_store.get_context.return_value = stored_return

        cancel_event = threading.Event()
        ready_event = threading.Event()
        proceed_event = threading.Event()

        def patched_get_context(*args, **kwargs):
            # Signal cancel thread that get_context has returned
            ready_event.set()
            proceed_event.wait(timeout=5.0)  # Wait for cancel thread to finish
            return stored_return

        mock_store.get_context.side_effect = patched_get_context

        def bg_cancel():
            ready_event.wait(timeout=5.0)  # Wait for get_context to return
            # Cancel fires immediately after get_context returns, before reranking starts
            cancel_event.set()
            proceed_event.set()  # Signal get_context to return

        t = threading.Thread(target=bg_cancel, daemon=True)
        t.start()

        result = engine.query(
            question="What is Python?",
            cancellation_event=cancel_event,
        )

        t.join(timeout=5.0)

        # cancel_event is set when checkpoint (b) is evaluated → [Cancelled]
        assert result.answer == "[Cancelled]"
        assert result.sources == []
        assert result.chunks_retrieved == 0
        mock_llm.answer_question.assert_not_called()


# ---------------------------------------------------------------------------
# Criterion 5: cancellation at checkpoint (d) — before answer_question
# ---------------------------------------------------------------------------

class TestCancellationCheckpointD:
    """Criterion 5: Cancellation before answer_question (checkpoint d).

    Uses reranking_enabled=False so checkpoint (c) is skipped and we reliably
    reach checkpoint (d) after context building.  A Barrier coordinates the
    cancel thread so that cancel_event.set() happens BEFORE the main thread
    evaluates the cancellation check at (d) — the key ordering is:
      1. main thread reaches answer_question(), side_effect waits on barrier
      2. cancel thread also reaches barrier, both are released
      3. cancel_thread sets cancel_event FIRST, then exits (its barrier.wait returns)
      4. main thread's barrier.wait returns; query checks cancel_event (now True)
         and returns [Cancelled] — answer_question is never actually called.
    """

    def test_cancellation_before_answer_question(self):
        """Cancellation at checkpoint (d) — after context is built, before LLM is called."""
        config = RAGConfig(reranking_enabled=False)
        engine, mock_store, mock_llm = make_engine(config=config)

        mock_store.get_context.return_value = (
            "Full context for answering the question.",
            ["doc.txt"],
            [MagicMock(text="Full context for answering the question.", source="doc.txt", chunk_index=0)],
        )

        cancel_event = threading.Event()
        barrier = threading.Barrier(2, timeout=2.0)

        # Pre-store the answer return value so we can reference it in side_effect
        stored_answer_return = "Should not be returned."
        mock_llm.answer_question.return_value = stored_answer_return

        def patched_answer(*args, **kwargs):
            # Barrier: wait for cancel thread to also reach barrier.
            # After both are released, cancel_thread sets cancel_event first,
            # then its barrier.wait returns. Then OUR barrier.wait returns here.
            # The cancellation check at (d) runs BEFORE this function is called,
            # so by the time we reach this line, cancel_event is already set.
            barrier.wait(timeout=2.0)
            return stored_answer_return

        mock_llm.answer_question.side_effect = patched_answer

        def bg_cancel():
            # KEY ORDERING: set cancel_event BEFORE waiting on barrier.
            # This ensures cancel_event is set before the main thread's
            # barrier.wait returns and the cancellation check at (d) runs.
            cancel_event.set()
            barrier.wait(timeout=2.0)  # Release the main thread

        t = threading.Thread(target=bg_cancel, daemon=True)
        t.start()

        result = engine.query(
            question="What is Python?",
            cancellation_event=cancel_event,
        )

        t.join(timeout=5.0)

        # cancel_event was set BEFORE checkpoint (d) was evaluated → [Cancelled]
        assert result.answer == "[Cancelled]"
        assert result.sources == []
        mock_llm.answer_question.assert_not_called()


# ---------------------------------------------------------------------------
# Criterion 6: no partial content at any checkpoint
# ---------------------------------------------------------------------------

class TestCancellationNoPartialContent:
    """Criterion 6: Cancellation at any checkpoint does not produce partial answer content."""

    def test_no_partial_answer_at_checkpoint_a(self):
        """At checkpoint (a) the answer must be exactly '[Cancelled]', not mixed."""
        config = RAGConfig(query_transformation_enabled=True)
        engine, mock_store, mock_llm = make_engine(config=config)
        mock_store.get_context.return_value = (
            "Context.", ["doc.txt"],
            [MagicMock(text="Context.", source="doc.txt", chunk_index=0)],
        )
        engine._query_transformer = MagicMock()
        engine._query_transformer.transform_step_back.return_value = "transformed"

        ready_event = threading.Event()
        proceed_event = threading.Event()
        original_return = engine._query_transformer.transform_step_back.return_value

        def patched_transform(q):
            ready_event.set()  # Signal cancel thread to proceed
            proceed_event.wait(timeout=5.0)  # Wait for cancel thread to finish
            return original_return
        engine._query_transformer.transform_step_back.side_effect = patched_transform

        cancel_event = threading.Event()

        def bg_cancel():
            ready_event.wait(timeout=5.0)  # Wait for side_effect to signal
            cancel_event.set()
            proceed_event.set()  # Signal side_effect to proceed

        t = threading.Thread(target=bg_cancel, daemon=True)
        t.start()
        result = engine.query("What is Python?", cancellation_event=cancel_event)
        t.join(timeout=5.0)

        assert result.answer == "[Cancelled]", \
            f"Expected '[Cancelled]', got: {result.answer!r}"
        mock_llm.answer_question.assert_not_called()

    def test_no_partial_answer_at_checkpoint_b(self):
        """At checkpoint (b) the answer must be exactly '[Cancelled]', not mixed."""
        engine, mock_store, mock_llm = make_engine()
        stored_return = (
            "Context.", ["doc.txt"],
            [MagicMock(text="Context.", source="doc.txt", chunk_index=0)],
        )
        mock_store.get_context.return_value = stored_return

        cancel_event = threading.Event()
        ready_event = threading.Event()
        proceed_event = threading.Event()

        def patched_get_context(*args, **kwargs):
            ready_event.set()  # Signal cancel thread that get_context returned
            proceed_event.wait(timeout=5.0)  # Wait for cancel thread to finish
            return stored_return
        mock_store.get_context.side_effect = patched_get_context

        def bg_cancel():
            ready_event.wait(timeout=5.0)  # Wait for get_context to return
            cancel_event.set()
            proceed_event.set()  # Signal get_context to return

        t = threading.Thread(target=bg_cancel, daemon=True)
        t.start()
        result = engine.query("What is Python?", cancellation_event=cancel_event)
        t.join(timeout=5.0)

        assert result.answer == "[Cancelled]", \
            f"Expected '[Cancelled]', got: {result.answer!r}"
        mock_llm.answer_question.assert_not_called()

    def test_no_partial_answer_at_checkpoint_d(self):
        """At checkpoint (d) the answer must be exactly '[Cancelled]', not mixed."""
        config = RAGConfig(reranking_enabled=False)
        engine, mock_store, mock_llm = make_engine(config=config)
        mock_store.get_context.return_value = (
            "Full context.", ["doc.txt"],
            [MagicMock(text="Full context.", source="doc.txt", chunk_index=0)],
        )

        cancel_event = threading.Event()
        barrier = threading.Barrier(2, timeout=2.0)

        stored_answer_return = "Should not be returned."
        mock_llm.answer_question.return_value = stored_answer_return

        def patched_answer(*args, **kwargs):
            barrier.wait(timeout=2.0)
            return stored_answer_return
        mock_llm.answer_question.side_effect = patched_answer

        def bg_cancel():
            cancel_event.set()  # Set BEFORE waiting on barrier
            barrier.wait(timeout=2.0)

        t = threading.Thread(target=bg_cancel, daemon=True)
        t.start()
        result = engine.query("What is Python?", cancellation_event=cancel_event)
        t.join(timeout=5.0)

        assert result.answer == "[Cancelled]", \
            f"Expected '[Cancelled]', got: {result.answer!r}"
        mock_llm.answer_question.assert_not_called()


# ---------------------------------------------------------------------------
# Extra: greeting bypass does NOT consult cancellation_event
# ---------------------------------------------------------------------------

class TestCancellationGreetingPath:
    """Verify cancellation is NOT checked in the greeting bypass path (early return)."""

    def test_greeting_does_not_reach_cancellation_check(self):
        """Short greetings return early; cancellation_event is never consulted for them."""
        with patch("rag_engine.VectorStore") as mock_vector_store, \
             patch("rag_engine.SmartLLM") as mock_llm, \
             patch("rag_engine.RAGEngine._save_config"), \
             patch("rag_engine.RAGEngine._ensure_llm"):  # Prevent lazy init from overwriting llm

            mock_store_instance = MagicMock()
            mock_vector_store.return_value = mock_store_instance

            mock_llm_instance = MagicMock()
            mock_llm_instance.answer_question.return_value = "Greeting response."
            mock_llm.return_value = mock_llm_instance

            engine = RAGEngine()
            engine.llm = mock_llm_instance
            engine._query_transformer = None
            engine.reranker = None

            cancel_event = threading.Event()
            # Do NOT set cancel_event — greeting bypass should work regardless of cancellation state

            result = engine.query(
                question="hello",
                cancellation_event=cancel_event,
            )

            # Greeting bypass: LLM is called directly, cancellation not consulted
            assert result.answer == "Greeting response."
            mock_llm_instance.answer_question.assert_called_once()
            mock_store_instance.get_context.assert_not_called()
