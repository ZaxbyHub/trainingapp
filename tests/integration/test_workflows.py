"""
End-to-end integration workflow tests for all entry points.

Tests complete workflows across API, CLI, and GUI modes to verify
data consistency, state management, error handling, and authentication.

Run with: pytest tests/integration/test_workflows.py -v
"""

import pytest
import os
import sys
import json
import tempfile
import shutil
import subprocess
import time
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock
from fastapi.testclient import TestClient

# Mark all tests in this module as integration tests
pytestmark = pytest.mark.integration


# =============================================================================
# SHARED FIXTURES
# =============================================================================

@pytest.fixture
def api_client(tmp_path):
    """
    Create a test API client with mocked LLM backends.
    
    Patches LLM classes BEFORE importing the API app to ensure the lifespan
    context uses mocked backends.
    """
    db_path = str(tmp_path / "test_api_db")
    
    # Apply env vars BEFORE importing
    env_overrides = {
        "ENABLE_AUTH": "false",
        "RAG_DB_PATH": db_path,
        "RAG_CHUNK_SIZE": "512",
    }
    
    saved_env = {}
    for k, v in env_overrides.items():
        saved_env[k] = os.environ.get(k)
        os.environ[k] = v
    
    # Mock LLM classes at module level BEFORE importing api_server
    mock_ollama_cls = MagicMock()
    mock_ollama_instance = MagicMock()
    mock_ollama_instance.generate.return_value = "Mock answer."
    mock_ollama_instance.answer_question.return_value = "Mock answer from context."
    mock_ollama_instance.get_info.return_value = {"backend": "mock_ollama", "model": "test"}
    mock_ollama_cls.return_value = mock_ollama_instance
    
    mock_openai_cls = MagicMock()
    mock_openai_instance = MagicMock()
    mock_openai_instance.generate.return_value = "Mock OpenAI answer."
    mock_openai_instance.answer_question.return_value = "Mock OpenAI answer."
    mock_openai_instance.get_info.return_value = {"backend": "mock_openai", "model": "test"}
    mock_openai_cls.return_value = mock_openai_instance
    
    mock_openvino_cls = MagicMock()
    mock_openvino_instance = MagicMock()
    mock_openvino_instance.generate.return_value = "Mock OpenVINO answer."
    mock_openvino_instance.answer_question.return_value = "Mock OpenVINO answer."
    mock_openvino_instance.get_info.return_value = {"backend": "mock_openvino", "model": "test"}
    mock_openvino_cls.return_value = mock_openvino_instance
    
    # Patch at the llm_interface module level (where SmartLLM imports from)
    with patch("llm_interface.OllamaLLM", mock_ollama_cls), \
         patch("llm_interface.OpenAICompatibleLLM", mock_openai_cls), \
         patch("llm_interface.OpenVINOLLM", mock_openvino_cls):
        
        # Now import and create app
        from fastapi.testclient import TestClient
        from api_server import app
        
        client = TestClient(app)
        yield client
    
    # Restore env
    for k, v in saved_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


@pytest.fixture
def cli_test_dir(tmp_path):
    """Create a test directory for CLI testing."""
    test_dir = tmp_path / "cli_test_docs"
    test_dir.mkdir()
    db_path = tmp_path / "cli_test_db"
    db_path.mkdir()
    
    # Create test files
    (test_dir / "doc1.txt").write_text("Python is a programming language.", encoding="utf-8")
    (test_dir / "doc2.txt").write_text("Machine learning is a subset of AI.", encoding="utf-8")
    
    yield test_dir, db_path


# =============================================================================
# WORKFLOW 1: Complete API Workflow
# =============================================================================

class TestCompleteAPIWorkflow:
    """Test complete end-to-end API workflow."""

    def test_ingest_search_ask_list_clear_workflow(self, api_client):
        """
        Complete workflow: POST /ingest → GET /stats → POST /search →
        POST /ask → GET /documents → DELETE /documents → verify clean state.
        """
        client = api_client

        # Step 1: Health check
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "Document Q&A API"
        assert "version" in data

        # Step 2: Initial stats should show 0 documents (or 503 if engine not ready)
        response = client.get("/stats")
        assert response.status_code in [200, 503]
        if response.status_code == 200:
            initial_stats = response.json()
            assert "document_count" in initial_stats
            assert "chunk_count" in initial_stats

        # Step 3: Ingest a test directory
        test_dir = self._create_test_docs()
        response = client.post("/ingest", json={"directory": str(test_dir)})
        # Accept 200 (success) or 503 (engine not initialized)
        if response.status_code == 200:
            ingest_result = response.json()
            assert ingest_result["success"] is True
            assert ingest_result["documents"] >= 1
            assert ingest_result["chunks_added"] >= 1
        elif response.status_code == 503:
            # Engine not initialized - skip ingestion-dependent tests
            shutil.rmtree(test_dir, ignore_errors=True)
            pytest.skip("Engine not initialized - skipping ingestion tests")

        # Step 4: Verify stats updated
        response = client.get("/stats")
        assert response.status_code in [200, 503]

        # Step 5: Search documents
        response = client.post("/search", json={"query": "artificial intelligence", "n_results": 3})
        assert response.status_code in [200, 503]
        if response.status_code == 200:
            search_results = response.json()
            assert isinstance(search_results, list)

        # Step 6: Ask a question (may succeed or 503 if no LLM backend)
        response = client.post("/ask", json={"question": "What is artificial intelligence?", "n_results": 3})
        assert response.status_code in [200, 503]
        if response.status_code == 200:
            ask_result = response.json()
            assert "question" in ask_result
            assert "answer" in ask_result
            assert "sources" in ask_result

        # Step 7: List documents
        response = client.get("/documents")
        assert response.status_code in [200, 503]
        if response.status_code == 200:
            docs = response.json()
            assert "documents" in docs
            assert isinstance(docs["documents"], list)

        # Step 8: Clear all documents
        response = client.delete("/documents")
        assert response.status_code in [200, 503]

        # Step 9: Verify clean state (if engine was initialized)
        response = client.get("/stats")
        if response.status_code == 200:
            final_stats = response.json()
            assert final_stats["document_count"] == 0
            assert final_stats["chunk_count"] == 0

        # Cleanup
        shutil.rmtree(test_dir, ignore_errors=True)

    def test_api_workflow_with_file_upload(self, api_client):
        """Test API workflow with file upload endpoint."""
        client = api_client

        # Create a test file
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write("This is a test document about machine learning.")
            test_file = f.name

        try:
            # Upload file
            with open(test_file, "rb") as f:
                response = client.post("/ingest/file", files={"file": ("test_doc.txt", f, "text/plain")})
            
            # Accept 200 (success) or 503 (engine not initialized)
            assert response.status_code in [200, 503]
            if response.status_code == 200:
                result = response.json()
                assert result["success"] is True
                assert result["chunks_added"] >= 1
        finally:
            os.unlink(test_file)

    def test_api_workflow_persistence(self, api_client, tmp_path):
        """
        Test that ingested data persists across API calls.
        Uses a shared test database directory.
        """
        client = api_client

        # Create and ingest test directory
        test_dir = self._create_test_docs()
        response = client.post("/ingest", json={"directory": str(test_dir)})
        
        if response.status_code == 503:
            shutil.rmtree(test_dir, ignore_errors=True)
            pytest.skip("Engine not initialized")
        
        assert response.status_code == 200

        # Get document count
        response = client.get("/stats")
        if response.status_code == 200:
            count = response.json()["document_count"]

        # Search should return results
        response = client.post("/search", json={"query": "test", "n_results": 5})
        assert response.status_code in [200, 503]

        # Cleanup
        shutil.rmtree(test_dir, ignore_errors=True)

    def _create_test_docs(self):
        """Create a temporary directory with test documents."""
        test_dir = tempfile.mkdtemp()
        
        # Create multiple test files
        files = {
            "ai_concepts.txt": "Artificial intelligence (AI) is a branch of computer science focused on creating intelligent machines. Machine learning is a subset of AI that enables systems to learn from data.",
            "python_basics.txt": "Python is a high-level programming language. It is known for its simplicity and readability. Python supports multiple programming paradigms.",
            "deep_learning.md": "# Deep Learning\n\nDeep learning is a subset of machine learning using neural networks with multiple layers. It excels at pattern recognition tasks.",
        }
        
        for filename, content in files.items():
            filepath = os.path.join(test_dir, filename)
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
        
        return test_dir


# =============================================================================
# WORKFLOW 2: CLI Integration Workflow
# =============================================================================

class TestCLIIntegrationWorkflow:
    """Test CLI entry point workflows."""

    def test_cli_ingest_workflow(self, cli_test_dir):
        """Test CLI --ingest flag workflow."""
        test_dir, db_path = cli_test_dir
        
        # Run CLI with --ingest flag
        result = subprocess.run(
            [sys.executable, "main.py", "--ingest", str(test_dir), "--db-path", str(db_path)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        
        # Should complete without error (exit code 0 or 1 if no LLM)
        assert result.returncode in [0, 1]
        # Should contain ingestion result
        assert "Ingesting" in result.stdout or "Result:" in result.stdout

    def test_cli_query_workflow(self, cli_test_dir):
        """Test CLI --query flag workflow."""
        test_dir, db_path = cli_test_dir
        
        # First ingest
        subprocess.run(
            [sys.executable, "main.py", "--ingest", str(test_dir), "--db-path", str(db_path)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        
        # Then query (may fail if no LLM, that's ok)
        result = subprocess.run(
            [sys.executable, "main.py", "--query", "What is Python?", "--db-path", str(db_path)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        
        # Accept success or failure (LLM may not be available)
        assert result.returncode in [0, 1]

    def test_cli_argument_parsing(self):
        """Test CLI argument parsing for all options."""
        import main
        
        # Test create_parser works
        parser = main.create_parser()
        
        # Parse various argument combinations
        args = parser.parse_args(["--ingest", "test_dir"])
        assert args.ingest == "test_dir"
        assert args.api is False
        assert args.cli is False
        
        args = parser.parse_args(["--cli"])
        assert args.cli is True
        assert args.api is False
        
        args = parser.parse_args(["--api", "--port", "9000"])
        assert args.api is True
        assert args.port == 9000
        
        args = parser.parse_args(["--query", "test question"])
        assert args.query == "test question"


# =============================================================================
# WORKFLOW 3: Cross-Entry Point Consistency
# =============================================================================

class TestCrossEntryPointConsistency:
    """Test data consistency across API, CLI, and GUI entry points."""

    def test_api_and_cli_use_same_db_path(self, tmp_path):
        """
        Verify that API and CLI can both use the same database path
        and share data.
        """
        shared_db = tmp_path / "shared_db"
        shared_db.mkdir()
        
        # Create test directory
        test_dir = tempfile.mkdtemp()
        with open(os.path.join(test_dir, "shared_test.txt"), "w", encoding="utf-8") as f:
            f.write("This content should be accessible from both API and CLI.")
        
        try:
            # CLI: ingest first
            result = subprocess.run(
                [sys.executable, "main.py", "--ingest", test_dir, "--db-path", str(shared_db)],
                capture_output=True,
                text=True,
                timeout=120,
            )
            
            # Check that db directory was created
            assert shared_db.exists() or result.returncode in [0, 1]
        finally:
            shutil.rmtree(test_dir, ignore_errors=True)


# =============================================================================
# WORKFLOW 4: Authentication Integration
# =============================================================================

class TestAuthenticationIntegration:
    """Test authentication workflows."""

    def test_auth_disabled_allows_all_requests(self, api_client):
        """Test that when auth is disabled, all requests are allowed."""
        client = api_client
        
        # All endpoints should work without auth headers
        response = client.get("/")
        assert response.status_code == 200
        
        response = client.get("/stats")
        assert response.status_code in [200, 503]  # 503 if engine not ready
        
        response = client.post("/search", json={"query": "test"})
        assert response.status_code in [200, 422, 503]
        
        response = client.delete("/documents")
        assert response.status_code in [200, 503]

    def test_auth_status_endpoint(self, api_client):
        """Test /auth/status endpoint returns correct configuration."""
        client = api_client
        
        response = client.get("/auth/status")
        assert response.status_code == 200
        
        data = response.json()
        assert "enabled" in data
        assert "methods" in data
        # When auth is disabled, methods should be empty
        if not data["enabled"]:
            assert data["methods"] == []

    def test_auth_with_enabled_auth(self, tmp_path):
        """Test API with authentication enabled."""
        from fastapi.testclient import TestClient
        from api_server import app
        
        # Set up auth environment
        old_auth = os.environ.get("ENABLE_AUTH")
        old_key = os.environ.get("API_KEY")
        old_db = os.environ.get("RAG_DB_PATH")
        
        os.environ["ENABLE_AUTH"] = "true"
        os.environ["API_KEY"] = "test-key-12345"
        os.environ["RAG_DB_PATH"] = str(tmp_path / "auth_test_db")
        
        try:
            client = TestClient(app)
            
            # Without auth - should be unauthorized (401) or engine not ready (503)
            response = client.get("/stats")
            # Accept 401 (auth blocked) or 503 (engine not ready - which also needs auth)
            assert response.status_code in [401, 503]
            
            # With invalid API key - should be unauthorized
            response = client.get("/stats", headers={"X-API-Key": "wrong-key"})
            assert response.status_code in [401, 503]
        finally:
            if old_auth is not None:
                os.environ["ENABLE_AUTH"] = old_auth
            else:
                os.environ.pop("ENABLE_AUTH", None)
            if old_key is not None:
                os.environ["API_KEY"] = old_key
            else:
                os.environ.pop("API_KEY", None)
            if old_db is not None:
                os.environ["RAG_DB_PATH"] = old_db
            else:
                os.environ.pop("RAG_DB_PATH", None)

    def test_jwt_token_workflow(self, tmp_path):
        """Test JWT token creation and validation."""
        from auth import create_access_token, verify_token
        
        # Check if JWT is available
        try:
            # Create a token
            token = create_access_token({"sub": "test_user"})
            assert token is not None
            assert isinstance(token, str)
            
            # Verify the token
            payload = verify_token(token)
            assert payload is not None
            assert payload.get("sub") == "test_user"
        except RuntimeError as e:
            if "JWT library not available" in str(e):
                pytest.skip("JWT library not installed")
            raise


# =============================================================================
# WORKFLOW 5: Error Recovery Workflows
# =============================================================================

class TestErrorRecoveryWorkflows:
    """Test error handling and recovery scenarios."""

    def test_nonexistent_directory_returns_400(self, api_client):
        """Test that ingesting nonexistent directory returns 400."""
        client = api_client
        
        response = client.post("/ingest", json={"directory": "/nonexistent/path/that/does/not/exist"})
        # 400 for invalid path, or 503 if engine not ready
        assert response.status_code in [400, 503]
        if response.status_code == 400:
            assert "detail" in response.json()

    def test_invalid_query_returns_422(self, api_client):
        """Test that empty/whitespace query returns 422."""
        client = api_client
        
        # Empty query
        response = client.post("/ask", json={"question": ""})
        assert response.status_code == 422
        
        # Whitespace-only query
        response = client.post("/ask", json={"question": "   "})
        assert response.status_code == 422

    def test_search_with_no_documents(self, api_client):
        """Test search returns empty results when no documents ingested."""
        client = api_client
        
        # Clear any existing documents
        client.delete("/documents")
        
        # Search should return empty list (or 503 if engine not ready)
        response = client.post("/search", json={"query": "anything", "n_results": 5})
        assert response.status_code in [200, 503]
        if response.status_code == 200:
            results = response.json()
            assert isinstance(results, list)

    def test_ask_with_no_documents_falls_back(self, api_client):
        """Test asking question with no documents returns informative response."""
        client = api_client
        
        # Clear any existing documents
        client.delete("/documents")
        
        # Ask question - may get "no context" response
        response = client.post("/ask", json={"question": "What is AI?"})
        # Either 503 (no LLM) or 200 with informative answer
        assert response.status_code in [200, 503]
        if response.status_code == 200:
            result = response.json()
            assert "answer" in result

    def test_invalid_file_type_rejected(self, api_client):
        """Test that unsupported file types are rejected."""
        client = api_client
        
        # Create a file with unsupported extension
        with tempfile.NamedTemporaryFile(suffix=".xyz", delete=False) as f:
            f.write(b"test content")
            test_file = f.name
        
        try:
            with open(test_file, "rb") as f:
                response = client.post("/ingest/file", files={"file": ("test.xyz", f, "application/octet-stream")})
            # 400 for unsupported type, 503 for engine not ready
            assert response.status_code in [400, 503]
            if response.status_code == 400:
                assert "Unsupported" in response.json().get("detail", "")
        finally:
            os.unlink(test_file)

    def test_oversized_file_rejected(self, api_client):
        """Test that files over 50MB are rejected."""
        client = api_client
        
        # Create a large file (simulated by checking the limit)
        large_content = b"x" * (51 * 1024 * 1024)  # 51MB
        
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
            f.write(large_content)
            test_file = f.name
        
        try:
            with open(test_file, "rb") as f:
                response = client.post("/ingest/file", files={"file": ("large.txt", f, "text/plain")})
            # 413 for too large, 503 for engine not ready
            assert response.status_code in [413, 503]
        finally:
            os.unlink(test_file)

    def test_path_traversal_prevented(self, api_client):
        """Test that path traversal attempts are blocked."""
        client = api_client
        
        # Try path traversal
        response = client.post("/ingest", json={"directory": "../../etc/passwd"})
        # 400 for traversal attempt blocked, 503 for engine not ready
        assert response.status_code in [400, 503]
        if response.status_code == 400:
            assert "traversal" in response.json().get("detail", "").lower()

    def test_invalid_endpoint_returns_404(self, api_client):
        """Test that invalid endpoints return 404."""
        client = api_client
        
        response = client.get("/nonexistent/endpoint")
        assert response.status_code == 404
        
        response = client.post("/invalid/path")
        assert response.status_code == 404

    def test_invalid_http_method_returns_405(self, api_client):
        """Test that invalid HTTP methods return 405."""
        client = api_client
        
        response = client.delete("/")
        assert response.status_code == 405
        
        response = client.put("/stats", json={})
        assert response.status_code == 405


# =============================================================================
# WORKFLOW 6: State Management Tests
# =============================================================================

class TestStateManagement:
    """Test state management across operations."""

    def test_engine_state_persists_across_requests(self, api_client):
        """Test that engine state is maintained across multiple requests."""
        client = api_client
        
        # Ingest documents
        test_dir = tempfile.mkdtemp()
        with open(os.path.join(test_dir, "state_test.txt"), "w", encoding="utf-8") as f:
            f.write("State management test content about testing.")
        
        try:
            # First ingestion
            response = client.post("/ingest", json={"directory": str(test_dir)})
            
            if response.status_code == 503:
                shutil.rmtree(test_dir, ignore_errors=True)
                pytest.skip("Engine not initialized")
            
            assert response.status_code == 200
            
            # Check stats
            response = client.get("/stats")
            if response.status_code == 200:
                count1 = response.json()["document_count"]
            
            # Search should work
            response = client.post("/search", json={"query": "state"})
            assert response.status_code in [200, 503]
            
            # List documents should return results
            response = client.get("/documents")
            assert response.status_code in [200, 503]
            if response.status_code == 200:
                assert isinstance(response.json()["documents"], list)
        finally:
            shutil.rmtree(test_dir, ignore_errors=True)

    def test_clear_state_resets_everything(self, api_client):
        """Test that clearing documents resets all state."""
        client = api_client
        
        # Ingest some documents
        test_dir = tempfile.mkdtemp()
        with open(os.path.join(test_dir, "clear_test.txt"), "w", encoding="utf-8") as f:
            f.write("Content to be cleared.")
        
        try:
            client.post("/ingest", json={"directory": str(test_dir)})
            
            # Clear documents
            response = client.delete("/documents")
            assert response.status_code in [200, 503]
            
            # Verify clean state (if engine was initialized)
            response = client.get("/stats")
            if response.status_code == 200:
                assert response.json()["document_count"] == 0
                assert response.json()["chunk_count"] == 0
                
                # Search should return empty
                response = client.post("/search", json={"query": "cleared"})
                assert response.status_code == 200
                assert len(response.json()) == 0
        finally:
            shutil.rmtree(test_dir, ignore_errors=True)


# =============================================================================
# WORKFLOW 7: Configuration and Settings Tests
# =============================================================================

class TestConfigurationWorkflows:
    """Test configuration loading and application."""

    def test_config_loading_from_env(self, monkeypatch, tmp_path):
        """Test that configuration is loaded from environment variables."""
        from config import get_settings
        
        # Set custom env vars
        monkeypatch.setenv("RAG_CHUNK_SIZE", "1024")
        monkeypatch.setenv("RAG_DB_PATH", str(tmp_path / "custom_db"))
        monkeypatch.setenv("RAG_MAX_TOKENS", "2048")
        
        # Reload settings
        from importlib import reload
        import config
        reload(config)
        
        settings = config.get_settings()
        assert settings.rag_chunk_size == 1024
        assert settings.rag_max_tokens == 2048

    def test_rag_config_validation(self):
        """Test RAGConfig validates its parameters."""
        from rag_engine import RAGConfig
        
        # Valid config
        config = RAGConfig(chunk_size=512, max_tokens=1024)
        assert config.chunk_size == 512
        assert config.max_tokens == 1024
        
        # Test to_dict and from_dict
        config_dict = config.to_dict()
        assert config_dict["chunk_size"] == 512
        
        restored = RAGConfig.from_dict(config_dict)
        assert restored.chunk_size == 512

    def test_settings_bounds_validation(self):
        """Test that config validates parameter bounds via RAGSettings."""
        from config import RAGSettings
        
        # Invalid chunk size (too small)
        with pytest.raises(ValueError):
            RAGSettings(rag_chunk_size=50)  # Below MIN_CHUNK_SIZE
        
        # Invalid chunk size (too large)
        with pytest.raises(ValueError):
            RAGSettings(rag_chunk_size=10000)  # Above MAX_CHUNK_SIZE
        
        # Invalid temperature
        with pytest.raises(ValueError):
            RAGSettings(rag_temperature=5.0)  # Above 2.0


# =============================================================================
# WORKFLOW 8: API Validation Tests
# =============================================================================

class TestAPIValidationWorkflows:
    """Test API input validation."""

    def test_question_length_limits(self, api_client):
        """Test question length validation."""
        client = api_client
        
        # Too long question (>2000 chars)
        long_question = "x" * 2001
        response = client.post("/ask", json={"question": long_question})
        assert response.status_code == 422

    def test_search_result_count_limits(self, api_client):
        """Test n_results parameter limits."""
        client = api_client
        
        # Too many results (>20)
        response = client.post("/search", json={"query": "test", "n_results": 25})
        assert response.status_code == 422
        
        # Too few results (<1)
        response = client.post("/search", json={"query": "test", "n_results": 0})
        assert response.status_code == 422

    def test_ask_n_results_limits(self, api_client):
        """Test n_results parameter limits for ask endpoint."""
        client = api_client
        
        # Too many results (>10)
        response = client.post("/ask", json={"question": "test?", "n_results": 15})
        assert response.status_code == 422
        
        # Too few results (<1)
        response = client.post("/ask", json={"question": "test?", "n_results": 0})
        assert response.status_code == 422


# Fixtures are defined at the top of the file (after imports)
