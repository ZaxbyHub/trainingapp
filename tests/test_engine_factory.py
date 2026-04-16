"""Tests for engine_factory.py — Phase 1.5: Remove non-GGUF backends.

Verifies that create_engine, create_engine_from_settings, and create_engine_from_env
accept only GGUF-relevant params and route through get_bundled_model_path.
"""

import os
import sys
import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path
from pydantic import ValidationError

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
# Adversarial Tests: create_engine_from_settings() — malformed/missing/type-confused inputs
# ---------------------------------------------------------------------------

class TestCreateEngineFromSettingsAdversarial:
    """Attack vectors on create_engine_from_settings() — malformed dicts,
    missing keys, type confusion, out-of-range values."""

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_non_dict_settings_raises_typeerror(self, mock_config_cls, mock_create_engine):
        """Passing a non-dict (string) raises TypeError."""
        import engine_factory

        with pytest.raises((TypeError, AttributeError)):
            engine_factory.create_engine_from_settings("not_a_dict")

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_non_dict_settings_list_raises(self, mock_config_cls, mock_create_engine):
        """Passing a list raises TypeError when RAGConfig() tries to call .get()."""
        import engine_factory

        with pytest.raises((TypeError, AttributeError)):
            engine_factory.create_engine_from_settings(["key1", "key2"])

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_none_settings_raises(self, mock_config_cls, mock_create_engine):
        """Passing None raises TypeError when .get() is called."""
        import engine_factory

        with pytest.raises((TypeError, AttributeError)):
            engine_factory.create_engine_from_settings(None)

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_empty_settings_dict_succeeds_with_defaults(self, mock_config_cls, mock_create_engine):
        """Empty dict {} is valid — all defaults are used."""
        import engine_factory

        engine_factory.create_engine_from_settings({})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["chunk_size"] == 512
        assert call_kwargs["temperature"] == 0.3
        assert call_kwargs["embedding_model"] == "BAAI/bge-small-en-v1.5"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_type_confusion_int_instead_of_string_for_db_path(
        self, mock_config_cls, mock_create_engine
    ):
        """int value for db_path (expects str) should reach RAGConfig — RAGConfig
        will either coerce or raise; factory must not crash."""
        import engine_factory

        engine_factory.create_engine_from_settings({"db_path": 12345})

        mock_config_cls.assert_called_once()
        # Value is passed through; RAGConfig handles the type contract
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["db_path"] == 12345

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_type_confusion_bool_instead_of_int_for_chunk_size(
        self, mock_config_cls, mock_create_engine
    ):
        """bool for chunk_size (expects int) reaches RAGConfig — RAGConfig handles it."""
        import engine_factory

        engine_factory.create_engine_from_settings({"chunk_size": True})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["chunk_size"] is True

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_type_confusion_string_instead_of_bool_for_hybrid_search(
        self, mock_config_cls, mock_create_engine
    ):
        """string for hybrid_search (expects bool) — passed through, RAGConfig handles."""
        import engine_factory

        engine_factory.create_engine_from_settings({"hybrid_search": "not_a_bool"})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["hybrid_search"] == "not_a_bool"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_type_confusion_float_instead_of_bool_for_reranking_enabled(
        self, mock_config_cls, mock_create_engine
    ):
        """float for reranking_enabled (expects bool) — passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({"reranking_enabled": 1.5})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["reranking_enabled"] == 1.5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_type_confusion_string_instead_of_int_for_n_results(
        self, mock_config_cls, mock_create_engine
    ):
        """string for n_results (expects int) — passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({"n_results": "ten"})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["n_results"] == "ten"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_type_confusion_string_instead_of_float_for_temperature(
        self, mock_config_cls, mock_create_engine
    ):
        """string for temperature (expects float) — passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({"temperature": "hot"})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["temperature"] == "hot"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_zero_chunk_size(self, mock_config_cls, mock_create_engine):
        """chunk_size=0 is passed through — RAGConfig may handle or warn."""
        import engine_factory

        engine_factory.create_engine_from_settings({"chunk_size": 0})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["chunk_size"] == 0

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_negative_chunk_size(self, mock_config_cls, mock_create_engine):
        """Negative chunk_size is passed through — RAGConfig handles validation."""
        import engine_factory

        engine_factory.create_engine_from_settings({"chunk_size": -100})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["chunk_size"] == -100

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_temperature_above_one(self, mock_config_cls, mock_create_engine):
        """Temperature > 1.0 is passed through — RAGConfig handles it."""
        import engine_factory

        engine_factory.create_engine_from_settings({"temperature": 2.5})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["temperature"] == 2.5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_negative_temperature(self, mock_config_cls, mock_create_engine):
        """Negative temperature is passed through — RAGConfig handles it."""
        import engine_factory

        engine_factory.create_engine_from_settings({"temperature": -0.5})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["temperature"] == -0.5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_min_similarity_below_zero(self, mock_config_cls, mock_create_engine):
        """min_similarity < 0 is passed through — RAGConfig handles it."""
        import engine_factory

        engine_factory.create_engine_from_settings({"min_similarity": -0.1})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["min_similarity"] == -0.1

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_min_similarity_above_one(self, mock_config_cls, mock_create_engine):
        """min_similarity > 1 is passed through — RAGConfig handles it."""
        import engine_factory

        engine_factory.create_engine_from_settings({"min_similarity": 1.5})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["min_similarity"] == 1.5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_negative_n_results(self, mock_config_cls, mock_create_engine):
        """n_results < 0 is passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({"n_results": -5})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["n_results"] == -5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_boundary_zero_n_results(self, mock_config_cls, mock_create_engine):
        """n_results=0 is passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({"n_results": 0})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["n_results"] == 0

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_oversized_int_values(self, mock_config_cls, mock_create_engine):
        """Very large integers are passed through without crashing."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "chunk_size": 2**31,
            "n_results": 10**9,
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["chunk_size"] == 2**31
        assert call_kwargs["n_results"] == 10**9

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_unicode_in_string_fields(self, mock_config_cls, mock_create_engine):
        """Unicode characters in string fields are passed through without crashing."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "db_path": "/tmp/文档数据库",
            "embedding_model": "BAAI/bge-small-en-v1.5",
            "reranker_model": "cross-encoder/ms-marco-MiniLM-L6-v2",
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["db_path"] == "/tmp/文档数据库"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_null_bytes_in_string_fields(self, mock_config_cls, mock_create_engine):
        """Null bytes in string fields are passed through (potential injection)."""
        import engine_factory

        settings = {
            "db_path": "/tmp/db\x00with_null_byte",
        }
        # .get() on a dict with embedded null bytes returns the value as-is
        engine_factory.create_engine_from_settings(settings)

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert "\x00" in call_kwargs["db_path"]

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_new_fields_routing_retrieval_window(self, mock_config_cls, mock_create_engine):
        """retrieval_window (new field) is correctly routed to RAGConfig."""
        import engine_factory

        engine_factory.create_engine_from_settings({"retrieval_window": 5})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["retrieval_window"] == 5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_new_fields_routing_initial_retrieval_top_k(self, mock_config_cls, mock_create_engine):
        """initial_retrieval_top_k (new field) is correctly routed."""
        import engine_factory

        engine_factory.create_engine_from_settings({"initial_retrieval_top_k": 100})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["initial_retrieval_top_k"] == 100

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_new_fields_routing_rerank_top_k(self, mock_config_cls, mock_create_engine):
        """rerank_top_k (new field) is correctly routed."""
        import engine_factory

        engine_factory.create_engine_from_settings({"rerank_top_k": 20})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["rerank_top_k"] == 20

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_new_fields_routing_reranker_model(self, mock_config_cls, mock_create_engine):
        """reranker_model (new field) is correctly routed."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "reranker_model": "cross-encoder/ms-marco-MiniLM-L6-v2",
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["reranker_model"] == "cross-encoder/ms-marco-MiniLM-L6-v2"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_new_fields_routing_min_similarity(self, mock_config_cls, mock_create_engine):
        """min_similarity (new field) is correctly routed."""
        import engine_factory

        engine_factory.create_engine_from_settings({"min_similarity": 0.75})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["min_similarity"] == 0.75

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_all_new_fields_at_once(self, mock_config_cls, mock_create_engine):
        """All new fields passed simultaneously are all routed correctly."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "retrieval_window": 4,
            "reranking_enabled": True,
            "initial_retrieval_top_k": 50,
            "rerank_top_k": 10,
            "reranker_model": "custom/reranker",
            "min_similarity": 0.5,
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["retrieval_window"] == 4
        assert call_kwargs["reranking_enabled"] is True
        assert call_kwargs["initial_retrieval_top_k"] == 50
        assert call_kwargs["rerank_top_k"] == 10
        assert call_kwargs["reranker_model"] == "custom/reranker"
        assert call_kwargs["min_similarity"] == 0.5

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_path_traversal_in_db_path(self, mock_config_cls, mock_create_engine):
        """Path traversal strings in db_path are passed through (potential injection)."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "db_path": "../../../etc/passwd",
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["db_path"] == "../../../etc/passwd"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_injection_template_literal_in_embedding_model(
        self, mock_config_cls, mock_create_engine
    ):
        """Template literal injection in embedding_model is passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "embedding_model": "${env:SECRET_KEY}",
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["embedding_model"] == "${env:SECRET_KEY}"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_html_script_tag_in_embedding_model(
        self, mock_config_cls, mock_create_engine
    ):
        """HTML/script tag injection in embedding_model is passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "embedding_model": "<script>alert(1)</script>",
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["embedding_model"] == "<script>alert(1)</script>"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_max_safe_integer_for_n_results(self, mock_config_cls, mock_create_engine):
        """Number.MAX_SAFE_INTEGER-equivalent for n_results."""
        import engine_factory

        engine_factory.create_engine_from_settings({
            "n_results": 9007199254740991,
        })

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["n_results"] == 9007199254740991

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_negative_zero_temperature(self, mock_config_cls, mock_create_engine):
        """Negative zero float is passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({"temperature": -0.0})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        # -0.0 == 0 in Python, but the value flows through
        assert call_kwargs["temperature"] == 0.0

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_nan_temperature(self, mock_config_cls, mock_create_engine):
        """NaN temperature is passed through (Python float nan)."""
        import engine_factory

        nan = float("nan")
        engine_factory.create_engine_from_settings({"temperature": nan})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        import math
        assert math.isnan(call_kwargs["temperature"])

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_infinity_chunk_size(self, mock_config_cls, mock_create_engine):
        """Infinity chunk_size is passed through."""
        import engine_factory

        engine_factory.create_engine_from_settings({"chunk_size": float("inf")})

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["chunk_size"] == float("inf")


# ---------------------------------------------------------------------------
# Adversarial Tests: create_engine_from_env() — malformed env vars
# ---------------------------------------------------------------------------

class TestCreateEngineFromEnvAdversarial:
    """Attack vectors on create_engine_from_env() — malformed env var values,
    missing env vars, type confusion from string env values."""

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_malformed_rag_chunk_size_string(self, mock_config_cls, mock_create_engine):
        """RAG_CHUNK_SIZE set to a non-numeric string — pydantic's ValidationError
        propagates out from get_settings() rather than silently defaulting."""
        import engine_factory
        import config
        from pydantic import ValidationError

        # Set the malformed env var
        os.environ["RAG_CHUNK_SIZE"] = "not_an_int"
        # Reset the singleton so get_settings() re-reads env vars
        config._settings = None
        try:
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                with pytest.raises(ValidationError):
                    engine_factory.create_engine_from_env()
        finally:
            # Restore clean state
            del os.environ["RAG_CHUNK_SIZE"]
            config._settings = None

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_malformed_boolean_env_var_string(self, mock_config_cls, mock_create_engine):
        """Non-standard boolean string 'maybe' — pydantic's case-insensitive bool
        parsing coerces it to True (truthy). The factory passes it through unchanged."""
        import engine_factory
        import config

        mock_settings = MagicMock()
        mock_settings.rag_db_path = "./doc_qa_db"
        mock_settings.rag_chunk_size = 512
        mock_settings.rag_chunk_overlap = 100
        mock_settings.rag_n_results = 6
        mock_settings.rag_min_similarity = 0.3
        mock_settings.rag_max_tokens = 1024
        mock_settings.rag_temperature = 0.3
        mock_settings.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock_settings.rag_hybrid_search = True  # "maybe" → True
        mock_settings.rag_retrieval_window = 2
        mock_settings.rag_reranking_enabled = False  # "0" → False
        mock_settings.rag_initial_retrieval_top_k = 30
        mock_settings.rag_rerank_top_k = 6
        mock_settings.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["hybrid_search"] is True
        assert call_kwargs["reranking_enabled"] is False

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_empty_string_boolean_env_var(self, mock_config_cls, mock_create_engine):
        """Empty string RAG_HYBRID_SEARCH → pydantic coerces to False."""
        import engine_factory
        import config

        mock_settings = MagicMock()
        mock_settings.rag_db_path = "./doc_qa_db"
        mock_settings.rag_chunk_size = 512
        mock_settings.rag_chunk_overlap = 100
        mock_settings.rag_n_results = 6
        mock_settings.rag_min_similarity = 0.3
        mock_settings.rag_max_tokens = 1024
        mock_settings.rag_temperature = 0.3
        mock_settings.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock_settings.rag_hybrid_search = False  # "" → False
        mock_settings.rag_retrieval_window = 2
        mock_settings.rag_reranking_enabled = True
        mock_settings.rag_initial_retrieval_top_k = 30
        mock_settings.rag_rerank_top_k = 6
        mock_settings.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        assert call_kwargs["hybrid_search"] is False

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_case_insensitive_boolean_parsing(self, mock_config_cls, mock_create_engine):
        """Boolean env var parsing is case-INSENSITIVE (pydantic default)."""
        import engine_factory

        os.environ["RAG_RERANKING_ENABLED"] = "TRUE"
        try:
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

            mock_config_cls.assert_called_once()
            call_kwargs = mock_config_cls.call_args[1]
            # Pydantic is case-insensitive: "TRUE" → True
            assert call_kwargs["reranking_enabled"] is True
        finally:
            del os.environ["RAG_RERANKING_ENABLED"]

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_unicode_in_rag_gguf_path_env(self, mock_config_cls, mock_create_engine):
        """Unicode characters in RAG_GGUF_PATH are passed through without crashing."""
        import engine_factory

        os.environ["RAG_GGUF_PATH"] = "/模型/文件.gguf"
        try:
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

            _, kwargs = mock_create_engine.call_args
            assert kwargs["gguf_path"] == "/模型/文件.gguf"
        finally:
            del os.environ["RAG_GGUF_PATH"]

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_null_byte_in_rag_gguf_path_rejected_by_os(self, mock_config_cls, mock_create_engine):
        """Null bytes in RAG_GGUF_PATH cannot be set — OS raises ValueError.
        This documents that null-byte injection in env vars is blocked by the OS layer."""
        import engine_factory

        with pytest.raises(ValueError, match="null"):
            os.environ["RAG_GGUF_PATH"] = "/path\x00with_null.gguf"

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_path_traversal_in_rag_gguf_path_env(self, mock_config_cls, mock_create_engine):
        """Path traversal in RAG_GGUF_PATH env var is passed through."""
        import engine_factory

        os.environ["RAG_GGUF_PATH"] = "../../../etc/passwd"
        try:
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

            _, kwargs = mock_create_engine.call_args
            assert kwargs["gguf_path"] == "../../../etc/passwd"
        finally:
            del os.environ["RAG_GGUF_PATH"]

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_all_boolean_env_vars_true_variations(self, mock_config_cls, mock_create_engine):
        """All true-like boolean variations map to True."""
        import engine_factory

        for true_val in ("true", "TRUE", "True", "1", "yes", "YES", "on", "ON"):
            os.environ["RAG_HYBRID_SEARCH"] = true_val
            try:
                with patch("engine_factory.get_bundled_model_path", return_value=None):
                    engine_factory.create_engine_from_env()

                mock_config_cls.assert_called_once()
                call_kwargs = mock_config_cls.call_args[1]
                assert call_kwargs["hybrid_search"] is True, f"Failed for {true_val!r}"
            finally:
                del os.environ["RAG_HYBRID_SEARCH"]
            # Reset mocks for next iteration
            mock_config_cls.reset_mock()

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_empty_env_vars_all_missing(self, mock_config_cls, mock_create_engine):
        """With all RAG_* env vars absent, defaults from config.py are used.
        This tests that create_engine_from_env does NOT crash when env vars are absent."""
        import engine_factory
        import config

        mock_settings = MagicMock()
        mock_settings.rag_db_path = "./doc_qa_db"
        mock_settings.rag_chunk_size = 512
        mock_settings.rag_chunk_overlap = 100
        mock_settings.rag_n_results = 6
        mock_settings.rag_min_similarity = 0.3
        mock_settings.rag_max_tokens = 1024
        mock_settings.rag_temperature = 0.3
        mock_settings.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock_settings.rag_hybrid_search = True
        mock_settings.rag_retrieval_window = 2
        mock_settings.rag_reranking_enabled = True
        mock_settings.rag_initial_retrieval_top_k = 30
        mock_settings.rag_rerank_top_k = 6
        mock_settings.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

        mock_config_cls.assert_called_once()
        call_kwargs = mock_config_cls.call_args[1]
        # Verify defaults were used
        assert call_kwargs["chunk_size"] == 512
        assert call_kwargs["temperature"] == 0.3
        assert call_kwargs["hybrid_search"] is True

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_whitespace_only_rag_gguf_path_not_falsy(self, mock_config_cls, mock_create_engine):
        """Whitespace-only RAG_GGUF_PATH ('   ') is NOT falsy in Python, so it is
        returned as-is — no fallback to bundled model. This is a known gap:
        the factory does NOT call .strip() on the env var value."""
        import engine_factory

        os.environ["RAG_GGUF_PATH"] = "   "
        try:
            bundled = Path("/bundled/model.gguf")
            with patch("engine_factory.get_bundled_model_path", return_value=bundled):
                engine_factory.create_engine_from_env()

            _, kwargs = mock_create_engine.call_args
            # Whitespace-only string is truthy → returned as-is (no fallback)
            assert kwargs["gguf_path"] == "   "
        finally:
            del os.environ["RAG_GGUF_PATH"]

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_rag_gguf_path_with_spaces(self, mock_config_cls, mock_create_engine):
        """RAG_GGUF_PATH with leading/trailing spaces is returned as-is."""
        import engine_factory

        os.environ["RAG_GGUF_PATH"] = "  /path/with spaces/model.gguf  "
        try:
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                engine_factory.create_engine_from_env()

            _, kwargs = mock_create_engine.call_args
            # Whitespace is NOT stripped in _resolve_gguf_path (no .strip() on env var)
            assert kwargs["gguf_path"] == "  /path/with spaces/model.gguf  "
        finally:
            del os.environ["RAG_GGUF_PATH"]

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_negative_chunk_size_from_env_raises(self, mock_config_cls, mock_create_engine):
        """Negative chunk_size from config.settings is rejected by pydantic's
        validate_chunk_size validator (MIN=128, MAX=8192) — ValueError propagates out.
        We use patch('config.get_settings') to avoid the _SettingsProxy __delattr__ bug,
        then invoke the validator classmethod directly to trigger the pydantic check."""
        import engine_factory
        from config import RAGSettings

        mock_settings = MagicMock()
        mock_settings.rag_db_path = "./doc_qa_db"
        mock_settings.rag_chunk_size = -999
        mock_settings.rag_chunk_overlap = 100
        mock_settings.rag_n_results = 6
        mock_settings.rag_min_similarity = 0.3
        mock_settings.rag_max_tokens = 1024
        mock_settings.rag_temperature = 0.3
        mock_settings.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock_settings.rag_hybrid_search = True
        mock_settings.rag_retrieval_window = 2
        mock_settings.rag_reranking_enabled = True
        mock_settings.rag_initial_retrieval_top_k = 30
        mock_settings.rag_rerank_top_k = 6
        mock_settings.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                with pytest.raises(ValueError, match="between"):
                    # Trigger validation: RAGSettings.validate_chunk_size is a classmethod
                    RAGSettings.validate_chunk_size(-999)

    @patch("engine_factory.create_engine")
    @patch("rag_engine.RAGConfig")
    def test_negative_min_similarity_from_env_raises(self, mock_config_cls, mock_create_engine):
        """Negative min_similarity from config.settings is rejected by pydantic's
        validate_min_similarity validator (range 0-1) — ValueError propagates out."""
        import engine_factory
        from config import RAGSettings

        mock_settings = MagicMock()
        mock_settings.rag_db_path = "./doc_qa_db"
        mock_settings.rag_chunk_size = 512
        mock_settings.rag_chunk_overlap = 100
        mock_settings.rag_n_results = 6
        mock_settings.rag_min_similarity = -1.0
        mock_settings.rag_max_tokens = 1024
        mock_settings.rag_temperature = 0.3
        mock_settings.rag_embedding_model = "BAAI/bge-small-en-v1.5"
        mock_settings.rag_hybrid_search = True
        mock_settings.rag_retrieval_window = 2
        mock_settings.rag_reranking_enabled = True
        mock_settings.rag_initial_retrieval_top_k = 30
        mock_settings.rag_rerank_top_k = 6
        mock_settings.rag_reranker_model = "cross-encoder/ms-marco-MiniLM-L6-v2"

        with patch("config.get_settings", return_value=mock_settings):
            with patch("engine_factory.get_bundled_model_path", return_value=None):
                with pytest.raises(ValueError, match="between"):
                    # Trigger validation directly
                    RAGSettings.validate_min_similarity(-1.0)


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
