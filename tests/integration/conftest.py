"""
Configuration for integration tests.

Provides shared fixtures and configuration for integration testing.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock


@pytest.fixture
def mock_llm_backends():
    """
    Mock LLM backends to prevent real HTTP calls during tests.
    
    This patches the LLM classes in llm_interface to return mock responses
    instead of making real HTTP requests.
    """
    with patch('llm_interface.OllamaLLM') as mock_ollama, \
         patch('llm_interface.OpenAICompatibleLLM') as mock_openai, \
         patch('llm_interface.OpenVINOLLM') as mock_openvino:
        
        # Configure mock Ollama
        mock_ollama_instance = MagicMock()
        mock_ollama_instance.generate.return_value = "This is a mock answer from Ollama."
        mock_ollama.return_value = mock_ollama_instance
        
        # Configure mock OpenAI-compatible
        mock_openai_instance = MagicMock()
        mock_openai_instance.generate.return_value = "This is a mock answer from OpenAI-compatible API."
        mock_openai.return_value = mock_openai_instance
        
        # Configure mock OpenVINO
        mock_openvino_instance = MagicMock()
        mock_openvino_instance.generate.return_value = "This is a mock answer from OpenVINO."
        mock_openvino.return_value = mock_openvino_instance
        
        yield {
            'ollama': mock_ollama,
            'openai': mock_openai,
            'openvino': mock_openvino,
            'ollama_instance': mock_ollama_instance,
            'openai_instance': mock_openai_instance,
            'openvino_instance': mock_openvino_instance,
        }


@pytest.fixture
def test_client(mock_llm_backends):
    """Create a test client with mocked LLM backends."""
    import os
    from fastapi.testclient import TestClient
    
    # Disable authentication for tests
    os.environ["ENABLE_AUTH"] = "false"
    
    # Import after setting env vars
    from api_server import app
    
    # Create test client
    client = TestClient(app)
    
    return client


@pytest.fixture
def test_client_with_auth():
    """Create a test client with authentication enabled."""
    import os
    from fastapi.testclient import TestClient
    
    # Enable authentication for tests
    os.environ["ENABLE_AUTH"] = "true"
    os.environ["API_KEY"] = "test-api-key-12345"
    
    # Import after setting env vars
    from api_server import app
    
    # Create test client
    client = TestClient(app)
    
    return client
