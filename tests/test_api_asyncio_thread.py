"""
Tests for asyncio.to_thread() wrapping in api_server.py

Verifies that CPU-bound RAG engine operations are properly offloaded
to the thread pool to avoid blocking the FastAPI event loop.

Phase 1.1: API & Thread Safety - asyncio.to_thread() wrapping verification
"""

import pytest
import asyncio
import time
from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport

from api_server import (
    app,
    QuestionRequest,
    SearchRequest,
    IngestRequest,
)


pytestmark = pytest.mark.unit


class TestAsyncioToThreadUsage:
    """Verify asyncio.to_thread is used for CPU-bound operations."""

    def test_ask_endpoint_uses_to_thread(self):
        """Test /ask endpoint calls engine.query via asyncio.to_thread."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="What is Python?",
                answer="Python is a programming language.",
                sources=["doc1.txt"],
                context_length=100,
                inference_time=0.5,
            )

            # Track calls to asyncio.to_thread
            original_to_thread = asyncio.to_thread
            call_tracker = []

            async def mock_to_thread(func, *args, **kwargs):
                call_tracker.append((func.__name__ if hasattr(func, '__name__') else str(func), args, kwargs))
                return await original_to_thread(func, *args, **kwargs)

            with patch('asyncio.to_thread', side_effect=mock_to_thread):
                request = QuestionRequest(question="What is Python?", n_results=3)
                client = TestClient(app)
                response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 200
            # Verify engine.query was called through to_thread
            assert len(call_tracker) >= 1
            func_name = call_tracker[0][0]
            assert 'query' in func_name or func_name == 'query'

    def test_search_endpoint_uses_to_thread(self):
        """Test /search endpoint calls engine.search_documents via asyncio.to_thread."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.search_documents.return_value = [
                ("Document text", {"source": "doc1.txt"}, 0.85),
            ]

            original_to_thread = asyncio.to_thread
            call_tracker = []

            async def mock_to_thread(func, *args, **kwargs):
                call_tracker.append((func.__name__ if hasattr(func, '__name__') else str(func), args, kwargs))
                return await original_to_thread(func, *args, **kwargs)

            with patch('asyncio.to_thread', side_effect=mock_to_thread):
                request = SearchRequest(query="test query", n_results=5)
                client = TestClient(app)
                response = client.post("/search", json=request.model_dump())

            assert response.status_code == 200
            # Verify engine.search_documents was called through to_thread
            assert len(call_tracker) >= 1
            func_name = call_tracker[0][0]
            assert 'search' in func_name or func_name == 'search_documents'

    def test_ingest_endpoint_uses_to_thread(self):
        """Test /ingest endpoint calls engine.ingest_directory via asyncio.to_thread."""
        with patch('api_server.engine') as mock_engine:
            with patch('api_server.validate_directory') as mock_validate:
                mock_validate.return_value = "./test_documents"
                mock_engine.ingest_directory.return_value = {
                    "success": True,
                    "documents": 3,
                    "chunks_added": 10,
                }

                original_to_thread = asyncio.to_thread
                call_tracker = []

                async def mock_to_thread(func, *args, **kwargs):
                    call_tracker.append((func.__name__ if hasattr(func, '__name__') else str(func), args, kwargs))
                    return await original_to_thread(func, *args, **kwargs)

                with patch('asyncio.to_thread', side_effect=mock_to_thread):
                    request = IngestRequest(directory="./test_documents")
                    client = TestClient(app)
                    response = client.post("/ingest", json=request.model_dump())

                assert response.status_code == 200
                # Verify engine.ingest_directory was called through to_thread
                assert len(call_tracker) >= 1
                func_name = call_tracker[0][0]
                assert 'ingest' in func_name or func_name == 'ingest_directory'


class TestEventLoopNonBlocking:
    """Verify the event loop is not blocked during CPU-bound operations.

    These tests verify that asyncio.to_thread properly offloads synchronous
    CPU-bound work to the thread pool, keeping the event loop responsive.
    """

    @pytest.mark.asyncio
    async def test_health_endpoint_responds_while_ask_running(self):
        """Test /health responds while /ask is processing (event loop not blocked).

        This test uses a slow synchronous mock function that blocks for 0.5s.
        If asyncio.to_thread is working properly, the event loop remains responsive
        and /health returns immediately while /ask is blocking in a thread.
        """
        import threading

        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            # Synchronous function that blocks to simulate CPU-bound work
            # asyncio.to_thread runs this in a separate thread
            def slow_query(*args, **kwargs):
                time.sleep(0.5)  # Blocking call - simulates CPU-bound work
                return MagicMock(
                    question="What is Python?",
                    answer="Python is a programming language.",
                    sources=["doc1.txt"],
                    context_length=100,
                    inference_time=0.5,
                )

            mock_engine.query = slow_query

            ask_request = QuestionRequest(question="What is Python?", n_results=3)
            start_time = time.time()

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                # Start ask task (this will block in thread pool)
                ask_task = asyncio.create_task(ac.post("/ask", json=ask_request.model_dump()))

                # Give the thread pool time to start the blocking work
                await asyncio.sleep(0.15)

                # Health should respond immediately if event loop is not blocked
                health_response = await ac.get("/")
                health_elapsed = time.time() - start_time

                assert health_response.status_code == 200
                # Health should be fast (< 0.3s) even while ask is running
                assert health_elapsed < 0.3, f"Health check took {health_elapsed}s - event loop may be blocked"

                # Now wait for ask to complete
                ask_response = await ask_task
                assert ask_response.status_code == 200

    @pytest.mark.asyncio
    async def test_parallel_requests_both_complete(self):
        """Test that parallel /ask and /search requests both complete successfully.

        Both requests use asyncio.to_thread to offload to the thread pool,
        so they should be able to run concurrently without blocking each other.
        """
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()

            # Synchronous functions that block briefly
            def counting_query(*args, **kwargs):
                time.sleep(0.15)
                return MagicMock(
                    question="What is Python?",
                    answer="Python is a programming language.",
                    sources=["doc1.txt"],
                    context_length=100,
                    inference_time=0.5,
                )

            def counting_search(*args, **kwargs):
                time.sleep(0.15)
                return [("Document text", {"source": "doc1.txt"}, 0.85)]

            mock_engine.query = counting_query
            mock_engine.search_documents = counting_search

            ask_request = QuestionRequest(question="What is Python?", n_results=3)
            search_request = SearchRequest(query="test query", n_results=5)

            start_time = time.time()

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                # Execute both requests concurrently
                ask_task = asyncio.create_task(ac.post("/ask", json=ask_request.model_dump()))
                search_task = asyncio.create_task(ac.post("/search", json=search_request.model_dump()))

                ask_response, search_response = await asyncio.gather(ask_task, search_task)

            total_elapsed = time.time() - start_time

            # If both ran sequentially (blocking), total time would be ~0.3s
            # If both ran concurrently via thread pool, should be ~0.15s
            # Allow up to 0.25s to account for overhead
            assert total_elapsed < 0.25, f"Requests took {total_elapsed}s - may be running sequentially"

            assert ask_response.status_code == 200
            assert search_response.status_code == 200

    @pytest.mark.asyncio
    async def test_health_responds_during_ingest_blocking(self):
        """Test /health remains responsive while /ingest is blocking in thread pool."""
        with patch('api_server.engine') as mock_engine:
            with patch('api_server.validate_directory') as mock_validate:
                mock_validate.return_value = "./test_documents"

                # Synchronous blocking function
                def slow_ingest(*args, **kwargs):
                    time.sleep(0.5)  # Simulate CPU-bound directory processing
                    return {
                        "success": True,
                        "documents": 10,
                        "chunks_added": 50,
                    }

                mock_engine.ingest_directory = slow_ingest

                ingest_request = IngestRequest(directory="./test_documents")
                start_time = time.time()

                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                    # Start ingest task
                    ingest_task = asyncio.create_task(ac.post("/ingest", json=ingest_request.model_dump()))

                    # Give thread time to start blocking work
                    await asyncio.sleep(0.15)

                    # Health should be fast
                    health_response = await ac.get("/")
                    health_elapsed = time.time() - start_time

                    assert health_response.status_code == 200
                    assert health_elapsed < 0.3

                    # Wait for ingest to complete
                    ingest_response = await ingest_task
                    assert ingest_response.status_code == 200


class TestErrorPropagation:
    """Verify errors propagate correctly through asyncio.to_thread."""

    def test_ask_error_propagates_through_to_thread(self):
        """Test engine.query error raised via asyncio.to_thread results in HTTPException."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.side_effect = RuntimeError("Database connection failed")

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            # Should get 500 error due to caught RuntimeError
            assert response.status_code == 500
            assert "error" in response.json()["detail"].lower() or "occurred" in response.json()["detail"].lower()

    def test_search_error_propagates_through_to_thread(self):
        """Test engine.search_documents error raised via asyncio.to_thread results in HTTPException."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.search_documents.side_effect = RuntimeError("Index corrupted")

            request = SearchRequest(query="test query", n_results=5)
            client = TestClient(app)
            response = client.post("/search", json=request.model_dump())

            # Should get 500 error due to caught RuntimeError
            assert response.status_code == 500
            assert "search" in response.json()["detail"].lower()

    def test_ingest_error_propagates_through_to_thread(self):
        """Test engine.ingest_directory error raised via asyncio.to_thread results in HTTPException."""
        with patch('api_server.engine') as mock_engine:
            with patch('api_server.validate_directory') as mock_validate:
                mock_validate.return_value = "./test_documents"
                mock_engine.ingest_directory.side_effect = RuntimeError("Disk full")

                request = IngestRequest(directory="./test_documents")
                client = TestClient(app)
                response = client.post("/ingest", json=request.model_dump())

                # Should get 500 error due to caught RuntimeError
                assert response.status_code == 500
                assert "ingest" in response.json()["detail"].lower() or "error" in response.json()["detail"].lower()

    def test_ask_engine_not_initialized_returns_503(self):
        """Test /ask with uninitialized engine returns 503 before reaching to_thread."""
        with patch('api_server.engine', None):
            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 503
            assert "not initialized" in response.json()["detail"].lower()

    def test_search_engine_not_initialized_returns_503(self):
        """Test /search with uninitialized engine returns 503 before reaching to_thread."""
        with patch('api_server.engine', None):
            request = SearchRequest(query="test query", n_results=5)
            client = TestClient(app)
            response = client.post("/search", json=request.model_dump())

            assert response.status_code == 503
            assert "not initialized" in response.json()["detail"].lower()

    def test_ingest_engine_not_initialized_returns_503(self):
        """Test /ingest with uninitialized engine returns 503 before reaching to_thread."""
        with patch('api_server.engine', None):
            request = IngestRequest(directory="./test_documents")
            client = TestClient(app)
            response = client.post("/ingest", json=request.model_dump())

            assert response.status_code == 503
            assert "not initialized" in response.json()["detail"].lower()


class TestReturnValuePreservation:
    """Verify return values are correctly preserved through asyncio.to_thread wrapper."""

    def test_ask_return_value_preserved(self):
        """Test /ask response contains correct data from engine.query."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.llm = MagicMock()
            mock_engine.query.return_value = MagicMock(
                question="What is Python?",
                answer="Python is a high-level programming language created by Guido van Rossum.",
                sources=["python_history.txt", "python_features.txt"],
                context_length=1500,
                inference_time=2.5,
            )

            request = QuestionRequest(question="What is Python?", n_results=3)
            client = TestClient(app)
            response = client.post("/ask", json=request.model_dump())

            assert response.status_code == 200
            data = response.json()

            assert data["question"] == "What is Python?"
            assert data["answer"] == "Python is a high-level programming language created by Guido van Rossum."
            assert data["sources"] == ["python_history.txt", "python_features.txt"]
            assert data["context_length"] == 1500
            assert data["inference_time"] == 2.5

    def test_search_return_value_preserved(self):
        """Test /search response contains correct data from engine.search_documents."""
        with patch('api_server.engine') as mock_engine:
            mock_engine.search_documents.return_value = [
                ("First document about testing", {"source": "test_doc.txt", "chunk_index": 0}, 0.95),
                ("Second document about testing", {"source": "test_doc2.txt", "chunk_index": 5}, 0.87),
                ("Third document on similar topic", {"source": "related.txt", "chunk_index": 2}, 0.72),
            ]

            request = SearchRequest(query="testing documents", n_results=3)
            client = TestClient(app)
            response = client.post("/search", json=request.model_dump())

            assert response.status_code == 200
            data = response.json()

            assert len(data) == 3
            assert data[0]["text"] == "First document about testing"
            assert data[0]["source"] == "test_doc.txt"
            assert data[0]["similarity"] == 0.95

            assert data[1]["text"] == "Second document about testing"
            assert data[1]["source"] == "test_doc2.txt"
            assert data[1]["similarity"] == 0.87

            assert data[2]["text"] == "Third document on similar topic"
            assert data[2]["source"] == "related.txt"
            assert data[2]["similarity"] == 0.72

    def test_ingest_return_value_preserved(self):
        """Test /ingest response contains correct data from engine.ingest_directory."""
        with patch('api_server.engine') as mock_engine:
            with patch('api_server.validate_directory') as mock_validate:
                mock_validate.return_value = "/path/to/documents"
                mock_engine.ingest_directory.return_value = {
                    "success": True,
                    "documents": 15,
                    "chunks_added": 142,
                    "message": "Successfully ingested 15 documents with 142 total chunks",
                    "time_seconds": 8.5,
                }

                request = IngestRequest(directory="/path/to/documents")
                client = TestClient(app)
                response = client.post("/ingest", json=request.model_dump())

                assert response.status_code == 200
                data = response.json()

                assert data["success"] is True
                assert data["documents"] == 15
                assert data["chunks_added"] == 142
                assert "Successfully ingested" in data["message"]


class TestSpecificEndpointsCode:
    """Direct code inspection tests to verify asyncio.to_thread is used in source."""

    def test_ask_endpoint_source_uses_to_thread(self):
        """Verify the /ask endpoint source code contains asyncio.to_thread(engine.query)."""
        import inspect
        from api_server import ask_question

        source = inspect.getsource(ask_question)
        assert 'asyncio.to_thread' in source, "ask_question should use asyncio.to_thread"
        assert 'engine.query' in source, "ask_question should call engine.query"

    def test_search_endpoint_source_uses_to_thread(self):
        """Verify the /search endpoint source code contains asyncio.to_thread(engine.search_documents)."""
        import inspect
        from api_server import search_documents

        source = inspect.getsource(search_documents)
        assert 'asyncio.to_thread' in source, "search_documents should use asyncio.to_thread"
        assert 'engine.search_documents' in source, "search_documents should call engine.search_documents"

    def test_ingest_endpoint_source_uses_to_thread(self):
        """Verify the /ingest endpoint source code contains asyncio.to_thread(engine.ingest_directory)."""
        import inspect
        from api_server import ingest_directory

        source = inspect.getsource(ingest_directory)
        assert 'asyncio.to_thread' in source, "ingest_directory should use asyncio.to_thread"
        assert 'engine.ingest_directory' in source, "ingest_directory should call engine.ingest_directory"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
