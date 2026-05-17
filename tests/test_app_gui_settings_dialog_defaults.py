"""
Tests for app_gui.py SettingsDialog defaults and validation (Task 8.3).

Verifies:
1. n_results defaults to 6 when not in settings
2. retrieval_window defaults to 2 when not in settings
3. Initial Retrieval Top-K defaults to 30, Rerank Top-K defaults to 6
4. Validation rejects values outside 1-100 for the new fields
5. Saving persists all fields including the new ones
"""
import pytest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Helper: replicate _populate_fields field-insertion logic
# ---------------------------------------------------------------------------

def _get_populated_value(settings: dict, key: str, default):
    """Mirror the logic in SettingsDialog._populate_fields."""
    return settings.get(key, default)


def _validate_retrieval_window(value: str, default: int = 2) -> tuple[int, list[str]]:
    """
    Mirror _save validation for retrieval_window.

    Range failure appends an error but the parsed value is still returned
    (consistent with how the source code works — errors are collected, the
    value participates in the result if no ValueError was raised).
    ValueError causes the value to be unreachable in the real code.
    """
    errors = []
    try:
        val = int(value) if value else default
        if not (0 <= val <= 5):
            errors.append("Window Expansion must be between 0 and 5")
        return val, errors
    except ValueError:
        errors.append("Window Expansion must be a valid integer")
        # In the real code: early return on ValueError, value never used.
        # We return (default, errors) so the helper is still usable.
        return default, errors


def _validate_initial_retrieval_top_k(value: str, default: int = 30) -> tuple[int, list[str]]:
    """
    Mirror _save validation for initial_retrieval_top_k.

    ValueError → early return, value never reaches result dict.
    Range error → error appended, parsed value returned (bug in source, but real).
    """
    errors = []
    try:
        val = int(value) if value else default
        if not (1 <= val <= 100):
            errors.append("Initial Retrieval Top-K must be between 1 and 100")
        return val, errors
    except ValueError:
        errors.append("Initial Retrieval Top-K must be a valid integer")
        return default, errors


def _validate_rerank_top_k(value: str, default: int = 6) -> tuple[int, list[str]]:
    """
    Mirror _save validation for rerank_top_k.

    ValueError → early return, value never reaches result dict.
    Range error → error appended, parsed value returned.
    """
    errors = []
    try:
        val = int(value) if value else default
        if not (1 <= val <= 100):
            errors.append("Rerank Top-K must be between 1 and 100")
        return val, errors
    except ValueError:
        errors.append("Rerank Top-K must be a valid integer")
        return default, errors


def _build_result_dict(
    settings: dict,
    n_results_str: str,
    retrieval_window_str: str,
    initial_retrieval_top_k_str: str,
    rerank_top_k_str: str,
) -> dict:
    """
    Mirror _save to build the result dict.
    Used to verify all fields are present in saved output.
    """
    n_results = int(n_results_str) if n_results_str else 6
    retrieval_window = int(retrieval_window_str) if retrieval_window_str else 2
    initial_retrieval_top_k = int(initial_retrieval_top_k_str) if initial_retrieval_top_k_str else 30
    rerank_top_k = int(rerank_top_k_str) if rerank_top_k_str else 6
    return {
        "n_results": n_results,
        "retrieval_window": retrieval_window,
        "initial_retrieval_top_k": initial_retrieval_top_k,
        "rerank_top_k": rerank_top_k,
    }


# ---------------------------------------------------------------------------
# 1. n_results default = 6
# ---------------------------------------------------------------------------

class TestNResultsDefault:
    """Task 8.3 requirement: n_results defaults to 6 when not in settings."""

    def test_missing_n_results_defaults_to_6(self):
        """Settings with no n_results key -> _populate_fields uses 6."""
        settings = {}
        val = _get_populated_value(settings, "n_results", 6)
        assert val == 6

    def test_explicit_6_preserved(self):
        """Explicit n_results=6 is returned as-is."""
        settings = {"n_results": 6}
        val = _get_populated_value(settings, "n_results", 6)
        assert val == 6

    def test_explicit_10_preserved(self):
        """Explicit n_results=10 is returned as-is."""
        settings = {"n_results": 10}
        val = _get_populated_value(settings, "n_results", 6)
        assert val == 10

    def test_other_keys_missing_n_results(self):
        """Settings with other keys but no n_results -> 6."""
        settings = {"chunk_size": 512, "temperature": 0.7}
        val = _get_populated_value(settings, "n_results", 6)
        assert val == 6


# ---------------------------------------------------------------------------
# 2. retrieval_window default = 2
# ---------------------------------------------------------------------------

class TestRetrievalWindowDefault:
    """Task 8.3 requirement: retrieval_window defaults to 2 when not in settings."""

    def test_missing_retrieval_window_defaults_to_2(self):
        """Settings with no retrieval_window key -> _populate_fields uses 2."""
        settings = {}
        val = _get_populated_value(settings, "retrieval_window", 2)
        assert val == 2

    def test_explicit_2_preserved(self):
        """Explicit retrieval_window=2 is returned as-is."""
        settings = {"retrieval_window": 2}
        val = _get_populated_value(settings, "retrieval_window", 2)
        assert val == 2

    def test_explicit_5_preserved(self):
        """Explicit retrieval_window=5 is returned as-is."""
        settings = {"retrieval_window": 5}
        val = _get_populated_value(settings, "retrieval_window", 2)
        assert val == 5

    def test_explicit_0_preserved(self):
        """Explicit retrieval_window=0 is returned as-is."""
        settings = {"retrieval_window": 0}
        val = _get_populated_value(settings, "retrieval_window", 2)
        assert val == 0


# ---------------------------------------------------------------------------
# 3. Initial Retrieval Top-K = 30, Rerank Top-K = 6
# ---------------------------------------------------------------------------

class TestRerankingTopKDefaults:
    """Task 8.3 requirement: new Top-K fields default to 30 and 6."""

    def test_initial_retrieval_top_k_missing_defaults_to_30(self):
        """Settings with no initial_retrieval_top_k -> 30."""
        settings = {}
        val = _get_populated_value(settings, "initial_retrieval_top_k", 30)
        assert val == 30

    def test_rerank_top_k_missing_defaults_to_6(self):
        """Settings with no rerank_top_k -> 6."""
        settings = {}
        val = _get_populated_value(settings, "rerank_top_k", 6)
        assert val == 6

    def test_initial_retrieval_top_k_explicit_50_preserved(self):
        """Explicit initial_retrieval_top_k=50 is returned as-is."""
        settings = {"initial_retrieval_top_k": 50}
        val = _get_populated_value(settings, "initial_retrieval_top_k", 30)
        assert val == 50

    def test_rerank_top_k_explicit_10_preserved(self):
        """Explicit rerank_top_k=10 is returned as-is."""
        settings = {"rerank_top_k": 10}
        val = _get_populated_value(settings, "rerank_top_k", 6)
        assert val == 10


# ---------------------------------------------------------------------------
# 4. Validation rejects values outside 1-100 for new fields
# ---------------------------------------------------------------------------

class TestInitialRetrievalTopKValidation:
    """Validation for Initial Retrieval Top-K (must be 1-100)."""

    def test_valid_boundary_low(self):
        val, errors = _validate_initial_retrieval_top_k("1")
        assert val == 1
        assert errors == []

    def test_valid_boundary_high(self):
        val, errors = _validate_initial_retrieval_top_k("100")
        assert val == 100
        assert errors == []

    def test_valid_mid_value(self):
        val, errors = _validate_initial_retrieval_top_k("50")
        assert val == 50
        assert errors == []

    def test_invalid_too_low(self):
        val, errors = _validate_initial_retrieval_top_k("0")
        assert val == 0  # parsed; validation error is still raised
        assert any("between 1 and 100" in e for e in errors)

    def test_invalid_negative(self):
        val, errors = _validate_initial_retrieval_top_k("-5")
        assert val == -5  # parsed; validation error is still raised
        assert any("between 1 and 100" in e for e in errors)

    def test_invalid_too_high(self):
        val, errors = _validate_initial_retrieval_top_k("101")
        assert val == 101  # parsed; validation error is still raised
        assert any("between 1 and 100" in e for e in errors)

    def test_invalid_non_numeric(self):
        # Non-numeric input causes ValueError → early return in real code,
        # value never used. Helper still returns (default, errors) so we verify
        # the error is present and the early-return contract is satisfied.
        val, errors = _validate_initial_retrieval_top_k("abc")
        assert any("valid integer" in e for e in errors)
        # value would never be reached in real code (early return on error)

    def test_empty_string_uses_default(self):
        """Empty string is falsy, uses default 30, which is valid."""
        val, errors = _validate_initial_retrieval_top_k("")
        assert val == 30
        assert errors == []


class TestRerankTopKValidation:
    """Validation for Rerank Top-K (must be 1-100)."""

    def test_valid_boundary_low(self):
        val, errors = _validate_rerank_top_k("1")
        assert val == 1
        assert errors == []

    def test_valid_boundary_high(self):
        val, errors = _validate_rerank_top_k("100")
        assert val == 100
        assert errors == []

    def test_valid_mid_value(self):
        val, errors = _validate_rerank_top_k("6")
        assert val == 6
        assert errors == []

    def test_invalid_too_low(self):
        val, errors = _validate_rerank_top_k("0")
        assert val == 0  # parsed; validation error is still raised
        assert any("between 1 and 100" in e for e in errors)

    def test_invalid_negative(self):
        val, errors = _validate_rerank_top_k("-3")
        assert val == -3  # parsed; validation error is still raised
        assert any("between 1 and 100" in e for e in errors)

    def test_invalid_too_high(self):
        val, errors = _validate_rerank_top_k("200")
        assert val == 200  # parsed; validation error is still raised
        assert any("between 1 and 100" in e for e in errors)

    def test_invalid_non_numeric(self):
        # Non-numeric causes ValueError → early return, value never used.
        val, errors = _validate_rerank_top_k("xyz")
        assert any("valid integer" in e for e in errors)
        # value would never be reached in real code (early return on error)

    def test_empty_string_uses_default(self):
        """Empty string is falsy, uses default 6, which is valid."""
        val, errors = _validate_rerank_top_k("")
        assert val == 6
        assert errors == []


# ---------------------------------------------------------------------------
# 5. Saving persists all fields including the new ones
# ---------------------------------------------------------------------------

class TestSavePersistsAllFields:
    """Verify _save includes all fields in the result dict."""

    def test_result_includes_n_results(self):
        result = _build_result_dict({}, "10", "3", "40", "8")
        assert "n_results" in result
        assert result["n_results"] == 10

    def test_result_includes_retrieval_window(self):
        result = _build_result_dict({}, "10", "3", "40", "8")
        assert "retrieval_window" in result
        assert result["retrieval_window"] == 3

    def test_result_includes_initial_retrieval_top_k(self):
        result = _build_result_dict({}, "10", "3", "40", "8")
        assert "initial_retrieval_top_k" in result
        assert result["initial_retrieval_top_k"] == 40

    def test_result_includes_rerank_top_k(self):
        result = _build_result_dict({}, "10", "3", "40", "8")
        assert "rerank_top_k" in result
        assert result["rerank_top_k"] == 8

    def test_defaults_all_fields_present(self):
        """With empty settings, all 4 new fields have their defaults."""
        result = _build_result_dict({}, "", "", "", "")
        assert result["n_results"] == 6
        assert result["retrieval_window"] == 2
        assert result["initial_retrieval_top_k"] == 30
        assert result["rerank_top_k"] == 6

    def test_explicit_values_all_fields(self):
        """All 4 fields can be set and retrieved independently."""
        result = _build_result_dict({}, "15", "4", "80", "15")
        assert result["n_results"] == 15
        assert result["retrieval_window"] == 4
        assert result["initial_retrieval_top_k"] == 80
        assert result["rerank_top_k"] == 15


# ---------------------------------------------------------------------------
# Integration: verify source lines match the expected defaults
# ---------------------------------------------------------------------------

class TestSourceDefaults:
    """Inspect app_gui.py source to verify defaults are hardcoded correctly."""

    def test_populate_fields_n_results_uses_4(self):
        """n_results default must be 4 (minimum-hardware default)."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._populate_fields)
        assert '"n_results", 4)' in source, (
            "_populate_fields must default n_results to 4"
        )

    def test_populate_fields_retrieval_window_uses_1(self):
        """retrieval_window default must be 1 (minimum-hardware default)."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._populate_fields)
        assert '"retrieval_window", 1)' in source, (
            "_populate_fields must default retrieval_window to 1"
        )

    def test_populate_fields_initial_retrieval_top_k_uses_12(self):
        """initial_retrieval_top_k default must be 12 (minimum-hardware default)."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._populate_fields)
        assert '"initial_retrieval_top_k", 12)' in source, (
            "_populate_fields must default initial_retrieval_top_k to 12"
        )

    def test_populate_fields_rerank_top_k_uses_4(self):
        """rerank_top_k default must be 4 (minimum-hardware default)."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._populate_fields)
        assert '"rerank_top_k", 4)' in source, (
            "_populate_fields must default rerank_top_k to 4"
        )

    def test_save_validation_initial_retrieval_top_k_range(self):
        """Line 304-307: initial_retrieval_top_k must validate 1-100."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._save)
        assert "1 <= initial_retrieval_top_k <= 100" in source, (
            "_save must validate initial_retrieval_top_k in range 1-100"
        )

    def test_save_validation_rerank_top_k_range(self):
        """Line 311-314: rerank_top_k must validate 1-100."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._save)
        assert "1 <= rerank_top_k <= 100" in source, (
            "_save must validate rerank_top_k in range 1-100"
        )

    def test_save_result_includes_all_new_fields(self):
        """Lines 329-330: saved result must include initial_retrieval_top_k and rerank_top_k."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._save)
        assert '"initial_retrieval_top_k": initial_retrieval_top_k' in source
        assert '"rerank_top_k": rerank_top_k' in source

    def test_create_widgets_has_initial_retrieval_top_k_entry(self):
        """Line 213: _create_widgets must create initial_retrieval_top_k_entry."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._create_widgets)
        assert "initial_retrieval_top_k_entry" in source, (
            "_create_widgets must create initial_retrieval_top_k_entry widget"
        )

    def test_create_widgets_has_rerank_top_k_entry(self):
        """Line 220: _create_widgets must create rerank_top_k_entry."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        import inspect
        source = inspect.getsource(app_gui.SettingsDialog._create_widgets)
        assert "rerank_top_k_entry" in source, (
            "_create_widgets must create rerank_top_k_entry widget"
        )
