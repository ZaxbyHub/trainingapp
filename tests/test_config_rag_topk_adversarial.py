"""
Adversarial tests for config.py RAGSettings new fields:
  - rag_initial_retrieval_top_k
  - rag_rerank_top_k

Covers attack vectors:
  - BOUNDARY VIOLATIONS:  zero, negative, -0, NaN, Infinity, MAX_SAFE_INTEGER
  - TYPE CONFUSION:       float where int expected, string, None, list, dict
  - OVERSIZED INPUT:      extremely large integers
  - INJECTION:            SQL fragments, path traversal chars, Unicode
"""

import pytest
import os
import sys
import importlib
from pathlib import Path

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))


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


def _reload_config():
    """Reload config module to pick up env var changes."""
    import config
    importlib.reload(config)
    return config


# ---------------------------------------------------------------------------
# 1. BOUNDARY VIOLATIONS — rag_initial_retrieval_top_k
# ---------------------------------------------------------------------------

class TestInitialRetrievalTopKBoundaryViolations:
    """Adversarial boundary tests for rag_initial_retrieval_top_k."""

    def test_zero_accepted_as_int(self, monkeypatch, clear_env):
        """Zero is accepted as a valid integer."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "0")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 0

    def test_negative_one_rejected(self, monkeypatch, clear_env):
        """Negative -1 should be rejected (retrieval with 0 candidates makes no sense).
        Currently no validator exists — this documents a MISSING CONSTRAINT.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "-1")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        # No validator → config accepts -1 silently — downstream RAG pipeline
        # with -1 chunks is a potential crash/infinite loop vector
        assert s.rag_initial_retrieval_top_k == -1

    def test_large_negative_rejected(self, monkeypatch, clear_env):
        """Large negative -999999 accepted — no validator. Documents MISSING CONSTRAINT."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "-999999")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == -999999

    def test_max_safe_integer_accepted(self, monkeypatch, clear_env):
        """Number.MAX_SAFE_INTEGER (9007199254740991) accepted — no validator.
        Downstream memory exhaustion / slice crash risk.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", str(2**53 - 1))
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 9007199254740991

    def test_float_string_rejected_strict(self, monkeypatch, clear_env):
        """Float string '3.7' is REJECTED by Pydantic v2 (strict int parsing).
        This is correct security behavior — no silent truncation.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "3.7")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):  # Pydantic v2 raises ValidationError / int_parsing
            RAGSettings()

    def test_float_string_half_rejected(self, monkeypatch, clear_env):
        """Float string '2.5' is REJECTED by Pydantic v2 — no silent coercion.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "2.5")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_negative_zero_string(self, monkeypatch, clear_env):
        """'-0' is accepted and coerced to 0."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "-0")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 0

    def test_exponential_notation_rejected(self, monkeypatch, clear_env):
        """Scientific notation '1e3' is REJECTED by Pydantic v2 strict int parsing.
        No silent float-to-int coercion for string env vars.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "1e3")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_scientific_notation_large_exponent_rejected(self, monkeypatch, clear_env):
        """'1e9' is REJECTED — Pydantic v2 int field is strict about string format."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "1e9")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_non_numeric_string_rejected(self, monkeypatch, clear_env):
        """Non-numeric string raises ValueError or TypeError."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "not_a_number")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()

    def test_sql_injection_fragment_accepted(self, monkeypatch, clear_env):
        """SQL injection fragment '; DROP TABLE-- is accepted as top_k value.
        Documents lack of input sanitisation (though Pydantic int coercion
        means this should fail with TypeError/ValueError anyway).
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "; DROP TABLE--")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()

    def test_path_traversal_string_accepted(self, monkeypatch, clear_env):
        """Path traversal '../' chars accepted in env var — no injection risk
        since field is typed int, but documents lack of sanitisation.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "../5")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()

    def test_unicode_digits_rejected(self, monkeypatch, clear_env):
        """Unicode Arabic-Indic digits '\u0665' (value 5) are REJECTED by Pydantic v2.
        This is correct — prevents bypass of numeric filters via Unicode codepoints.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "\u0665")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_leading_plus_sign_accepted(self, monkeypatch, clear_env):
        """'+10' is accepted (Python int handles leading +)."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "+10")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 10

    def test_whitespace_padded_accepted(self, monkeypatch, clear_env):
        """'  20  ' is accepted (Pydantic strips whitespace for ints)."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "  20  ")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 20

    def test_empty_string_rejected(self, monkeypatch, clear_env):
        """Empty string raises ValueError."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()


# ---------------------------------------------------------------------------
# 2. BOUNDARY VIOLATIONS — rag_rerank_top_k
# ---------------------------------------------------------------------------

class TestRerankTopKBoundaryViolations:
    """Adversarial boundary tests for rag_rerank_top_k."""

    def test_zero_accepted(self, monkeypatch, clear_env):
        """Zero is accepted — reranking with 0 results is a no-op but valid."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "0")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == 0

    def test_negative_one_accepted_no_validator(self, monkeypatch, clear_env):
        """-1 accepted with no validator — downstream reranker may crash on -1 slices."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "-1")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == -1

    def test_negative_hundred_accepted(self, monkeypatch, clear_env):
        """-100 accepted — documents MISSING CONSTRAINT."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "-100")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == -100

    def test_float_string_rejected(self, monkeypatch, clear_env):
        """Float string '4.9' is REJECTED by Pydantic v2 strict int parsing.
        No silent coercion — callers get explicit error.
        """
        monkeypatch.setenv("RAG_RERANK_TOP_K", "4.9")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_negative_zero_string(self, monkeypatch, clear_env):
        """'-0' coerced to 0."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "-0")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == 0

    def test_scientific_notation_large_rejected(self, monkeypatch, clear_env):
        """'1e6' is REJECTED by Pydantic v2 strict int parsing."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "1e6")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_non_numeric_rejected(self, monkeypatch, clear_env):
        """Non-numeric string rejected."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "forty-two")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()

    def test_unicode_digits_rejected(self, monkeypatch, clear_env):
        """Unicode digit '\u0663' (value 3) is REJECTED by Pydantic v2.
        Prevents filter bypass via Unicode codepoints.
        """
        monkeypatch.setenv("RAG_RERANK_TOP_K", "\u0663")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_leading_plus(self, monkeypatch, clear_env):
        """'+7' accepted."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "+7")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == 7

    def test_whitespace_padded(self, monkeypatch, clear_env):
        """'  15  ' accepted."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "  15  ")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == 15

    def test_empty_string_rejected(self, monkeypatch, clear_env):
        """Empty string rejected."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings()


# ---------------------------------------------------------------------------
# 3. TYPE CONFUSION — both fields
# ---------------------------------------------------------------------------

class TestTypeConfusionBothFields:
    """Type confusion attacks on rag_initial_retrieval_top_k and rag_rerank_top_k."""

    def test_boolean_true_string_rejected(self, monkeypatch, clear_env):
        """Boolean string 'true' is REJECTED by Pydantic v2 int field.
        No silent bool-to-int coercion for env var strings — callers must use '1'.
        This is correct security behavior.
        """
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "true")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_boolean_false_string_rejected(self, monkeypatch, clear_env):
        """Boolean string 'false' is REJECTED — callers must use '0'."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "false")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_rerank_boolean_true_rejected(self, monkeypatch, clear_env):
        """'true' string is REJECTED for rag_rerank_top_k — correct strict behavior."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "true")
        cfg = _reload_config()
        from config import RAGSettings
        with pytest.raises(Exception):
            RAGSettings()

    def test_direct_list_type_rejected(self, monkeypatch, clear_env):
        """Passing a list value to an int field — env var is always str so this
        is a code-injection scenario if fields are set programmatically.
        """
        import config
        config._settings = None
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings(rag_initial_retrieval_top_k=[10])  # type: ignore

    def test_direct_none_rejected(self, monkeypatch, clear_env):
        """Passing None to an int field raises ValidationError."""
        import config
        config._settings = None
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings(rag_initial_retrieval_top_k=None)  # type: ignore

    def test_direct_dict_rejected(self, monkeypatch, clear_env):
        """Passing dict to int field raises ValidationError."""
        import config
        config._settings = None
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings(rag_initial_retrieval_top_k={"k": 5})  # type: ignore

    def test_direct_float_rejected_in_programmatic(self, monkeypatch, clear_env):
        """Passing float 3.14 directly to int field raises TypeError."""
        import config
        config._settings = None
        from config import RAGSettings
        with pytest.raises((ValueError, TypeError)):
            RAGSettings(rag_initial_retrieval_top_k=3.14)  # type: ignore


# ---------------------------------------------------------------------------
# 4. OVERSIZED INPUT
# ---------------------------------------------------------------------------

class TestOversizedInput:
    """Oversized integer inputs for both fields."""

    def test_initial_retrieval_top_k_very_large(self, monkeypatch, clear_env):
        """10 billion accepted — no upper-bound validator. Potential memory exhaustion."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", "10000000000")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 10_000_000_000

    def test_rerank_top_k_very_large(self, monkeypatch, clear_env):
        """1 billion accepted — no upper-bound validator."""
        monkeypatch.setenv("RAG_RERANK_TOP_K", "1000000000")
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == 1_000_000_000

    def test_negative_extreme_minus_max_safe(self, monkeypatch, clear_env):
        """-MAX_SAFE_INTEGER accepted."""
        monkeypatch.setenv("RAG_INITIAL_RETRIEVAL_TOP_K", str(-(2**53 - 1)))
        cfg = _reload_config()
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == -(2**53 - 1)


# ---------------------------------------------------------------------------
# 5. DEFAULT VALUES — sanity check
# ---------------------------------------------------------------------------

class TestNewFieldDefaults:
    """Verify default values for the two new fields."""

    def test_initial_retrieval_top_k_default(self, clear_env, monkeypatch):
        """Default rag_initial_retrieval_top_k is 30."""
        monkeypatch.delenv("RAG_INITIAL_RETRIEVAL_TOP_K", raising=False)
        monkeypatch.delenv("RAG_RERANK_TOP_K", raising=False)
        # Reset singleton so defaults are recomputed
        import config as cfg_module
        cfg_module._settings = None
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 30

    def test_rerank_top_k_default(self, clear_env, monkeypatch):
        """Default rag_rerank_top_k is 6."""
        monkeypatch.delenv("RAG_INITIAL_RETRIEVAL_TOP_K", raising=False)
        monkeypatch.delenv("RAG_RERANK_TOP_K", raising=False)
        import config as cfg_module
        cfg_module._settings = None
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_rerank_top_k == 6

    def test_defaults_coexist(self, clear_env, monkeypatch):
        """Both new fields coexist without conflict."""
        monkeypatch.delenv("RAG_INITIAL_RETRIEVAL_TOP_K", raising=False)
        monkeypatch.delenv("RAG_RERANK_TOP_K", raising=False)
        import config as cfg_module
        cfg_module._settings = None
        from config import RAGSettings
        s = RAGSettings()
        assert s.rag_initial_retrieval_top_k == 30
        assert s.rag_rerank_top_k == 6

    def test_both_fields_via_proxy(self, clear_env, monkeypatch):
        """Both new fields are accessible via the settings proxy."""
        monkeypatch.delenv("RAG_INITIAL_RETRIEVAL_TOP_K", raising=False)
        monkeypatch.delenv("RAG_RERANK_TOP_K", raising=False)
        import config as cfg_module
        cfg_module._settings = None
        from config import settings
        assert settings.rag_initial_retrieval_top_k == 30
        assert settings.rag_rerank_top_k == 6
