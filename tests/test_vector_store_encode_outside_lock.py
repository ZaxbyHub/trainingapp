"""
Tests for encode_single outside lock behavior in VectorStore (Phase 3.5).

Verifies that:
1. encode_single() is called OUTSIDE the lock in search() method
2. search() accepts optional query_embedding parameter and skips encoding when provided
3. get_chunks() encodes outside its lock scope, passes pre-computed embedding to search()
4. get_context() encodes outside its lock scope, passes pre-computed embedding to search()
5. Concurrent search()/get_chunks()/get_context() calls from multiple threads don't cause deadlock
"""

import pytest
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from unittest.mock import Mock, patch, MagicMock, call
from typing import List

from vector_store import VectorStore, EmbeddingModel, DocumentChunk


@pytest.fixture
def temp_chroma_db(tmp_path):
    """Temporary ChromaDB directory for testing."""
    db_path = tmp_path / "chroma_db"
    db_path.mkdir()
    yield db_path


@pytest.fixture
def mock_embedding_model():
    """Mock EmbeddingModel for testing."""
    import numpy as np

    def _word_hash_embedding(text, dim=384):
        """Generate deterministic embedding based on word hash."""
        words = str(text).lower().split()
        embedding = np.zeros(dim, dtype=np.float32)
        for word in words:
            word_hash = hash(word)
            for offset in range(8):
                dim_idx = (word_hash + offset * 97) % dim
                embedding[dim_idx] = 10.0
        return embedding

    class MockEmbeddingModel:
        def __init__(self, model_name=None):
            self.model_name = model_name or "mock-model"

        def encode(self, texts):
            """Encode multiple texts with deterministic embeddings."""
            return [_word_hash_embedding(str(text)).tolist() for text in texts]

        def encode_single(self, text):
            """Encode single text with deterministic embedding."""
            return _word_hash_embedding(str(text)).tolist()

    return MockEmbeddingModel


@pytest.fixture
def vector_store(temp_chroma_db, mock_embedding_model, sample_chunks):
    """Initialized VectorStore for testing."""
    pytest.importorskip("chromadb")

    # Clear any cached imports first to ensure patching works
    import sys
    modules_to_clear = [k for k in list(sys.modules.keys()) if k.startswith("vector_store")]
    for mod in modules_to_clear:
        del sys.modules[mod]

    with patch("vector_store.EmbeddingModel", mock_embedding_model):
        from vector_store import VectorStore

        store = VectorStore(
            db_path=str(temp_chroma_db), embedding_model="mock-model"
        )
        store.add_chunks(sample_chunks)
        yield store


@pytest.fixture
def sample_chunks():
    """Sample DocumentChunk list for testing."""
    return [
        DocumentChunk(
            text="Python is a high-level programming language known for its simplicity.",
            source="test1.pdf",
            page=1,
            chunk_index=0,
        ),
        DocumentChunk(
            text="Machine learning is a subset of artificial intelligence that enables systems to learn from data.",
            source="test1.pdf",
            page=2,
            chunk_index=1,
        ),
        DocumentChunk(
            text="Natural language processing involves the interaction between computers and human language.",
            source="test2.txt",
            page=None,
            chunk_index=0,
        ),
    ]


class TestEncodeSingleOutsideLock:
    """Tests for encode_single() being called outside the lock in search()."""

    def test_search_encodes_outside_lock(self, vector_store, mock_embedding_model):
        """Test that encode_single() is called OUTSIDE the lock in search() method."""
        # Track call order by wrapping embedder methods
        call_order = []
        original_encode_single = vector_store.embedder.encode_single

        def tracked_encode_single(text):
            call_order.append(("encode_single", text))
            return original_encode_single(text)

        def tracked_collection_query(*args, **kwargs):
            call_order.append(("collection_query", args, kwargs))
            return {"documents": [[]], "metadatas": [[]], "distances": [[]]}

        vector_store.embedder.encode_single = tracked_encode_single
        original_query = vector_store.collection.query
        vector_store.collection.query = tracked_collection_query

        try:
            # Call search without query_embedding - should encode first
            vector_store.search("Python programming", n_results=2)

            # Verify encode_single was called
            encode_calls = [c for c in call_order if c[0] == "encode_single"]
            query_calls = [c for c in call_order if c[0] == "collection_query"]

            assert len(encode_calls) == 1, "encode_single should be called once"
            assert len(query_calls) == 1, "collection.query should be called once"

            # Verify encode_single was called BEFORE collection.query
            encode_idx = call_order.index(encode_calls[0])
            query_idx = call_order.index(query_calls[0])
            assert encode_idx < query_idx, "encode_single must be called BEFORE collection.query (outside lock)"
        finally:
            vector_store.embedder.encode_single = original_encode_single
            vector_store.collection.query = original_query

    def test_search_skips_encoding_when_query_embedding_provided(self, vector_store):
        """Test that search() skips encoding when query_embedding is provided."""
        # Track if encode_single is called
        encode_single_called = []

        original_encode_single = vector_store.embedder.encode_single

        def tracked_encode_single(text):
            encode_single_called.append(text)
            return original_encode_single(text)

        vector_store.embedder.encode_single = tracked_encode_single

        try:
            # Provide pre-computed embedding - should NOT call encode_single
            precomputed_embedding = [0.1] * 384
            results = vector_store.search(
                "Python programming",
                n_results=2,
                query_embedding=precomputed_embedding
            )

            assert len(encode_single_called) == 0, "encode_single should NOT be called when query_embedding is provided"
        finally:
            vector_store.embedder.encode_single = original_encode_single

    def test_get_chunks_encodes_outside_lock_passes_to_search(self, vector_store):
        """Test that get_chunks() encodes outside its lock scope, passes pre-computed embedding to search()."""
        call_order = []
        original_encode_single = vector_store.embedder.encode_single
        original_search = vector_store.search

        def tracked_encode_single(text):
            call_order.append(("encode_single", text))
            return original_encode_single(text)

        def tracked_search(query, n_results=5, query_embedding=None):
            call_order.append(("search", query, query_embedding))
            return original_search(query, n_results=n_results, query_embedding=query_embedding)

        vector_store.embedder.encode_single = tracked_encode_single
        vector_store.search = tracked_search

        try:
            # Call get_chunks - should encode first, then call search with embedding
            chunks = vector_store.get_chunks("Python programming", n_results=2)

            # Verify encode_single was called
            encode_calls = [c for c in call_order if c[0] == "encode_single"]
            search_calls = [c for c in call_order if c[0] == "search"]

            assert len(encode_calls) == 1, "encode_single should be called once in get_chunks"
            assert len(search_calls) == 1, "search should be called once in get_chunks"

            # Verify search was called with the pre-computed embedding
            _, query, embedding_passed = search_calls[0]
            assert query == "Python programming", "search should receive the original query"
            assert embedding_passed is not None, "search should receive the pre-computed embedding"
            assert isinstance(embedding_passed, list), "embedding should be a list"
            assert len(embedding_passed) == 384, "embedding should have correct dimension"
        finally:
            vector_store.embedder.encode_single = original_encode_single
            vector_store.search = original_search

    def test_get_context_encodes_outside_lock_passes_to_search_hybrid(self, vector_store):
        """Test that get_context() encodes outside its lock scope, passes pre-computed embedding to search()."""
        call_order = []
        original_encode_single = vector_store.embedder.encode_single
        original_search = vector_store.search

        def tracked_encode_single(text):
            call_order.append(("encode_single", text))
            return original_encode_single(text)

        def tracked_search(query, n_results=5, query_embedding=None):
            call_order.append(("search", query, query_embedding))
            return original_search(query, n_results=n_results, query_embedding=query_embedding)

        vector_store.embedder.encode_single = tracked_encode_single
        vector_store.search = tracked_search

        try:
            # Call get_context with hybrid_search=True - should encode first, then call search with embedding
            context, sources, chunks = vector_store.get_context(
                "Python programming",
                n_results=2,
                hybrid_search=True
            )

            # Verify encode_single was called
            encode_calls = [c for c in call_order if c[0] == "encode_single"]
            search_calls = [c for c in call_order if c[0] == "search"]

            assert len(encode_calls) == 1, "encode_single should be called once in get_context"
            assert len(search_calls) == 1, "search should be called once in get_context (hybrid mode)"

            # Verify search was called with the pre-computed embedding
            _, query, embedding_passed = search_calls[0]
            assert query == "Python programming", "search should receive the original query"
            assert embedding_passed is not None, "search should receive the pre-computed embedding"
            assert isinstance(embedding_passed, list), "embedding should be a list"
        finally:
            vector_store.embedder.encode_single = original_encode_single
            vector_store.search = original_search


class TestConcurrentSearchNoDeadlock:
    """Tests for concurrent search/get_chunks/get_context calls not causing deadlock."""

    def test_concurrent_search_calls_no_deadlock(self, vector_store):
        """Test that concurrent search() calls from multiple threads don't cause deadlock."""
        num_threads = 5
        calls_per_thread = 3

        def search_worker(thread_id):
            """Worker function that performs multiple search calls."""
            results = []
            for i in range(calls_per_thread):
                try:
                    result = vector_store.search(
                        f"Python programming {thread_id} {i}",
                        n_results=2
                    )
                    results.append(result)
                except Exception as e:
                    return f"Error in thread {thread_id}: {e}"
            return f"Thread {thread_id} completed {len(results)} searches"

        # Run concurrent searches with timeout
        start_time = time.time()
        timeout = 30  # seconds

        with ThreadPoolExecutor(max_workers=num_threads) as executor:
            futures = [executor.submit(search_worker, i) for i in range(num_threads)]

            try:
                for future in futures:
                    result = future.result(timeout=timeout)
                    assert "completed" in result, f"Search should complete successfully: {result}"
            except TimeoutError:
                pytest.fail(f"Deadlock detected: searches did not complete within {timeout} seconds")
            except Exception as e:
                pytest.fail(f"Exception during concurrent searches: {e}")

        elapsed = time.time() - start_time
        assert elapsed < timeout, f"Searches took too long: {elapsed}s (possible performance issue)"

    def test_concurrent_mixed_operations_no_deadlock(self, vector_store):
        """Test that concurrent search(), get_chunks(), and get_context() calls don't cause deadlock."""
        num_threads = 5
        calls_per_thread = 2

        def mixed_operations_worker(thread_id):
            """Worker that performs all three types of operations."""
            results = {"search": 0, "get_chunks": 0, "get_context": 0}
            errors = []

            for i in range(calls_per_thread):
                # search
                try:
                    vector_store.search(f"query {thread_id} {i}", n_results=2)
                    results["search"] += 1
                except Exception as e:
                    errors.append(f"search error: {e}")

                # get_chunks
                try:
                    vector_store.get_chunks(f"query {thread_id} {i}", n_results=2)
                    results["get_chunks"] += 1
                except Exception as e:
                    errors.append(f"get_chunks error: {e}")

                # get_context
                try:
                    vector_store.get_context(f"query {thread_id} {i}", n_results=2)
                    results["get_context"] += 1
                except Exception as e:
                    errors.append(f"get_context error: {e}")

            if errors:
                return f"Errors in thread {thread_id}: {errors}"
            return f"Thread {thread_id} completed: {results}"

        # Run concurrent operations with timeout
        start_time = time.time()
        timeout = 60  # seconds

        with ThreadPoolExecutor(max_workers=num_threads) as executor:
            futures = [executor.submit(mixed_operations_worker, i) for i in range(num_threads)]

            try:
                for future in futures:
                    result = future.result(timeout=timeout)
                    assert "completed" in result, f"Operations should complete successfully: {result}"
            except TimeoutError:
                pytest.fail(f"Deadlock detected: mixed operations did not complete within {timeout} seconds")
            except Exception as e:
                pytest.fail(f"Exception during concurrent operations: {e}")

        elapsed = time.time() - start_time
        assert elapsed < timeout, f"Operations took too long: {elapsed}s (possible performance issue)"

    def test_concurrent_operations_with_lock_contention(self, vector_store):
        """Test concurrent operations under lock contention to verify no deadlock."""
        lock = vector_store._lock
        num_threads = 10
        barrier = threading.Barrier(num_threads)

        def contended_worker():
            """Worker that synchronizes to maximize lock contention."""
            barrier.wait()  # All threads start at the same time
            results = []
            for i in range(3):
                try:
                    # All threads will try to acquire the lock around the same time
                    result = vector_store.search(f"query {i}", n_results=1)
                    results.append(result)
                except Exception as e:
                    return f"Error: {e}"
            return "completed"

        start_time = time.time()
        timeout = 30

        with ThreadPoolExecutor(max_workers=num_threads) as executor:
            futures = [executor.submit(contended_worker) for _ in range(num_threads)]

            try:
                for future in futures:
                    result = future.result(timeout=timeout)
                    assert "completed" in result, f"Contended operations should complete: {result}"
            except TimeoutError:
                pytest.fail(f"Deadlock under contention: operations did not complete within {timeout} seconds")
            except Exception as e:
                pytest.fail(f"Exception under contention: {e}")

        elapsed = time.time() - start_time
        assert elapsed < timeout, f"Contended operations took too long: {elapsed}s"


class TestSearchQueryEmbeddingParameter:
    """Tests for search() query_embedding parameter behavior."""

    def test_search_without_query_embedding_calls_encode_single(self, vector_store):
        """Test that search() without query_embedding calls encode_single."""
        encode_called = []

        original_encode = vector_store.embedder.encode_single

        def track_encode(text):
            encode_called.append(text)
            return original_encode(text)

        vector_store.embedder.encode_single = track_encode
        try:
            vector_store.search("test query", n_results=2)
            assert len(encode_called) == 1, "encode_single should be called when query_embedding is not provided"
            assert "test query" in encode_called[0], "encode_single should be called with the query text"
        finally:
            vector_store.embedder.encode_single = original_encode

    def test_search_with_query_embedding_skips_encode_single(self, vector_store):
        """Test that search() with query_embedding does NOT call encode_single."""
        encode_called = []

        original_encode = vector_store.embedder.encode_single

        def track_encode(text):
            encode_called.append(text)
            return original_encode(text)

        vector_store.embedder.encode_single = track_encode
        try:
            precomputed = [0.1] * 384
            vector_store.search("test query", n_results=2, query_embedding=precomputed)
            assert len(encode_called) == 0, "encode_single should NOT be called when query_embedding is provided"
        finally:
            vector_store.embedder.encode_single = original_encode

    def test_search_query_embedding_parameter_optional(self, vector_store):
        """Test that query_embedding parameter is truly optional (defaults to None)."""
        # Verify the method signature allows calling without query_embedding
        import inspect
        sig = inspect.signature(vector_store.search)
        params = sig.parameters

        assert "query_embedding" in params, "search should have query_embedding parameter"
        assert params["query_embedding"].default is None, "query_embedding should default to None"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
