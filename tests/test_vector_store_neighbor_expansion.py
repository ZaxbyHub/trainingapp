"""
Tests for neighbor expansion optimization in vector_store.py.

This module tests the _expand_chunks_with_neighbors optimization which reduces
N ChromaDB queries to M queries (M = number of unique sources, M << N).
"""

import pytest
from unittest.mock import MagicMock, patch, call
from dataclasses import dataclass
from typing import List, Optional

# Import the module under test
import sys
sys.path.insert(0, '.')

from vector_store import VectorStore, BM25Index
from document_processor import DocumentChunk


@dataclass
class MockChunk:
    """Minimal mock of DocumentChunk for testing."""
    text: str
    source: str
    chunk_index: int
    page: Optional[int] = None


class TestExpandChunksWithNeighborsOptimization:
    """Tests for the neighbor expansion optimization."""

    def test_multiple_chunks_same_source_one_get_chunks_by_source_call(self):
        """Test: Multiple chunks from same source result in ONE get_chunks_by_source call.

        This verifies the core optimization: when expanding multiple chunks from the same
        source document, we should fetch that source's chunks exactly once, not once per chunk.
        """
        # Create a mock VectorStore
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        # Create 5 chunks all from the same source but different indices
        chunks = [
            MockChunk(text="chunk0", source="doc1.txt", chunk_index=0),
            MockChunk(text="chunk1", source="doc1.txt", chunk_index=1),
            MockChunk(text="chunk2", source="doc1.txt", chunk_index=2),
            MockChunk(text="chunk3", source="doc1.txt", chunk_index=3),
            MockChunk(text="chunk4", source="doc1.txt", chunk_index=4),
        ]

        # Track calls to get_chunks_by_source
        call_count = 0
        call_args = []

        def mock_get_chunks_by_source(source, indices=None):
            nonlocal call_count
            call_count += 1
            call_args.append((source, indices))
            # Return chunks matching the requested indices
            return [
                MockChunk(text=f"chunk{i}", source=source, chunk_index=i)
                for i in indices if i in [0, 1, 2, 3, 4]
            ]

        store.get_chunks_by_source = mock_get_chunks_by_source

        # Expand with window=1 (should include neighbors)
        result = store._expand_chunks_with_neighbors(chunks, window=1)

        # ASSERTION: With 5 chunks from same source, get_chunks_by_source should be called
        # exactly ONCE, not 5 times
        assert call_count == 1, (
            f"Expected 1 get_chunks_by_source call for 5 chunks from same source, "
            f"but got {call_count} calls. The optimization is broken!"
        )

        # Verify the source was correct
        assert call_args[0][0] == "doc1.txt"

    def test_get_chunks_by_source_indices_parameter_filters_correctly(self):
        """Test: get_chunks_by_source with indices parameter only returns chunks matching those indices.

        Verifies that when we pass a list of indices, only chunks with matching indices are returned.
        """
        # Create a mock VectorStore
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        # Set up mock collection
        store.collection = MagicMock()

        # Simulate stored chunks: indices 0-4 exist
        store.collection.get.return_value = {
            "documents": ["doc0", "doc1", "doc2", "doc3", "doc4"],
            "metadatas": [
                {"source": "test.txt", "chunk_index": 0, "page": 1},
                {"source": "test.txt", "chunk_index": 1, "page": 1},
                {"source": "test.txt", "chunk_index": 2, "page": 2},
                {"source": "test.txt", "chunk_index": 3, "page": 2},
                {"source": "test.txt", "chunk_index": 4, "page": 3},
            ]
        }

        # Call with specific indices
        result = store.get_chunks_by_source("test.txt", indices=[1, 3])

        # Should only return chunks at indices 1 and 3
        assert len(result) == 2, f"Expected 2 chunks, got {len(result)}"
        result_indices = {c.chunk_index for c in result}
        assert result_indices == {1, 3}, f"Expected indices {{1, 3}}, got {result_indices}"

    def test_expansion_includes_window_neighbors_correctly(self):
        """Test: Expansion includes ±window neighbors correctly.

        With window=2 and chunk at index 5, should include indices 3,4,5,6,7.
        """
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        # Single chunk at index 5
        chunks = [MockChunk(text="chunk5", source="doc.txt", chunk_index=5)]

        # Track the indices passed to get_chunks_by_source
        received_indices = None

        def mock_get_chunks_by_source(source, indices=None):
            nonlocal received_indices
            received_indices = indices
            # Return all chunks that would be in the range
            return [
                MockChunk(text=f"chunk{i}", source=source, chunk_index=i)
                for i in indices
            ]

        store.get_chunks_by_source = mock_get_chunks_by_source

        # Expand with window=2
        result = store._expand_chunks_with_neighbors(chunks, window=2)

        # For chunk at index 5 with window=2, should request indices 3,4,5,6,7
        expected_indices = {3, 4, 5, 6, 7}
        assert received_indices == sorted(received_indices), "Indices should be sorted"
        assert set(received_indices) == expected_indices, (
            f"For chunk at index 5 with window=2, expected indices {expected_indices}, "
            f"but got {received_indices}"
        )

    def test_same_chunk_not_duplicated_in_output(self):
        """Test: Same chunk not duplicated in output (dedup by source+chunk_index).

        When multiple chunks request overlapping neighbors, each (source, chunk_index)
        pair should appear only once in the output.
        """
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        # Two chunks from same source that overlap in their windows
        # Chunk 3's window (1-5) and chunk 4's window (2-6) both include indices 3,4
        chunks = [
            MockChunk(text="chunk3", source="doc.txt", chunk_index=3),
            MockChunk(text="chunk4", source="doc.txt", chunk_index=4),
        ]

        def mock_get_chunks_by_source(source, indices=None):
            # Return chunks for all requested indices
            return [
                MockChunk(text=f"chunk{i}", source=source, chunk_index=i)
                for i in indices if 1 <= i <= 6
            ]

        store.get_chunks_by_source = mock_get_chunks_by_source

        result = store._expand_chunks_with_neighbors(chunks, window=1)

        # Count occurrences of each (source, chunk_index) pair
        from collections import Counter
        counts = Counter((c.source, c.chunk_index) for c in result)

        # Every chunk should appear exactly once
        duplicates = [(key, count) for key, count in counts.items() if count > 1]
        assert len(duplicates) == 0, (
            f"Found duplicate chunks in output: {duplicates}. "
            f"Deduplication by (source, chunk_index) is broken!"
        )

        # Expected: indices 2,3,4,5 (chunk3's window + chunk4's window, deduped)
        expected_indices = {2, 3, 4, 5}
        result_indices = {c.chunk_index for c in result}
        assert result_indices == expected_indices, (
            f"Expected indices {expected_indices}, got {result_indices}"
        )

    def test_window_zero_returns_original_chunks_unchanged(self):
        """Test: Window=0 returns original chunks unchanged.

        When window is 0, the function should return the input chunks as-is,
        without any expansion or deduplication.
        """
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        original_chunks = [
            MockChunk(text="chunk0", source="doc.txt", chunk_index=0),
            MockChunk(text="chunk1", source="doc.txt", chunk_index=1),
            MockChunk(text="chunk2", source="doc.txt", chunk_index=2),
        ]

        # window=0 should return chunks unchanged
        result = store._expand_chunks_with_neighbors(original_chunks, window=0)

        # Should return exactly the same chunks
        assert len(result) == len(original_chunks)
        for orig, res in zip(original_chunks, result):
            assert res.text == orig.text
            assert res.source == orig.source
            assert res.chunk_index == orig.chunk_index

    def test_multiple_sources_multiple_calls(self):
        """Test: Different sources each get their own get_chunks_by_source call.

        Verifies that chunks from different sources are handled correctly,
        each source getting its own fetch.
        """
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        # Chunks from 3 different sources
        chunks = [
            MockChunk(text="chunk0", source="doc1.txt", chunk_index=0),
            MockChunk(text="chunk0", source="doc2.txt", chunk_index=0),
            MockChunk(text="chunk0", source="doc3.txt", chunk_index=0),
        ]

        call_count = 0

        def mock_get_chunks_by_source(source, indices=None):
            nonlocal call_count
            call_count += 1
            return [MockChunk(text=f"chunk0", source=source, chunk_index=0)]

        store.get_chunks_by_source = mock_get_chunks_by_source

        # Use window=1 so the expansion actually happens (window=0 returns early)
        result = store._expand_chunks_with_neighbors(chunks, window=1)

        # Should have 3 calls, one per source
        assert call_count == 3, f"Expected 3 calls (one per source), got {call_count}"

    def test_expansion_with_empty_indices_for_source(self):
        """Test: Expansion handles sources with no chunks gracefully."""
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        chunks = [MockChunk(text="chunk0", source="nonexistent.txt", chunk_index=0)]

        def mock_get_chunks_by_source(source, indices=None):
            # Simulate a source that doesn't exist in the store
            return []

        store.get_chunks_by_source = mock_get_chunks_by_source

        # Should not crash, just return empty
        result = store._expand_chunks_with_neighbors(chunks, window=1)
        assert result == []

    def test_expansion_boundary_indices(self):
        """Test: Expansion handles boundary indices correctly.

        Chunk at index 0 with window=2 should request indices 0,1,2 (not negative).
        """
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()

        # Chunk at index 0
        chunks = [MockChunk(text="chunk0", source="doc.txt", chunk_index=0)]

        received_indices = None

        def mock_get_chunks_by_source(source, indices=None):
            nonlocal received_indices
            received_indices = indices
            return [MockChunk(text=f"chunk{i}", source=source, chunk_index=i) for i in indices]

        store.get_chunks_by_source = mock_get_chunks_by_source

        result = store._expand_chunks_with_neighbors(chunks, window=2)

        # Should request indices 0,1,2 (not -2, -1)
        expected = {0, 1, 2}
        assert set(received_indices) == expected, (
            f"Chunk at index 0 with window=2 should request {expected}, got {received_indices}"
        )


class TestGetChunksBySource:
    """Tests for get_chunks_by_source method."""

    def test_get_chunks_by_source_returns_all_chunks_when_no_indices(self):
        """Test: When indices is None, all chunks from source are returned."""
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()
        store.collection = MagicMock()

        store.collection.get.return_value = {
            "documents": ["doc0", "doc1", "doc2"],
            "metadatas": [
                {"source": "test.txt", "chunk_index": 0, "page": 1},
                {"source": "test.txt", "chunk_index": 1, "page": 1},
                {"source": "test.txt", "chunk_index": 2, "page": 2},
            ]
        }

        result = store.get_chunks_by_source("test.txt")

        assert len(result) == 3
        assert [c.chunk_index for c in result] == [0, 1, 2]

    def test_get_chunks_by_source_returns_sorted_by_chunk_index(self):
        """Test: Results are sorted by chunk_index."""
        store = VectorStore.__new__(VectorStore)
        store._lock = MagicMock()
        store.collection = MagicMock()

        # Return in wrong order
        store.collection.get.return_value = {
            "documents": ["doc2", "doc0", "doc1"],
            "metadatas": [
                {"source": "test.txt", "chunk_index": 2, "page": 3},
                {"source": "test.txt", "chunk_index": 0, "page": 1},
                {"source": "test.txt", "chunk_index": 1, "page": 2},
            ]
        }

        result = store.get_chunks_by_source("test.txt")

        # Should be sorted by chunk_index regardless of storage order
        assert [c.chunk_index for c in result] == [0, 1, 2]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
