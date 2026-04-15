"""
Configuration for integration tests.

Provides shared fixtures and configuration for integration testing.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock


@pytest.fixture
def mock_llm_backend():
    """
    Mock GGUFBackend to prevent real model loading during tests.
    """
    with patch('llm_interface.GGUFBackend') as mock_gguf:
        mock_gguf_instance = MagicMock()
        mock_gguf_instance.generate.return_value = "This is a mock answer."
        mock_gguf_instance.chat_complete.return_value = "This is a mock chat answer."
        mock_gguf_instance.get_info.return_value = {"backend": "gguf", "model": "mock-model.gguf"}
        mock_gguf.return_value = mock_gguf_instance
        
        yield {
            'gguf': mock_gguf,
            'instance': mock_gguf_instance,
        }


@pytest.fixture
def test_client(mock_llm_backend):
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
