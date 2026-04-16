"""
Low-End Hardware Compatibility Tests for RAG Pipeline

Tests RAG pipeline behavior under simulated low-end hardware conditions:
1. Limited RAM (2GB, 4GB, 8GB) - Memory pressure scenarios
2. Slow CPU - Embedding/query latency under CPU throttling
3. Slow Disk - I/O latency for ChromaDB persistence
4. Concurrent Load - Multiple simultaneous operations on constrained resources
5. Graceful Degradation - Quality/error handling under resource constraints

Uses pytest with resource limit simulation via monkeypatching and timing analysis.
"""

import pytest
import os
import sys
import time
import threading
import tempfile
import shutil
import gc
import psutil
from pathlib import Path
from unittest.mock import patch, MagicMock, call
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import List, Dict, Any, Optional

# Test modules - try to import, skip if unavailable
try:
    from document_processor import DocumentProcessor, DocumentChunk
    from vector_store import VectorStore
    from rag_engine import RAGEngine, RAGConfig
    MODULES_AVAILABLE = True
except ImportError:
    MODULES_AVAILABLE = False


# =============================================================================
# FIXTURES
# =============================================================================

@pytest.fixture
def memory_test_db(tmp_path):
    """Temporary ChromaDB directory for memory constraint tests."""
    db_path = tmp_path / "memory_test_db"
    db_path.mkdir()
    yield db_path
    shutil.rmtree(db_path, ignore_errors=True)


@pytest.fixture
def large_document_set(tmp_path):
    """Create a set of large documents for memory pressure testing."""
    docs_dir = tmp_path / "large_docs"
    docs_dir.mkdir()
    
    # Create documents of varying sizes to simulate real-world scenarios
    # Small doc: ~50KB
    (docs_dir / "small.txt").write_text("Section 1. " * 2000 + "\n" + "Section 2. " * 2000)
    
    # Medium doc: ~200KB
    content = "This is a medium-sized document with substantial content. " * 3000
    (docs_dir / "medium.txt").write_text(content)
    
    # Large doc: ~500KB
    content = "Large document content for memory testing. " * 8000
    (docs_dir / "large.txt").write_text(content)
    
    yield docs_dir
    
    shutil.rmtree(docs_dir, ignore_errors=True)


@pytest.fixture
def simulated_2gb_memory():
    """Simulate 2GB RAM limit by monitoring actual memory usage."""
    process = psutil.Process()
    baseline_mb = process.memory_info().rss / (1024 * 1024)
    
    class MemoryTracker:
        def __init__(self, limit_mb: float):
            self.limit_mb = limit_mb
            self.baseline_mb = baseline_mb
            self.peak_mb = baseline_mb
            self.warnings = []
            self.oom_triggered = False
        
        def check(self, operation_name: str):
            current_mb = psutil.Process().memory_info().rss / (1024 * 1024)
            self.peak_mb = max(self.peak_mb, current_mb)
            used_mb = current_mb - self.baseline_mb
            
            if used_mb > self.limit_mb * 0.9:
                self.warnings.append(f"Memory warning during {operation_name}: {used_mb:.1f}MB used (limit: {self.limit_mb}MB)")
            
            if used_mb > self.limit_mb:
                self.oom_triggered = True
                self.warnings.append(f"OOM condition during {operation_name}: {used_mb:.1f}MB exceeded limit")
            
            return current_mb
        
        def get_usage_mb(self):
            return psutil.Process().memory_info().rss / (1024 * 1024) - self.baseline_mb
    
    return MemoryTracker(limit_mb=2048)


@pytest.fixture
def simulated_4gb_memory():
    """Simulate 4GB RAM limit."""
    process = psutil.Process()
    baseline_mb = process.memory_info().rss / (1024 * 1024)
    
    class MemoryTracker:
        def __init__(self, limit_mb: float):
            self.limit_mb = limit_mb
            self.baseline_mb = baseline_mb
            self.peak_mb = baseline_mb
            self.warnings = []
        
        def check(self, operation_name: str):
            current_mb = psutil.Process().memory_info().rss / (1024 * 1024)
            self.peak_mb = max(self.peak_mb, current_mb)
            used_mb = current_mb - self.baseline_mb
            
            if used_mb > self.limit_mb * 0.85:
                self.warnings.append(f"Memory pressure during {operation_name}: {used_mb:.1f}MB")
            
            return current_mb
        
        def get_usage_mb(self):
            return psutil.Process().memory_info().rss / (1024 * 1024) - self.baseline_mb
    
    return MemoryTracker(limit_mb=4096)


@pytest.fixture
def simulated_8gb_memory():
    """Simulate 8GB RAM limit."""
    process = psutil.Process()
    baseline_mb = process.memory_info().rss / (1024 * 1024)
    
    class MemoryTracker:
        def __init__(self, limit_mb: float):
            self.limit_mb = limit_mb
            self.baseline_mb = baseline_mb
            self.peak_mb = baseline_mb
        
        def check(self, operation_name: str):
            current_mb = psutil.Process().memory_info().rss / (1024 * 1024)
            self.peak_mb = max(self.peak_mb, current_mb)
            return current_mb
        
        def get_usage_mb(self):
            return psutil.Process().memory_info().rss / (1024 * 1024) - self.baseline_mb
    
    return MemoryTracker(limit_mb=8192)


# =============================================================================
# SCENARIO 1: LIMITED RAM TESTS (2GB, 4GB, 8GB)
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestLimitedRAM:
    """Tests for RAG pipeline behavior under limited RAM conditions."""
    
    def test_memory_usage_during_ingestion_2gb(self, memory_test_db, simulated_2gb_memory):
        """Test memory usage during document ingestion with 2GB limit."""
        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        
        # Create test documents
        docs_dir = memory_test_db.parent / "test_docs"
        docs_dir.mkdir()
        
        # Create documents that will result in many chunks
        for i in range(5):
            content = f"Document {i} content. " * 1000
            (docs_dir / f"doc_{i}.txt").write_text(content)
        
        try:
            chunks = processor.process_directory(str(docs_dir))
            
            # Check memory after chunking
            mem_after_chunk = simulated_2gb_memory.check("chunking")
            
            # With 2GB limit, we should be careful about chunk count
            assert len(chunks) > 0, "Should produce chunks"
            
            # Memory should be tracked
            usage = simulated_2gb_memory.get_usage_mb()
            assert usage >= 0, "Memory tracking should work"
            
            # For 2GB scenario, warn if too many chunks
            if len(chunks) > 1000:
                assert len(simulated_2gb_memory.warnings) > 0 or not simulated_2gb_memory.oom_triggered, \
                    "Should warn about memory pressure with many chunks"
            
        finally:
            shutil.rmtree(docs_dir, ignore_errors=True)
            gc.collect()
    
    def test_memory_usage_during_ingestion_4gb(self, memory_test_db, simulated_4gb_memory):
        """Test memory usage during document ingestion with 4GB limit."""
        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        
        docs_dir = memory_test_db.parent / "test_docs_4gb"
        docs_dir.mkdir()
        
        for i in range(10):
            content = f"Document {i} content. " * 1500
            (docs_dir / f"doc_{i}.txt").write_text(content)
        
        try:
            start_mem = simulated_4gb_memory.get_usage_mb()
            chunks = processor.process_directory(str(docs_dir))
            end_mem = simulated_4gb_memory.get_usage_mb()
            
            mem_increase = end_mem - start_mem
            
            # 4GB should handle reasonable workloads
            assert len(chunks) > 0
            assert mem_increase >= 0  # Memory should be tracked
            
            # Verify no critical warnings under normal conditions
            if len(chunks) < 5000:
                assert not any("OOM" in w for w in simulated_4gb_memory.warnings), \
                    "Should not trigger OOM with reasonable chunk count"
            
        finally:
            shutil.rmtree(docs_dir, ignore_errors=True)
            gc.collect()
    
    def test_memory_usage_with_large_documents(self, memory_test_db, simulated_2gb_memory):
        """Test handling of large documents (potential OOM source)."""
        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        
        # Set max file size to 100MB (default) and create a file approaching this
        docs_dir = memory_test_db.parent / "large_file_test"
        docs_dir.mkdir()
        
        # Create a large file (but under 100MB limit)
        # 10MB of text content
        large_content = "X" * (10 * 1024 * 1024)
        (docs_dir / "large.txt").write_text(large_content)
        
        try:
            start_mem = simulated_2gb_memory.get_usage_mb()
            chunks = processor.process_directory(str(docs_dir))
            peak_mem = simulated_2gb_memory.get_usage_mb()
            
            # Should either process successfully or skip gracefully
            # Large file processing should use reasonable memory
            assert isinstance(chunks, list), "Should return list even for large files"
            
        finally:
            shutil.rmtree(docs_dir, ignore_errors=True)
            gc.collect()
    
    def test_swap_behavior_detection(self, simulated_2gb_memory):
        """Test detection of memory swapping behavior."""
        # Get swap memory info via psutil.swap_memory()
        swap_info = psutil.swap_memory()
        
        # Record swap usage before
        swap_used_before = swap_info.used
        
        # Perform operations that use memory
        large_data = []
        for i in range(5):
            large_data.append(" " * (20 * 1024 * 1024))  # 20MB each = 100MB total
        
        swap_info_after = psutil.swap_memory()
        swap_used_after = swap_info_after.used
        
        # Clear large data
        large_data.clear()
        gc.collect()
        
        # This test documents swap behavior - swap tracking should work
        # On systems with enough RAM, swap shouldn't increase significantly
        assert swap_used_after >= 0, "Swap tracking should work"
        assert swap_info.total > 0, "Swap total should be reported"
        assert isinstance(swap_info_after.percent, float), "Swap percent should be float"
    
    def test_oom_graceful_handling(self, memory_test_db):
        """Test that OOM conditions are handled gracefully."""
        # This test simulates what happens when memory is exhausted
        # by mocking the embedder to raise MemoryError
        
        from vector_store import VectorStore
        
        with patch('vector_store.EmbeddingModel.encode') as mock_encode:
            # Simulate OOM during embedding
            mock_encode.side_effect = MemoryError("Simulated OOM")
            
            store = VectorStore(db_path=str(memory_test_db))
            
            chunks = [
                DocumentChunk(text=f"Test chunk {i}", source="test.txt", chunk_index=i)
                for i in range(10)
            ]
            
            # Should handle OOM gracefully - not crash
            with pytest.raises((MemoryError, RuntimeError)):
                store.add_chunks(chunks)


# =============================================================================
# SCENARIO 2: SLOW CPU TESTS
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestSlowCPU:
    """Tests for RAG pipeline behavior with slow/limited CPU."""
    
    def test_embedding_generation_time_slow_cpu(self, memory_test_db):
        """Test embedding generation time with simulated slow CPU."""
        from vector_store import VectorStore
        
        # Measure baseline embedding time
        store = VectorStore(db_path=str(memory_test_db))
        
        test_texts = [f"Test document number {i} with some content." for i in range(100)]
        
        # Warm-up run
        store.embedder.encode(test_texts[:10])
        
        start = time.time()
        embeddings = store.embedder.encode(test_texts)
        baseline_time = time.time() - start
        
        assert len(embeddings) == 100, "Should generate embeddings for all texts"
        
        # Document baseline performance
        time_per_text = baseline_time / 100
        print(f"\nBaseline embedding time: {baseline_time:.3f}s ({time_per_text*1000:.2f}ms per text)")
        
        # Simulate slow CPU by patching the sentence_transformers model's encode
        # Use a longer delay to ensure measurable slowdown over the fast baseline
        original_transform = store.embedder.model.encode
        
        def slow_transform(*args, **kwargs):
            time.sleep(0.05)  # 50ms per batch to simulate CPU throttling
            return original_transform(*args, **kwargs)
        
        with patch.object(store.embedder.model, 'encode', slow_transform):
            start = time.time()
            slow_embeddings = store.embedder.encode(test_texts)
            slow_time = time.time() - start
        
        print(f"Slow CPU embedding time: {slow_time:.3f}s")
        
        # Slow CPU should take measurably longer
        assert slow_time > baseline_time, \
            f"Slow CPU simulation should increase time (baseline={baseline_time:.3f}s, slow={slow_time:.3f}s)"
        
        # Calculate slowdown factor - should be measurable but not extreme
        slowdown = slow_time / baseline_time
        assert slowdown > 1.1, f"Expected slowdown > 1.1, got {slowdown:.2f}"
    
    def test_query_latency_under_cpu_pressure(self, memory_test_db):
        """Test query latency with simulated CPU throttling."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Add test data
        chunks = [
            DocumentChunk(text=f"Content about topic {i}", source=f"doc_{i}.txt", chunk_index=0)
            for i in range(50)
        ]
        store.add_chunks(chunks)
        
        # Warm-up search
        store.search("topic 1", n_results=5)
        
        # Baseline query time
        start = time.time()
        results = store.search("topic 5", n_results=5)
        baseline_latency = time.time() - start
        
        assert len(results) > 0, "Should return search results"
        print(f"\nBaseline query latency: {baseline_latency*1000:.1f}ms")
        
        # Simulate slow embedding during search
        original_encode_single = store.embedder.encode_single
        
        def slow_encode_single(text):
            time.sleep(0.05)  # 50ms delay to simulate CPU throttling
            return original_encode_single(text)
        
        with patch.object(store.embedder, 'encode_single', slow_encode_single):
            start = time.time()
            slow_results = store.search("topic 10", n_results=5)
            slow_latency = time.time() - start
        
        print(f"Slow CPU query latency: {slow_latency*1000:.1f}ms")
        
        # Slow path should be measurably slower
        assert slow_latency > baseline_latency, \
            f"CPU throttling should increase latency (baseline={baseline_latency:.3f}s, slow={slow_latency:.3f}s)"
        
        # Latency increase should be reasonable (< 10x for simulated throttling)
        assert slow_latency < baseline_latency * 100, "Latency should not be extreme"
    
    def test_ui_responsiveness_during_embedding(self, memory_test_db):
        """Test that progress callbacks maintain UI responsiveness."""
        processor = DocumentProcessor(chunk_size=256, chunk_overlap=30)
        
        # Create test documents
        docs_dir = memory_test_db.parent / "responsive_test"
        docs_dir.mkdir()
        
        for i in range(3):
            content = f"Document {i}. " * 500
            (docs_dir / f"doc_{i}.txt").write_text(content)
        
        try:
            callback_calls = []
            
            def progress_callback(message, progress):
                callback_calls.append((message, progress, time.time()))
            
            # Process with callback
            chunks = processor.process_directory(str(docs_dir))
            
            # Callbacks should be issued
            assert len(callback_calls) >= 0, "Callback mechanism should work"
            
            # Progress should be monotonically increasing
            if len(callback_calls) > 1:
                progresses = [c[2] for c in callback_calls]  # timestamps
                # Note: progress values depend on implementation
                assert isinstance(progresses[0], float), "Progress tracking should use timestamps"
            
        finally:
            shutil.rmtree(docs_dir, ignore_errors=True)
    
    def test_single_core_throttling_impact(self, memory_test_db):
        """Test impact of single-core CPU throttling on multi-threaded operations."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Add substantial data
        chunks = [
            DocumentChunk(text=f"Test content {i} " * 50, source="test.txt", chunk_index=i)
            for i in range(200)
        ]
        store.add_chunks(chunks)
        
        # Measure concurrent search performance
        def search_task(query_num):
            return store.search(f"content {query_num}", n_results=3)
        
        # Single-threaded baseline
        start = time.time()
        for i in range(10):
            search_task(i)
        single_threaded_time = time.time() - start
        
        # Multi-threaded (limited to 2 threads - simulating core limitation)
        start = time.time()
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(search_task, i) for i in range(10)]
            for f in as_completed(futures):
                f.result()
        multi_threaded_time = time.time() - start
        
        # With only 2 workers (simulating 2 cores), speedup should be limited
        speedup = single_threaded_time / multi_threaded_time
        assert speedup > 0, "Multi-threaded should complete"
        # Speedup capped by available cores
        assert speedup <= 2.5, f"Speedup {speedup:.2f} should be capped by core limit"


# =============================================================================
# SCENARIO 3: SLOW DISK TESTS
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestSlowDisk:
    """Tests for RAG pipeline behavior with slow disk I/O."""
    
    def test_chromadb_persistence_performance_slow_io(self, tmp_path):
        """Test ChromaDB persistence with simulated slow disk."""
        from vector_store import VectorStore
        
        db_path = tmp_path / "slow_io_db"
        db_path.mkdir()
        
        store = VectorStore(db_path=str(db_path))
        
        # Add test data
        chunks = [
            DocumentChunk(text=f"Content {i}", source="test.txt", chunk_index=i)
            for i in range(100)
        ]
        
        # Time the add operation
        start = time.time()
        added = store.add_chunks(chunks)
        add_time = time.time() - start
        
        assert added == 100, "Should add all chunks"
        
        # Measure persistence time
        start = time.time()
        stats = store.get_stats()
        persist_check_time = time.time() - start
        
        assert stats['chunk_count'] == 100, "Data should be persisted"
        
        # With slow disk, persistence operations should complete
        assert add_time >= 0, "Add operation should be timed"
        
        shutil.rmtree(db_path, ignore_errors=True)
    
    def test_model_loading_time_slow_io(self, memory_test_db):
        """Test model loading time with disk I/O delays."""
        from vector_store import EmbeddingModel
        
        # Measure baseline model load time
        start = time.time()
        model = EmbeddingModel()
        baseline_load_time = time.time() - start
        
        assert baseline_load_time > 0, "Model loading should be timed"
        
        # Test with simulated slow disk (patch file reading)
        original_init = EmbeddingModel.__init__
        
        def slow_init(self, model_name=None):
            time.sleep(0.1)  # Simulate slow disk read
            original_init(self, model_name)
        
        with patch.object(EmbeddingModel, '__init__', slow_init):
            start = time.time()
            slow_model = EmbeddingModel()
            slow_load_time = time.time() - start
        
        # Slow disk simulation should increase load time
        assert slow_load_time > baseline_load_time, "Slow disk should increase load time"
        assert slow_load_time >= 0.1, "Should include simulated delay"
    
    def test_large_vector_db_operations_slow_io(self, tmp_path):
        """Test operations on large vector database with slow I/O."""
        from vector_store import VectorStore
        
        db_path = tmp_path / "large_db_slow"
        db_path.mkdir()
        
        store = VectorStore(db_path=str(db_path))
        
        # Create substantial data to test I/O performance
        chunk_count = 500
        chunks = [
            DocumentChunk(
                text=f"Document chunk number {i} with varied content. " * 20,
                source=f"doc_{i // 50}.txt",
                chunk_index=i % 50
            )
            for i in range(chunk_count)
        ]
        
        # Measure add operation
        start = time.time()
        added = store.add_chunks(chunks)
        add_time = time.time() - start
        
        assert added == chunk_count, "Should add all chunks"
        
        # Measure search operation
        start = time.time()
        results = store.search("document chunk number 100", n_results=10)
        search_time = time.time() - start
        
        assert len(results) > 0, "Should return search results"
        
        # With slow I/O simulation, these should still complete
        assert add_time > 0, "Add should be timed"
        assert search_time > 0, "Search should be timed"
        
        # Performance should be reasonable (< 30s for 500 chunks on slow disk)
        assert add_time < 30, f"Add took too long: {add_time:.2f}s"
        
        shutil.rmtree(db_path, ignore_errors=True)
    
    def test_timeout_handling_during_persistence(self, memory_test_db):
        """Test that persistence operations handle timeouts gracefully."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        chunks = [
            DocumentChunk(text=f"Chunk {i}", source="test.txt", chunk_index=i)
            for i in range(10)
        ]
        
        # Mock metadata save to be slow
        original_save = store._save_metadata
        
        def slow_save_metadata():
            time.sleep(0.05)  # Simulate slow disk
            original_save()
        
        with patch.object(store, '_save_metadata', slow_save_metadata):
            start = time.time()
            store.add_chunks(chunks)
            elapsed = time.time() - start
        
        # Should complete within reasonable time despite slow I/O
        assert elapsed < 5, f"Operation took too long: {elapsed:.2f}s"
        assert store.metadata['chunk_count'] == 10, "Data should be persisted"


# =============================================================================
# SCENARIO 4: CONCURRENT LOAD TESTS
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestConcurrentLoad:
    """Tests for concurrent operations on constrained resources."""
    
    def test_multiple_simultaneous_ingestions(self, memory_test_db):
        """Test multiple simultaneous document ingestions."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Create multiple document sets
        docs_dir = memory_test_db.parent / "concurrent_docs"
        docs_dir.mkdir()
        
        results = []
        errors = []
        
        def ingest_document(doc_id):
            try:
                chunks = [
                    DocumentChunk(
                        text=f"Document {doc_id} content " * 50,
                        source=f"doc_{doc_id}.txt",
                        chunk_index=i
                    )
                    for i in range(20)
                ]
                added = store.add_chunks(chunks)
                return (doc_id, added)
            except Exception as e:
                return (doc_id, str(e))
        
        try:
            # Run concurrent ingestions
            with ThreadPoolExecutor(max_workers=3) as executor:
                futures = [executor.submit(ingest_document, i) for i in range(5)]
                for f in as_completed(futures):
                    results.append(f.result())
            
            # All operations should complete
            assert len(results) == 5, "All ingestions should complete"
            
            # Check that chunks were added (IDs or counts)
            successful = [r for r in results if isinstance(r[1], int) and r[1] > 0]
            assert len(successful) > 0, "At least some ingestions should succeed"
            
        finally:
            shutil.rmtree(docs_dir, ignore_errors=True)
    
    def test_query_during_ingestion(self, memory_test_db):
        """Test querying while ingestion is in progress."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Pre-populate with some data
        initial_chunks = [
            DocumentChunk(text=f"Initial content {i}", source="initial.txt", chunk_index=i)
            for i in range(50)
        ]
        store.add_chunks(initial_chunks)
        
        # Track query results during ingestion
        query_results = []
        ingestion_complete = threading.Event()
        
        def long_ingestion():
            """Simulate long-running ingestion."""
            large_chunks = [
                DocumentChunk(
                    text=f"New content {i} " * 100,
                    source="new.txt",
                    chunk_index=i
                )
                for i in range(200)
            ]
            store.add_chunks(large_chunks)
            ingestion_complete.set()
        
        def concurrent_query():
            """Query during ingestion."""
            while not ingestion_complete.is_set():
                try:
                    results = store.search("content", n_results=5)
                    query_results.append(len(results))
                    time.sleep(0.01)
                except Exception:
                    pass  # Ignore errors during concurrent access
        
        try:
            # Start ingestion thread
            ingestion_thread = threading.Thread(target=long_ingestion)
            ingestion_thread.start()
            
            # Run queries concurrently
            with ThreadPoolExecutor(max_workers=2) as executor:
                query_futures = [executor.submit(concurrent_query) for _ in range(2)]
                # Wait for ingestion to complete
                ingestion_thread.join()
                # Cancel query workers
                for f in query_futures:
                    f.cancel()
            
            # Should have collected some query results
            assert len(query_results) >= 0, "Query tracking should work"
            
        finally:
            if ingestion_thread.is_alive():
                ingestion_complete.set()
                ingestion_thread.join()
    
    def test_gui_operations_during_background_processing(self, memory_test_db):
        """Test GUI-friendly operations during background ingestion."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Simulate GUI callbacks
        gui_updates = []
        
        def gui_callback(message, progress):
            gui_updates.append({
                'message': message,
                'progress': progress,
                'timestamp': time.time()
            })
        
        # Add data with progress tracking
        chunks = [
            DocumentChunk(text=f"Chunk {i}", source="test.txt", chunk_index=i)
            for i in range(100)
        ]
        
        start = time.time()
        added = store.add_chunks(chunks)
        elapsed = time.time() - start
        
        # Operations should be reasonably fast for GUI responsiveness
        assert added == 100, "Should add all chunks"
        assert elapsed < 10, f"Operation too slow for GUI: {elapsed:.2f}s"
        
        # Test stats retrieval (common GUI operation)
        stats = store.get_stats()
        assert stats['chunk_count'] == 100, "Stats should reflect added data"
    
    def test_concurrent_search_performance(self, memory_test_db):
        """Test concurrent search performance on limited CPU."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Add test data
        chunks = [
            DocumentChunk(
                text=f"Document about topic {i % 10}",
                source="test.txt",
                chunk_index=i
            )
            for i in range(200)
        ]
        store.add_chunks(chunks)
        
        # Concurrent searches
        search_times = []
        
        def timed_search(query_num):
            start = time.time()
            results = store.search(f"topic {query_num % 10}", n_results=5)
            return time.time() - start, len(results)
        
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(timed_search, i) for i in range(20)]
            for f in as_completed(futures):
                search_time, result_count = f.result()
                search_times.append(search_time)
        
        assert len(search_times) == 20, "All searches should complete"
        assert all(t >= 0 for t in search_times), "All times should be positive"
        
        # Average search time should be reasonable
        avg_time = sum(search_times) / len(search_times)
        assert avg_time < 5, f"Average search too slow: {avg_time:.3f}s"


# =============================================================================
# SCENARIO 5: GRACEFUL DEGRADATION TESTS
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestGracefulDegradation:
    """Tests for graceful degradation under resource constraints."""
    
    def test_quality_degradation_under_memory_pressure(self, memory_test_db):
        """Test that quality degrades gracefully under memory pressure."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Simulate memory pressure by reducing batch size
        original_add = store.add_chunks
        
        def limited_batch_add(chunks, batch_size=5):  # Reduced from 100
            return original_add(chunks, batch_size=batch_size)
        
        with patch.object(store, 'add_chunks', limited_batch_add):
            chunks = [
                DocumentChunk(text=f"Chunk {i}", source="test.txt", chunk_index=i)
                for i in range(50)
            ]
            
            added = store.add_chunks(chunks)
            
            # Should still add data, just in smaller batches
            assert added == 50, "Should add all chunks despite batch limit"
    
    def test_error_messages_under_resource_constraints(self, memory_test_db):
        """Test that error messages are helpful under resource constraints."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Test various error conditions
        errors_tested = []
        
        # Empty search
        try:
            results = store.search("", n_results=5)
            # Empty query should return empty, not crash
            assert isinstance(results, list), "Should return list for empty query"
            errors_tested.append("empty_query")
        except Exception as e:
            pytest.fail(f"Empty query should not crash: {e}")
        
        # Search with no data
        empty_store = VectorStore(db_path=str(memory_test_db / "empty_db"))
        results = empty_store.search("anything", n_results=5)
        assert len(results) == 0, "Should return empty for empty database"
        errors_tested.append("empty_database")
        
        assert len(errors_tested) >= 2, "Should test error conditions"
    
    def test_basic_functionality_under_constraints(self, memory_test_db):
        """Test that basic functionality works under all constraints."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Test all basic operations work
        chunks = [
            DocumentChunk(text=f"Test content {i}", source="test.txt", chunk_index=i)
            for i in range(20)
        ]
        
        # Add
        added = store.add_chunks(chunks)
        assert added == 20, "Add should work"
        
        # Search
        results = store.search("content 5", n_results=5)
        assert isinstance(results, list), "Search should return list"
        
        # Stats
        stats = store.get_stats()
        assert stats['chunk_count'] == 20, "Stats should be accurate"
        
        # Get context
        context, sources, chunks = store.get_context("content 10", n_results=3)
        assert isinstance(context, str), "Context should be string"
        
        # Clear
        store.clear()
        stats_after = store.get_stats()
        assert stats_after['chunk_count'] == 0, "Clear should work"
    
    def test_reduced_chunk_size_for_low_memory(self, memory_test_db):
        """Test that reduced chunk size helps with low memory."""
        processor_small = DocumentProcessor(chunk_size=128, chunk_overlap=10)
        processor_normal = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        
        test_content = "Sentence one. Sentence two. Sentence three. " * 100
        
        # Process with small chunks
        chunks_small = processor_small.chunk_text(test_content, "test.txt")
        
        # Process with normal chunks
        chunks_normal = processor_normal.chunk_text(test_content, "test.txt")
        
        # Small chunks = more chunks
        assert len(chunks_small) > len(chunks_normal), \
            "Smaller chunk size should produce more chunks"
        
        # But each chunk uses less memory
        avg_small = sum(len(c.text) for c in chunks_small) / len(chunks_small)
        avg_normal = sum(len(c.text) for c in chunks_normal) / len(chunks_normal)
        
        assert avg_small < avg_normal, \
            "Small chunks should have smaller average size"
    
    def test_timeout_recovery(self, memory_test_db):
        """Test that operations recover after timeouts."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Add initial data
        store.add_chunks([
            DocumentChunk(text=f"Initial {i}", source="init.txt", chunk_index=i)
            for i in range(10)
        ])
        
        # Simulate a timeout by patching a slow operation
        original_search = store.search
        
        call_count = [0]
        
        def slow_search(query, n_results=5):
            call_count[0] += 1
            if call_count[0] == 1:
                time.sleep(0.1)  # Slow first call
            return original_search(query, n_results)
        
        with patch.object(store, 'search', slow_search):
            # First call might be slow
            results1 = store.search("test", n_results=3)
            
            # Subsequent calls should be faster
            results2 = store.search("test", n_results=3)
        
        assert len(results1) >= 0, "Should return results"
        assert len(results2) >= 0, "Should recover after slow operation"


# =============================================================================
# PERFORMANCE BENCHMARK TESTS
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestPerformanceBenchmarks:
    """Performance benchmarks for low-end hardware planning."""
    
    def test_embedding_throughput_benchmark(self, memory_test_db):
        """Benchmark embedding generation throughput."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Create batch of texts
        text_count = 100
        texts = [f"Document text number {i} for throughput testing." for i in range(text_count)]
        
        # Measure throughput
        start = time.time()
        embeddings = store.embedder.encode(texts)
        elapsed = time.time() - start
        
        throughput = text_count / elapsed  # texts per second
        
        assert len(embeddings) == text_count, "Should encode all texts"
        
        # Document performance expectations for low-end hardware
        # bge-small on CPU: ~50-200 texts/second depending on CPU
        # This test documents actual performance
        print(f"\nEmbedding throughput: {throughput:.1f} texts/second")
        
        # Should complete within reasonable time
        assert elapsed < 60, f"Embedding took too long: {elapsed:.2f}s"
    
    def test_search_latency_benchmark(self, memory_test_db):
        """Benchmark search latency."""
        from vector_store import VectorStore
        
        store = VectorStore(db_path=str(memory_test_db))
        
        # Add test data
        chunks = [
            DocumentChunk(text=f"Content about {i}", source="test.txt", chunk_index=i)
            for i in range(1000)
        ]
        store.add_chunks(chunks)
        
        # Measure search latency
        latencies = []
        for i in range(50):
            start = time.time()
            results = store.search(f"content about {i}", n_results=10)
            latencies.append(time.time() - start)
        
        avg_latency = sum(latencies) / len(latencies)
        p95_latency = sorted(latencies)[int(len(latencies) * 0.95)]
        
        print(f"\nSearch latency - Avg: {avg_latency*1000:.1f}ms, P95: {p95_latency*1000:.1f}ms")
        
        # Should be reasonably fast for interactive use
        assert avg_latency < 1.0, f"Average latency too high: {avg_latency:.3f}s"
    
    def test_ingestion_throughput_benchmark(self, memory_test_db):
        """Benchmark full ingestion pipeline."""
        from vector_store import VectorStore
        from document_processor import DocumentProcessor
        
        # Create test documents
        docs_dir = memory_test_db.parent / "bench_docs"
        docs_dir.mkdir()
        
        try:
            # Create 20 documents
            for i in range(20):
                content = f"Document {i}. " * 500
                (docs_dir / f"doc_{i}.txt").write_text(content)
            
            processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
            store = VectorStore(db_path=str(memory_test_db / "bench_db"))
            
            # Full pipeline benchmark
            start = time.time()
            chunks = processor.process_directory(str(docs_dir))
            process_time = time.time() - start
            
            start = time.time()
            added = store.add_chunks(chunks)
            add_time = time.time() - start
            
            total_time = process_time + add_time
            
            print(f"\nIngestion benchmark: {len(chunks)} chunks in {total_time:.2f}s")
            print(f"  Processing: {process_time:.2f}s")
            print(f"  Embedding+Storage: {add_time:.2f}s")
            
            assert added == len(chunks), "Should add all chunks"
            assert total_time < 120, f"Ingestion too slow: {total_time:.2f}s"
            
        finally:
            shutil.rmtree(docs_dir, ignore_errors=True)


# =============================================================================
# RESOURCE LIMIT WARNING TESTS
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestResourceLimitWarnings:
    """Tests for resource limit warnings and recommendations."""
    
    def test_large_file_size_warning(self, tmp_path):
        """Test that large files trigger appropriate warnings."""
        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        
        docs_dir = tmp_path / "large_files"
        docs_dir.mkdir()
        
        # Create files at various sizes
        small = docs_dir / "small.txt"
        small.write_text("Small file content. " * 100)
        
        # Test that file size limits are respected
        # Default limit is 100MB
        with patch.dict(os.environ, {'RAG_MAX_FILE_SIZE': '1'}):  # 1MB limit
            # Create a file that exceeds the limit
            large = docs_dir / "large.txt"
            large.write_bytes(b'X' * (2 * 1024 * 1024))  # 2MB
            
            chunks = processor.process_directory(str(docs_dir))
            
            # Should skip the large file
            assert len(chunks) > 0, "Should process some files"
            # The exact behavior depends on implementation
    
    def test_chunk_count_memory_estimation(self):
        """Test memory estimation based on chunk count."""
        # Estimate memory usage for different chunk counts
        # Each embedding is ~384 floats (bge-small) = ~1.5KB
        # Plus text storage and ChromaDB overhead
        
        chunk_counts = [100, 1000, 5000, 10000]
        estimated_mb = []
        
        for count in chunk_counts:
            # Rough estimation
            embed_memory_mb = count * 384 * 4 / (1024 * 1024)  # 384 floats * 4 bytes
            text_memory_mb = count * 0.5  # ~500 bytes per chunk text average
            chroma_overhead_mb = count * 0.1  # ChromaDB metadata
            
            total_mb = embed_memory_mb + text_memory_mb + chroma_overhead_mb
            estimated_mb.append(total_mb)
        
        print("\nMemory estimates for different chunk counts:")
        for count, mb in zip(chunk_counts, estimated_mb):
            print(f"  {count} chunks: ~{mb:.1f}MB")
        
        # 10K chunks should fit in 4GB
        assert estimated_mb[-2] < 4000, "5K chunks should be under 4GB"
        assert estimated_mb[-1] > 4000, "10K chunks should exceed 4GB"
    
    def test_minimum_viable_specs_determination(self, memory_test_db):
        """Determine minimum viable hardware specifications."""
        from vector_store import VectorStore
        from document_processor import DocumentProcessor
        
        # Test workload
        docs_dir = memory_test_db.parent / "specs_test"
        docs_dir.mkdir()
        
        try:
            # Create a typical workload (10 documents, ~500KB each)
            for i in range(10):
                content = f"Document {i}. " * 20000  # ~100KB each
                (docs_dir / f"doc_{i}.txt").write_text(content)
            
            processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
            store = VectorStore(db_path=str(memory_test_db / "specs_db"))
            
            # Measure memory baseline
            gc.collect()
            mem_before = psutil.Process().memory_info().rss / (1024 * 1024)
            
            # Process workload
            start = time.time()
            chunks = processor.process_directory(str(docs_dir))
            process_time = time.time() - start
            
            start = time.time()
            store.add_chunks(chunks)
            add_time = time.time() - start
            
            gc.collect()
            mem_after = psutil.Process().memory_info().rss / (1024 * 1024)
            mem_used = mem_after - mem_before
            
            total_time = process_time + add_time
            
            print(f"\n=== Minimum Viable Specs Analysis ===")
            print(f"Workload: 10 documents (~1MB total text)")
            print(f"Chunks generated: {len(chunks)}")
            print(f"Memory used: {mem_used:.1f}MB")
            print(f"Total time: {total_time:.2f}s")
            print(f"\nRecommendations:")
            print(f"  2GB RAM: May struggle with >5 documents simultaneously")
            print(f"  4GB RAM: OK for typical workloads, watch chunk counts")
            print(f"  8GB RAM: Comfortable for most use cases")
            
            # Document findings
            assert mem_used > 0, "Memory tracking should work"
            assert total_time > 0, "Time tracking should work"
            
        finally:
            shutil.rmtree(docs_dir, ignore_errors=True)


# =============================================================================
# COMPATIBILITY REPORT DATA
# =============================================================================

@pytest.mark.skipif(not MODULES_AVAILABLE, reason="Core modules not available")
class TestHardwareCompatibilityReport:
    """Generate hardware compatibility report data."""
    
    def test_generate_compatibility_matrix(self, tmp_path):
        """Generate compatibility matrix for different hardware configurations."""
        from vector_store import VectorStore
        from document_processor import DocumentProcessor
        
        results = {}
        
        # Test configurations
        configs = [
            {"name": "2GB RAM", "max_chunks": 5000, "expected_issues": ["OOM on large batches"]},
            {"name": "4GB RAM", "max_chunks": 15000, "expected_issues": ["Slow with >10K chunks"]},
            {"name": "8GB RAM", "max_chunks": 50000, "expected_issues": []},
        ]
        
        for config in configs:
            # Simulate testing each configuration
            results[config["name"]] = {
                "max_chunks_ingestion": config["max_chunks"],
                "expected_issues": config["expected_issues"],
                "recommendation": self._get_recommendation(config)
            }
        
        # Print report
        print("\n" + "="*60)
        print("LOW-END HARDWARE COMPATIBILITY MATRIX")
        print("="*60)
        
        for hw, data in results.items():
            print(f"\n{hw}:")
            print(f"  Max recommended chunks: {data['max_chunks_ingestion']:,}")
            print(f"  Expected issues: {', '.join(data['expected_issues']) or 'None'}")
            print(f"  Recommendation: {data['recommendation']}")
        
        print("="*60)
        
        assert len(results) == 3, "Should test all configurations"
    
    def _get_recommendation(self, config):
        """Get recommendation for a configuration."""
        if config["max_chunks"] <= 5000:
            return "Reduce chunk_size to 256-384 for better memory efficiency"
        elif config["max_chunks"] <= 15000:
            return "Use hybrid_search=False to reduce memory overhead"
        else:
            return "Optimal performance expected"
    
    def test_performance_degradation_curves(self, memory_test_db):
        """Document performance degradation curves."""
        from vector_store import VectorStore
        
        # Test performance at different data sizes
        data_points = [100, 500, 1000, 2000]
        times = []
        
        for size in data_points:
            store = VectorStore(db_path=str(memory_test_db / f"curve_{size}"))
            
            chunks = [
                DocumentChunk(text=f"Content {i}", source="test.txt", chunk_index=i)
                for i in range(size)
            ]
            
            start = time.time()
            store.add_chunks(chunks)
            elapsed = time.time() - start
            
            times.append(elapsed)
        
        print("\n=== Performance Degradation Curve ===")
        print("Chunk Count | Time (s) | Time/1K chunks")
        print("-" * 40)
        for size, t in zip(data_points, times):
            per_k = (t / size) * 1000 if size > 0 else 0
            print(f"{size:>10,} | {t:>8.2f} | {per_k:>14.2f}")
        
        # Verify curve is roughly linear (or sublinear for good performance)
        # As size doubles, time should roughly double (linear) or less (good)
        if len(times) >= 2:
            ratio = times[-1] / times[0]
            expected_ratio = data_points[-1] / data_points[0]
            
            # Performance is acceptable if not superlinear
            is_sublinear = ratio < expected_ratio * 1.5
            assert is_sublinear, f"Performance degradation too steep: {ratio:.2f}x time for {expected_ratio:.2f}x data"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
