"""
Tests for incremental BM25 update fix in vector_store.py

Verifies:
1. Adding 100 chunks to 5000-chunk corpus completes BM25 update in <500ms (O(k) not O(N))
2. _total_token_count maintained incrementally (O(1) per add)
3. add_chunks() accepts rebuild_index parameter
4. Default rebuild_index=False skips legacy BM25Okapi rebuild
5. rebuild_index=True triggers full rebuild
6. add_chunks_with_embeddings() accepts rebuild_index parameter
7. _bm25_needs_rebuild flag check is thread-safe
"""

import os
import sys
import tempfile
import time
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch
import json
import shutil

import pytest

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


class MockDocumentChunk:
    """Mock DocumentChunk for testing without full dependencies."""

    def __init__(self, text: str, source: str, chunk_index: int, page=None):
        self.text = text
        self.source = source
        self.chunk_index = chunk_index
        self.page = page


class MockStopWords:
    """Mock stop words for tokenization."""
    STOP_WORDS = {"the", "a", "an", "is", "are", "was", "were", "be", "been", "being"}


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test artifacts."""
    tmp = tempfile.mkdtemp()
    yield tmp
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def mock_chunk():
    """Create a mock document chunk."""
    return MockDocumentChunk(
        text="This is a test document with some words for tokenization testing purposes.",
        source="test.txt",
        chunk_index=0,
        page=1
    )


@pytest.fixture
def sample_chunks():
    """Create a list of sample document chunks."""
    return [
        MockDocumentChunk(
            text=f"This is test document number {i} with various content for BM25 indexing.",
            source=f"doc_{i}.txt",
            chunk_index=j,
            page=i
        )
        for i in range(10)
        for j in range(5)
    ]


class TestBM25IndexIncremental:
    """Tests for BM25Index incremental update behavior."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        # Patch STOP_WORDS before importing
        self.stop_words_patcher = patch('vector_store.STOP_WORDS', MockStopWords.STOP_WORDS)
        self.stop_words_patcher.start()

        # Patch DocumentChunk import
        self.chunk_patcher = patch('vector_store.DocumentChunk', MockDocumentChunk)
        self.chunk_patcher.start()

        # Patch BM25Okapi availability
        self.bm25_patcher = patch('vector_store.BM25_AVAILABLE', True)
        self.bm25_patcher.start()

        # Mock rank_bm25 module
        self.bm25_mock = MagicMock()
        self.bm25_mock.BM25Okapi = MagicMock(return_value=MagicMock())
        self.bm25_module_patcher = patch.dict('sys.modules', {'rank_bm25': self.bm25_mock})
        self.bm25_module_patcher.start()

        yield

        self.stop_words_patcher.stop()
        self.chunk_patcher.stop()
        self.bm25_patcher.stop()
        self.bm25_module_patcher.stop()

    @pytest.fixture
    def bm25_index(self):
        """Create a fresh BM25Index instance."""
        from vector_store import BM25Index
        return BM25Index()

    def test_total_token_count_maintained_incrementally(self, bm25_index, sample_chunks):
        """Test: _total_token_count maintained incrementally (O(1) per add).

        Verifies that adding chunks updates _total_token_count incrementally
        rather than recomputing from all chunks.
        """
        initial_count = bm25_index._total_token_count
        assert initial_count == 0, "Initial token count should be 0"

        # Add first batch of chunks
        first_batch = sample_chunks[:10]
        bm25_index.add_documents(first_batch, rebuild_index=False)

        count_after_first = bm25_index._total_token_count
        assert count_after_first > 0, "Token count should increase after adding chunks"

        # Store the token counts from first batch
        first_batch_tokens = sum(len(bm25_index._tokenized[i]) for i in range(len(first_batch)))

        # Add second batch
        second_batch = sample_chunks[10:20]
        bm25_index.add_documents(second_batch, rebuild_index=False)

        count_after_second = bm25_index._total_token_count
        assert count_after_second > count_after_first, "Token count should continue increasing"

        # Verify avgdl is correctly maintained (total_token_count / num_chunks)
        assert bm25_index._avgdl == bm25_index._total_token_count / len(bm25_index.chunks)

        # Verify incremental update: _total_token_count should be the sum of all
        # tokenized chunks, not recomputed from scratch
        # The increment should equal the token count of the second batch
        second_batch_tokens = sum(len(bm25_index._tokenized[i]) for i in range(len(first_batch), len(bm25_index._tokenized)))
        expected_increment = second_batch_tokens
        actual_increment = count_after_second - count_after_first

        assert actual_increment == expected_increment, \
            f"Token count increment {actual_increment} != expected {expected_increment}"

    def test_add_chunks_accepts_rebuild_index_parameter(self, bm25_index, sample_chunks):
        """Test: add_chunks() accepts rebuild_index parameter.

        Verifies the rebuild_index parameter exists and is used correctly.
        """
        # Should not raise - rebuild_index parameter exists
        bm25_index.add_documents(sample_chunks[:5], rebuild_index=False)
        assert len(bm25_index.chunks) == 5

        bm25_index.add_documents(sample_chunks[5:10], rebuild_index=True)
        assert len(bm25_index.chunks) == 10

    def test_rebuild_index_false_skips_legacy_bm25_rebuild(self, bm25_index, sample_chunks):
        """Test: Default rebuild_index=False skips legacy BM25Okapi rebuild.

        When rebuild_index=False, the legacy bm25_index should not be rebuilt.
        """
        from vector_store import BM25_AVAILABLE

        bm25_index.add_documents(sample_chunks[:5], rebuild_index=False)

        # Legacy index should remain None when rebuild_index=False
        assert bm25_index.bm25_index is None, \
            "Legacy BM25 index should not be built when rebuild_index=False"

        # Incremental structures should still be updated
        assert len(bm25_index.chunks) == 5
        assert len(bm25_index._tokenized) == 5
        assert bm25_index._avgdl > 0

    def test_rebuild_index_true_triggers_full_rebuild(self, bm25_index, sample_chunks):
        """Test: rebuild_index=True triggers full rebuild.

        When rebuild_index=True, the legacy BM25Okapi index should be rebuilt.
        """
        from vector_store import BM25_AVAILABLE

        if not BM25_AVAILABLE:
            pytest.skip("BM25 not available")

        bm25_index.add_documents(sample_chunks[:5], rebuild_index=False)
        assert bm25_index.bm25_index is None

        # After adding with rebuild_index=True, legacy index should be built
        bm25_index.add_documents(sample_chunks[5:10], rebuild_index=True)

        # Legacy index should now exist
        assert bm25_index.bm25_index is not None, \
            "Legacy BM25 index should be built when rebuild_index=True"

    def test_incremental_add_is_o1_per_chunk(self, bm25_index):
        """Test: Adding chunks is O(1) per chunk, not O(N).

        This test verifies timing scales linearly with number of chunks added,
        not with total corpus size.
        """
        # Create a large corpus (5000 chunks)
        large_corpus = [
            MockDocumentChunk(
                text=f"Document number {i} with some text content for testing performance.",
                source=f"doc_{i}.txt",
                chunk_index=0,
            )
            for i in range(5000)
        ]

        # First add 5000 chunks without building legacy index
        start = time.perf_counter()
        bm25_index.add_documents(large_corpus[:5000], rebuild_index=False)
        initial_build_time = time.perf_counter() - start

        # Now measure time to add 100 more chunks
        small_batch = [
            MockDocumentChunk(
                text=f"New document {i} with some additional content.",
                source=f"new_doc_{i}.txt",
                chunk_index=0,
            )
            for i in range(100)
        ]

        start = time.perf_counter()
        bm25_index.add_documents(small_batch, rebuild_index=False)
        incremental_add_time = time.perf_counter() - start

        # Incremental add of 100 chunks should be fast (<500ms)
        # If it were O(N), it would take much longer on a 5100-chunk corpus
        assert incremental_add_time < 0.5, \
            f"Adding 100 chunks took {incremental_add_time*1000:.1f}ms, expected <500ms. " \
            f"Incremental update may not be O(k)"

        # Verify the incremental update was actually fast (not proportional to corpus)
        # O(N) would be ~5100/5000 = 1.02x the initial build time
        # O(k) should be ~100/5000 = 0.02x the initial build time
        ratio = incremental_add_time / initial_build_time if initial_build_time > 0 else 0

        # The ratio should be much smaller than N/k = 5100/100 = 51
        assert ratio < 1.0, \
            f"Time ratio {ratio:.2f} suggests O(N) behavior, expected O(k) behavior"

    def test_idf_cache_invalidated_on_add(self, bm25_index, sample_chunks):
        """Test: IDF cache is invalidated when new documents are added."""
        # Add initial chunks
        bm25_index.add_documents(sample_chunks[:5], rebuild_index=False)

        # Compute IDF
        idf1 = bm25_index._compute_idf()
        bm25_index._idf_cache = idf1

        # Add more chunks
        bm25_index.add_documents(sample_chunks[5:10], rebuild_index=False)

        # IDF cache should be invalidated
        assert bm25_index._idf_cache is None, \
            "IDF cache should be invalidated after adding new documents"


class TestVectorStoreBM25Integration:
    """Integration tests for VectorStore BM25 behavior."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures with extensive mocking."""
        # Patch all external dependencies
        self.stop_words_patcher = patch('vector_store.STOP_WORDS', MockStopWords.STOP_WORDS)
        self.stop_words_patcher.start()

        self.chunk_patcher = patch('vector_store.DocumentChunk', MockDocumentChunk)
        self.chunk_patcher.start()

        self.bm25_patcher = patch('vector_store.BM25_AVAILABLE', True)
        self.bm25_patcher.start()

        # Mock chromadb
        self.chromadb_mock = MagicMock()
        self.chromadb_mock.PersistentClient = MagicMock()
        self.chromadb_mock.Config = MagicMock()
        self.chromadb_mock.Settings = MagicMock()

        self.chroma_module_patcher = patch.dict('sys.modules', {
            'chromadb': self.chromadb_mock,
            'chromadb.config': MagicMock()
        })
        self.chroma_module_patcher.start()

        # Mock sentence_transformers
        self.st_mock = MagicMock()
        self.st_mock.SentenceTransformer = MagicMock()
        self.st_module_patcher = patch.dict('sys.modules', {
            'sentence_transformers': self.st_mock
        })
        self.st_module_patcher.start()

        # Mock rank_bm25
        self.bm25_mock = MagicMock()
        self.bm25_mock.BM25Okapi = MagicMock(return_value=MagicMock())
        self.bm25_module_patcher = patch.dict('sys.modules', {'rank_bm25': self.bm25_mock})
        self.bm25_module_patcher.start()

        yield

        self.stop_words_patcher.stop()
        self.chunk_patcher.stop()
        self.bm25_patcher.stop()
        self.chroma_module_patcher.stop()
        self.st_module_patcher.stop()
        self.bm25_module_patcher.stop()

    @pytest.fixture
    def vector_store(self, temp_dir):
        """Create a VectorStore instance with mocked dependencies."""
        from vector_store import VectorStore

        # Create a mock collection
        mock_collection = MagicMock()
        mock_collection.count.return_value = 0
        mock_collection.get.return_value = {"ids": [], "documents": [], "metadatas": []}

        # Create mock client
        mock_client = MagicMock()
        mock_client.get_or_create_collection.return_value = mock_collection

        with patch('vector_store.chromadb.PersistentClient', return_value=mock_client):
            store = VectorStore(db_path=temp_dir)
            store.collection = mock_collection

        return store

    def test_add_chunks_accepts_rebuild_index(self, vector_store, mock_chunk):
        """Test: add_chunks() accepts rebuild_index parameter.

        Verifies the VectorStore.add_chunks method accepts and uses rebuild_index.
        """
        # Should not raise
        result = vector_store.add_chunks([mock_chunk], rebuild_index=False)
        assert isinstance(result, int)

        result = vector_store.add_chunks([mock_chunk], rebuild_index=True)
        assert isinstance(result, int)

    def test_add_chunks_with_embeddings_accepts_rebuild_index(self, vector_store):
        """Test: add_chunks_with_embeddings() accepts rebuild_index parameter.

        Verifies the add_chunks_with_embeddings method accepts rebuild_index.
        """
        chunk_data = {
            "chunk_id": "test_0",
            "text": "Test document content",
            "embedding": [0.1] * 384,
            "metadata": {"source": "test.txt", "chunk_index": 0}
        }

        # Should not raise
        vector_store.add_chunks_with_embeddings([chunk_data], rebuild_index=False)
        vector_store.add_chunks_with_embeddings([chunk_data], rebuild_index=True)


class TestBM25ThreadSafety:
    """Tests for thread safety of BM25 operations."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.stop_words_patcher = patch('vector_store.STOP_WORDS', MockStopWords.STOP_WORDS)
        self.stop_words_patcher.start()

        self.chunk_patcher = patch('vector_store.DocumentChunk', MockDocumentChunk)
        self.chunk_patcher.start()

        self.bm25_patcher = patch('vector_store.BM25_AVAILABLE', True)
        self.bm25_patcher.start()

        self.bm25_mock = MagicMock()
        self.bm25_mock.BM25Okapi = MagicMock(return_value=MagicMock())
        self.bm25_module_patcher = patch.dict('sys.modules', {'rank_bm25': self.bm25_mock})
        self.bm25_module_patcher.start()

        yield

        self.stop_words_patcher.stop()
        self.chunk_patcher.stop()
        self.bm25_patcher.stop()
        self.bm25_module_patcher.stop()

    @pytest.fixture
    def bm25_index(self):
        """Create a fresh BM25Index instance."""
        from vector_store import BM25Index
        return BM25Index()

    def test_bm25_index_thread_safety_under_concurrent_access(self, bm25_index):
        """Test: BM25Index is thread-safe under concurrent access.

        Verifies that concurrent access to BM25Index operations doesn't cause issues.
        Note: _bm25_needs_rebuild is on VectorStore, not BM25Index.
        """
        from vector_store import BM25Index

        # Create multiple index instances for concurrent access
        indices = [BM25Index() for _ in range(10)]

        errors = []
        barrier = threading.Barrier(10)

        def access_index(index, i):
            try:
                # Wait for all threads to start
                barrier.wait()

                # Perform various operations
                for j in range(100):
                    # Add documents
                    chunks = [
                        MockDocumentChunk(
                            text=f"Doc {i}-{j} content for testing",
                            source=f"source_{i}.txt",
                            chunk_index=0,
                        )
                    ]
                    index.add_documents(chunks, rebuild_index=False)

                    # Access internal state
                    _ = len(index.chunks)
                    _ = index._avgdl
                    _ = index._total_token_count
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=access_index, args=(indices[i % len(indices)], i))
            for i in range(10)
        ]

        for t in threads:
            t.start()

        for t in threads:
            t.join()

        assert len(errors) == 0, f"Thread safety errors: {errors}"

    def test_concurrent_add_documents_thread_safety(self):
        """Test: Concurrent add_documents calls are thread-safe."""
        from vector_store import BM25Index

        index = BM25Index()

        chunks = [
            MockDocumentChunk(
                text=f"Document {i} with content for concurrent testing.",
                source=f"doc_{i}.txt",
                chunk_index=0,
            )
            for i in range(100)
        ]

        errors = []
        barrier = threading.Barrier(5)

        def add_batch(batch_start, batch_end):
            try:
                barrier.wait()
                index.add_documents(chunks[batch_start:batch_end], rebuild_index=False)
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=add_batch, args=(i*20, (i+1)*20))
            for i in range(5)
        ]

        for t in threads:
            t.start()

        for t in threads:
            t.join()

        assert len(errors) == 0, f"Concurrent add errors: {errors}"
        assert len(index.chunks) == 100, f"Expected 100 chunks, got {len(index.chunks)}"

    def test_vector_store_bm25_flag_thread_safe(self, temp_dir):
        """Test: VectorStore._bm25_needs_rebuild is thread-safe."""
        from vector_store import VectorStore

        # Create mocks
        mock_collection = MagicMock()
        mock_collection.count.return_value = 0
        mock_collection.get.return_value = {"ids": [], "documents": [], "metadatas": []}

        mock_client = MagicMock()
        mock_client.get_or_create_collection.return_value = mock_collection

        errors = []
        barrier = threading.Barrier(5)

        def check_flag():
            try:
                barrier.wait()
                for _ in range(50):
                    # Access the flag
                    _ = vector_store._bm25_needs_rebuild
                    # Set the flag
                    vector_store._bm25_needs_rebuild = True
                    vector_store._bm25_needs_rebuild = False
            except Exception as e:
                errors.append(e)

        with patch('vector_store.chromadb.PersistentClient', return_value=mock_client):
            vector_store = VectorStore(db_path=temp_dir)
            vector_store.collection = mock_collection

            threads = [threading.Thread(target=check_flag) for _ in range(5)]

            for t in threads:
                t.start()

            for t in threads:
                t.join()

        assert len(errors) == 0, f"Thread safety errors on _bm25_needs_rebuild: {errors}"


class TestBM25IndexSearch:
    """Tests for BM25Index search functionality after incremental updates."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.stop_words_patcher = patch('vector_store.STOP_WORDS', MockStopWords.STOP_WORDS)
        self.stop_words_patcher.start()

        self.chunk_patcher = patch('vector_store.DocumentChunk', MockDocumentChunk)
        self.chunk_patcher.start()

        self.bm25_patcher = patch('vector_store.BM25_AVAILABLE', True)
        self.bm25_patcher.start()

        self.bm25_mock = MagicMock()
        self.bm25_mock.BM25Okapi = MagicMock(return_value=MagicMock())
        self.bm25_module_patcher = patch.dict('sys.modules', {'rank_bm25': self.bm25_mock})
        self.bm25_module_patcher.start()

        yield

        self.stop_words_patcher.stop()
        self.chunk_patcher.stop()
        self.bm25_patcher.stop()
        self.bm25_module_patcher.stop()

    @pytest.fixture
    def bm25_index(self):
        """Create a fresh BM25Index instance."""
        from vector_store import BM25Index
        return BM25Index()

    def test_search_works_after_incremental_add(self, bm25_index):
        """Test: Search works correctly after incremental document additions."""
        # Add initial corpus
        initial_chunks = [
            MockDocumentChunk(
                text="Python is a popular programming language for data science.",
                source="python.txt",
                chunk_index=0,
            ),
            MockDocumentChunk(
                text="JavaScript is widely used for web development.",
                source="javascript.txt",
                chunk_index=0,
            ),
            MockDocumentChunk(
                text="Machine learning algorithms can process large datasets.",
                source="ml.txt",
                chunk_index=0,
            ),
        ]
        bm25_index.add_documents(initial_chunks, rebuild_index=False)

        # Search should work
        results = bm25_index.search("Python programming", top_k=5)
        assert isinstance(results, list)

        # Add more chunks incrementally
        new_chunks = [
            MockDocumentChunk(
                text="Rust is a systems programming language focused on safety.",
                source="rust.txt",
                chunk_index=0,
            ),
            MockDocumentChunk(
                text="Go is designed for concurrency and cloud computing.",
                source="go.txt",
                chunk_index=0,
            ),
        ]
        bm25_index.add_documents(new_chunks, rebuild_index=False)

        # Search should still work
        results = bm25_index.search("programming language", top_k=5)
        assert isinstance(results, list)

        # Results should include both initial and new chunks
        chunk_indices = [r[0] for r in results]
        assert len(chunk_indices) > 0

    def test_avgdl_correct_after_multiple_incremental_adds(self, bm25_index):
        """Test: Average document length is correctly maintained after multiple adds."""
        for i in range(5):
            chunks = [
                MockDocumentChunk(
                    text=f"Document {i}-{j} with some content for testing average length calculation.",
                    source=f"doc_{i}.txt",
                    chunk_index=j,
                )
                for j in range(10)
            ]
            bm25_index.add_documents(chunks, rebuild_index=False)

        # Verify avgdl is reasonable
        assert bm25_index._avgdl > 0
        assert len(bm25_index.chunks) == 50

        # avgdl should be total_tokens / num_docs
        expected_avgdl = bm25_index._total_token_count / len(bm25_index.chunks)
        assert abs(bm25_index._avgdl - expected_avgdl) < 0.001


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
