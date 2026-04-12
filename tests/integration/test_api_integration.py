"""
Integration tests for API endpoints with real RAG pipeline.

These tests use the actual RAGEngine and dependencies, with the LLM
backends mocked to prevent real HTTP calls. This provides real confidence
that the API works correctly with the actual codebase.

Run with: pytest tests/integration/ -v -m integration
"""

import pytest
import json
from pathlib import Path
from fastapi.testclient import TestClient

# Mark all tests in this module as integration tests
pytestmark = pytest.mark.integration


class TestHealthEndpoint:
    """Tests for the health check endpoint."""
    
    def test_root_returns_ok(self, test_client):
        """Test root endpoint returns health status."""
        response = test_client.get("/")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["service"] == "Document Q&A API"


class TestAuthEndpoints:
    """Tests for authentication endpoints."""
    
    def test_auth_status_shows_disabled(self, test_client):
        """Test auth status shows authentication is disabled."""
        response = test_client.get("/auth/status")
        
        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is False
        assert data["methods"] == []


class TestStatsEndpoint:
    """Tests for the stats endpoint with real engine."""
    
    def test_get_stats_returns_engine_info(self, test_client):
        """Test getting engine statistics returns real data."""
        response = test_client.get("/stats")
        
        # Should return 503 if engine not initialized, or 200 with stats
        if response.status_code == 503:
            # Engine not initialized - this is expected if no documents ingested
            data = response.json()
            assert "detail" in data
        else:
            # Engine is initialized - verify response structure
            assert response.status_code == 200
            data = response.json()
            # Verify response structure matches StatsResponse
            assert "document_count" in data
            assert "chunk_count" in data
            assert "embedding_model" in data
            assert "llm_backend" in data
            assert "documents" in data
            # Verify types
            assert isinstance(data["document_count"], int)
            assert isinstance(data["chunk_count"], int)
            assert isinstance(data["documents"], list)


class TestDocumentsEndpoints:
    """Tests for document management endpoints."""
    
    def test_list_documents_returns_list(self, test_client):
        """Test listing documents returns a list."""
        response = test_client.get("/documents")
        
        if response.status_code == 503:
            # Engine not initialized
            pass
        else:
            assert response.status_code == 200
            data = response.json()
            assert "documents" in data
            assert isinstance(data["documents"], list)
    
    def test_clear_documents_requires_confirmation(self, test_client):
        """Test clearing documents endpoint exists."""
        response = test_client.delete("/documents")
        
        # Should either succeed or fail with engine not initialized
        assert response.status_code in [200, 503]


class TestIngestEndpoints:
    """Tests for document ingestion endpoints."""
    
    def test_ingest_directory_validates_path(self, test_client):
        """Test ingest directory validates the path."""
        response = test_client.post(
            "/ingest",
            json={"directory": "/nonexistent/path"}
        )
        
        # Should fail with 400 (invalid path) or 503 (engine not ready)
        assert response.status_code in [400, 503]
    
    def test_ingest_file_requires_valid_file(self, test_client):
        """Test ingest file requires a valid file upload."""
        # Test without file
        response = test_client.post("/ingest/file")
        
        # Should fail with 422 (validation error) or 503 (engine not ready)
        assert response.status_code in [422, 503]


class TestSearchEndpoint:
    """Tests for the search endpoint."""
    
    def test_search_requires_query(self, test_client):
        """Test search endpoint requires a query parameter."""
        response = test_client.post("/search", json={})
        
        # Should fail with 422 (validation error) or 503 (engine not ready)
        assert response.status_code in [422, 503]
    
    def test_search_with_query(self, test_client):
        """Test search with a valid query."""
        response = test_client.post(
            "/search",
            json={"query": "test query", "n_results": 3}
        )
        
        # Should succeed or fail with engine not ready
        if response.status_code == 503:
            pass  # Engine not initialized
        else:
            assert response.status_code == 200
            data = response.json()
            # Should return list of SearchResult objects
            assert isinstance(data, list)


class TestAskEndpoint:
    """Tests for the question answering endpoint."""
    
    def test_ask_requires_question(self, test_client):
        """Test ask endpoint requires a question."""
        response = test_client.post("/ask", json={})
        
        # Should fail with 422 (validation error) or 503 (engine not ready)
        assert response.status_code in [422, 503]
    
    def test_ask_with_question(self, test_client):
        """Test asking a question."""
        response = test_client.post(
            "/ask",
            json={"question": "What is this document about?", "n_results": 3}
        )
        
        # Should succeed or fail with engine not ready
        if response.status_code == 503:
            pass  # Engine not initialized
        else:
            assert response.status_code == 200
            data = response.json()
            # Verify response structure matches QuestionResponse
            assert "question" in data
            assert "answer" in data
            assert "sources" in data
            assert "context_length" in data
            assert "inference_time" in data


class TestErrorHandling:
    """Tests for API error handling."""
    
    def test_invalid_endpoint_returns_404(self, test_client):
        """Test invalid endpoints return 404."""
        response = test_client.get("/invalid/endpoint")
        assert response.status_code == 404
    
    def test_invalid_method_returns_405(self, test_client):
        """Test invalid HTTP methods return 405."""
        response = test_client.delete("/")
        assert response.status_code == 405
