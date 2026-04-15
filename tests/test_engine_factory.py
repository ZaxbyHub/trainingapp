"""Tests for engine_factory.py — Phase 1.5: Remove non-GGUF backends.

Verifies that create_engine, create_engine_from_settings, and create_engine_from_env
accept only GGUF-relevant params and route through get_bundled_model_path.
"""

import os
import sys
import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path

# Ensure engine_factory is importable
sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture(autouse=True)
def reset_cache():
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


# ---------------------------------------------------------------------------
# Tests: create_engine() signature / params
# ---------------------------------------------------------------------------

class TestCreateEngineSignatures:
    """Verify create_engine accepts only allowed params (FR-110)."""

    @patch("rag_engine.RAGEngine")
    @patch("rag_engine.RAGConfig")
    @patch("engine_factory.get_bundled_model_path", return_value=None)
    def test_config_only_no_gguf(
        self, mock_bundled, mock_config_cls, mock_engine_cls
    ):
        """create_engine(config) → RAGEngine called with config + None gguf_path."""
        import engine_factory

        mock_config = MagicMock()
        engine_factory.create_engine(config=mock_config)

        mock_engine_cls.assert_called_once_with(
            config=mock_config,
            gguf_path=None,
        )

    @patch("rag_engine.RAGEngine")
    @patch("rag_engine.RAGConfig")
    def test_config_plus_gguf_path(self, mock_config_cls, mock_engine_cls):
        """create_engine(config, gguf_path) → RAGEngine called with both."""
        import engine_factory

        mock_config = MagicMock()
        engine_factory.create_engine(
            config=mock_config, gguf_path="/path/to/model.gguf"
        )

        mock_engine_cls.assert_called_once_with(
            config=mock_config,
            gguf_path="/path/to/model.gguf",
        )

    @pytest.mark.parametrize(
        "forbidden_param",
        [
            "model_path",
            "ollama_model",
            "ollama_url",
            "api_url",
            "api_model",
            "device",
        ],
    )
    @patch("rag_engine.RAGEngine")
    @patch("rag_engine.RAGConfig")
    def test_rejects_removed_params(
        self, mock_config_cls, mock_engine_cls, forbidden_param
    ):
        """Any removed param must raise TypeError."""
        import engine_factory

        kwargs = {"config": MagicMock(), forbidden_param: "some_value"}

        with pytest.raises(TypeError):
            engine_factory.create_engine(**kwargs)

    @patch("rag_engine.RAGEngine")
    @patch("rag_engine.RAGConfig")
    def test_embedding_model_param_accepted(
        self, mock_config_cls, mock_engine_cls
    ):
        """embedding_model is still a valid param and should be set on config."""
        import engine_factory

        mock_config = MagicMock()
        engine_factory.create_engine(
            config=mock_config,
            gguf_path="/path/to/model.gguf",
            embedding_model="BAAI/bge-small-en-v1.5",
        )

        assert mock_config.embedding_model == "BAAI/bge-small-en-v1.5"
        mock_engine_cls.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: _resolve_gguf_path() priority order
# ---------------------------------------------------------------------------

class TestResolveGgufPath:
    """Verify _resolve_gguf_path priority: param → env var → bundled → None."""

    def test_explicit_path_returns_that_path(self):
        """Explicit gguf_path parameter is returned as-is."""
        import engine_factory

        result = engine_factory._resolve_gguf_path("/explicit/model.gguf")
        assert result == "/explicit/model.gguf"

    def test_env_var_used_when_no_param(self):
        """RAG_GGUF_PATH env var is used when gguf_path param is None."""
        import engine_factory

        os.environ["RAG_GGUF_PATH"] = "/env/model.gguf"
        try:
            result = engine_factory._resolve_gguf_path(None)
            assert result == "/env/model.gguf"
        finally:
            del os.environ["RAG_GGUF_PATH"]

    def test_env_var_takes_precedence_over_bundled(self):
        """Env var wins over bundled model."""
        import engine_factory

        os.environ["RAG_GGUF_PATH"] = "/env/model.gguf"
        try:
            with patch(
                "engine_factory.get_bundled_model_path",
                return_value=Path("/bundled/model.gguf"),
            ):
                result = engine_factory._resolve_gguf_path(None)
                assert result == "/env/model.gguf"
        finally:
            del os.environ["RAG_GGUF_PATH"]

    def test_bundled_model_used_when_no_param_no_env(self):
        """When no param and no env var, get_bundled_model_path result is returned."""
        import engine_factory

        assert "RAG_GGUF_PATH" not in os.environ
        bundled = Path("/bundled/gemma.gguf")
        with patch(
            "engine_factory.get_bundled_model_path",
            return_value=bundled,
        ):
            result = engine_factory._resolve_gguf_path(None)
            # Normalize to forward slashes so test passes on Windows
            assert result.replace("\\", "/") == str(bundled).replace("\\", "/")

    def test_returns_none_when_no_param_no_env_no_bundled(self):
        """When no param, no env var, and no bundled model, returns None."""
        import engine_factory

        assert "RAG_GGUF_PATH" not in os.environ
        with patch(
            "engine_factory.get_bundled_model_path", return_value=None
        ):
            result = engine_factory._resolve_gguf_path(None)
            assert result is None

    def test_empty_string_falls_through_to_env_var(self):
        """Empty string gguf_path is falsy and falls through to env var."""
        import engine_factory

        os.environ["RAG_GGUF_PATH"] = "/env/model.gguf"
        try:
            result = engine_factory._resolve_gguf_path("")
            assert result == "/env/model.gguf"
        finally:
            del os.environ["RAG_GGUF_PATH"]

    def test_bundled_path_converted_to_string(self):
        """get_bundled_model_path returns a Path; result must be a string."""
        import engine_factory

        assert "RAG_GGUF_PATH" not in os.environ
        bundled_path = Path("/path/to/bundled.gguf")
        with patch(
            "engine_factory.get_bundled_model_path", return_value=bundled_path
        ):
            result = engine_factory._resolve_gguf_path(None)
            # Normalize to forward slashes for cross-platform comparison
            assert result.replace("\\", "/") == "/path/to/bundled.gguf"
            assert isinstance(result, str)


# ---------------------------------------------------------------------------
# Tests: create_engine_from_settings() filters forbidden keys
# ---------------------------------------------------------------------------

class TestCreateEngineFromSettings:
    """Verify create_engine_from_settings extracts only gguf_path from settings."""

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_passes_only_gguf_path(self, mock_config_cls, mock_create_engine):
        """Only gguf_path is forwarded to create_engine; other keys go to RAGConfig."""
        import engine_factory

        settings = {
            "db_path": "./test_db",
            "chunk_size": 256,
            "gguf_path": "/settings/model.gguf",
            "temperature": 0.7,
            "embedding_model": "BAAI/bge-small-en-v1.5",
        }

        engine_factory.create_engine_from_settings(settings)

        mock_create_engine.assert_called_once()
        _, kwargs = mock_create_engine.call_args
        assert kwargs["gguf_path"] == "/settings/model.gguf"
        mock_config_cls.assert_called_once()

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_ignores_ollama_api_device_keys(
        self, mock_config_cls, mock_create_engine
    ):
        """Forbidden keys (ollama_model, ollama_url, api_url, api_model, device,
        model_path) are silently ignored — not forwarded to create_engine."""
        import engine_factory

        settings = {
            "db_path": "./test_db",
            "ollama_model": "llama3",
            "ollama_url": "http://localhost:11434",
            "api_url": "http://api.example.com",
            "api_model": "gpt-4",
            "device": "cuda",
            "model_path": "/old/path/model.bin",
            "gguf_path": "/settings/model.gguf",
        }

        # Must NOT raise
        engine_factory.create_engine_from_settings(settings)

        _, kwargs = mock_create_engine.call_args
        assert "ollama_model" not in kwargs
        assert "ollama_url" not in kwargs
        assert "api_url" not in kwargs
        assert "api_model" not in kwargs
        assert "device" not in kwargs
        assert "model_path" not in kwargs
        assert kwargs["gguf_path"] == "/settings/model.gguf"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_no_gguf_path_passes_none(self, mock_config_cls, mock_create_engine):
        """When settings has no gguf_path key, create_engine receives None."""
        import engine_factory

        settings = {"db_path": "./test_db", "chunk_size": 512}

        engine_factory.create_engine_from_settings(settings)

        _, kwargs = mock_create_engine.call_args
        assert kwargs["gguf_path"] is None


# ---------------------------------------------------------------------------
# Tests: create_engine_from_env() reads only RAG_GGUF_PATH
# ---------------------------------------------------------------------------

class TestCreateEngineFromEnv:
    """Verify create_engine_from_env reads only RAG_GGUF_PATH (not old env vars)."""

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_reads_only_rag_gguf_path_env_var(
        self, mock_config_cls, mock_create_engine
    ):
        """create_engine_from_env must not read RAG_MODEL_PATH, RAG_OLLAMA_MODEL,
        RAG_OLLAMA_URL, RAG_API_URL, RAG_API_MODEL, or RAG_DEVICE."""
        with patch.dict(
            os.environ,
            {
                "RAG_DB_PATH": "/env/db",
                "RAG_CHUNK_SIZE": "256",
                "RAG_GGUF_PATH": "/env/model.gguf",
                # These must NOT influence gguf_path
                "RAG_MODEL_PATH": "/old/model.bin",
                "RAG_OLLAMA_MODEL": "llama3",
                "RAG_OLLAMA_URL": "http://localhost:11434",
                "RAG_API_URL": "http://api.example.com",
                "RAG_API_MODEL": "gpt-4",
                "RAG_DEVICE": "cuda",
            },
            clear=False,
        ), patch(
            "engine_factory.get_bundled_model_path", return_value=None
        ):
            import engine_factory
            engine_factory.create_engine_from_env()

        _, kwargs = mock_create_engine.call_args
        assert kwargs["gguf_path"] == "/env/model.gguf"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_falls_back_to_bundled_model(
        self, mock_config_cls, mock_create_engine
    ):
        """When RAG_GGUF_PATH is absent, get_bundled_model_path is called."""
        bundled = Path("/bundled/gemma.gguf")
        with patch.dict(
            os.environ, {"RAG_DB_PATH": "/env/db"}, clear=False
        ), patch(
            "engine_factory.get_bundled_model_path",
            return_value=bundled,
        ):
            import engine_factory
            engine_factory.create_engine_from_env()

        _, kwargs = mock_create_engine.call_args
        # Normalize to forward slashes for cross-platform comparison
        assert kwargs["gguf_path"].replace("\\", "/") == str(bundled).replace("\\", "/")

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_no_gguf_path_no_bundled_passes_none(
        self, mock_config_cls, mock_create_engine
    ):
        """When no env var and no bundled model, create_engine gets None."""
        with patch.dict(
            os.environ, {"RAG_DB_PATH": "/env/db"}, clear=False
        ), patch(
            "engine_factory.get_bundled_model_path", return_value=None
        ):
            import engine_factory
            engine_factory.create_engine_from_env()

        _, kwargs = mock_create_engine.call_args
        assert kwargs["gguf_path"] is None


# ---------------------------------------------------------------------------
# Tests: get_bundled_model_path integration
# ---------------------------------------------------------------------------

class TestGetBundledModelPathUsed:
    """Verify get_bundled_model_path from app_paths is called in the right places."""

    def test_resolve_gguf_path_calls_get_bundled_model_path(self):
        """_resolve_gguf_path delegates to get_bundled_model_path when no param/env."""
        import engine_factory

        assert "RAG_GGUF_PATH" not in os.environ
        bundled = Path("/bundled/model.gguf")
        with patch(
            "engine_factory.get_bundled_model_path",
            return_value=bundled,
        ) as mock_bundled:
            result = engine_factory._resolve_gguf_path(None)
            mock_bundled.assert_called_once()
            # Normalize to forward slashes for cross-platform comparison
            assert result.replace("\\", "/") == str(bundled).replace("\\", "/")

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_from_env_calls_get_bundled_when_no_env_var(
        self, mock_config_cls, mock_create_engine
    ):
        """create_engine_from_env calls get_bundled_model_path as fallback."""
        bundled = Path("/bundled/model.gguf")
        with patch.dict(
            os.environ, {"RAG_DB_PATH": "/env/db"}, clear=False
        ), patch(
            "engine_factory.get_bundled_model_path",
            return_value=bundled,
        ) as mock_bundled:
            import engine_factory
            engine_factory.create_engine_from_env()
            mock_bundled.assert_called_once()

        _, kwargs = mock_create_engine.call_args
        # Normalize to forward slashes for cross-platform comparison
        assert kwargs["gguf_path"].replace("\\", "/") == str(bundled).replace("\\", "/")
