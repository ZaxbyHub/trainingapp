"""
Acceptance checks for issue #53 (AC5 + diagnostic propagation): the GUI and
RAGEngine must surface the real RAM diagnostic instead of misdirecting the
user to "configure an LLM backend".

DISCRIMINATING checks (base is RED):
- Part 1: app_gui._classify_error maps any unrecognized query error to
  "Make sure at least one LLM backend is configured in Settings" even when
  the error text is an "Insufficient RAM" diagnostic, so the
  '"configured in Settings" not in result' assertion fails at base.
- Part 2: rag_engine._init_llm swallows the SmartLLM failure and query()
  raises a bare "LLM not initialized. Cannot answer questions.", so the
  query-message assertion fails at base. The llm_init_error attribute read
  uses getattr(..., None) so the base failure comes from the query-message
  assertion (clean RED), and the recorded-diagnostic assertions apply once
  the attribute exists.
"""

from unittest.mock import patch

import pytest

RAM_DIAGNOSTIC = (
    "Insufficient RAM to load GGUF model: need ~5.2GB, "
    "but only 4.0GB available. Close other applications or use a smaller model."
)


def _load_app_gui():
    try:
        import app_gui

        return app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")


class TestClassifyErrorSurfacesRamDiagnostic:
    """Part 1: _classify_error must relay RAM numbers, not Settings advice."""

    def test_ram_error_classified_with_numbers_and_no_settings_misdirection(self):
        app_gui = _load_app_gui()
        result = app_gui._classify_error(RuntimeError(RAM_DIAGNOSTIC), "query")

        assert (
            "5.2GB" in result
        ), f"classified message must keep the required-RAM number; got: {result!r}"
        assert (
            "4.0GB" in result
        ), f"classified message must keep the available-RAM number; got: {result!r}"
        assert (
            "Insufficient RAM" in result
        ), f"classified message must keep the RAM-failure marker; got: {result!r}"
        assert "configured in Settings" not in result, (
            "RAM-gate refusal must not be misdirected to "
            f"'configured in Settings' (a backend IS configured); got: {result!r}"
        )


class TestEngineDiagnosticPropagation:
    """Part 2: RAGEngine must record and re-raise the load diagnostic."""

    def test_llm_init_error_recorded_and_survives_into_query_message(self):
        import rag_engine
        from rag_engine import RAGConfig, RAGEngine

        engine = RAGEngine.__new__(RAGEngine)  # bypass heavy __init__
        engine.config = RAGConfig()
        engine.gguf_path = "models/x.gguf"
        engine.llm = None

        with patch.object(
            rag_engine,
            "SmartLLM",
            side_effect=RuntimeError(
                "Insufficient RAM to load GGUF model: need ~5.2GB, "
                "but only 4.0GB available"
            ),
        ):
            engine._init_llm("models/x.gguf")

            assert engine.llm is None, "failed load must leave llm as None"
            # Tolerant at base (attribute does not exist yet); pinned RED is
            # the query-message assertion below.
            diagnostic = getattr(engine, "llm_init_error", None)

            with pytest.raises(RuntimeError) as exc_info:
                engine.query("q")

        msg = str(exc_info.value)
        assert "Insufficient RAM" in msg, (
            "RAGEngine.query() must raise the recorded llm_init_error "
            f"diagnostic instead of a bare 'LLM not initialized' message; "
            f"llm_init_error={diagnostic!r}, raised: {msg!r}"
        )
        if diagnostic is not None:
            assert "Insufficient RAM" in diagnostic, (
                f"llm_init_error must carry the SmartLLM failure text; "
                f"got: {diagnostic!r}"
            )
