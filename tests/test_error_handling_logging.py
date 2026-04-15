"""
Test FR-601 (query_transformer try/except) and FR-602 (llm_interface print→logger).
Verifies:
  - LLM call in transform_step_back is wrapped in try/except; on failure returns original query + logs warning
  - llm_interface.py has zero print() calls
  - Both modules have module-level loggers
"""
import pytest
import logging
import re
import sys
from unittest.mock import MagicMock


# Ensure the app root is on sys.path so imports resolve
import os
app_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(app_root))


class TestQueryTransformerErrorHandling:
    """Test FR-601: query_transformer LLM call wrapped in try/except."""

    def test_transform_step_back_returns_original_on_exception(self):
        """LLM failure must return original query unchanged."""
        from query_transformer import QueryTransformer

        mock_llm = MagicMock()
        mock_llm.generate.side_effect = RuntimeError("Model not loaded")
        qt = QueryTransformer(mock_llm)

        result = qt.transform_step_back("What is the speed of light?")
        assert result == "What is the speed of light?"

    def test_transform_step_back_logs_warning_on_exception(self, caplog):
        """LLM failure must log a warning."""
        from query_transformer import QueryTransformer

        mock_llm = MagicMock()
        mock_llm.generate.side_effect = RuntimeError("OOM")
        qt = QueryTransformer(mock_llm)

        with caplog.at_level(logging.WARNING, logger="query_transformer"):
            qt.transform_step_back("test query")

        assert "Query transformation failed" in caplog.text
        assert "OOM" in caplog.text

    def test_transform_step_back_normal_flow(self):
        """Successful transformation must still work."""
        from query_transformer import QueryTransformer

        mock_llm = MagicMock()
        mock_llm.generate.return_value = "quantum physics fundamentals"
        qt = QueryTransformer(mock_llm)

        result = qt.transform_step_back("What is quantum entanglement?")
        assert result == "quantum physics fundamentals"

    def test_transform_step_back_returns_original_on_empty_result(self):
        """Empty or short result must return original query."""
        from query_transformer import QueryTransformer

        mock_llm = MagicMock()
        mock_llm.generate.return_value = "abc"  # len < 5
        qt = QueryTransformer(mock_llm)

        result = qt.transform_step_back("What is AI?")
        assert result == "What is AI?"

    def test_transform_keywords_unchanged(self):
        """transform_keywords must not be affected by the try/except change."""
        from query_transformer import QueryTransformer

        mock_llm = MagicMock()
        qt = QueryTransformer(mock_llm)

        result = qt.transform_keywords("the quick brown fox jumps over lazy dog")
        assert "fox" in result
        assert "the" not in result  # stop word removed


class TestLLMInterfaceNoPrints:
    """Test FR-602: llm_interface.py has zero print() calls."""

    def test_no_print_in_llm_interface_source(self):
        """Verify no print() statements remain in llm_interface.py source code."""
        import llm_interface
        source_file = llm_interface.__file__
        with open(source_file, "r") as f:
            source = f.read()
        # Match print( at the start of a line (possibly indented), not inside comments
        # Strip comment lines first
        lines = source.splitlines()
        code_lines = []
        for line in lines:
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue
            code_lines.append(line)
        code_only = "\n".join(code_lines)
        # Find print( that is not inside a string
        print_calls = re.findall(r'print\s*\(', code_only)
        assert len(print_calls) == 0, (
            f"Found {len(print_calls)} print() call(s) in llm_interface.py. "
            f"All print() statements must be replaced with logger calls."
        )

    def test_llm_interface_has_module_logger(self):
        """Verify module-level logger exists."""
        import llm_interface
        assert hasattr(llm_interface, 'logger'), (
            "llm_interface must have a module-level logger: logger = logging.getLogger(__name__)"
        )
        assert isinstance(llm_interface.logger, logging.Logger)

    def test_query_transformer_has_module_logger(self):
        """Verify module-level logger exists."""
        import query_transformer
        assert hasattr(query_transformer, 'logger'), (
            "query_transformer must have a module-level logger: logger = logging.getLogger(__name__)"
        )
        assert isinstance(query_transformer.logger, logging.Logger)
