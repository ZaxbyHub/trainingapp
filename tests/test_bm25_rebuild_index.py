"""
Tests for BM25 rebuild_index parameter (O(n²) rebuild performance fix).

Verifies:
1. add_documents() accepts rebuild_index parameter
2. When rebuild_index=False, build_index is NOT called
3. When rebuild_index=True, build_index IS called (backward compatible)
4. Batch operations can defer rebuilding for performance
"""

import pytest
from unittest.mock import patch, MagicMock
from vector_store import BM25Index
from document_processor import DocumentChunk


@pytest.fixture
def sample_chunks():
    """Two sample chunks for testing."""
    return [
        DocumentChunk(
            text="Python is a programming language.",
            source="test.txt",
            chunk_index=0,
        ),
        DocumentChunk(
            text="Machine learning uses algorithms.",
            source="test.txt",
            chunk_index=1,
        ),
    ]


class TestBM25RebuildIndexParameter:
    """Tests for rebuild_index parameter on BM25Index methods."""

    def test_add_documents_accepts_rebuild_index_true(self, sample_chunks):
        """add_documents() accepts rebuild_index=True and calls build_index."""
        index = BM25Index()

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            index.add_documents(sample_chunks, rebuild_index=True)

            # build_index should have been called once with all chunks
            mock_build.assert_called_once()
            assert mock_build.call_args[0][0] == sample_chunks
            # Index should be ready
            assert index.chunks == sample_chunks

    def test_add_documents_accepts_rebuild_index_false(self, sample_chunks):
        """add_documents() accepts rebuild_index=False and skips build_index."""
        index = BM25Index()

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            index.add_documents(sample_chunks, rebuild_index=False)

            # build_index should NOT have been called
            mock_build.assert_not_called()
            # Chunks should still be added
            assert index.chunks == sample_chunks

    def test_add_documents_default_rebuilds(self, sample_chunks):
        """add_documents() defaults to rebuild_index=True for backward compatibility."""
        index = BM25Index()

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            index.add_documents(sample_chunks)

            mock_build.assert_called_once()
            assert index.chunks == sample_chunks

    def test_add_documents_multiple_false_then_true(self):
        """Multiple add_documents(rebuild_index=False) calls defer rebuild until rebuild_index=True."""
        index = BM25Index()
        chunks1 = [
            DocumentChunk(text="first chunk", source="a.txt", chunk_index=0),
        ]
        chunks2 = [
            DocumentChunk(text="second chunk", source="b.txt", chunk_index=0),
        ]

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            # First add with rebuild_index=False
            index.add_documents(chunks1, rebuild_index=False)
            # Second add with rebuild_index=False
            index.add_documents(chunks2, rebuild_index=False)

            # build_index should NOT have been called yet
            assert mock_build.call_count == 0
            # Both chunks should be accumulated
            assert len(index.chunks) == 2

            # Now rebuild once
            index.add_documents([], rebuild_index=True)

            # build_index should have been called exactly once with all chunks
            assert mock_build.call_count == 1
            assert mock_build.call_args[0][0] == index.chunks

    def test_add_document_accepts_rebuild_index_true(self):
        """add_document() accepts rebuild_index=True and calls build_index."""
        index = BM25Index()

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            index.add_document("chunk1", "Some text content here.", rebuild_index=True)

            mock_build.assert_called_once()
            assert len(index.chunks) == 1

    def test_add_document_accepts_rebuild_index_false(self):
        """add_document() accepts rebuild_index=False and skips build_index."""
        index = BM25Index()

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            index.add_document("chunk1", "Some text content here.", rebuild_index=False)

            mock_build.assert_not_called()
            assert len(index.chunks) == 1

    def test_add_document_default_rebuilds(self):
        """add_document() defaults to rebuild_index=True for backward compatibility."""
        index = BM25Index()

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            index.add_document("chunk1", "Some text content here.")

            mock_build.assert_called_once()
            assert len(index.chunks) == 1

    def test_add_documents_rebuild_false_preserves_existing_index(self, sample_chunks):
        """When rebuild_index=False, existing bm25_index is NOT modified."""
        index = BM25Index()
        # Pre-build the index with initial chunks
        initial_chunks = [
            DocumentChunk(text="existing content", source="init.txt", chunk_index=0),
        ]
        index.build_index(initial_chunks)

        # Capture the original bm25_index object reference
        original_bm25_index = index.bm25_index

        # Add more chunks WITHOUT rebuilding
        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            index.add_documents(sample_chunks, rebuild_index=False)

            mock_build.assert_not_called()
            # bm25_index should be unchanged
            assert index.bm25_index is original_bm25_index

    def test_batch_deferred_rebuild_performance(self):
        """Simulates batch adding 5 chunks in separate calls without rebuild, then rebuilding once."""
        index = BM25Index()

        with patch.object(index, "build_index", wraps=index.build_index) as mock_build:
            for i in range(5):
                chunk = DocumentChunk(
                    text=f"Batch chunk number {i}",
                    source="batch.txt",
                    chunk_index=i,
                )
                index.add_documents([chunk], rebuild_index=False)

            # build_index should NOT have been called during batch additions
            assert mock_build.call_count == 0
            assert len(index.chunks) == 5

            # Single rebuild after all additions
            index.add_documents([], rebuild_index=True)

            # build_index called exactly once for the final rebuild
            assert mock_build.call_count == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
