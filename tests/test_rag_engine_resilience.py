"""
Resilience tests for rag_engine.py — _log_init_banner, _save_config, reranker, query_transformer.
"""
import pytest
import json
import logging
from pathlib import Path
from unittest.mock import MagicMock, patch, mock_open


# ------------------------------------------------------------------
# Test: _log_init_banner exists and is a staticmethod
# ------------------------------------------------------------------
class TestLogInitBanner:
    def test_banner_exists_and_is_staticmethod(self):
        from rag_engine import RAGEngine
        import inspect

        assert hasattr(RAGEngine, "_log_init_banner")
        attr = inspect.getattr_static(RAGEngine, "_log_init_banner")
        assert isinstance(attr, staticmethod), (
            f"_log_init_banner should be a staticmethod, got {type(attr)}"
        )

    def test_banner_logs_correct_format(self, caplog):
        from rag_engine import RAGEngine

        with caplog.at_level(logging.INFO, logger="rag_engine"):
            RAGEngine._log_init_banner("Test Message")

        assert any("=" * 50 in record.message for record in caplog.records)
        assert any("Test Message" in record.message for record in caplog.records)

    def test_banner_is_callable_as_static(self):
        from rag_engine import RAGEngine

        # Should NOT raise — staticmethod can be called on class directly
        RAGEngine._log_init_banner("Bare call")


# ------------------------------------------------------------------
# Test: _save_config error handling — catches exceptions and logs
# ------------------------------------------------------------------
class TestSaveConfigErrorHandling:
    def test_save_config_catches_permission_error(self, caplog):
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig(db_path="/fake/db")

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.doc_processor = MagicMock()
        engine.vector_store = MagicMock()
        engine.llm = MagicMock()
        engine.reranker = None
        engine._lock = MagicMock()

        with caplog.at_level(logging.ERROR, logger="rag_engine"):
            with patch("builtins.open", side_effect=PermissionError("denied")):
                # Should NOT raise — error is caught and logged
                engine._save_config()

        assert any("Failed to save configuration" in r.message for r in caplog.records)

    def test_save_config_catches_file_not_found_error(self, caplog):
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig(db_path="/fake/db")

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config

        with caplog.at_level(logging.ERROR, logger="rag_engine"):
            with patch("builtins.open", side_effect=FileNotFoundError("parent dir missing")):
                engine._save_config()

        assert any("Failed to save configuration" in r.message for r in caplog.records)

    def test_save_config_succeeds_when_path_valid(self):
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig(db_path="/fake/db")
        written = {}

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config

        def capture_open(path, mode):
            written["path"] = str(path)
            m = MagicMock()
            written["handle"] = m
            return m

        with patch("builtins.open", side_effect=capture_open):
            engine._save_config()

        assert "rag_config.json" in written["path"]
        written["handle"].__enter__.assert_called_once()


# ------------------------------------------------------------------
# Test: Reranker lazy-init error handling inside query()
# ------------------------------------------------------------------
class TestRerankerErrorHandling:
    def test_reranker_init_failure_leaves_reranker_none(self, caplog):
        from rag_engine import RAGEngine, RAGConfig
        from rag_engine import QueryResult

        config = RAGConfig(reranking_enabled=True)

        mock_llm = MagicMock()
        mock_llm.answer_question.return_value = "test answer"
        mock_llm.get_info.return_value = {"backend": "gguf"}

        mock_vs = MagicMock()
        mock_vs.get_context.return_value = ("some context\n\n---\n\nmore", ["source1", "source2"], [])

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.doc_processor = MagicMock()
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None  # Will be lazily init'd
        engine.gguf_path = None

        # CrossEncoderReranker is imported dynamically inside query() from reranking module
        with caplog.at_level(logging.WARNING, logger="rag_engine"):
            with patch("reranking.CrossEncoderReranker", side_effect=ImportError("no reranker module")):
                result = engine.query("test question")

        # Reranker stayed None (lazy init failed gracefully)
        assert engine.reranker is None
        # Warning was logged
        assert any("Reranker initialization failed" in r.message for r in caplog.records)
        # Query still returned a result (no hard crash)
        assert isinstance(result, QueryResult)
        assert result.answer == "test answer"

    def test_reranker_init_failure_does_not_break_retrieval(self, caplog):
        from rag_engine import RAGEngine, RAGConfig
        from rag_engine import QueryResult

        config = RAGConfig(reranking_enabled=True)

        mock_llm = MagicMock()
        mock_llm.answer_question.return_value = "answer based on context"

        mock_vs = MagicMock()
        mock_vs.get_context.return_value = ("context chunk", ["source1"], [])

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.doc_processor = MagicMock()
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.gguf_path = None

        with patch("reranking.CrossEncoderReranker", side_effect=RuntimeError("reranker error")):
            result = engine.query("what is this?")

        assert isinstance(result, QueryResult)
        # Context was still retrieved and passed to LLM
        mock_llm.answer_question.assert_called_once()

    def test_reranker_success_sets_reranker(self):
        from rag_engine import RAGEngine, RAGConfig
        from rag_engine import QueryResult
        from document_processor import DocumentChunk

        config = RAGConfig(reranking_enabled=True)

        mock_llm = MagicMock()
        mock_llm.answer_question.return_value = "reranked answer"

        mock_vs = MagicMock()
        mock_vs.get_context.return_value = ("chunk1\n\n---\n\nchunk2", ["src1", "src2"], [])

        mock_reranker = MagicMock()
        mock_reranker.rerank.return_value = [
            (DocumentChunk(text="chunk2", source="src2", chunk_index=1), 0.9),
            (DocumentChunk(text="chunk1", source="src1", chunk_index=0), 0.8),
        ]

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.doc_processor = MagicMock()
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.gguf_path = None

        with patch("reranking.CrossEncoderReranker", return_value=mock_reranker):
            result = engine.query("test question")

        assert engine.reranker is mock_reranker
        assert isinstance(result, QueryResult)


# ------------------------------------------------------------------
# Test: QueryTransformer gating
# ------------------------------------------------------------------
class TestQueryTransformerGating:
    def test_disabled_flag_skips_transformation(self, caplog):
        from rag_engine import RAGEngine, RAGConfig
        from rag_engine import QueryResult

        config = RAGConfig(query_transformation_enabled=False)
        assert config.query_transformation_enabled is False

        mock_llm = MagicMock()
        mock_llm.answer_question.return_value = "answer"

        mock_vs = MagicMock()
        mock_vs.get_context.return_value = ("ctx", ["src"], [])

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.gguf_path = None

        with patch("query_transformer.QueryTransformer") as mock_qt:
            result = engine.query("test question")

        # QueryTransformer should NOT be imported/called
        mock_qt.assert_not_called()
        assert isinstance(result, QueryResult)

    def test_enabled_but_llm_none_skips_transformation(self, caplog):
        from rag_engine import RAGEngine, RAGConfig
        from rag_engine import QueryResult

        config = RAGConfig(query_transformation_enabled=True)

        mock_vs = MagicMock()
        mock_vs.get_context.return_value = ("ctx", ["src"], [])

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = None  # No LLM — should skip transformation
        engine.reranker = None
        engine.gguf_path = None

        with pytest.raises(RuntimeError, match="LLM not initialized"):
            engine.query("test question")

    def test_transformation_failure_falls_back_to_original(self, caplog):
        from rag_engine import RAGEngine, RAGConfig
        from rag_engine import QueryResult
        from document_processor import DocumentChunk

        config = RAGConfig(query_transformation_enabled=True)

        mock_llm = MagicMock()
        mock_llm.answer_question.return_value = "fallback answer"

        # Provide real chunks so the engine rebuilds context from them
        chunks = [DocumentChunk(text="relevant context", source="src.txt", chunk_index=0)]
        mock_vs = MagicMock()
        mock_vs.get_context.return_value = ("relevant context", ["src.txt"], chunks)

        mock_qt_instance = MagicMock()
        mock_qt_instance.transform_step_back.side_effect = RuntimeError("LLM error")

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.gguf_path = None

        with caplog.at_level(logging.WARNING, logger="rag_engine"):
            with patch("query_transformer.QueryTransformer", return_value=mock_qt_instance):
                result = engine.query("test question")

        # QueryTransformer WAS called (attempted)
        mock_qt_instance.transform_step_back.assert_called_once_with("test question")
        # Warning was logged about failure
        assert any("Query transformation failed" in r.message for r in caplog.records)
        # Query still returned a result using the original query with real context
        assert isinstance(result, QueryResult)
        assert result.answer == "fallback answer"

    def test_transformation_success_changes_retrieval_query(self):
        from rag_engine import RAGEngine, RAGConfig
        from rag_engine import QueryResult

        config = RAGConfig(query_transformation_enabled=True)

        mock_llm = MagicMock()
        mock_llm.answer_question.return_value = "transformed answer"

        mock_vs = MagicMock()
        mock_vs.get_context.return_value = ("ctx", ["src"], [])

        mock_qt_instance = MagicMock()
        mock_qt_instance.transform_step_back.return_value = "transformed query"

        engine = RAGEngine.__new__(RAGEngine)
        engine.config = config
        engine.vector_store = mock_vs
        engine.llm = mock_llm
        engine.reranker = None
        engine.gguf_path = None

        with patch("query_transformer.QueryTransformer", return_value=mock_qt_instance):
            engine.query("original question")

        # Verify get_context was called with the transformed query
        mock_vs.get_context.assert_called_once()
        call_args = mock_vs.get_context.call_args
        assert call_args[0][0] == "transformed query"
