"""
Tests for QueryTransformer lazy singleton in RAGEngine (Phase 1, Task 3.2)

Acceptance Criteria:
1. Test: QueryTransformer instance created only once (cached), not per-query
2. Test: _init_lock is used for thread-safe lazy initialization
3. Test: Concurrent queries (50 threads) don't cause double-init
4. Test: If query_transformation_enabled=False, _query_transformer stays None
5. Test: QueryTransformer construction failure is handled gracefully (stays None, doesn't crash query)
"""

import pytest
from unittest.mock import patch, MagicMock
import threading
import time

from rag_engine import RAGEngine, RAGConfig


class TestQueryTransformerLazySingleton:
    """Tests for lazy QueryTransformer initialization behavior."""

    def test_init_query_transformer_stays_none_before_query(self, tmp_path):
        """Criterion 1: RAGEngine.__init__ leaves _query_transformer=None (lazy, not eager)."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                mock_vector_store_instance = MagicMock()
                mock_vector_store.return_value = mock_vector_store_instance

                mock_doc_instance = MagicMock()
                mock_doc.return_value = mock_doc_instance

                engine = RAGEngine(
                    config=RAGConfig(
                        db_path=str(db_path),
                        query_transformation_enabled=True
                    ),
                    gguf_path="/fake/path/model.gguf"
                )

                # _query_transformer should be None at init (lazy)
                assert engine._query_transformer is None
                # _init_lock should be a threading.Lock
                assert isinstance(engine._init_lock, threading.Lock)

    def test_query_transformer_created_once_on_first_query(self, tmp_path):
        """Criterion 1: QueryTransformer instance created only once on first query call."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        mock_transformer_instance = MagicMock()
        mock_transformer_instance.transform_step_back.return_value = "transformed query"

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer") as mock_qt_cls:
                        # Setup mocks
                        mock_vector_store_instance = MagicMock()
                        mock_vector_store_instance.get_context.return_value = (
                            "context text",
                            ["source.txt"],
                            [],
                        )
                        mock_vector_store_instance.get_stats.return_value = {
                            "document_count": 1,
                            "chunk_count": 1,
                            "documents": ["source.txt"],
                        }
                        mock_vector_store.return_value = mock_vector_store_instance

                        mock_doc_instance = MagicMock()
                        mock_doc.return_value = mock_doc_instance

                        mock_llm_instance = MagicMock()
                        mock_llm_instance.answer_question.return_value = "Test answer"
                        mock_llm_instance.generate.return_value = "transformed query"
                        mock_llm_cls.return_value = mock_llm_instance

                        mock_qt_cls.return_value = mock_transformer_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        # Before query - QueryTransformer not created
                        assert engine._query_transformer is None

                        # Call query - this should trigger lazy init of QueryTransformer
                        result = engine.query("What is this about?")

                        # After first query - QueryTransformer should be created
                        assert engine._query_transformer is not None
                        mock_qt_cls.assert_called_once()

    def test_query_transformer_reused_across_multiple_queries(self, tmp_path):
        """Criterion 1: Multiple queries reuse same cached QueryTransformer instance."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        init_count = 0

        def counting_init(*args, **kwargs):
            nonlocal init_count
            init_count += 1
            mock = MagicMock()
            mock.transform_step_back.return_value = "transformed"
            return mock

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer", side_effect=counting_init) as mock_qt_cls:
                        mock_vector_store_instance = MagicMock()
                        mock_vector_store_instance.get_context.return_value = (
                            "context",
                            ["src.txt"],
                            [],
                        )
                        mock_vector_store_instance.get_stats.return_value = {
                            "document_count": 1,
                            "chunk_count": 1,
                            "documents": ["src.txt"],
                        }
                        mock_vector_store.return_value = mock_vector_store_instance

                        mock_doc_instance = MagicMock()
                        mock_doc.return_value = mock_doc_instance

                        mock_llm_instance = MagicMock()
                        mock_llm_instance.answer_question.return_value = "Test answer"
                        mock_llm_cls.return_value = mock_llm_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        # Fire multiple queries in sequence
                        for _ in range(5):
                            engine.query("Rapid question?")

                        # QueryTransformer should only have been initialized ONCE
                        assert init_count == 1, f"QueryTransformer was initialized {init_count} times, expected 1"
                        mock_qt_cls.assert_called_once()


class TestQueryTransformerThreadSafety:
    """Tests for thread-safe lazy initialization using _init_lock."""

    def test_init_lock_is_threading_lock(self, tmp_path):
        """Criterion 2: _init_lock is a threading.Lock for thread-safe lazy init."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                mock_vector_store_instance = MagicMock()
                mock_vector_store.return_value = mock_vector_store_instance

                mock_doc_instance = MagicMock()
                mock_doc.return_value = mock_doc_instance

                engine = RAGEngine(
                    config=RAGConfig(
                        db_path=str(db_path),
                        query_transformation_enabled=True
                    ),
                    gguf_path="/fake/path/model.gguf"
                )

                # _init_lock should exist and be a threading.Lock
                assert hasattr(engine, "_init_lock")
                assert isinstance(engine._init_lock, threading.Lock)

    def test_concurrent_queries_50_threads_no_double_init(self, tmp_path):
        """Criterion 3: 50 concurrent threads don't cause double-init of QueryTransformer."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        init_count = 0
        init_lock = threading.Lock()
        barrier = threading.Barrier(50)  # Synchronize thread start

        def counting_init(*args, **kwargs):
            nonlocal init_count
            # Thread-safe increment
            with init_lock:
                init_count += 1
            mock = MagicMock()
            mock.transform_step_back.return_value = "transformed"
            time.sleep(0.1)  # Ensure all threads race to init
            return mock

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer", side_effect=counting_init) as mock_qt_cls:
                        mock_vector_store_instance = MagicMock()
                        mock_vector_store_instance.get_context.return_value = (
                            "context",
                            ["src.txt"],
                            [],
                        )
                        mock_vector_store_instance.get_stats.return_value = {
                            "document_count": 1,
                            "chunk_count": 1,
                            "documents": ["src.txt"],
                        }
                        mock_vector_store.return_value = mock_vector_store_instance

                        mock_doc_instance = MagicMock()
                        mock_doc.return_value = mock_doc_instance

                        mock_llm_instance = MagicMock()
                        mock_llm_instance.answer_question.return_value = "Test answer"
                        mock_llm_cls.return_value = mock_llm_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        errors = []

                        def concurrent_query(i):
                            try:
                                barrier.wait()  # All threads start simultaneously
                                engine.query(f"Concurrent question {i}?")
                            except Exception as e:
                                errors.append(e)

                        # Launch 50 concurrent threads
                        threads = [threading.Thread(target=concurrent_query, args=(i,)) for i in range(50)]
                        for t in threads:
                            t.start()
                        for t in threads:
                            t.join(timeout=30)

                        # Should have no errors
                        assert len(errors) == 0, f"Errors during concurrent queries: {errors}"

                        # QueryTransformer should only have been initialized ONCE despite 50 concurrent threads
                        assert init_count == 1, f"QueryTransformer was initialized {init_count} times, expected 1"
                        mock_qt_cls.assert_called_once()


class TestQueryTransformerDisabled:
    """Tests for when query transformation is disabled."""

    def test_query_transformer_stays_none_when_disabled(self, tmp_path):
        """Criterion 4: If query_transformation_enabled=False, _query_transformer stays None."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer") as mock_qt_cls:
                        # Setup mocks
                        mock_vector_store_instance = MagicMock()
                        mock_vector_store_instance.get_context.return_value = (
                            "context text",
                            ["source.txt"],
                            [],
                        )
                        mock_vector_store_instance.get_stats.return_value = {
                            "document_count": 1,
                            "chunk_count": 1,
                            "documents": ["source.txt"],
                        }
                        mock_vector_store.return_value = mock_vector_store_instance

                        mock_doc_instance = MagicMock()
                        mock_doc.return_value = mock_doc_instance

                        mock_llm_instance = MagicMock()
                        mock_llm_instance.answer_question.return_value = "Test answer"
                        mock_llm_cls.return_value = mock_llm_instance

                        # query_transformation_enabled=False
                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=False
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        # Before query - QueryTransformer should be None
                        assert engine._query_transformer is None

                        # Call query
                        engine.query("What is this about?")

                        # QueryTransformer should NOT have been created
                        assert engine._query_transformer is None
                        mock_qt_cls.assert_not_called()


class TestQueryTransformerGracefulDegradation:
    """Tests for QueryTransformer construction failure handling."""

    def test_query_transformer_init_failure_leaves_none(self, tmp_path):
        """Criterion 5: QueryTransformer construction failure handled gracefully - stays None."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer", side_effect=Exception("QT init failed")) as mock_qt_cls:
                        mock_vector_store_instance = MagicMock()
                        mock_chunk = MagicMock()
                        mock_chunk.text = "context text"
                        mock_chunk.source = "source.txt"
                        mock_vector_store_instance.get_context.return_value = (
                            "context text",
                            ["source.txt"],
                            [mock_chunk],
                        )
                        mock_vector_store_instance.get_stats.return_value = {
                            "document_count": 1,
                            "chunk_count": 1,
                            "documents": ["source.txt"],
                        }
                        mock_vector_store.return_value = mock_vector_store_instance

                        mock_doc_instance = MagicMock()
                        mock_doc.return_value = mock_doc_instance

                        mock_llm_instance = MagicMock()
                        mock_llm_instance.answer_question.return_value = "Test answer"
                        mock_llm_cls.return_value = mock_llm_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        # QueryTransformer init fails - but query should still work
                        result = engine.query("What is this about?")

                        # _query_transformer should remain None after failed init
                        assert engine._query_transformer is None
                        # Query should still succeed (graceful degradation)
                        assert result.answer == "Test answer"

    def test_query_transformer_failure_does_not_crash_query(self, tmp_path):
        """Criterion 5: QueryTransformer init failure doesn't crash the query workflow."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer", side_effect=RuntimeError("QT failed")):
                        mock_vector_store_instance = MagicMock()
                        mock_chunk = MagicMock()
                        mock_chunk.text = "context text"
                        mock_chunk.source = "source.txt"
                        mock_vector_store_instance.get_context.return_value = (
                            "context text",
                            ["source.txt"],
                            [mock_chunk],
                        )
                        mock_vector_store_instance.get_stats.return_value = {
                            "document_count": 1,
                            "chunk_count": 1,
                            "documents": ["source.txt"],
                        }
                        mock_vector_store.return_value = mock_vector_store_instance

                        mock_doc_instance = MagicMock()
                        mock_doc.return_value = mock_doc_instance

                        mock_llm_instance = MagicMock()
                        mock_llm_instance.answer_question.return_value = "Answer despite QT failure"
                        mock_llm_cls.return_value = mock_llm_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        # Should not raise - graceful degradation
                        result = engine.query("Question about stuff?")

                        # Query should complete with result
                        assert isinstance(result.answer, str)
                        assert result.answer == "Answer despite QT failure"

    def test_query_transformer_failure_on_subsequent_queries_still_works(self, tmp_path):
        """Criterion 5: QueryTransformer failure on first query doesn't break subsequent queries.

        Note: After failure, _query_transformer is set to None, so subsequent queries
        will retry initialization. The code's "Mark as failed to avoid retry" comment
        in rag_engine.py is misleading - setting to None doesn't actually prevent retry.
        The important thing is that each query doesn't crash and graceful degradation works.
        """
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        first_query = [True]  # Use list to allow mutation in closure

        def failing_init(*args, **kwargs):
            if first_query[0]:
                first_query[0] = False
                raise Exception("First init fails")
            mock = MagicMock()
            mock.transform_step_back.return_value = "transformed"
            return mock

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer", side_effect=failing_init):
                        mock_vector_store_instance = MagicMock()
                        mock_chunk = MagicMock()
                        mock_chunk.text = "context text"
                        mock_chunk.source = "source.txt"
                        mock_vector_store_instance.get_context.return_value = (
                            "context text",
                            ["source.txt"],
                            [mock_chunk],
                        )
                        mock_vector_store_instance.get_stats.return_value = {
                            "document_count": 1,
                            "chunk_count": 1,
                            "documents": ["source.txt"],
                        }
                        mock_vector_store.return_value = mock_vector_store_instance

                        mock_doc_instance = MagicMock()
                        mock_doc.return_value = mock_doc_instance

                        mock_llm_instance = MagicMock()
                        mock_llm_instance.answer_question.return_value = "Test answer"
                        mock_llm_cls.return_value = mock_llm_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path.model.gguf"
                        )

                        # First query fails to init QT - but query still works
                        result1 = engine.query("First question?")
                        assert result1.answer == "Test answer"

                        # Subsequent queries still work - the important criterion is no crash
                        result2 = engine.query("Second question?")
                        assert result2.answer == "Test answer"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
