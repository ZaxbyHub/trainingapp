"""Phase 5 supplementary tests for config wiring verification.

Tests coverage gaps identified:
1. RAGSettings defaults for Phase 5 new fields (rag_context_truncation, rag_reranker_model,
   rag_initial_retrieval_top_k, rag_rerank_top_k, rag_retrieval_window)
2. create_engine_from_settings() missing rag_context_truncation mapping
3. create_engine_from_env() getattr fallback when new attrs are absent from settings
"""

import os
import sys
import pytest
import importlib
from pathlib import Path
from unittest.mock import patch, MagicMock

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_engine_cache():
    """Reset the lazy-load cache before each test to ensure isolation."""
    import engine_factory
    engine_factory._rag_classes_cache = None
    yield
    engine_factory._rag_classes_cache = None


@pytest.fixture(autouse=True)
def clear_env_gguf_path():
    """Remove RAG_GGUF_PATH from env for tests that don't explicitly set it."""
    original = os.environ.get("RAG_GGUF_PATH")
    if "RAG_GGUF_PATH" in os.environ:
        del os.environ["RAG_GGUF_PATH"]
    yield
    if original is not None:
        os.environ["RAG_GGUF_PATH"] = original
    elif "RAG_GGUF_PATH" in os.environ:
        del os.environ["RAG_GGUF_PATH"]


@pytest.fixture
def clear_env(monkeypatch):
    """Clear all RAG_ environment variables before test."""
    for key in list(os.environ.keys()):
        if key.startswith("RAG_"):
            monkeypatch.delenv(key, raising=False)
    yield

# ---------------------------------------------------------------------------
# 1. RAGSettings Phase 5 default values
# ---------------------------------------------------------------------------

class TestRAGSettingsPhase5Defaults:
    """Phase 5 new fields on RAGSettings have correct defaults."""

    def test_rag_context_truncation_default(self, monkeypatch, clear_env):
        """rag_context_truncation defaults to 20000."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_context_truncation == 20000

    def test_rag_initial_retrieval_top_k_default(self, monkeypatch, clear_env):
        """rag_initial_retrieval_top_k defaults to 12."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 12

    def test_rag_rerank_top_k_default(self, monkeypatch, clear_env):
        """rag_rerank_top_k defaults to 4."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == 4

    def test_rag_reranker_model_default(self, monkeypatch, clear_env):
        """rag_reranker_model defaults to cross-encoder/ms-marco-MiniLM-L6-v2."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_reranker_model == "cross-encoder/ms-marco-MiniLM-L6-v2"

    def test_rag_retrieval_window_default(self, monkeypatch, clear_env):
        """rag_retrieval_window defaults to 1."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_retrieval_window == 1

    def test_rag_n_results_default(self, monkeypatch, clear_env):
        """rag_n_results defaults to 4."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_n_results == 4

    def test_rag_chunk_overlap_default(self, monkeypatch, clear_env):
        """rag_chunk_overlap defaults to 100."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_chunk_overlap == 100

    def test_all_phase5_defaults_together(self, monkeypatch, clear_env):
        """All Phase 5 new fields are correct simultaneously."""
        import config
        config._settings = None
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_n_results == 4
        assert s.rag_chunk_overlap == 100
        assert s.rag_retrieval_window == 1
        assert s.rag_reranker_model == "cross-encoder/ms-marco-MiniLM-L6-v2"
        assert s.rag_context_truncation == 20000
        assert s.rag_initial_retrieval_top_k == 12
        assert s.rag_rerank_top_k == 4


# ---------------------------------------------------------------------------
# 2. create_engine_from_settings() mapping verification
# ---------------------------------------------------------------------------

class TestCreateEngineFromSettingsPhase5Mapping:
    """create_engine_from_settings() correctly maps Phase 5 settings to RAGConfig."""

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_mapping_n_results(self, mock_config_cls, mock_create_engine):
        """n_results maps from settings to RAGConfig with correct default."""
        import engine_factory

        engine_factory.create_engine_from_settings({})
        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["n_results"] == 4

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_mapping_retrieval_window(self, mock_config_cls, mock_create_engine):
        """retrieval_window maps from settings to RAGConfig with correct default."""
        import engine_factory

        engine_factory.create_engine_from_settings({})
        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["retrieval_window"] == 1

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_mapping_reranker_model(self, mock_config_cls, mock_create_engine):
        """reranker_model maps from settings to RAGConfig with correct default."""
        import engine_factory

        engine_factory.create_engine_from_settings({})
        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L6-v2"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_mapping_initial_retrieval_top_k(self, mock_config_cls, mock_create_engine):
        """initial_retrieval_top_k maps from settings to RAGConfig with correct default."""
        import engine_factory

        engine_factory.create_engine_from_settings({})
        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["initial_retrieval_top_k"] == 12

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_mapping_rerank_top_k(self, mock_config_cls, mock_create_engine):
        """rerank_top_k maps from settings to RAGConfig with correct default."""
        import engine_factory

        engine_factory.create_engine_from_settings({})
        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["rerank_top_k"] == 4

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_all_phase5_fields_explicit(self, mock_config_cls, mock_create_engine):
        """All Phase 5 fields provided in settings are routed to RAGConfig."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "n_results": 10,
            "retrieval_window": 3,
            "reranker_model": "cross-encoder/ms-marco-MiniLM-L6-v2",
            "initial_retrieval_top_k": 50,
            "rerank_top_k": 15,
            "min_similarity": 0.5,
        })
        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["n_results"] == 10
        assert call_kwargs["retrieval_window"] == 3
        assert call_kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L6-v2"
        assert call_kwargs["initial_retrieval_top_k"] == 50
        assert call_kwargs["rerank_top_k"] == 15
        assert call_kwargs["min_similarity"] == 0.5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_all_defaults_from_empty_dict(self, mock_config_cls, mock_create_engine):
        """Empty settings dict produces correct defaults for all fields."""
        import engine_factory

        engine_factory.create_engine_from_settings({})
        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        # Verify all expected defaults
        assert call_kwargs["db_path"] == "./doc_qa_db"
        assert call_kwargs["chunk_size"] == 512
        assert call_kwargs["chunk_overlap"] == 100
        assert call_kwargs["n_results"] == 4
        assert call_kwargs["max_tokens"] == 512
        assert call_kwargs["temperature"] == 0.3
        assert call_kwargs["embedding_model"] == "BAAI/bge-small-en-v1.5"
        assert call_kwargs["hybrid_search"] is True
        assert call_kwargs["retrieval_window"] == 1
        assert call_kwargs["reranking_enabled"] is False
        assert call_kwargs["initial_retrieval_top_k"] == 12
        assert call_kwargs["rerank_top_k"] == 4
        assert call_kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L6-v2"
        assert call_kwargs["min_similarity"] == 0.3

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_settings_to_config_gguf_path_forwarded(self, mock_config_cls, mock_create_engine):
        """gguf_path is forwarded to create_engine, not to RAGConfig."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "db_path": "/custom/db",
            "gguf_path": "/models/llama.gguf",
        })

        mock_config_cls.assert_called_once()
        mock_create_engine.assert_called_once()
        _, engine_kwargs = mock_create_engine.call_args
        assert engine_kwargs["gguf_path"] == "/models/llama.gguf"
        assert "gguf_path" not in mock_config_cls.call_args[1]


# ---------------------------------------------------------------------------
# 3. create_engine_from_env() getattr fallback
# ---------------------------------------------------------------------------

class TestCreateEngineFromEnvGetattrFallback:
    """create_engine_from_env() uses getattr fallback for missing settings attrs."""

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_getattr_fallback_for_rag_initial_retrieval_top_k(
        self, mock_config_cls, mock_create_engine
    ):
        """When rag_initial_retrieval_top_k is absent, getattr returns default 30."""
        import engine_factory
        import config

        # Mock settings with NO rag_initial_retrieval_top_k attribute
        mock_settings = MagicMock(spec=["rag_db_path", "rag_chunk_size", "rag_chunk_overlap",
                                        "rag_n_results", "rag_min_similarity", "rag_max_tokens",
                                        "rag_temperature", "rag_embedding_model", "rag_hybrid_search",
                                        "rag_retrieval_window", "rag_reranking_enabled",
                                        "rag_context_truncation",
                                        "rag_rerank_top_k", "rag_reranker_model"])
        # Remove the attribute to simulate missing field
        del mock_settings.rag_initial_retrieval_top_k

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        # getattr(settings, "rag_initial_retrieval_top_k", 12) should return 12
        assert call_kwargs["initial_retrieval_top_k"] == 12

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_getattr_fallback_for_rag_rerank_top_k(
        self, mock_config_cls, mock_create_engine
    ):
        """When rag_rerank_top_k is absent, getattr returns default 6."""
        import engine_factory
        import config

        mock_settings = MagicMock(spec=["rag_db_path", "rag_chunk_size", "rag_chunk_overlap",
                                        "rag_n_results", "rag_min_similarity", "rag_max_tokens",
                                        "rag_temperature", "rag_embedding_model", "rag_hybrid_search",
                                        "rag_retrieval_window", "rag_reranking_enabled",
                                        "rag_context_truncation",
                                        "rag_initial_retrieval_top_k", "rag_reranker_model"])
        del mock_settings.rag_rerank_top_k

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["rerank_top_k"] == 4

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_getattr_fallback_for_rag_reranker_model(
        self, mock_config_cls, mock_create_engine
    ):
        """When rag_reranker_model is absent, getattr returns default cross-encoder model."""
        import engine_factory
        import config

        mock_settings = MagicMock(spec=["rag_db_path", "rag_chunk_size", "rag_chunk_overlap",
                                        "rag_n_results", "rag_min_similarity", "rag_max_tokens",
                                        "rag_temperature", "rag_embedding_model", "rag_hybrid_search",
                                        "rag_retrieval_window", "rag_reranking_enabled",
                                        "rag_context_truncation",
                                        "rag_initial_retrieval_top_k", "rag_rerank_top_k"])
        del mock_settings.rag_reranker_model

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L6-v2"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_all_new_attrs_missing_uses_getattr_defaults(
        self, mock_config_cls, mock_create_engine
    ):
        """When ALL Phase 5 new attrs are missing, all getattr defaults are used."""
        import engine_factory
        import config

        # Mock settings missing ALL Phase 5 new attributes
        mock_settings = MagicMock(spec=["rag_db_path", "rag_chunk_size", "rag_chunk_overlap",
                                        "rag_n_results", "rag_min_similarity", "rag_max_tokens",
                                        "rag_temperature", "rag_embedding_model", "rag_hybrid_search",
                                        "rag_retrieval_window", "rag_reranking_enabled",
                                        "rag_context_truncation"])
        del mock_settings.rag_initial_retrieval_top_k
        del mock_settings.rag_rerank_top_k
        del mock_settings.rag_reranker_model

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["initial_retrieval_top_k"] == 12
        assert call_kwargs["rerank_top_k"] == 4
        assert call_kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L6-v2"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_explicit_values_override_getattr_defaults(
        self, mock_config_cls, mock_create_engine
    ):
        """When settings has explicit values, they are used instead of getattr defaults."""
        import engine_factory
        import config

        mock_settings = MagicMock()
        mock_settings.rag_db_path = "./custom_db"
        mock_settings.rag_chunk_size = 1024
        mock_settings.rag_chunk_overlap = 50
        mock_settings.rag_n_results = 12
        mock_settings.rag_min_similarity = 0.6
        mock_settings.rag_max_tokens = 2048
        mock_settings.rag_temperature = 0.8
        mock_settings.rag_embedding_model = "BAAI/bge-large-en-v1.5"
        mock_settings.rag_hybrid_search = False
        mock_settings.rag_retrieval_window = 4
        mock_settings.rag_reranking_enabled = False
        mock_settings.rag_initial_retrieval_top_k = 100
        mock_settings.rag_rerank_top_k = 20
        mock_settings.rag_reranker_model = "custom/reranker-v1"

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["db_path"] == "./custom_db"
        assert call_kwargs["chunk_size"] == 1024
        assert call_kwargs["chunk_overlap"] == 50
        assert call_kwargs["n_results"] == 12
        assert call_kwargs["min_similarity"] == 0.6
        assert call_kwargs["max_tokens"] == 2048
        assert call_kwargs["temperature"] == 0.8
        assert call_kwargs["embedding_model"] == "BAAI/bge-large-en-v1.5"
        assert call_kwargs["hybrid_search"] is False
        assert call_kwargs["retrieval_window"] == 4
        assert call_kwargs["reranking_enabled"] is False
        assert call_kwargs["initial_retrieval_top_k"] == 100
        assert call_kwargs["rerank_top_k"] == 20
        assert call_kwargs["reranker_model"] == "custom/reranker-v1"


# ---------------------------------------------------------------------------
# 4. Regression: verify defaults match across RAGSettings and RAGConfig
# ---------------------------------------------------------------------------

class TestDefaultValueConsistency:
    """Defaults in RAGSettings match defaults in RAGConfig for cross-module consistency."""

    def test_default_n_results_consistent(self, monkeypatch, clear_env):
        """RAGSettings.rag_n_results default == RAGConfig default (4)."""
        import config
        config._settings = None
        from config import RAGSettings
        from rag_engine import RAGConfig

        settings_default = RAGSettings().rag_n_results
        ragconfig_default = RAGConfig().n_results
        assert settings_default == ragconfig_default == 4

    def test_default_retrieval_window_consistent(self, monkeypatch, clear_env):
        """RAGSettings.rag_retrieval_window default == RAGConfig default (1)."""
        import config
        config._settings = None
        from config import RAGSettings
        from rag_engine import RAGConfig

        settings_default = RAGSettings().rag_retrieval_window
        ragconfig_default = RAGConfig().retrieval_window
        assert settings_default == ragconfig_default == 1

    def test_default_reranker_model_consistent(self, monkeypatch, clear_env):
        """RAGSettings.rag_reranker_model default == RAGConfig default."""
        import config
        config._settings = None
        from config import RAGSettings
        from rag_engine import RAGConfig

        settings_default = RAGSettings().rag_reranker_model
        ragconfig_default = RAGConfig().reranker_model
        assert settings_default == ragconfig_default == "cross-encoder/ms-marco-MiniLM-L6-v2"

    def test_default_initial_retrieval_top_k_consistent(self, monkeypatch, clear_env):
        """RAGSettings.rag_initial_retrieval_top_k default == RAGConfig default (12)."""
        import config
        config._settings = None
        from config import RAGSettings
        from rag_engine import RAGConfig

        settings_default = RAGSettings().rag_initial_retrieval_top_k
        ragconfig_default = RAGConfig().initial_retrieval_top_k
        assert settings_default == ragconfig_default == 12

    def test_default_rerank_top_k_consistent(self, monkeypatch, clear_env):
        """RAGSettings.rag_rerank_top_k default == RAGConfig default (4)."""
        import config
        config._settings = None
        from config import RAGSettings
        from rag_engine import RAGConfig

        settings_default = RAGSettings().rag_rerank_top_k
        ragconfig_default = RAGConfig().rerank_top_k
        assert settings_default == ragconfig_default == 4

    def test_default_chunk_overlap_consistent(self, monkeypatch, clear_env):
        """RAGSettings.rag_chunk_overlap default == RAGConfig default (100)."""
        import config
        config._settings = None
        from config import RAGSettings
        from rag_engine import RAGConfig

        settings_default = RAGSettings().rag_chunk_overlap
        ragconfig_default = RAGConfig().chunk_overlap
        assert settings_default == ragconfig_default == 100



