"""Tests for api_server.py RAGConfig wiring in lifespan function.

Verifies that:
1. The lifespan function creates RAGConfig with all expected fields.
2. Each field is populated from the correct settings attribute.
3. No fields are silently dropped.
4. rag_context_truncation is NOT passed (RAGConfig has no such parameter).
"""

import sys
import os
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_settings_cache():
    """Reset the settings cache before each test."""
    import config
    config._settings = None
    yield
    config._settings = None


@pytest.fixture(autouse=True)
def clear_gguf_env():
    """Ensure RAG_GGUF_PATH is not set so lifespan doesn't try to validate it."""
    original = os.environ.get("RAG_GGUF_PATH")
    if "RAG_GGUF_PATH" in os.environ:
        del os.environ["RAG_GGUF_PATH"]
    yield
    if original is not None:
        os.environ["RAG_GGUF_PATH"] = original
    elif "RAG_GGUF_PATH" in os.environ:
        del os.environ["RAG_GGUF_PATH"]


@pytest.fixture
def mock_settings():
    """Return a fully-populated RAGSettings mock with realistic Phase 5 values."""
    mock = MagicMock()
    mock.rag_db_path = "/custom/db/path"
    mock.rag_chunk_size = 1024
    mock.rag_chunk_overlap = 200
    mock.rag_n_results = 8
    mock.rag_min_similarity = 0.45
    mock.rag_max_tokens = 2048
    mock.rag_temperature = 0.7
    mock.rag_embedding_model = "BAAI/bge-large-en-v1.5"
    mock.rag_retrieval_window = 5
    mock.rag_hybrid_search = False
    mock.rag_reranking_enabled = True
    mock.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L-12-v2"
    mock.rag_context_truncation = 15000
    mock.rag_initial_retrieval_top_k = 50
    mock.rag_rerank_top_k = 10
    return mock


# ---------------------------------------------------------------------------
# ASYNC HELPER: actually enter the lifespan and capture RAGConfig call args
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def _build_ragconfig_via_lifespan_async(mock_settings_instance):
    """Actually enter the async lifespan context and capture RAGConfig kwargs."""
    captured_config = {}

    def capture_ragconfig(*args, **kwargs):
        captured_config.update(kwargs)

    with patch("api_server.settings", mock_settings_instance):
        # Patch at api_server namespace since it imported these at module level
        with patch("api_server.RAGEngine") as mock_engine_cls:
            mock_engine_cls.return_value = MagicMock()

            with patch("api_server.RAGConfig") as mock_config_cls:
                mock_config_cls.side_effect = capture_ragconfig

                from api_server import lifespan
                from fastapi import FastAPI

                app = FastAPI()
                ctx = lifespan(app)
                # Enter the async context manager
                await ctx.__aenter__()
                try:
                    pass
                finally:
                    await ctx.__aexit__(None, None, None)

    return captured_config


# ---------------------------------------------------------------------------
# TEST: All 15 RAGConfig fields are wired correctly
# ---------------------------------------------------------------------------

class TestRAGConfigFieldWiring:
    """Every RAGConfig field is correctly populated from settings in lifespan."""

    @pytest.mark.asyncio
    async def test_db_path_wired(self, mock_settings):
        """db_path ← settings.rag_db_path."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["db_path"] == "/custom/db/path"

    @pytest.mark.asyncio
    async def test_chunk_size_wired(self, mock_settings):
        """chunk_size ← settings.rag_chunk_size."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["chunk_size"] == 1024

    @pytest.mark.asyncio
    async def test_n_results_wired(self, mock_settings):
        """n_results ← settings.rag_n_results."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["n_results"] == 8

    @pytest.mark.asyncio
    async def test_max_tokens_wired(self, mock_settings):
        """max_tokens ← settings.rag_max_tokens."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["max_tokens"] == 2048

    @pytest.mark.asyncio
    async def test_temperature_wired(self, mock_settings):
        """temperature ← settings.rag_temperature."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["temperature"] == 0.7

    @pytest.mark.asyncio
    async def test_embedding_model_wired(self, mock_settings):
        """embedding_model ← settings.rag_embedding_model."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["embedding_model"] == "BAAI/bge-large-en-v1.5"

    @pytest.mark.asyncio
    async def test_chunk_overlap_wired(self, mock_settings):
        """chunk_overlap ← settings.rag_chunk_overlap."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["chunk_overlap"] == 200

    @pytest.mark.asyncio
    async def test_min_similarity_wired(self, mock_settings):
        """min_similarity ← settings.rag_min_similarity."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["min_similarity"] == 0.45

    @pytest.mark.asyncio
    async def test_retrieval_window_wired(self, mock_settings):
        """retrieval_window ← settings.rag_retrieval_window."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["retrieval_window"] == 5

    @pytest.mark.asyncio
    async def test_hybrid_search_wired(self, mock_settings):
        """hybrid_search ← settings.rag_hybrid_search."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["hybrid_search"] is False

    @pytest.mark.asyncio
    async def test_reranking_enabled_wired(self, mock_settings):
        """reranking_enabled ← settings.rag_reranking_enabled."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["reranking_enabled"] is True

    @pytest.mark.asyncio
    async def test_reranker_model_wired(self, mock_settings):
        """reranker_model ← settings.rag_reranker_model."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L-12-v2"

    @pytest.mark.asyncio
    async def test_initial_retrieval_top_k_wired(self, mock_settings):
        """initial_retrieval_top_k ← settings.rag_initial_retrieval_top_k."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["initial_retrieval_top_k"] == 50

    @pytest.mark.asyncio
    async def test_rerank_top_k_wired(self, mock_settings):
        """rerank_top_k ← settings.rag_rerank_top_k."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["rerank_top_k"] == 10

    @pytest.mark.asyncio
    async def test_query_transformation_enabled_hardcoded_false(self, mock_settings):
        """query_transformation_enabled is hardcoded to False (not from settings)."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)
        assert kwargs["query_transformation_enabled"] is False


# ---------------------------------------------------------------------------
# TEST: No settings fields are silently dropped
# ---------------------------------------------------------------------------

class TestNoFieldsDropped:
    """Every field that appears in settings appears in the RAGConfig call."""

    @pytest.mark.asyncio
    async def test_all_settings_fields_present_in_config(self, mock_settings):
        """Every settings field that maps to RAGConfig appears in the call kwargs."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)

        # The 14 fields that come from settings (all except query_transformation_enabled)
        settings_fields = [
            "db_path", "chunk_size", "n_results", "max_tokens", "temperature",
            "embedding_model", "chunk_overlap", "min_similarity", "retrieval_window",
            "hybrid_search", "reranking_enabled", "reranker_model",
            "initial_retrieval_top_k", "rerank_top_k",
        ]
        for field in settings_fields:
            assert field in kwargs, f"Field '{field}' is missing from RAGConfig call"

    @pytest.mark.asyncio
    async def test_all_ragconfig_fields_present(self, mock_settings):
        """All RAGConfig constructor parameters are passed (now 18 fields after fixes 2 and 8)."""
        kwargs = await _build_ragconfig_via_lifespan_async(mock_settings)

        # Core 15 original fields plus 3 added in remediation (context_truncation, gguf_n_ctx, gguf_n_threads)
        required = {
            "db_path", "chunk_size", "n_results", "max_tokens", "temperature",
            "embedding_model", "chunk_overlap", "min_similarity", "retrieval_window",
            "hybrid_search", "reranking_enabled", "reranker_model",
            "query_transformation_enabled", "initial_retrieval_top_k", "rerank_top_k",
            "context_truncation", "gguf_n_ctx", "gguf_n_threads",
        }
        missing = required - set(kwargs.keys())
        assert not missing, f"Missing RAGConfig fields: {missing}"


# ---------------------------------------------------------------------------
# TEST: rag_context_truncation NOT wired (RAGConfig has no such parameter)
# ---------------------------------------------------------------------------

class TestContextTruncationWired:
    """context_truncation is now a RAGConfig field — verify it is present and defaults correctly."""

    def test_rag_settings_has_rag_context_truncation(self):
        """Sanity check: RAGSettings does have rag_context_truncation."""
        from config import RAGSettings
        s = RAGSettings()
        assert hasattr(s, "rag_context_truncation")
        assert s.rag_context_truncation == 20000

    def test_ragconfig_has_context_truncation_param(self):
        """RAGConfig.__init__ now has context_truncation parameter (fix 2)."""
        import inspect
        from rag_engine import RAGConfig
        sig = inspect.signature(RAGConfig.__init__)
        params = set(sig.parameters.keys())
        assert "context_truncation" in params, (
            "context_truncation must be a RAGConfig parameter — it was added in fix 2"
        )
        assert "rag_context_truncation" not in params

    def test_ragconfig_context_truncation_default(self):
        """RAGConfig.context_truncation defaults to 20000."""
        from rag_engine import RAGConfig
        c = RAGConfig()
        assert c.context_truncation == 20000

    def test_ragconfig_context_truncation_roundtrip(self):
        """context_truncation survives to_dict/from_dict roundtrip."""
        from rag_engine import RAGConfig
        c = RAGConfig(context_truncation=15000)
        d = c.to_dict()
        assert d["context_truncation"] == 15000
        c2 = RAGConfig.from_dict(d)
        assert c2.context_truncation == 15000


# ---------------------------------------------------------------------------
# TEST: Default values flow through when settings are at defaults
# ---------------------------------------------------------------------------

class TestDefaultValuesFlowThrough:
    """When settings are at their defaults, RAGConfig receives correct default values."""

    @pytest.mark.asyncio
    async def test_defaults_from_settings(self):
        """Default settings produce correct RAGConfig defaults."""
        from config import RAGSettings

        mock = MagicMock(spec=RAGSettings)
        mock.rag_db_path = "./doc_qa_db"
        mock.rag_chunk_size = 512
        mock.rag_chunk_overlap = 100
        mock.rag_n_results = 6
        mock.rag_min_similarity = 0.3
        mock.rag_max_tokens = 1024
        mock.rag_temperature = 0.3
        mock.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock.rag_retrieval_window = 2
        mock.rag_hybrid_search = True
        mock.rag_reranking_enabled = True
        mock.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"
        mock.rag_context_truncation = 20000
        mock.rag_initial_retrieval_top_k = 30
        mock.rag_rerank_top_k = 6
        mock.rag_gguf_n_ctx = 4096
        mock.rag_gguf_n_threads = 4

        kwargs = await _build_ragconfig_via_lifespan_async(mock)

        assert kwargs["db_path"] == "./doc_qa_db"
        assert kwargs["chunk_size"] == 512
        assert kwargs["chunk_overlap"] == 100
        assert kwargs["n_results"] == 6
        assert kwargs["min_similarity"] == 0.3
        assert kwargs["max_tokens"] == 1024
        assert kwargs["temperature"] == 0.3
        assert kwargs["embedding_model"] == "BAAI/bge-small-en-v1.5"
        assert kwargs["retrieval_window"] == 2
        assert kwargs["hybrid_search"] is True
        assert kwargs["reranking_enabled"] is True
        assert kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L6-v2"
        assert kwargs["initial_retrieval_top_k"] == 30
        assert kwargs["rerank_top_k"] == 6
        assert kwargs["query_transformation_enabled"] is False


# ---------------------------------------------------------------------------
# TEST: RAGConfig is used to instantiate RAGEngine
# ---------------------------------------------------------------------------

class TestRAGEngineReceivesRAGConfig:
    """The RAGConfig created in lifespan is passed to RAGEngine."""

    @pytest.mark.asyncio
    async def test_ragengine_receives_config(self):
        """RAGEngine is instantiated with config=the created RAGConfig."""
        from config import RAGSettings

        mock = MagicMock(spec=RAGSettings)
        mock.rag_db_path = "./test_db"
        mock.rag_chunk_size = 512
        mock.rag_chunk_overlap = 100
        mock.rag_n_results = 6
        mock.rag_min_similarity = 0.3
        mock.rag_max_tokens = 1024
        mock.rag_temperature = 0.3
        mock.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock.rag_retrieval_window = 2
        mock.rag_hybrid_search = True
        mock.rag_reranking_enabled = True
        mock.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"
        mock.rag_context_truncation = 20000
        mock.rag_initial_retrieval_top_k = 30
        mock.rag_rerank_top_k = 6
        mock.rag_gguf_n_ctx = 4096
        mock.rag_gguf_n_threads = 4

        captured_engine_calls = []

        def capture_engine(*args, **kwargs):
            captured_engine_calls.append(kwargs)
            return MagicMock()

        with patch("api_server.settings", mock):
            with patch("api_server.RAGEngine", side_effect=capture_engine):
                with patch("api_server.RAGConfig") as mock_config_cls:
                    mock_config_cls.return_value = MagicMock()

                    from api_server import lifespan
                    from fastapi import FastAPI

                    app = FastAPI()
                    ctx = lifespan(app)
                    await ctx.__aenter__()
                    try:
                        pass
                    finally:
                        await ctx.__aexit__(None, None, None)

        assert len(captured_engine_calls) == 1
        assert "config" in captured_engine_calls[0]
        assert captured_engine_calls[0]["config"] is not None


# ---------------------------------------------------------------------------
# TEST: GGUF path validation respects environment variable
# ---------------------------------------------------------------------------

class TestGGUFPathValidation:
    """GGUF path is validated when RAG_GGUF_PATH env var is set."""

    @pytest.mark.asyncio
    async def test_gguf_path_set_and_valid(self):
        """When RAG_GGUF_PATH is set to a valid path, it is passed to RAGEngine."""
        from config import RAGSettings
        import tempfile

        mock = MagicMock(spec=RAGSettings)
        mock.rag_db_path = "./doc_qa_db"
        mock.rag_chunk_size = 512
        mock.rag_chunk_overlap = 100
        mock.rag_n_results = 6
        mock.rag_min_similarity = 0.3
        mock.rag_max_tokens = 1024
        mock.rag_temperature = 0.3
        mock.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock.rag_retrieval_window = 2
        mock.rag_hybrid_search = True
        mock.rag_reranking_enabled = True
        mock.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"
        mock.rag_context_truncation = 20000
        mock.rag_initial_retrieval_top_k = 30
        mock.rag_rerank_top_k = 6
        mock.rag_gguf_n_ctx = 4096
        mock.rag_gguf_n_threads = 4

        with tempfile.TemporaryDirectory() as tmpdir:
            fake_gguf = os.path.join(tmpdir, "model.gguf")
            Path(fake_gguf).touch()

            captured_engine_calls = []

            def capture_engine(*args, **kwargs):
                captured_engine_calls.append(kwargs)
                return MagicMock()

            with patch.dict(os.environ, {"RAG_GGUF_PATH": fake_gguf}):
                with patch("api_server.settings", mock):
                    with patch("api_server.RAGEngine", side_effect=capture_engine):
                        with patch("api_server.RAGConfig") as mock_config_cls:
                            mock_config_cls.return_value = MagicMock()

                            from api_server import lifespan
                            from fastapi import FastAPI

                            app = FastAPI()
                            ctx = lifespan(app)
                            await ctx.__aenter__()
                            try:
                                pass
                            finally:
                                await ctx.__aexit__(None, None, None)

            assert len(captured_engine_calls) == 1
            assert "gguf_path" in captured_engine_calls[0]
            assert captured_engine_calls[0]["gguf_path"] is not None

    @pytest.mark.asyncio
    async def test_gguf_path_invalid_raises_runtime_error(self):
        """When RAG_GGUF_PATH points to a non-existent path, startup raises RuntimeError."""
        from config import RAGSettings

        mock = MagicMock(spec=RAGSettings)
        mock.rag_db_path = "./doc_qa_db"
        mock.rag_chunk_size = 512
        mock.rag_chunk_overlap = 100
        mock.rag_n_results = 6
        mock.rag_min_similarity = 0.3
        mock.rag_max_tokens = 1024
        mock.rag_temperature = 0.3
        mock.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock.rag_retrieval_window = 2
        mock.rag_hybrid_search = True
        mock.rag_reranking_enabled = True
        mock.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"
        mock.rag_context_truncation = 20000
        mock.rag_initial_retrieval_top_k = 30
        mock.rag_rerank_top_k = 6
        mock.rag_gguf_n_ctx = 4096
        mock.rag_gguf_n_threads = 4

        with patch.dict(os.environ, {"RAG_GGUF_PATH": "/nonexistent/path/model.gguf"}):
            with patch("api_server.settings", mock):
                with patch("api_server.RAGEngine"):
                    with patch("api_server.RAGConfig"):
                        from api_server import lifespan
                        from fastapi import FastAPI

                        app = FastAPI()
                        ctx = lifespan(app)
                        with pytest.raises(RuntimeError, match="Invalid configuration"):
                            await ctx.__aenter__()
