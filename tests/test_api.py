"""
Tests for API Server Module (Phase 4.6)

These are unit tests that mock the RAG engine. For integration tests
that use the real engine, see tests/integration/test_api_integration.py
"""

import pytest
import os
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock
from fastapi.testclient import TestClient
from fastapi import HTTPException

from api_server import (
    app, engine, validate_url, validate_model_path,
    validate_directory, validate_numeric,
    QuestionRequest, QuestionResponse,
    SearchRequest, SearchResult,
    IngestRequest, IngestResponse,
    StatsResponse
)

# Mark all tests in this module as unit tests
pytestmark = pytest.mark.unit


# Create a test client
client = TestClient(app)


class TestGetRoot:
    """Tests for root endpoint (test_get_root)."""
    
    def test_root_health_check(self):
        """Test root endpoint returns health status with valid indicators."""
        response = client.get("/")

        assert response.status_code == 200
        data = response.json()

        # Verify structure and types of health indicators, not just hardcoded strings
        assert "service" in data
        assert "version" in data
        assert "docs" in data
        assert "auth_status" in data
        assert isinstance(data["service"], str)
        assert isinstance(data["version"], str)
        assert len(data["service"]) > 0


class TestGetStats:
    """Tests for stats endpoint (test_get_stats)."""
    
    def test_get_stats_success(self):
        """Test getting engine statistics."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 5,
                "chunk_count": 20,
                "embedding_model": "BAAI/bge-small-en-v1.5",
                "llm": {"backend": "GGUF"},
                "documents": ["doc1.txt", "doc2.txt"]
            }
            
            response = client.get("/stats")
            
            assert response.status_code == 200
            data = response.json()
            
            assert data["document_count"] == 5
            assert data["chunk_count"] == 20
            assert data["embedding_model"] == "BAAI/bge-small-en-v1.5"
            assert data["llm_backend"] == "GGUF"
            assert "doc1.txt" in data["documents"]
    
    def test_get_stats_engine_not_initialized(self):
        """Test getting stats when engine is not initialized."""
        with patch('api_server.engine', None):
            response = client.get("/stats")
            
            assert response.status_code == 503
            data = response.json()
            assert data["detail"] == "Engine not initialized"


class TestPostAsk:
    """Tests for ask endpoint (test_post_ask)."""
    
    def test_ask_question_success(self):
        """Test asking a question successfully."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="What is Python?",
                answer="Python is a programming language.",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.5,
                chunks_retrieved=2
            )
            
            request = QuestionRequest(question="What is Python?", n_results=3)
            response = client.post("/ask", json=request.model_dump())
            
            assert response.status_code == 200
            data = response.json()
            
            assert data["question"] == "What is Python?"
            assert data["answer"] == "Python is a programming language."
            assert data["sources"] == ["doc1.txt"]
            assert data["context_length"] == 100
            assert data["inference_time"] == 0.5
    
    def test_ask_question_engine_not_initialized(self):
        """Test asking question when engine is not initialized."""
        with patch('api_server.engine', None):
            request = QuestionRequest(question="Test question")
            response = client.post("/ask", json=request.model_dump())
            
            assert response.status_code == 503
            assert response.json()["detail"] == "Engine not initialized"
    
    def test_ask_question_no_llm(self):
        """Test asking question when no LLM backend available."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = None
            mock_engine.query.side_effect = RuntimeError("LLM not initialized")
            
            request = QuestionRequest(question="Test question")
            response = client.post("/ask", json=request.model_dump())
            
            assert response.status_code == 503
            assert response.json()["detail"] == "No LLM backend available"
    
    def test_ask_question_empty_question(self):
        """Test asking with empty question."""
        # Bypass Pydantic model construction to test API-level validation
        response = client.post("/ask", json={"question": "", "n_results": 3})

        # FastAPI validation should catch empty question
        assert response.status_code == 422


class TestPostSearch:
    """Tests for search endpoint (test_post_search)."""
    
    def test_search_documents_success(self):
        """Test searching documents successfully."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.search_documents.return_value = [
                ("Document text content", {"source": "doc1.txt", "chunk_index": 0}, 0.85),
                ("Another document", {"source": "doc2.txt", "chunk_index": 1}, 0.72),
            ]
            
            request = SearchRequest(query="test query", n_results=5)
            response = client.post("/search", json=request.model_dump())
            
            assert response.status_code == 200
            data = response.json()
            
            assert len(data) == 2
            assert data[0]["text"] == "Document text content"
            assert data[0]["source"] == "doc1.txt"
            assert data[0]["similarity"] == 0.85
    
    def test_search_documents_engine_not_initialized(self):
        """Test searching when engine is not initialized."""
        with patch('api_server.engine', None):
            request = SearchRequest(query="test query")
            response = client.post("/search", json=request.model_dump())
            
            assert response.status_code == 503
            assert response.json()["detail"] == "Engine not initialized"


class TestPostIngest:
    """Tests for ingest endpoint (test_post_ingest)."""
    
    def test_ingest_directory_success(self):
        """Test ingesting a directory successfully."""
        with patch('api_server.engine') as mock_engine:
            with patch('api_server.validate_directory') as mock_validate:
                mock_validate.return_value = "./test_documents"
                mock_engine.ingest_directory.return_value = {
                    "success": True,
                    "documents": 3,
                    "chunks_added": 10,
                    "time_seconds": 5.5
                }
                
                request = IngestRequest(directory="./test_documents")
                response = client.post("/ingest", json=request.model_dump())
                
                assert response.status_code == 200
                data = response.json()
                
                assert data["success"] is True
                assert data["documents"] == 3
                assert data["chunks_added"] == 10
    
    def test_ingest_directory_invalid_path(self):
        """Test ingesting with invalid directory path (path traversal)."""
        # Test multiple path traversal patterns
        traversal_patterns = [
            "../etc/passwd",
            "..\\windows\\system32",
            "%2e%2e/etc/passwd",  # URL-encoded traversal
        ]
        
        for pattern in traversal_patterns:
            with patch('api_server.engine') as mock_engine:
                with patch('api_server.validate_directory') as mock_validate:
                    mock_validate.side_effect = ValueError("Directory path contains path traversal attempts")
                    
                    request = IngestRequest(directory=pattern)
                    response = client.post("/ingest", json=request.model_dump())
                    
                    # Verify validation was called
                    mock_validate.assert_called_once()
                    
                    # Verify the response detail mentions path traversal or invalid directory
                    assert response.status_code == 400
                    data = response.json()
                    assert "invalid" in data["detail"].lower() or "path traversal" in data["detail"].lower()
    
    def test_ingest_directory_engine_not_initialized(self):
        """Test ingesting when engine is not initialized."""
        with patch('api_server.engine', None):
            request = IngestRequest(directory="./test")
            response = client.post("/ingest", json=request.model_dump())
            
            assert response.status_code == 503
            assert response.json()["detail"] == "Engine not initialized"


class TestGetDocuments:
    """Tests for documents list endpoint (test_get_documents)."""
    
    def test_get_documents_success(self):
        """Test listing documents successfully."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.get_all_documents.return_value = [
                {"id": "doc1.txt", "chunk_count": 5},
                {"id": "doc2.txt", "chunk_count": 3},
                {"id": "doc3.md", "chunk_count": 8},
            ]

            response = client.get("/documents")

            assert response.status_code == 200
            data = response.json()

            assert "documents" in data
            assert "total" in data
            assert data["total"] == 3
            ids = [d["id"] for d in data["documents"]]
            assert "doc1.txt" in ids
            assert "doc2.txt" in ids
            assert "doc3.md" in ids

    def test_get_documents_empty(self):
        """Test listing documents when none exist."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.get_all_documents.return_value = []

            response = client.get("/documents")

            assert response.status_code == 200
            data = response.json()

            assert data["documents"] == []
            assert data["total"] == 0
    
    def test_get_documents_engine_not_initialized(self):
        """Test listing documents when engine is not initialized."""
        with patch('api_server.engine', None):
            response = client.get("/documents")
            
            assert response.status_code == 503
            assert response.json()["detail"] == "Engine not initialized"


class TestDeleteDocuments:
    """Tests for clear documents endpoint (test_delete_documents)."""
    
    def test_delete_documents_success(self):
        """Test clearing all documents successfully."""
        with patch('api_server.engine') as mock_engine:
            response = client.delete("/documents")
            
            assert response.status_code == 200
            data = response.json()
            
            assert data["status"] == "cleared"
            mock_engine.clear_documents.assert_called_once()
    
    def test_delete_documents_engine_not_initialized(self):
        """Test clearing documents when engine is not initialized."""
        with patch('api_server.engine', None):
            response = client.delete("/documents")
            
            assert response.status_code == 503
            assert response.json()["detail"] == "Engine not initialized"


# Additional validation tests

class TestValidateUrl:
    """Tests for URL validation."""
    
    def test_validate_url_valid(self):
        """Test validating a valid URL."""
        url = "http://localhost:11434"
        # localhost is rejected by the validation
        with pytest.raises(ValueError, match="URL must not point to localhost"):
            validate_url(url)
    
    def test_validate_url_https(self):
        """Test validating HTTPS URL."""
        url = "https://api.example.com"
        with patch('security._resolve_and_validate_host'):
            result = validate_url(url)
        assert result == url
    
    def test_validate_url_no_scheme(self):
        """Test URL without scheme is rejected."""
        url = "localhost:11434"
        
        with pytest.raises(ValueError, match="URL scheme must be http or https"):
            validate_url(url)
    
    def test_validate_url_invalid_scheme(self):
        """Test URL with invalid scheme is rejected."""
        url = "ftp://example.com"
        
        with pytest.raises(ValueError, match="URL scheme must be http or https"):
            validate_url(url)
    
    def test_validate_url_localhost_rejected(self):
        """Test localhost URLs are rejected."""
        url = "http://localhost:8000"
        
        with pytest.raises(ValueError, match="URL must not point to localhost"):
            validate_url(url)


class TestValidateModelPath:
    """Tests for model path validation."""
    
    def test_validate_model_path_valid(self, tmp_path):
        """Test validating a valid model path."""
        # Create a subdirectory and file within it
        subdir = tmp_path / "models"
        subdir.mkdir()
        model_path = subdir / "test_model.gguf"
        model_path.write_text("dummy")
        
        # Use absolute path with explicit base_dir
        result = validate_model_path(str(model_path), base_dir=tmp_path)
        assert "test_model.gguf" in result
    
    def test_validate_model_path_traversal_rejected(self):
        """Test path traversal is rejected."""
        path = "../etc/passwd"
        
        with pytest.raises(ValueError, match="path traversal"):
            validate_model_path(path)
    
    def test_validate_model_path_nonexistent(self, tmp_path):
        """Test non-existent path is rejected."""
        path = str(tmp_path / "nonexistent" / "model.gguf")
        
        with pytest.raises(ValueError, match="does not exist"):
            validate_model_path(path, base_dir=tmp_path)


class TestValidateDirectory:
    """Tests for directory validation."""
    
    def test_validate_directory_valid(self, tmp_path):
        """Test validating a valid directory."""
        # Create a subdirectory
        subdir = tmp_path / "test_dir"
        subdir.mkdir()
        
        result = validate_directory(str(subdir), base_dir=tmp_path)
        assert "test_dir" in result
    
    def test_validate_directory_traversal_rejected(self):
        """Test path traversal in directory is rejected."""
        path = "../etc"
        
        with pytest.raises(ValueError, match="path traversal"):
            validate_directory(path)


class TestValidateNumeric:
    """Tests for numeric validation."""
    
    def test_validate_numeric_valid(self):
        """Test validating a valid numeric value."""
        result = validate_numeric(5, 1, 10, "test_param")
        assert result == 5
    
    def test_validate_numeric_below_min(self):
        """Test value below minimum is rejected."""
        with pytest.raises(ValueError, match="must be between"):
            validate_numeric(0, 1, 10, "test_param")
    
    def test_validate_numeric_above_max(self):
        """Test value above maximum is rejected."""
        with pytest.raises(ValueError, match="must be between"):
            validate_numeric(15, 1, 10, "test_param")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
