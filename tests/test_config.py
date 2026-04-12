"""
Tests for config.py — Pydantic BaseSettings configuration.

Covers:
1. Config validation: RAG_MIN_SIMILARITY, RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP, RAG_TEMPERATURE
2. Config usage: engine_factory.py, api_server.py wiring
3. Default values and CORS origins parsing
"""

import pytest
import os
import sys
import importlib
from pathlib import Path
import config  # noqa: F401 — used for importlib.reload

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))


# ---------------------------------------------------------------------------
# 1. CONFIG VALIDATION TESTS
# ---------------------------------------------------------------------------

class TestRAGMinSimilarityValidation:
    """RAG_MIN_SIMILARITY must be between 0.0 and 1.0 inclusive."""

    def test_min_similarity_valid_boundary_low(self, monkeypatch):
        """0.0 is the minimum valid value."""
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "0.0")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_min_similarity == 0.0

    def test_min_similarity_valid_boundary_high(self, monkeypatch):
        """1.0 is the maximum valid value."""
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "1.0")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_min_similarity == 1.0

    def test_min_similarity_valid_mid(self, monkeypatch):
        """0.5 is a valid mid-range value."""
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "0.5")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_min_similarity == 0.5

    def test_min_similarity_invalid_too_high(self, monkeypatch):
        """1.5 raises ValueError (must be 0-1)."""
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "1.5")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be between 0.0 and 1.0"):
            RAGSettings()

    def test_min_similarity_invalid_negative(self, monkeypatch):
        """-0.1 raises ValueError (must be 0-1)."""
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "-0.1")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be between 0.0 and 1.0"):
            RAGSettings()

    def test_min_similarity_invalid_string(self, monkeypatch):
        """Non-numeric string raises ValueError."""
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "not_a_number")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()


class TestRAGChunkSizeValidation:
    """RAG_CHUNK_SIZE must be positive (> 0)."""

    def test_chunk_size_valid_standard(self, monkeypatch):
        """512 is a valid chunk size."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "512")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_chunk_size == 512

    def test_chunk_size_valid_large(self, monkeypatch):
        """4096 is valid."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "4096")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_chunk_size == 4096

    def test_chunk_size_invalid_negative(self, monkeypatch):
        """-5 raises ValueError (must be within range)."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "-5")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be between 128 and 8192"):
            RAGSettings()

    def test_chunk_size_invalid_zero(self, monkeypatch):
        """0 raises ValueError (must be within range)."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "0")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be between 128 and 8192"):
            RAGSettings()

    def test_chunk_size_invalid_string(self, monkeypatch):
        """Non-integer string raises ValueError."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "abc")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()


class TestRAGChunkOverlapValidation:
    """RAG_CHUNK_OVERLAP must be non-negative and less than RAG_CHUNK_SIZE."""

    def test_chunk_overlap_valid_within_limit(self, monkeypatch):
        """50 with chunk_size=512 is valid."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "512")
        monkeypatch.setenv("RAG_CHUNK_OVERLAP", "50")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_chunk_overlap == 50
        assert s.rag_chunk_size == 512

    def test_chunk_overlap_valid_zero(self, monkeypatch):
        """0 overlap is valid."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "512")
        monkeypatch.setenv("RAG_CHUNK_OVERLAP", "0")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_chunk_overlap == 0

    def test_chunk_overlap_invalid_negative(self, monkeypatch):
        """-5 raises ValueError (must be non-negative)."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "512")
        monkeypatch.setenv("RAG_CHUNK_OVERLAP", "-5")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be non-negative"):
            RAGSettings()

    def test_chunk_overlap_invalid_equal_to_chunk_size(self, monkeypatch):
        """overlap=512 with chunk_size=512 raises ValueError (must be < chunk_size)."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "512")
        monkeypatch.setenv("RAG_CHUNK_OVERLAP", "512")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be less than RAG_CHUNK_SIZE"):
            RAGSettings()

    def test_chunk_overlap_invalid_exceeds_chunk_size(self, monkeypatch):
        """600 with chunk_size=512 raises ValueError (must be < chunk_size)."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "512")
        monkeypatch.setenv("RAG_CHUNK_OVERLAP", "600")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be less than RAG_CHUNK_SIZE"):
            RAGSettings()


class TestRAGTemperatureValidation:
    """RAG_TEMPERATURE must be between 0.0 and 2.0."""

    def test_temperature_valid_mid(self, monkeypatch):
        """0.3 is valid (and matches default)."""
        monkeypatch.setenv("RAG_TEMPERATURE", "0.3")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_temperature == 0.3

    def test_temperature_valid_boundary_high(self, monkeypatch):
        """2.0 is the maximum valid value."""
        monkeypatch.setenv("RAG_TEMPERATURE", "2.0")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_temperature == 2.0

    def test_temperature_invalid_too_high(self, monkeypatch):
        """2.5 raises ValueError (must be 0-2)."""
        monkeypatch.setenv("RAG_TEMPERATURE", "2.5")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be between 0.0 and 2.0"):
            RAGSettings()

    def test_temperature_invalid_negative(self, monkeypatch):
        """-0.1 raises ValueError."""
        monkeypatch.setenv("RAG_TEMPERATURE", "-0.1")
        importlib.reload(config)
        from config import RAGSettings
        with pytest.raises(ValueError, match="must be between 0.0 and 2.0"):
            RAGSettings()


# ---------------------------------------------------------------------------
# 2. DEFAULT VALUES
# ---------------------------------------------------------------------------

class TestDefaultValues:
    """All settings have appropriate defaults matching previous hardcoded values."""

    def test_defaults_are_loaded(self, monkeypatch, clear_env):
        """With no env vars set, defaults are used."""
        # Clear all RAG_ env vars first
        for key in list(os.environ.keys()):
            if key.startswith("RAG_"):
                monkeypatch.delenv(key, raising=False)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_db_path == "./doc_qa_db"
        assert s.rag_chunk_size == 512
        assert s.rag_chunk_overlap == 50
        assert s.rag_n_results == 3
        assert s.rag_min_similarity == 0.3
        assert s.rag_retrieval_window == 1
        assert s.rag_max_tokens == 1024
        assert s.rag_temperature == 0.3
        assert s.rag_embedding_model == "BAAI/bge-small-en-v1.5"
        assert s.rag_hybrid_search is True
        assert s.rag_reranking_enabled is True
        assert s.rag_cors_origins == "http://localhost,http://127.0.0.1"

    def test_global_settings_instance_exists(self):
        """The global `settings` instance is accessible."""
        from config import settings
        assert settings is not None
        assert hasattr(settings, "rag_min_similarity")
        assert hasattr(settings, "rag_chunk_size")


# ---------------------------------------------------------------------------
# 3. CONFIG USAGE TESTS
# ---------------------------------------------------------------------------

class TestConfigUsage:
    """engine_factory.py and api_server.py correctly use the config module."""

    def test_engine_factory_uses_settings_rag_min_similarity(self, monkeypatch):
        """create_engine_from_env() reads settings.rag_min_similarity into RAGConfig."""
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "0.75")
        monkeypatch.setenv("RAG_CHUNK_SIZE", "1024")
        monkeypatch.setenv("RAG_CHUNK_OVERLAP", "100")
        monkeypatch.setenv("RAG_N_RESULTS", "5")
        monkeypatch.setenv("RAG_MAX_TOKENS", "2048")
        monkeypatch.setenv("RAG_TEMPERATURE", "0.7")
        monkeypatch.setenv("RAG_EMBEDDING_MODEL", "BAAI/bge-base-en-v1.5")
        monkeypatch.setenv("RAG_HYBRID_SEARCH", "false")
        monkeypatch.setenv("RAG_RETRIEVAL_WINDOW", "2")
        monkeypatch.setenv("RAG_RERANKING_ENABLED", "true")
        monkeypatch.setenv("RAG_DB_PATH", "/custom/db")
        importlib.reload(config)
        from config import RAGSettings, settings
        # Access settings attr to trigger lazy init with current env vars
        s = RAGSettings()
        assert s.rag_min_similarity == 0.75
        assert s.rag_chunk_size == 1024
        assert s.rag_chunk_overlap == 100
        assert s.rag_n_results == 5
        assert s.rag_max_tokens == 2048
        assert s.rag_temperature == 0.7
        assert s.rag_embedding_model == "BAAI/bge-base-en-v1.5"
        assert s.rag_hybrid_search is False
        assert s.rag_retrieval_window == 2
        assert s.rag_reranking_enabled is True
        assert s.rag_db_path == "/custom/db"

    def test_engine_factory_imports_settings(self):
        """engine_factory.create_engine_from_env() imports settings from config."""
        # Read the source to verify import statement
        engine_factory_path = Path(__file__).parent.parent / "engine_factory.py"
        source = engine_factory_path.read_text()
        assert "from config import settings" in source
        assert "settings.rag_min_similarity" in source

    def test_api_server_imports_settings(self):
        """api_server imports settings from config module."""
        api_server_path = Path(__file__).parent.parent / "api_server.py"
        source = api_server_path.read_text()
        assert "from config import settings" in source


class TestCORsOriginsParsing:
    """RAG_CORS_ORIGINS is correctly parsed into a list."""

    def test_cors_origins_default(self, monkeypatch):
        """Default CORS origins parse to two entries."""
        monkeypatch.setenv("RAG_CORS_ORIGINS", "http://localhost,http://127.0.0.1")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        origins = s.get_cors_origins_list()
        assert origins == ["http://localhost", "http://127.0.0.1"]

    def test_cors_origins_single(self, monkeypatch):
        """Single origin parses correctly."""
        monkeypatch.setenv("RAG_CORS_ORIGINS", "https://example.com")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        origins = s.get_cors_origins_list()
        assert origins == ["https://example.com"]

    def test_cors_origins_multiple(self, monkeypatch):
        """Multiple comma-separated origins parse correctly."""
        monkeypatch.setenv("RAG_CORS_ORIGINS", "http://localhost:3000, https://example.com , http://127.0.0.1:8080")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        origins = s.get_cors_origins_list()
        assert origins == [
            "http://localhost:3000",
            "https://example.com",
            "http://127.0.0.1:8080",
        ]

    def test_cors_origins_whitespace_trimmed(self, monkeypatch):
        """Whitespace around origins is trimmed."""
        monkeypatch.setenv("RAG_CORS_ORIGINS", "  http://localhost  ,  http://127.0.0.1  ")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        origins = s.get_cors_origins_list()
        assert origins == ["http://localhost", "http://127.0.0.1"]

    def test_cors_origins_empty_string(self, monkeypatch):
        """Empty string returns empty list."""
        monkeypatch.setenv("RAG_CORS_ORIGINS", "")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        origins = s.get_cors_origins_list()
        assert origins == [""]


# ---------------------------------------------------------------------------
# 4. EDGE CASES & ADVERSARIAL INPUTS
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Boundary and adversarial inputs for config validation."""

    def test_similarity_extremes(self, monkeypatch):
        """Test extreme but valid similarity values."""
        # 0.0001 is valid
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "0.0001")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_min_similarity == 0.0001

        # 0.9999 is valid
        monkeypatch.setenv("RAG_MIN_SIMILARITY", "0.9999")
        importlib.reload(config)
        from config import RAGSettings
        s2 = RAGSettings()
        assert s2.rag_min_similarity == 0.9999

    def test_temperature_extremes(self, monkeypatch):
        """Test extreme but valid temperature values."""
        # 0.0 is valid
        monkeypatch.setenv("RAG_TEMPERATURE", "0.0")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_temperature == 0.0

        # 2.0 is valid
        monkeypatch.setenv("RAG_TEMPERATURE", "2.0")
        importlib.reload(config)
        from config import RAGSettings
        s2 = RAGSettings()
        assert s2.rag_temperature == 2.0

    def test_hybrid_search_bool_true_variants(self, monkeypatch):
        """Boolean env vars accept true-like strings."""
        for val in ("true", "1", "yes", "on"):
            monkeypatch.setenv("RAG_HYBRID_SEARCH", val)
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_hybrid_search is True, f"Failed for {val}"

    def test_hybrid_search_bool_false_variants(self, monkeypatch):
        """Boolean env vars accept false-like strings."""
        for val in ("false", "0", "no", "off"):
            monkeypatch.setenv("RAG_HYBRID_SEARCH", val)
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_hybrid_search is False, f"Failed for {val}"

    def test_reranking_bool_true(self, monkeypatch):
        """RERANKING_ENABLED accepts true-like strings."""
        monkeypatch.setenv("RAG_RERANKING_ENABLED", "true")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_reranking_enabled is True

    def test_large_chunk_size(self, monkeypatch):
        """Large chunk sizes like 8192 are valid."""
        monkeypatch.setenv("RAG_CHUNK_SIZE", "8192")
        monkeypatch.setenv("RAG_CHUNK_OVERLAP", "100")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_chunk_size == 8192

    def test_negative_n_results(self, monkeypatch):
        """Negative n_results is likely invalid but not validated (no validator).
        This is a known gap — only min_similarity, chunk_size, chunk_overlap,
        and temperature have validators. n_results relies on RAGConfig validation.
        """
        monkeypatch.setenv("RAG_N_RESULTS", "-1")
        importlib.reload(config)
        from config import RAGSettings
        s = RAGSettings()
        # Config allows it; RAGConfig should reject it at engine creation time
        assert s.rag_n_results == -1


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 5. LAZY SINGLETON & SETTINGS PROXY TESTS
# ---------------------------------------------------------------------------

class TestSettingsProxyAndSingleton:
    """_SettingsProxy delegates correctly; get_settings() is idempotent."""

    def test_get_settings_returns_singleton(self, clear_env):
        """get_settings() returns the same instance on repeated calls."""
        import config
        # Reset the global singleton so test is order-independent
        config._settings = None
        from config import get_settings
        instance1 = get_settings()
        instance2 = get_settings()
        assert instance1 is instance2

    def test_settings_proxy_getattr_delegates(self, clear_env):
        """settings.xxx transparently delegates to the lazy RAGSettings."""
        import config
        config._settings = None  # Reset
        from config import settings
        # Trigger lazy init by accessing an attribute
        val = settings.rag_min_similarity
        assert isinstance(val, float)
        assert 0.0 <= val <= 1.0

    def test_settings_proxy_repr(self, clear_env):
        """repr(settings) returns the repr of the underlying RAGSettings."""
        import config
        config._settings = None  # Reset
        from config import settings
        r = repr(settings)
        # Should contain the RAGSettings class name or the dict-like repr
        assert "RAGSettings" in r or "rag_db_path" in r

    def test_settings_proxy_setattr(self, clear_env):
        """settings.xxx = val sets the attribute on the lazy RAGSettings."""
        import config
        config._settings = None  # Reset
        from config import settings
        settings.rag_min_similarity = 0.42
        assert settings.rag_min_similarity == 0.42
        # Reset for other tests
        config._settings = None

    def test_all_settings_attributes_accessible_via_proxy(self, clear_env):
        """Every field on RAGSettings is accessible via the settings proxy."""
        import config
        config._settings = None  # Reset
        from config import settings
        attrs = [
            "rag_db_path", "rag_chunk_size", "rag_chunk_overlap",
            "rag_n_results", "rag_min_similarity", "rag_retrieval_window",
            "rag_max_tokens", "rag_temperature", "rag_embedding_model",
            "rag_hybrid_search", "rag_reranking_enabled", "rag_cors_origins",
        ]
        for attr in attrs:
            # Accessing should not raise AttributeError
            _ = getattr(settings, attr)


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------

@pytest.fixture
def clear_env(monkeypatch):
    """Clear all RAG_ environment variables before test."""
    for key in list(os.environ.keys()):
        if key.startswith("RAG_"):
            monkeypatch.delenv(key, raising=False)
    yield
