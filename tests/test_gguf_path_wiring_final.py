import os
import tempfile
from unittest.mock import patch, MagicMock
import pytest

# Import the modules to test
from rag_engine import RAGEngine, create_engine_from_env
from llm_interface import SmartLLM


class TestGGUFPathWiring:
    """Tests for GGUF path wiring functionality."""
    
    def test_rag_engine_accepts_gguf_path_parameter(self):
        """Test that RAGEngine accepts gguf_path parameter without error."""
        # Mock the SmartLLM to avoid actual LLM instantiation
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm_instance = MagicMock()
            mock_smart_llm.return_value = mock_smart_llm_instance
            
            # This should not raise any exception
            engine = RAGEngine(gguf_path="/path/to/model.gguf")
            
            # Verify that SmartLLM was called with gguf_path
            mock_smart_llm.assert_called_once()
            call_args = mock_smart_llm.call_args
            assert call_args[1]['gguf_path'] == "/path/to/model.gguf"
    
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
                mock_smart_llm.assert_called_once()
                call_args = mock_smart_llm.call_args
                assert call_args[1]['gguf_path'] == "/env/path/to/model.gguf"
    
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
            
            # Verify that SmartLLM was called with gguf_path
            mock_smart_llm.assert_called_once()
            call_args = mock_smart_llm.call_args
            assert call_args[1]['gguf_path'] == "/test/path/model.gguf"
    
    def test_backward_compatibility_no_gguf_path(self):
        """Test backward compatibility: RAGEngine works without gguf_path (None default)."""
        # Mock the SmartLLM to avoid actual LLM instantiation
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm_instance = MagicMock()
            mock_smart_llm.return_value = mock_smart_llm_instance
            
            # Create engine without gguf_path (should default to None)
            engine = RAGEngine()
            
            # Verify that SmartLLM was called with gguf_path=None
            mock_smart_llm.assert_called_once()
            call_args = mock_smart_llm.call_args
            assert call_args[1]['gguf_path'] is None
            
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
            
            # Verify that SmartLLM was called with gguf_path=None
            mock_smart_llm.assert_called_once()
            call_args = mock_smart_llm.call_args
            assert call_args[1]['gguf_path'] is None
            
            # Verify that gguf_path is None in the engine
            assert engine.gguf_path is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])