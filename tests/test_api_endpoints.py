"""
Tests for new API endpoints (SSE streaming, batch upload, settings CRUD).

These are unit tests that mock the RAG engine. Tests SSE streaming,
batch file upload, and settings endpoints.

Run with: pytest test_api_endpoints.py -v
"""

import json
import sys
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

# Pre-register optional C-extension dependencies so tests work regardless of collection order


sys.modules.setdefault("llama_cpp", MagicMock())

# Pre-mock jose if the cryptography backend is broken
try:
    import jose.jwt as _jwt_check  # noqa: F401
except BaseException:
    for _k in list(sys.modules.keys()):
        if _k.startswith("jose"):
            del sys.modules[_k]
    _jose_mock = MagicMock()
    _jose_mock.JWTError = Exception
    _jose_mock.jwt = MagicMock()
    for _name in [
        "jose",
        "jose.jwt",
        "jose.jws",
        "jose.jwk",
        "jose.backends",
        "jose.backends.base",
        "jose.backends.cryptography_backend",
    ]:
        sys.modules[_name] = _jose_mock

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api_server import app, sanitize_filename  # noqa: E402

# Mark all tests in this module as unit tests
pytestmark = pytest.mark.unit


# Create a test client
client = TestClient(app)


# ---------------------------------------------------------------------------
# Shared test fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def bypass_auth():
    """Bypass authentication for tests that don't test auth itself."""
    from auth import authenticate

    app.dependency_overrides[authenticate] = lambda: {
        "authenticated": True,
        "method": "test",
    }
    yield
    if authenticate in app.dependency_overrides:
        del app.dependency_overrides[authenticate]


def _make_mock_settings(**overrides):
    """Create a mock settings object with all required RAG settings fields."""
    defaults = {
        "rag_chunk_size": 512,
        "rag_chunk_overlap": 100,
        "rag_n_results": 4,
        "rag_min_similarity": 0.3,
        "rag_temperature": 0.3,
        "rag_max_tokens": 512,
        "rag_hybrid_search": True,
        "rag_reranking_enabled": False,
        "rag_context_truncation": 20000,
        "rag_retrieval_window": 1,
        "rag_initial_retrieval_top_k": 12,
        "rag_rerank_top_k": 4,
    }
    defaults.update(overrides)
    mock = MagicMock()
    for key, value in defaults.items():
        setattr(mock, key, value)
    return mock


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSanitizeFilename:
    """Tests for sanitize_filename utility function."""

    def test_sanitize_filename_valid(self):
        """Test sanitizing a valid filename."""
        safe, display = sanitize_filename("document.pdf")
        assert safe == "document.pdf"
        assert display == "document.pdf"

    def test_sanitize_filename_with_path_separators(self):
        """Test sanitizing filename with path separators."""
        safe, display = sanitize_filename("../../../etc/passwd")
        assert ".." not in safe
        assert safe != "../../../etc/passwd"

    def test_sanitize_filename_windows_reserved_name(self):
        """Test sanitizing Windows reserved name."""
        safe, display = sanitize_filename("CON.pdf")
        assert safe.startswith("_")
        assert safe == "_CON.pdf"

    def test_sanitize_filename_empty_raises(self):
        """Test that empty filename raises ValueError."""
        with pytest.raises(ValueError, match="empty"):
            sanitize_filename("")

    def test_sanitize_filename_null_bytes_removed(self):
        """Test that null bytes are removed."""
        safe, display = sanitize_filename("doc\x00.pdf")
        assert "\x00" not in safe


class TestAskStreamEndpoint:
    """Tests for POST /ask/stream SSE streaming endpoint."""

    def test_ask_stream_engine_not_initialized(self, bypass_auth):
        """Test /ask/stream returns 503 when engine is not initialized."""
        with patch("api_server.engine", None):
            response = client.post("/ask/stream", json={"question": "What is Python?"})

            assert response.status_code == 503
            assert response.json()["detail"] == "Engine not initialized"

    def test_ask_stream_no_llm_backend(self, bypass_auth):
        """Test /ask/stream returns 503 when LLM backend is not available."""
        with patch("api_server.engine") as mock_engine:
            mock_engine.llm = None
            # No load diagnostic recorded -> the generic detail is expected
            # (a bare MagicMock would auto-create a truthy llm_init_error).
            mock_engine.llm_init_error = None

            response = client.post("/ask/stream", json={"question": "What is Python?"})

            assert response.status_code == 503
            assert response.json()["detail"] == "No LLM backend available"

    def test_ask_stream_success_with_sse_response(self, bypass_auth):
        """Test /ask/stream returns 200 and SSE events when engine is available."""
        with patch("api_server.engine") as mock_engine:
            mock_engine.llm = MagicMock()

            # Mock query to return a result with stream_callback
            mock_result = MagicMock()
            mock_result.sources = ["doc1.txt"]
            mock_result.context_length = 100
            mock_result.inference_time = 0.5

            def mock_query(
                question,
                n_results=6,
                stream_callback=None,
                conversation_history=None,
                cancellation_event=None,
            ):
                # Simulate streaming tokens
                if stream_callback:
                    stream_callback("Hello ")
                    stream_callback("World!")
                return mock_result

            mock_engine.query.side_effect = mock_query

            response = client.post(
                "/ask/stream", json={"question": "What is Python?", "n_results": 3}
            )

            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")

            # Read SSE events
            events = list(response.iter_lines())
            # Should have message events with tokens and a final done event
            event_data = [
                json.loads(line.split("data: ", 1)[1])
                for line in events
                if line.startswith("data: ")
            ]

            # Should have at least token events and a final done event
            assert len(event_data) >= 2
            # First events should be tokens
            assert "token" in event_data[0]
            # Last event should be done
            assert event_data[-1].get("done") is True

    def test_ask_stream_empty_question_rejected(self, bypass_auth):
        """Test /ask/stream rejects empty question."""
        response = client.post("/ask/stream", json={"question": "", "n_results": 3})

        assert response.status_code == 422


class TestBatchIngestEndpoint:
    """Tests for POST /ingest/batch endpoint."""

    @pytest.fixture(autouse=True)
    def _engine_available(self):
        # Early-rejection tests (limits, filename, size) need a live engine
        # mock so the request reaches the endpoint validation logic.
        with patch("api_server.engine", MagicMock()):
            yield

    def _create_test_file(self, filename, content=b"Test content", size=12):
        """Helper to create a fake upload file."""
        return (filename, BytesIO(content * size))

    def test_batch_ingest_success(self, bypass_auth):
        """Test successful batch upload with valid files."""
        with patch("api_server.engine") as mock_engine:
            mock_engine.ingest_file.return_value = {
                "success": True,
                "chunks_added": 5,
                "message": "File ingested successfully",
            }

            # Create test files
            files = [
                ("file1.txt", BytesIO(b"Test content 1")),
                ("file2.txt", BytesIO(b"Test content 2")),
            ]

            response = client.post(
                "/ingest/batch",
                files=[("files", (name, f, "text/plain")) for name, f in files],
            )

            assert response.status_code == 200
            data = response.json()

            assert data["total_files"] == 2
            assert data["successful"] == 2
            assert data["failed"] == 0
            assert len(data["results"]) == 2
            assert data["results"][0]["success"] is True
            assert data["results"][1]["success"] is True

    def test_batch_ingest_too_many_files(self, bypass_auth):
        """Test rejection when more than 20 files are uploaded."""
        # Create 21 files (over limit of 20)
        files = [(f"file{i}.txt", BytesIO(b"Test content")) for i in range(21)]

        response = client.post(
            "/ingest/batch",
            files=[("files", (name, f, "text/plain")) for name, f in files],
        )

        assert response.status_code == 400
        assert "Too many files" in response.json()["detail"]
        assert "20" in response.json()["detail"]

    def test_batch_ingest_mixed_valid_invalid_files(self, bypass_auth):
        """Test per-file error isolation with mix of valid and invalid files."""
        with patch("api_server.engine") as mock_engine:
            # First file succeeds, second fails (engine returns failure)
            # Both use valid extensions so they pass extension validation
            # and reach engine.ingest_file()
            def mock_ingest(path, source_name=None):
                if source_name == "good.txt":
                    return {"success": True, "chunks_added": 3}
                return {"success": False, "message": "Unsupported format"}

            mock_engine.ingest_file.side_effect = mock_ingest

            files = [
                ("good.txt", BytesIO(b"Valid content")),
                ("bad.txt", BytesIO(b"Invalid content")),
            ]

            response = client.post(
                "/ingest/batch",
                files=[("files", (name, f, "text/plain")) for name, f in files],
            )

            assert response.status_code == 200
            data = response.json()

            assert data["total_files"] == 2
            assert data["successful"] == 1
            assert data["failed"] == 1

            # Check individual results
            results = {r["filename"]: r for r in data["results"]}
            assert results["good.txt"]["success"] is True
            assert results["bad.txt"]["success"] is False
            assert "Unsupported format" in results["bad.txt"]["error"]

    def test_batch_ingest_file_too_large(self, bypass_auth):
        """Test file too large rejection (50MB limit)."""
        # Create a file larger than 50MB (51MB)
        large_content = b"x" * (51 * 1024 * 1024)

        response = client.post(
            "/ingest/batch",
            files=[("files", ("large.txt", BytesIO(large_content), "text/plain"))],
        )

        assert response.status_code == 200  # Request succeeds but individual file fails
        data = response.json()

        assert data["failed"] == 1
        assert "too large" in data["results"][0]["error"].lower()

    def test_batch_ingest_invalid_filename(self, bypass_auth):
        """Test invalid filename rejection."""
        response = client.post(
            "/ingest/batch",
            files=[
                (
                    "files",
                    (
                        "../../../etc/passwd",
                        BytesIO(b"Malicious content"),
                        "text/plain",
                    ),
                )
            ],
        )

        assert response.status_code == 200  # Request succeeds but individual file fails
        data = response.json()

        assert data["failed"] == 1
        # The traversal name is sanitized to an extensionless basename and
        # rejected by the extension allowlist; either rejection reason is a
        # pass as long as the malicious file is not ingested.
        assert ("invalid filename" in data["results"][0]["error"].lower()) or (
            "unsupported file type" in data["results"][0]["error"].lower()
        )

    def test_batch_ingest_unsupported_extension(self, bypass_auth):
        """Test unsupported file extension rejection."""
        response = client.post(
            "/ingest/batch",
            files=[
                (
                    "files",
                    (
                        "document.exe",
                        BytesIO(b"Executable content"),
                        "application/octet-stream",
                    ),
                )
            ],
        )

        assert response.status_code == 200  # Request succeeds but individual file fails
        data = response.json()

        assert data["failed"] == 1
        assert "unsupported file type" in data["results"][0]["error"].lower()

    def test_batch_ingest_empty_batch(self, bypass_auth):
        """Test empty batch (0 files) - should be rejected."""
        response = client.post("/ingest/batch", files=[])

        # Empty batch: files is a required multipart field, so FastAPI
        # validation rejects it with 422 before the endpoint body runs.
        assert response.status_code == 422

    def test_batch_ingest_missing_filename(self, bypass_auth):
        """Test missing filename is rejected.

        A multipart part with an empty filename cannot satisfy the required
        UploadFile field, so FastAPI request validation rejects it with 422
        before the endpoint's per-file error reporting runs.
        """
        with patch("api_server.engine"):
            response = client.post(
                "/ingest/batch",
                files=[("files", ("", BytesIO(b"Content with no name"), "text/plain"))],
            )

            assert response.status_code == 422


class TestSettingsEndpoint:
    """Tests for GET /settings and PUT /settings endpoints."""

    def test_get_settings_returns_expected_fields(self, bypass_auth):
        """Test GET /settings returns expected fields."""
        mock_settings = _make_mock_settings()

        with patch("api_server.get_settings", return_value=mock_settings):
            response = client.get("/settings")

        assert response.status_code == 200
        data = response.json()

        # Verify all expected fields are present
        expected_fields = [
            "chunk_size",
            "chunk_overlap",
            "n_results",
            "min_similarity",
            "temperature",
            "max_tokens",
            "hybrid_search",
            "reranking_enabled",
            "context_truncation",
            "retrieval_window",
            "initial_retrieval_top_k",
            "rerank_top_k",
        ]

        for field in expected_fields:
            assert field in data, f"Missing field: {field}"

        # Verify values match what we set
        assert data["chunk_size"] == 512
        assert data["chunk_overlap"] == 100
        assert data["n_results"] == 4
        assert data["hybrid_search"] is True

    def test_get_settings_no_sensitive_fields(self, bypass_auth):
        """Test GET /settings does not expose sensitive fields (no API keys)."""
        response = client.get("/settings")

        assert response.status_code == 200
        data = response.json()

        # Verify no sensitive fields are exposed
        sensitive_fields = ["api_key", "secret", "password", "token", "key"]
        for field in sensitive_fields:
            assert field not in data, f"Sensitive field {field} should not be exposed"

    def test_put_settings_partial_update(self, bypass_auth):
        """Test PUT /settings with valid partial update."""
        mock_settings = _make_mock_settings()

        with patch("api_server.get_settings", return_value=mock_settings):
            # Update only temperature
            response = client.put("/settings", json={"rag_temperature": 0.7})

        assert response.status_code == 200
        data = response.json()

        # Temperature should be updated
        assert data["temperature"] == 0.7
        # Other fields should remain unchanged
        assert data["chunk_size"] == 512

    def test_put_settings_invalid_overlap_geq_chunk_size(self, bypass_auth):
        """Test PUT /settings with chunk_overlap >= chunk_size returns 400."""
        mock_settings = _make_mock_settings()

        with patch("api_server.get_settings", return_value=mock_settings):
            # Try to set chunk_overlap >= chunk_size
            response = client.put(
                "/settings",
                json={"rag_chunk_overlap": 512},  # Equal to chunk_size, should fail
            )

        assert response.status_code == 400
        assert (
            "rag_chunk_overlap must be less than rag_chunk_size"
            in response.json()["detail"]
        )

    def test_put_settings_invalid_overlap_exceeds_chunk_size(self, bypass_auth):
        """Test PUT /settings with chunk_overlap > chunk_size returns 400."""
        mock_settings = _make_mock_settings()

        with patch("api_server.get_settings", return_value=mock_settings):
            # Try to set chunk_overlap > chunk_size
            response = client.put(
                "/settings", json={"rag_chunk_overlap": 600}  # Greater than chunk_size
            )

        assert response.status_code == 400
        assert (
            "rag_chunk_overlap must be less than rag_chunk_size"
            in response.json()["detail"]
        )

    def test_put_settings_update_multiple_fields(self, bypass_auth):
        """Test PUT /settings with multiple field updates."""
        mock_settings = _make_mock_settings()

        with patch("api_server.get_settings", return_value=mock_settings):
            response = client.put(
                "/settings",
                json={
                    "rag_temperature": 0.9,
                    "rag_max_tokens": 1024,
                    "rag_hybrid_search": False,
                },
            )

        assert response.status_code == 200
        data = response.json()

        assert data["temperature"] == 0.9
        assert data["max_tokens"] == 1024
        assert data["hybrid_search"] is False

    def test_put_settings_requires_auth(self):
        """PUT /settings requires authentication when auth is enabled."""
        from auth import authenticate

        def mock_auth_failure():
            raise HTTPException(status_code=401, detail="Invalid credentials")

        app.dependency_overrides[authenticate] = mock_auth_failure
        try:
            response = client.put("/settings", json={"rag_temperature": 0.5})
            assert response.status_code == 401
        finally:
            if authenticate in app.dependency_overrides:
                del app.dependency_overrides[authenticate]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
