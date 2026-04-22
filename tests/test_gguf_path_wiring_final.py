import os
import tempfile
from unittest.mock import patch, MagicMock
import pytest

# Import the modules to test
from rag_engine import RAGEngine
from engine_factory import create_engine_from_env
from llm_interface import SmartLLM


def _get_last_call_args(mock):
    """Get the call_kwargs from the last call to a mock."""
    if not mock.call_args_list:
        return None
    return mock.call_args_list[-1].kwargs


class TestGGUFPathWiring:
    """Tests for GGUF path wiring functionality."""

    def setup_method(self):
        """Reset SmartLLM mock state before each test to avoid test pollution."""
        # Clear any cached imports that might have SmartLLM references
        import sys
        # Force re-import of rag_engine to get fresh references
        if 'rag_engine' in sys.modules:
            import importlib
            import rag_engine
            importlib.reload(rag_engine)

    def test_rag_engine_accepts_gguf_path_parameter(self):
        """Test that RAGEngine accepts gguf_path parameter without error."""
        # Mock the SmartLLM to avoid actual LLM instantiation
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm_instance = MagicMock()
            mock_smart_llm.return_value = mock_smart_llm_instance

            # This should not raise any exception
            engine = RAGEngine(gguf_path="/path/to/model.gguf")

            # Verify that SmartLLM was called with gguf_path - check LAST call
            # This is more robust when tests run in suite and previous tests may
            # have left mock state
            assert mock_smart_llm.call_count >= 1, "SmartLLM should be called at least once"
            call_args = _get_last_call_args(mock_smart_llm)
            assert call_args is not None
            assert call_args['gguf_path'] == "/path/to/model.gguf"

    def test_rag_engine_stores_gguf_path(self):
        """Test that RAGEngine stores gguf_path in self.gguf_path."""
        # Mock the SmartLLM to avoid actual LLM instantiation
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm_instance = MagicMock()
            mock_smart_llm.return_value = mock_smart_llm_instance

            engine = RAGEngine(gguf_path="/path/to/model.gguf")

            assert engine.gguf_path == "/path/to/model.gguf"

    def test_create_engine_from_env_reads_env_var(self):
        """Test that create_engine_from_env reads RAG_GGUF_PATH env var correctly."""
        # Set the environment variable
        with patch.dict(os.environ, {"RAG_GGUF_PATH": "/env/path/to/model.gguf"}):
            # Mock the SmartLLM to avoid actual LLM instantiation
            with patch('rag_engine.SmartLLM') as mock_smart_llm:
                mock_smart_llm_instance = MagicMock()
                mock_smart_llm.return_value = mock_smart_llm_instance

                engine = create_engine_from_env()

                # Verify that SmartLLM was called with the correct gguf_path from env
                # Check LAST call for robustness
                assert mock_smart_llm.call_count >= 1, "SmartLLM should be called at least once"
                call_args = _get_last_call_args(mock_smart_llm)
                assert call_args is not None
                assert call_args['gguf_path'] == "/env/path/to/model.gguf"

    def test_create_engine_from_env_passes_gguf_path_to_rag_engine(self):
        """Test that create_engine_from_env passes gguf_path to RAGEngine."""
        # Set the environment variable
        with patch.dict(os.environ, {"RAG_GGUF_PATH": "/env/path/to/model.gguf"}):
            # Mock the SmartLLM to avoid actual LLM instantiation
            with patch('rag_engine.SmartLLM') as mock_smart_llm:
                mock_smart_llm_instance = MagicMock()
                mock_smart_llm.return_value = mock_smart_llm_instance

                engine = create_engine_from_env()

                # Verify that the engine was created with the correct gguf_path
                assert engine.gguf_path == "/env/path/to/model.gguf"

    def test_init_llm_passes_gguf_path_to_smartllm(self):
        """Test that _init_llm passes gguf_path to SmartLLM."""
        # Mock the SmartLLM to avoid actual LLM instantiation
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm_instance = MagicMock()
            mock_smart_llm.return_value = mock_smart_llm_instance

            # Create engine with gguf_path
            engine = RAGEngine(gguf_path="/test/path/model.gguf")

            # Verify that SmartLLM was called with gguf_path - check LAST call
            assert mock_smart_llm.call_count >= 1, "SmartLLM should be called at least once"
            call_args = _get_last_call_args(mock_smart_llm)
            assert call_args is not None
            assert call_args['gguf_path'] == "/test/path/model.gguf"

    def test_backward_compatibility_no_gguf_path(self):
        """Test backward compatibility: RAGEngine works without gguf_path (None default)."""
        # Mock the SmartLLM to avoid actual LLM instantiation
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm_instance = MagicMock()
            mock_smart_llm.return_value = mock_smart_llm_instance

            # Create engine without gguf_path (should default to None)
            engine = RAGEngine()

            # Verify that SmartLLM was called with gguf_path=None - check LAST call
            assert mock_smart_llm.call_count >= 1, "SmartLLM should be called at least once"
            call_args = _get_last_call_args(mock_smart_llm)
            assert call_args is not None
            assert call_args['gguf_path'] is None

            # Verify that gguf_path is None in the engine
            assert engine.gguf_path is None

    def test_backward_compatibility_explicit_none_gguf_path(self):
        """Test backward compatibility: RAGEngine works with explicit None gguf_path."""
        # Mock the SmartLLM to avoid actual LLM instantiation
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm_instance = MagicMock()
            mock_smart_llm.return_value = mock_smart_llm_instance

            # Create engine with explicit None gguf_path
            engine = RAGEngine(gguf_path=None)

            # Verify that SmartLLM was called with gguf_path=None - check LAST call
            assert mock_smart_llm.call_count >= 1, "SmartLLM should be called at least once"
            call_args = _get_last_call_args(mock_smart_llm)
            assert call_args is not None
            assert call_args['gguf_path'] is None

            # Verify that gguf_path is None in the engine
            assert engine.gguf_path is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
