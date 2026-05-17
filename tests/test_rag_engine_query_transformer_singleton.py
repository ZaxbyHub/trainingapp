"""
Tests for QueryTransformer lazy singleton in RAGEngine (Phase 1, Task 3.2)

Tests verify:
1. QueryTransformer instance created only once (cached), not per-query
2. InferenceConfig instance created only once (cached), not per-query
3. If query_transformation_enabled=False, _query_transformer stays None
4. Rapid consecutive queries reuse same transformer instance
5. QueryTransformer construction failure is handled gracefully (stays None, doesn't crash query)
"""

import pytest
from unittest.mock import patch, MagicMock
import threading
import time

from rag_engine import RAGEngine, RAGConfig


class TestQueryTransformerLazySingleton:
    """Tests for lazy QueryTransformer initialization behavior."""

    def test_init_query_transformer_stays_none_before_query(self, tmp_path):
        """Test 1a: RAGEngine.__init__ leaves _query_transformer=None (not loaded at init)."""
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
                # _inference_config should also be None at init
                assert engine._inference_config is None

    def test_query_transformer_created_once_on_first_query(self, tmp_path):
        """Test 1: QueryTransformer instance created only once on first query call."""
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

    def test_inference_config_created_once_on_first_query(self, tmp_path):
        """Test 2: InferenceConfig instance created only once on first query call."""
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
                        mock_llm_instance.generate.return_value = "transformed query"
                        mock_llm_cls.return_value = mock_llm_instance

                        mock_qt_instance = MagicMock()
                        mock_qt_instance.transform_step_back.return_value = "transformed query"
                        mock_qt_cls.return_value = mock_qt_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        # Before query - InferenceConfig not created
                        assert engine._inference_config is None

                        # Call query
                        engine.query("What is this about?")

                        # After query - InferenceConfig should be created (in _ensure_query_transformer)
                        assert engine._inference_config is not None

    def test_query_transformer_stays_none_when_disabled(self, tmp_path):
        """Test 3: If query_transformation_enabled=False, _query_transformer stays None."""
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

                        # Call query
                        engine.query("What is this about?")

                        # QueryTransformer should NOT have been created
                        assert engine._query_transformer is None
                        mock_qt_cls.assert_not_called()


class TestQueryTransformerRapidConsecutive:
    """Tests for rapid consecutive query calls reusing same transformer instance."""

    def test_rapid_consecutive_queries_reuse_same_transformer(self, tmp_path):
        """Test 4: Rapid consecutive queries reuse same transformer instance."""
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
                        mock_llm_instance.generate.return_value = "transformed query"
                        mock_llm_cls.return_value = mock_llm_instance

                        engine = RAGEngine(
                            config=RAGConfig(
                                db_path=str(db_path),
                                query_transformation_enabled=True
                            ),
                            gguf_path="/fake/path/model.gguf"
                        )

                        # Fire multiple queries rapidly in sequence
                        for _ in range(5):
                            engine.query("Rapid question?")

                        # QueryTransformer should only have been initialized ONCE
                        assert init_count == 1, f"QueryTransformer was initialized {init_count} times, expected 1"
                        mock_qt_cls.assert_called_once()


class TestQueryTransformerGracefulDegradation:
    """Tests for QueryTransformer construction failure handling."""

    def test_query_transformer_init_failure_leaves_none(self, tmp_path):
        """Test 5: QueryTransformer construction failure handled gracefully - stays None."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer", side_effect=Exception("QT init failed")) as mock_qt_cls:
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
        """Test 5b: QueryTransformer init failure doesn't crash the query workflow."""
        db_path = tmp_path / "test_db"
        db_path.mkdir()

        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.DocumentProcessor") as mock_doc:
                with patch("rag_engine.SmartLLM") as mock_llm_cls:
                    with patch("query_transformer.QueryTransformer", side_effect=RuntimeError("QT failed")):
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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
