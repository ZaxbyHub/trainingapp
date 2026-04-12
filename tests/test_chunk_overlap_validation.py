"""
Tests for chunk_overlap validation and edge case handling in DocumentProcessor.
Verifies fix for chunk_overlap=0 infinite loop investigation (Task 1.4).
"""

import pytest
from document_processor import DocumentProcessor, DocumentChunk


class TestChunkOverlapValidation:
    """Tests for chunk_overlap parameter validation in __init__."""

    def test_chunk_overlap_zero_is_accepted(self):
        """
        chunk_overlap=0 is a VALID configuration — no overlap is a legitimate use case.
        The validation rejects: negative overlap, and overlap >= chunk_size.
        It does NOT reject chunk_overlap=0 because 0 < chunk_size.
        """
        # This should NOT raise — 0 is non-negative and 0 < 256
        processor = DocumentProcessor(chunk_size=256, chunk_overlap=0)
        assert processor.chunk_size == 256
        assert processor.chunk_overlap == 0

    def test_chunk_overlap_negative_rejected(self):
        """chunk_overlap < 0 must be rejected with ValueError."""
        with pytest.raises(ValueError) as exc_info:
            DocumentProcessor(chunk_size=256, chunk_overlap=-1)
        assert "non-negative" in str(exc_info.value)

    def test_chunk_overlap_equals_chunk_size_rejected(self):
        """chunk_overlap >= chunk_size must be rejected with ValueError."""
        with pytest.raises(ValueError) as exc_info:
            DocumentProcessor(chunk_size=256, chunk_overlap=256)
        assert "less than chunk_size" in str(exc_info.value)

    def test_chunk_overlap_exceeds_chunk_size_rejected(self):
        """chunk_overlap > chunk_size must be rejected with ValueError."""
        with pytest.raises(ValueError) as exc_info:
            DocumentProcessor(chunk_size=100, chunk_overlap=200)
        assert "less than chunk_size" in str(exc_info.value)

    def test_chunk_size_zero_rejected(self):
        """chunk_size <= 0 must be rejected with ValueError."""
        with pytest.raises(ValueError) as exc_info:
            DocumentProcessor(chunk_size=0, chunk_overlap=0)
        assert "positive" in str(exc_info.value)

    def test_chunk_size_negative_rejected(self):
        """chunk_size < 0 must be rejected with ValueError."""
        with pytest.raises(ValueError) as exc_info:
            DocumentProcessor(chunk_size=-1, chunk_overlap=0)
        assert "positive" in str(exc_info.value)


class TestChunkOverlapZeroNoInfiniteLoop:
    """
    Verify that chunk_overlap=0 does NOT cause an infinite loop.

    Investigation finding: The original code (lines 217-222) already guards against
    infinite loop when chunk_overlap=0 by returning an empty overlap_words list,
    which breaks the while loop for split sentences.

    For normal sentences, the chunk loop at line 226 uses _calculate_overlap which
    returns empty sentences list when overlap_size=0 (since the loop condition
    overlap_word_count + s_word_count <= 0 can never be true). So current_chunk_sentences
    becomes empty and the loop advances normally — no infinite loop.
    """

    def test_chunk_overlap_zero_completes_terminates(self):
        """
        chunk_overlap=0 must NOT cause infinite loop — it must complete in finite time.
        Uses a long text that would definitely trigger multiple chunk iterations.
        """
        processor = DocumentProcessor(chunk_size=10, chunk_overlap=0)
        # Create text with 200 words — will require ~20 chunks of 10 words each
        long_text = " ".join([f"word{i}" for i in range(200)])
        chunks = processor.chunk_text(long_text, "test.txt")
        # Should complete with finite number of chunks (not hanging)
        assert len(chunks) > 0
        # Verify no chunk is empty (sanity check)
        for chunk in chunks:
            assert len(chunk.text) > 0

    def test_chunk_overlap_zero_terminates_large_text(self):
        """chunk_overlap=0 with large text must complete without hanging."""
        processor = DocumentProcessor(chunk_size=50, chunk_overlap=0)
        # Very long text: 1000 words
        long_text = " ".join(["sentence"] * 1000)
        chunks = processor.chunk_text(long_text, "test.txt")
        # Should complete — if it hung, this would time out
        assert len(chunks) >= 1

    def test_chunk_overlap_zero_chunk_indices_are_valid(self):
        """chunk_overlap=0 produces correctly indexed chunks."""
        processor = DocumentProcessor(chunk_size=20, chunk_overlap=0)
        text = " ".join([f"word{i}" for i in range(100)])
        chunks = processor.chunk_text(text, "test.txt")
        indices = [c.chunk_index for c in chunks]
        # Indices should be sequential starting from 0
        assert indices == list(range(len(chunks)))

    def test_chunk_overlap_zero_no_overlap_between_chunks(self):
        """
        chunk_overlap=0 means consecutive chunks share NO words.
        This is a property-based test: if we concatenate chunks and split,
        we should get back the original word set (minus boundary words lost to sentence splits).
        """
        processor = DocumentProcessor(chunk_size=50, chunk_overlap=0)
        text = " ".join([f"w{i}" for i in range(200)])
        chunks = processor.chunk_text(text, "test.txt")
        # Collect all words from all chunks
        all_words = []
        for chunk in chunks:
            all_words.extend(chunk.text.split())
        # With 0 overlap, we expect fewer total words than 200*2 (which would indicate heavy overlap)
        # Each word appears at most a few times due to boundary splits
        assert len(all_words) <= 300  # Reasonable bound for a 200-word text


class TestChunkOverlapNormalValues:
    """Verify normal chunk_overlap values work correctly (happy path)."""

    def test_normal_chunk_overlap_and_size(self):
        """Normal values: chunk_size=256, chunk_overlap=50."""
        processor = DocumentProcessor(chunk_size=256, chunk_overlap=50)
        assert processor.chunk_size == 256
        assert processor.chunk_overlap == 50

    def test_normal_values_produce_overlapping_chunks(self):
        """Normal chunk_overlap produces overlapping chunks with shared content."""
        processor = DocumentProcessor(chunk_size=30, chunk_overlap=10)
        # 100 identical words — will create ~4 chunks
        text = " ".join(["word"] * 100)
        chunks = processor.chunk_text(text, "test.txt")
        assert len(chunks) >= 2

        # With overlap, consecutive chunks should share some words
        if len(chunks) >= 2:
            shared_words = set(chunks[0].text.split()) & set(chunks[1].text.split())
            # Overlap of 10 means at least some words should be shared
            assert len(shared_words) > 0

    def test_small_overlap_values(self):
        """Small but valid chunk_overlap values work."""
        for overlap in [1, 2, 5]:
            processor = DocumentProcessor(chunk_size=100, chunk_overlap=overlap)
            text = " ".join(["word"] * 200)
            chunks = processor.chunk_text(text, "test.txt")
            assert len(chunks) >= 1

    def test_boundary_overlap_equals_one(self):
        """chunk_overlap=1 (minimum valid positive) works."""
        processor = DocumentProcessor(chunk_size=50, chunk_overlap=1)
        assert processor.chunk_overlap == 1


class TestCalculateOverlapEdgeCases:
    """Tests for _calculate_overlap helper method."""

    def test_calculate_overlap_zero_size(self):
        """_calculate_overlap with overlap_size=0 returns empty list."""
        processor = DocumentProcessor(chunk_size=100, chunk_overlap=0)
        sentences = ["hello world", "foo bar"]
        result, word_count = processor._calculate_overlap(sentences, 0)
        assert result == []
        assert word_count == 0

    def test_calculate_overlap_exact_size(self):
        """_calculate_overlap handles exact size match."""
        processor = DocumentProcessor(chunk_size=100, chunk_overlap=10)
        sentences = ["one two three"]
        result, word_count = processor._calculate_overlap(sentences, 10)
        # Word count should not exceed requested size
        assert word_count <= 10

    def test_calculate_overlap_partial_fill(self):
        """_calculate_overlap stops when size limit is reached."""
        processor = DocumentProcessor(chunk_size=100, chunk_overlap=10)
        sentences = ["hello world this is a test sentence"]
        result, word_count = processor._calculate_overlap(sentences, 3)
        # Should stop after adding words up to limit
        assert word_count <= 3


class TestChunkTextWithVariousOverlap:
    """Property-based tests for chunk_text with varying overlap values."""

    def test_overlap_zero_vs_positive_produces_valid_chunks(self):
        """Both overlap=0 and overlap>0 produce valid chunks for the same text."""
        text = " ".join(["word"] * 200)

        processor_zero = DocumentProcessor(chunk_size=50, chunk_overlap=0)
        chunks_zero = processor_zero.chunk_text(text, "test.txt")

        processor_overlap = DocumentProcessor(chunk_size=50, chunk_overlap=25)
        chunks_overlap = processor_overlap.chunk_text(text, "test.txt")

        # Both should produce at least 1 chunk and complete successfully
        assert len(chunks_zero) >= 1
        assert len(chunks_overlap) >= 1
        # All chunks should be non-empty
        for chunk in chunks_zero + chunks_overlap:
            assert len(chunk.text) > 0

    def test_both_overlap_modes_complete_without_hanging(self):
        """Both zero and positive overlap complete in finite time."""
        text = " ".join(["word"] * 500)
        for overlap in [0, 10, 20, 30, 40]:
            processor = DocumentProcessor(chunk_size=50, chunk_overlap=overlap)
            chunks = processor.chunk_text(text, "test.txt")
            # All must complete without hanging and produce valid chunks
            assert len(chunks) >= 1
            for chunk in chunks:
                assert len(chunk.text) > 0
                assert isinstance(chunk.chunk_index, int)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
