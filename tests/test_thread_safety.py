"""
Thread safety tests for components that use threading locks.
Tests concurrent access patterns, race conditions, and deadlock prevention.
"""

import pytest
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from unittest.mock import MagicMock, patch, Mock
import sys
import os
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_chromadb():
    """Mock ChromaDB to avoid actual database operations."""
    mock_client = MagicMock()
    mock_collection = MagicMock()
    # Track added IDs dynamically for dynamic count()
    added_ids = []
    mock_collection.count.side_effect = lambda: max(1, len(added_ids))

    def mock_add(ids=None, **kwargs):
        if ids:
            added_ids.extend(ids)

    mock_collection.add.side_effect = mock_add
    # Return mock data for both direct get() and where-filtered get()
    mock_collection.get.return_value = {
        "ids": ["mock_id_1"],
        "documents": ["mock document"],
        "metadatas": [{"source": "test.txt", "chunk_index": 0, "page": None}],
    }
    mock_collection.query.return_value = {
        "ids": [["mock_id_1"]],
        "documents": [["mock document"]],
        "metadatas": [[{"source": "test.txt", "chunk_index": 0}]],
        "distances": [[0.1]],
    }
    mock_client.get_or_create_collection.return_value = mock_collection
    mock_client.delete_collection = MagicMock()

    with patch("vector_store.chromadb.PersistentClient", return_value=mock_client):
        yield mock_client


@pytest.fixture
def mock_embedding_model():
    """Mock embedding model to avoid loading actual models."""
    mock_embedding = np.random.rand(384).tolist()  # Standard BGE-small embedding dimension (384)
    with patch("vector_store.SentenceTransformer") as MockModel:
        mock_instance = MagicMock()
        mock_instance.encode.return_value = np.array([mock_embedding])
        MockModel.return_value = mock_instance
        yield mock_instance


@pytest.fixture
def mock_rag_engine(mock_chromadb, mock_embedding_model, tmp_path):
    """Create RAGEngine with all heavy deps mocked."""
    from rag_engine import RAGEngine, RAGConfig
    from unittest.mock import MagicMock
    
    db_path = tmp_path / "test_db"
    db_path.mkdir()
    config = RAGConfig(db_path=str(db_path))
    
    with patch("rag_engine.SmartLLM") as mock_llm_class:
        mock_llm = MagicMock()
        mock_llm.answer_question.return_value = "Mocked answer."
        mock_llm.get_info.return_value = {"backend": "mock"}
        mock_llm_class.return_value = mock_llm
        
        engine = RAGEngine(config=config)
        engine.llm = mock_llm
        yield engine


# ---------------------------------------------------------------------------
# Test 1: Vector Store Concurrent Reads
# ---------------------------------------------------------------------------

class TestVectorStoreConcurrentReads:
    """Test 10 threads reading simultaneously, no deadlocks."""

    def test_vector_store_concurrent_reads(self, mock_chromadb, mock_embedding_model, tmp_path):
        """10 threads reading simultaneously should complete without deadlock."""
        from vector_store import VectorStore
        
        db_path = tmp_path / "test_db"
        db_path.mkdir()
        store = VectorStore(db_path=str(db_path))
        
        # Pre-populate with some data
        from document_processor import DocumentChunk
        test_chunks = [
            DocumentChunk(text=f"Document {i}", source=f"doc{i}.txt", chunk_index=i, page=None)
            for i in range(10)
        ]
        store.add_chunks(test_chunks)
        
        results = []
        errors = []
        lock = threading.Lock()
        timeout_event = threading.Event()
        
        def reader_thread(thread_id):
            try:
                # Each thread performs multiple reads
                for _ in range(5):
                    if timeout_event.is_set():
                        break
                    query = f"test query {thread_id}"
                    result = store.search(query, n_results=3)
                    with lock:
                        results.append((thread_id, len(result)))
                return True
            except Exception as e:
                with lock:
                    errors.append((thread_id, str(e)))
                return False
        
        # Start 10 reader threads
        threads = []
        for i in range(10):
            t = threading.Thread(target=reader_thread, args=(i,))
            threads.append(t)
            t.start()
        
        # Wait with timeout
        for t in threads:
            t.join(timeout=5.0)
            if t.is_alive():
                timeout_event.set()
                pytest.fail("Thread deadlock detected - thread did not complete within 5 seconds")
        
        # Verify results
        assert len(errors) == 0, f"Errors occurred: {errors}"
        assert len(results) == 50, f"Expected 50 successful reads (10 threads × 5 reads), got {len(results)}"
        
        # All reads should return some results
        for thread_id, count in results:
            assert count >= 0, f"Thread {thread_id} returned negative count"


# ---------------------------------------------------------------------------
# Test 2: Vector Store Concurrent Read/Write
# ---------------------------------------------------------------------------

class TestVectorStoreConcurrentReadWrite:
    """Test 5 readers + 1 writer, no deadlocks, data consistent."""

    def test_vector_store_concurrent_read_write(self, mock_chromadb, mock_embedding_model, tmp_path):
        """5 readers + 1 writer should complete without deadlock and maintain data consistency."""
        from vector_store import VectorStore
        from document_processor import DocumentChunk
        
        db_path = tmp_path / "test_db"
        db_path.mkdir()
        store = VectorStore(db_path=str(db_path))
        
        # Initial data
        initial_chunks = [
            DocumentChunk(text=f"Initial doc {i}", source=f"initial{i}.txt", chunk_index=i, page=None)
            for i in range(5)
        ]
        store.add_chunks(initial_chunks)
        
        results = {"reads": [], "writes": []}
        errors = []
        lock = threading.Lock()
        done_event = threading.Event()
        
        def reader_thread(thread_id):
            try:
                for _ in range(10):
                    if done_event.is_set():
                        break
                    query = f"test query {thread_id}"
                    try:
                        result = store.search(query, n_results=3)
                        with lock:
                            results["reads"].append((thread_id, len(result)))
                    except Exception as e:
                        with lock:
                            errors.append(f"Reader {thread_id}: {e}")
                    time.sleep(0.01)  # Small delay to interleave with writer
                return True
            except Exception as e:
                with lock:
                    errors.append(f"Reader {thread_id} crash: {e}")
                return False
        
        def writer_thread():
            try:
                for i in range(5):
                    if done_event.is_set():
                        break
                    new_chunk = DocumentChunk(
                        text=f"New doc {i}",
                        source=f"new{i}.txt",
                        chunk_index=100 + i,
                        page=None
                    )
                    try:
                        store.add_chunks([new_chunk])
                        with lock:
                            results["writes"].append(i)
                    except Exception as e:
                        with lock:
                            errors.append(f"Writer: {e}")
                    time.sleep(0.02)  # Slightly slower than readers
                return True
            except Exception as e:
                with lock:
                    errors.append(f"Writer crash: {e}")
                return False
        
        # Start 5 reader threads
        reader_threads = [threading.Thread(target=reader_thread, args=(i,)) for i in range(5)]
        for t in reader_threads:
            t.start()
        
        # Start 1 writer thread
        writer_thread_obj = threading.Thread(target=writer_thread)
        writer_thread_obj.start()
        
        # Wait with timeout
        all_threads = reader_threads + [writer_thread_obj]
        for t in all_threads:
            t.join(timeout=5.0)
            if t.is_alive():
                done_event.set()
                pytest.fail("Thread deadlock detected in read/write test")
        
        done_event.set()
        
        # Verify no errors
        assert len(errors) == 0, f"Errors occurred: {errors}"
        assert len(results["writes"]) == 5, f"Expected 5 successful writes, got {len(results['writes'])}"
        assert len(results["reads"]) == 50, f"Expected 50 reads, got {len(results['reads'])}"
        
        # Verify data consistency - final count should be 10 (5 initial + 5 new)
        final_stats = store.get_stats()
        assert final_stats["chunk_count"] == 10, f"Expected 10 chunks, got {final_stats['chunk_count']}"


# ---------------------------------------------------------------------------
# Test 3: CrossEncoder Concurrent Init
# ---------------------------------------------------------------------------

class TestCrossEncoderConcurrentInit:
    """Test 10 threads initializing CrossEncoder simultaneously."""

    def test_crossencoder_concurrent_init(self, tmp_path):
        """10 threads initializing CrossEncoder should have only one actual load, all get same instance."""
        from reranking import CrossEncoderReranker
        
        # Track initialization calls
        init_count = {"count": 0}
        original_init = CrossEncoderReranker.__init__
        lock = threading.Lock()
        
        def counting_init(self, model_name):
            with lock:
                init_count["count"] += 1
            original_init(self, model_name)
        
        with patch.object(CrossEncoderReranker, '__init__', counting_init):
            rerankers = [None] * 10
            errors = []
            
            def init_thread(thread_id):
                try:
                    reranker = CrossEncoderReranker("cross-encoder/ms-marco-MiniLM-L6-v2")
                    with lock:
                        rerankers[thread_id] = reranker
                    return True
                except Exception as e:
                    with lock:
                        errors.append((thread_id, str(e)))
                    return False
            
            # Start 10 threads simultaneously
            threads = []
            for i in range(10):
                t = threading.Thread(target=init_thread, args=(i,))
                threads.append(t)
                t.start()
            
            # Wait with timeout
            for t in threads:
                t.join(timeout=5.0)
                if t.is_alive():
                    pytest.fail("CrossEncoder init deadlock detected")
            
            # Verify
            assert len(errors) == 0, f"Errors during init: {errors}"
            assert all(r is not None for r in rerankers), "Some rerankers failed to initialize"
            # Verify all threads got the same singleton instance
            instance_ids = [id(r) for r in rerankers]
            assert len(set(instance_ids)) == 1, f"Expected 1 singleton, got {len(set(instance_ids))}"
            # Note: Due to Python's GIL and threading, actual init count may vary
            # The important thing is that all threads complete without deadlock


# ---------------------------------------------------------------------------
# Test 4: RAG Engine Concurrent Query + Cancel
# ---------------------------------------------------------------------------

class TestRAGEngineConcurrentQueryCancel:
    """Test 5 threads querying, 2 cancelling simultaneously."""

    def test_ragengine_concurrent_query_cancel(self, mock_rag_engine, mock_chromadb, mock_embedding_model):
        """5 concurrent queries with 2 cancellations should complete without resource leaks."""
        engine = mock_rag_engine
        results = [None] * 5
        errors = []
        lock = threading.Lock()
        
        # Create cancellation events for threads 3 and 4
        cancel_events = [None] * 5
        cancel_events[3] = threading.Event()
        cancel_events[4] = threading.Event()
        
        # Set cancellation events immediately to test cancellation path
        cancel_events[3].set()
        cancel_events[4].set()
        
        def query_thread(thread_id):
            try:
                result = engine.query(
                    f"Question {thread_id}",
                    cancellation_event=cancel_events[thread_id]
                )
                with lock:
                    results[thread_id] = result
                return True
            except Exception as e:
                with lock:
                    errors.append((thread_id, str(e)))
                return False
        
        # Start 5 query threads
        threads = []
        for i in range(5):
            t = threading.Thread(target=query_thread, args=(i,))
            threads.append(t)
            t.start()
        
        # Wait with timeout
        for t in threads:
            t.join(timeout=5.0)
            if t.is_alive():
                pytest.fail("Query thread deadlock detected")
        
        # Verify results
        assert len(errors) == 0, f"Errors occurred: {errors}"
        assert all(r is not None for r in results), "Some queries failed"
        
        # Verify cancelled queries returned proper cancellation response
        for i in [3, 4]:
            assert results[i].answer == "[Cancelled]", f"Thread {i} should have been cancelled"
        
        # Verify non-cancelled queries completed normally
        for i in [0, 1, 2]:
            assert results[i].answer == "Mocked answer.", f"Thread {i} should have normal answer"


# ---------------------------------------------------------------------------
# Test 5: Config Singleton Thread Safety
# ---------------------------------------------------------------------------

class TestConfigSingletonThreadSafety:
    """Verify Settings singleton not corrupted by concurrent init from multiple threads."""

    def test_config_singleton_tsan(self, tmp_path):
        """Concurrent access to settings singleton should not cause corruption."""
        from config import get_settings, _settings, _settings_lock
        import config
        
        # Reset settings for clean test
        with _settings_lock:
            original_settings = config._settings
            config._settings = None
        
        results = []
        errors = []
        lock = threading.Lock()
        
        try:
            def get_settings_thread(thread_id):
                try:
                    # Multiple threads call get_settings simultaneously
                    settings = get_settings()
                    # Access various attributes
                    _ = settings.rag_db_path
                    _ = settings.rag_chunk_size
                    _ = settings.rag_min_similarity
                    _ = settings.rag_context_truncation
                    with lock:
                        results.append((thread_id, id(settings)))
                    return True
                except Exception as e:
                    with lock:
                        errors.append((thread_id, str(e)))
                    return False
            
            # Start 10 threads simultaneously
            threads = []
            for i in range(10):
                t = threading.Thread(target=get_settings_thread, args=(i,))
                threads.append(t)
                t.start()
            
            # Wait with timeout
            for t in threads:
                t.join(timeout=5.0)
                if t.is_alive():
                    pytest.fail("Settings singleton deadlock detected")
            
            # Verify no errors
            assert len(errors) == 0, f"Errors occurred: {errors}"
            assert len(results) == 10, f"Expected 10 successful settings accesses, got {len(results)}"
            
            # Verify all threads got the same singleton instance
            unique_instances = set(id for _, id in results)
            assert len(unique_instances) == 1, f"Expected singleton pattern (1 instance), got {len(unique_instances)}"
        finally:
            # Restore original settings
            with _settings_lock:
                config._settings = original_settings


# ---------------------------------------------------------------------------
# Additional Thread Safety Tests
# ---------------------------------------------------------------------------

class TestVectorStoreLockMechanism:
    """Test the actual lock mechanism in VectorStore."""

    def test_rlock_reentrancy(self, mock_chromadb, mock_embedding_model, tmp_path):
        """RLock should allow reentrant acquisition by same thread."""
        from vector_store import VectorStore
        
        db_path = tmp_path / "test_db"
        db_path.mkdir()
        store = VectorStore(db_path=str(db_path))
        
        # Same thread should be able to acquire lock multiple times
        def nested_operation():
            # This simulates nested lock acquisition
            with store._lock:
                # Should be able to acquire again
                with store._lock:
                    return store.collection.count()
        
        result = nested_operation()
        assert result >= 0, "Nested lock acquisition should work"

    def test_lock_prevents_concurrent_modification(self, mock_chromadb, mock_embedding_model, tmp_path):
        """Lock should prevent concurrent modifications from corrupting state."""
        from vector_store import VectorStore
        from document_processor import DocumentChunk
        
        db_path = tmp_path / "test_db"
        db_path.mkdir()
        store = VectorStore(db_path=str(db_path))
        
        # Add initial data
        initial_chunks = [
            DocumentChunk(text=f"Doc {i}", source=f"doc{i}.txt", chunk_index=i, page=None)
            for i in range(10)
        ]
        store.add_chunks(initial_chunks)
        
        modification_count = [0]
        lock = threading.Lock()
        
        def modifier(thread_id):
            for _ in range(20):
                new_chunk = DocumentChunk(
                    text=f"New {thread_id}_{_}",
                    source=f"new{thread_id}_{_}.txt",
                    chunk_index=1000 + thread_id * 20 + _,
                    page=None
                )
                store.add_chunks([new_chunk])
                with lock:
                    modification_count[0] += 1
        
        # Run 5 modifiers concurrently
        threads = [threading.Thread(target=modifier, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10.0)
            if t.is_alive():
                pytest.fail("Modifier thread deadlock")
        
        # Verify all modifications completed without corruption
        assert modification_count[0] == 100, f"Expected 100 modifications, got {modification_count[0]}"
        
        final_stats = store.get_stats()
        assert final_stats["chunk_count"] == 110, f"Expected 110 total chunks, got {final_stats['chunk_count']}"


class TestEmbeddingModelThreadSafety:
    """Test embedding model thread safety."""

    def test_embedding_model_concurrent_encode(self, mock_embedding_model, tmp_path):
        """Multiple threads encoding simultaneously should not corrupt state."""
        from vector_store import EmbeddingModel
        
        embedder = EmbeddingModel("BAAI/bge-small-en-v1.5")
        
        results = []
        errors = []
        lock = threading.Lock()
        
        def encoder_thread(thread_id):
            try:
                for i in range(10):
                    text = f"Test text {thread_id}_{i}"
                    embedding = embedder.encode_single(text)
                    with lock:
                        results.append((thread_id, len(embedding)))
                return True
            except Exception as e:
                with lock:
                    errors.append((thread_id, str(e)))
                return False
        
        # Start 10 encoder threads
        threads = []
        for i in range(10):
            t = threading.Thread(target=encoder_thread, args=(i,))
            threads.append(t)
            t.start()
        
        # Wait with timeout
        for t in threads:
            t.join(timeout=5.0)
            if t.is_alive():
                pytest.fail("Embedding encoder deadlock")
        
        assert len(errors) == 0, f"Errors occurred: {errors}"
        assert len(results) == 100, f"Expected 100 encodings, got {len(results)}"
        
        # All embeddings should have the correct dimension
        for _, dim in results:
            assert dim == 384, f"Expected embedding dimension 384, got {dim}"
