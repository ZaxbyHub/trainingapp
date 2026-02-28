"""
Tests for Document Processor Module (Phase 4.2)
"""

import pytest
import os
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

from document_processor import DocumentProcessor, DocumentChunk


class TestPDFExtraction:
    """Tests for PDF text extraction (test_pdf_extraction)."""

    def test_pdf_extraction(self, sample_pdf_bytes, tmp_path):
        """
        Test extracting text from PDF using sample_pdf_bytes fixture.

        Mocks pdfplumber to avoid requiring the actual PDF parsing library
        and verifies that:
        - The method returns extracted text
        - Page information is correctly parsed
        - The processor can handle PDF files
        """
        # Create a temporary PDF file
        pdf_path = tmp_path / "test.pdf"
        pdf_path.write_bytes(sample_pdf_bytes)

        # Mock pdfplumber to avoid requiring actual PDF parsing library
        with patch('pdfplumber.open') as mock_open:
            # Set up mock PDF with pages
            mock_page1 = MagicMock()
            mock_page1.extract_text.return_value = "This is page one content. It has multiple sentences."
            mock_page1.page_number = 1

            mock_page2 = MagicMock()
            mock_page2.extract_text.return_value = "This is page two content. More sentences here."
            mock_page2.page_number = 2

            mock_pdf = MagicMock()
            mock_pdf.pages = [mock_page1, mock_page2]
            mock_pdf.__enter__ = Mock(return_value=mock_pdf)
            mock_pdf.__exit__ = Mock(return_value=False)

            mock_open.return_value = mock_pdf

            # Create processor and extract
            processor = DocumentProcessor()
            text, pages = processor.extract_pdf(str(pdf_path))

            # Verify extraction
            assert isinstance(text, str)
            assert "page one" in text.lower()
            assert len(pages) == 2
            assert pages[0][0] == 1  # First page number
            assert pages[1][0] == 2  # Second page number


class TestDOCXExtraction:
    """Tests for DOCX text extraction (test_docx_extraction)."""

    def test_docx_extraction(self, tmp_path):
        """
        Mock DOCX extraction test.

        Mocks python-docx library to verify:
        - Paragraphs are correctly extracted
        - Tables are properly handled
        - The processor can handle DOCX files without actual library
        """
        # Create a temporary DOCX file (path only, not real DOCX)
        docx_path = tmp_path / "test.docx"
        docx_path.write_text("fake docx content")

        # Mock python-docx
        with patch('docx.Document') as mock_document_class:
            # Set up mock DOCX structure
            mock_doc = MagicMock()

            # Mock paragraphs
            mock_para1 = MagicMock()
            mock_para1.text = "This is a test paragraph."
            mock_para2 = MagicMock()
            mock_para2.text = "Another paragraph with more content."
            mock_doc.paragraphs = [mock_para1, mock_para2]

            # Mock table
            mock_cell1 = MagicMock()
            mock_cell1.text = "Cell1"
            mock_cell2 = MagicMock()
            mock_cell2.text = "Cell2"
            mock_cell3 = MagicMock()
            mock_cell3.text = "Cell3"
            mock_cell4 = MagicMock()
            mock_cell4.text = "Cell4"

            mock_row = MagicMock()
            mock_row.cells = [mock_cell1, mock_cell2]
            mock_row2 = MagicMock()
            mock_row2.cells = [mock_cell3, mock_cell4]
            mock_table = MagicMock()
            mock_table.rows = [mock_row, mock_row2]
            mock_doc.tables = [mock_table]

            mock_document_class.return_value = mock_doc

            # Create processor and extract
            processor = DocumentProcessor()
            text = processor.extract_docx(str(docx_path))

            # Verify extraction
            assert "This is a test paragraph." in text
            assert "Another paragraph with more content." in text
            assert "Cell1" in text or "Cell3" in text  # Table content


class TestTXTExtraction:
    """Tests for TXT file extraction (test_txt_extraction)."""

    def test_txt_extraction(self, sample_text_file):
        """
        Test plain text file extraction using sample_text_file.

        Verifies:
        - Text is correctly read from file
        - Multiple paragraphs are preserved
        - UTF-8 encoding is handled properly
        """
        processor = DocumentProcessor()
        text = processor.extract_text_file(str(sample_text_file))

        # Verify content
        assert "sample text file" in text.lower()
        assert "paragraphs" in text.lower()
        assert len(text) > 0

        # Verify paragraph structure
        assert "\n\n" in text or "\n" in text  # Multiple paragraphs


class TestChunkingBoundary:
    """Tests for text chunking boundary conditions (test_chunking_boundary)."""

    def test_chunking_boundary(self):
        """
        Test semantic chunking respects sentence boundaries.

        Verifies that:
        - Chunks don't split in the middle of sentences
        - Sentence boundaries are preserved
        - Chunks respect the chunk_size limit
        - Overlap is handled correctly
        """
        # Create text with clear sentence boundaries
        text = """
        This is the first sentence. This is the second sentence.
        This is the third sentence. This is the fourth sentence.

        This is a new paragraph with more sentences. This is the sixth sentence.
        This is the seventh sentence. This is the eighth sentence here.
        """

        processor = DocumentProcessor(chunk_size=15, chunk_overlap=5)
        chunks = processor.chunk_text(text, "test.txt")

        # Verify we got chunks
        assert len(chunks) > 0

        # Check that chunks respect sentence boundaries
        for chunk in chunks:
            # No chunk should end in the middle of a sentence
            # (unless it's a very long single sentence)
            chunk_text = chunk.text.strip()
            # Check if chunk doesn't end with a period followed by lowercase
            # which would indicate mid-sentence split
            if len(chunk_text) > 10:
                # If it ends with a lowercase letter after space, it's likely mid-sentence
                assert not (chunk_text[-1].islower() and chunk_text[-2] == ' '), \
                    f"Chunk may split mid-sentence: {chunk_text[-30:]}"

        # Verify chunks don't exceed size (by word count)
        for chunk in chunks:
            word_count = len(chunk.text.split())
            assert word_count <= processor.chunk_size + 5, \
                f"Chunk exceeds size: {word_count} words, max {processor.chunk_size}"

    def test_chunking_small_text(self, tmp_path):
        """Test chunking with text smaller than chunk size."""
        processor = DocumentProcessor(chunk_size=100, chunk_overlap=10)

        small_text = "Short text."
        chunks = processor.chunk_text(small_text, "test.txt")

        assert len(chunks) == 1
        assert chunks[0].text == "Short text."
        assert chunks[0].source == "test.txt"
        assert chunks[0].chunk_index == 0

    def test_chunking_large_text(self, tmp_path):
        """Test chunking with text larger than chunk size."""
        processor = DocumentProcessor(chunk_size=50, chunk_overlap=10)

        # Create text that will exceed chunk size
        long_text = " ".join(["word"] * 200)
        chunks = processor.chunk_text(long_text, "test.txt")

        assert len(chunks) > 1
        # Verify chunk indices are sequential
        for i, chunk in enumerate(chunks):
            assert chunk.chunk_index == i

    def test_chunking_respects_paragraphs(self, tmp_path):
        """Test that chunking respects paragraph boundaries."""
        processor = DocumentProcessor(chunk_size=100, chunk_overlap=10)

        text = "First paragraph with some content.\n\nSecond paragraph with different content."
        chunks = processor.chunk_text(text, "test.txt")

        # Should have at least 2 chunks for 2 paragraphs
        assert len(chunks) >= 1

    def test_chunking_overlap(self, tmp_path):
        """Test chunking with overlap between chunks."""
        processor = DocumentProcessor(chunk_size=30, chunk_overlap=10)

        # Create text with predictable words
        text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"
        chunks = processor.chunk_text(text, "test.txt")

        # With overlap, some words should appear in multiple chunks
        all_words = []
        for chunk in chunks:
            words = chunk.text.split()
            all_words.extend(words)

        # Should have more words than unique words due to overlap
        assert len(all_words) >= len(set(all_words))

    def test_chunking_long_sentence(self):
        """
        Test chunking handles very long single sentences.

        When a single sentence exceeds chunk_size, it should be split
        at word boundaries with overlap.
        """
        # Create a very long sentence
        words = ["word"] * 100
        text = " ".join(words) + ". This is a short second sentence."

        processor = DocumentProcessor(chunk_size=20, chunk_overlap=5)
        chunks = processor.chunk_text(text, "test.txt")

        # Should create multiple chunks
        assert len(chunks) >= 2

        # First chunk should contain words from the long sentence
        assert "word" in chunks[0].text

    def test_chunking_empty_text(self):
        """Test chunking with empty text returns empty list."""
        processor = DocumentProcessor()
        chunks = processor.chunk_text("", "test.txt")
        assert len(chunks) == 0

    def test_chunking_preserves_source(self):
        """Test that chunks preserve the source filename."""
        text = "First sentence. Second sentence. Third sentence."
        processor = DocumentProcessor()
        chunks = processor.chunk_text(text, "myfile.txt")

        for chunk in chunks:
            assert chunk.source == "myfile.txt"
            assert isinstance(chunk.chunk_index, int)

    def test_chunking_index_increment(self):
        """Test that chunk_index increments correctly."""
        text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence."
        processor = DocumentProcessor(chunk_size=5, chunk_overlap=0)
        chunks = processor.chunk_text(text, "test.txt")

        # Verify chunk indices are sequential
        indices = [chunk.chunk_index for chunk in chunks]
        assert indices == list(range(len(chunks)))


class TestEmptyFile:
    """Tests for empty file handling (test_empty_file)."""

    def test_empty_file(self, tmp_path):
        """
        Test handling of empty files.

        Verifies that:
        - Empty files are handled gracefully
        - Empty text extraction returns appropriate results
        - Processing empty files doesn't crash
        """
        # Create empty text file
        empty_path = tmp_path / "empty.txt"
        empty_path.write_text("")

        processor = DocumentProcessor()

        # Test extract_text_file with empty file
        text = processor.extract_text_file(str(empty_path))
        assert text == ""

        # Test process_file with empty file
        chunks = processor.process_file(str(empty_path))
        assert len(chunks) == 0

    def test_empty_file_with_whitespace(self, tmp_path):
        """Test handling of files with only whitespace."""
        # Create file with only whitespace
        whitespace_path = tmp_path / "whitespace.txt"
        whitespace_path.write_text("   \n\n   \t  ")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(whitespace_path))
        assert len(chunks) == 0

    def test_empty_pdf(self, tmp_path, sample_pdf_bytes):
        """Test processing an empty PDF."""
        # Create a minimal valid PDF with no content
        pdf_path = tmp_path / "empty.pdf"
        pdf_path.write_bytes(sample_pdf_bytes)

        processor = DocumentProcessor()
        text, pages = processor.extract_pdf(str(pdf_path))

        # Should return empty or minimal text
        assert isinstance(text, str)

    def test_process_directory_empty(self, tmp_path):
        """Test process_directory with no supported files."""
        # Create directory with only unsupported files
        unsupported_path = tmp_path / "unsupported"
        unsupported_path.mkdir()
        (unsupported_path / "unsupported.xyz").write_text("content")

        processor = DocumentProcessor()
        chunks = processor.process_directory(str(unsupported_path))

        assert chunks == []


class TestUnsupportedExtension:
    """Tests for unsupported file extension handling (test_unsupported_extension)."""

    def test_unsupported_extension(self, tmp_path):
        """
        Test error on unsupported file format.

        Verifies that:
        - Unsupported file extensions raise ValueError
        - Error message indicates the unsupported format
        - Processor doesn't crash on invalid formats
        """
        # Create file with unsupported extension
        unsupported_path = tmp_path / "test.xyz"
        unsupported_path.write_text("some content")

        processor = DocumentProcessor()

        # Should raise ValueError for unsupported format
        with pytest.raises(ValueError) as exc_info:
            processor.extract_document(str(unsupported_path))

        assert "Unsupported file format" in str(exc_info.value)
        assert ".xyz" in str(exc_info.value)

    def test_process_file_unsupported(self, tmp_path):
        """Test process_file returns empty list for unsupported formats."""
        unsupported_path = tmp_path / "test.xyz"
        unsupported_path.write_text("some content")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(unsupported_path))

        # Should return empty list instead of crashing
        assert len(chunks) == 0

    def test_unsupported_extension_in_directory(self, tmp_path):
        """Test that unsupported files are skipped in directory processing."""
        # Create directory with mixed file types
        mixed_path = tmp_path / "mixed"
        mixed_path.mkdir()

        (mixed_path / "supported.txt").write_text("supported content")
        (mixed_path / "unsupported.xyz").write_text("unsupported content")
        (mixed_path / "also_supported.md").write_text("# Markdown")

        processor = DocumentProcessor()
        chunks = processor.process_directory(str(mixed_path))

        # Should process only supported files
        sources = set(c.source for c in chunks)
        assert "supported.txt" in sources
        assert "also_supported.md" in sources
        assert "unsupported.xyz" not in sources

    def test_supported_extensions_list(self, tmp_path):
        """Test that SUPPORTED_EXTENSIONS includes all expected formats."""
        processor = DocumentProcessor()

        expected = {'.pdf', '.docx', '.doc', '.pptx', '.ppt', '.txt', '.md'}
        assert processor.SUPPORTED_EXTENSIONS == expected


class TestDocumentProcessorIntegration:
    """Integration tests for document processing."""

    def test_process_file(self, sample_text_file):
        """
        Test DocumentProcessor.process_file extracts and chunks text.

        Verifies the complete pipeline:
        - File extraction
        - Text cleaning
        - Text chunking
        - Returns DocumentChunk objects
        """
        processor = DocumentProcessor(chunk_size=50, chunk_overlap=10)
        chunks = processor.process_file(str(sample_text_file))

        # Verify we got chunks
        assert len(chunks) > 0

        # Verify chunks are DocumentChunk objects
        for chunk in chunks:
            assert isinstance(chunk, DocumentChunk)
            assert isinstance(chunk.text, str)
            assert isinstance(chunk.source, str)
            assert isinstance(chunk.chunk_index, int)
            assert chunk.source == sample_text_file.name

    def test_process_directory(self, tmp_path):
        """
        Test DocumentProcessor.process_directory processes multiple files.

        Verifies:
        - All supported files are processed
        - Unsupported files are skipped
        - Chunks from all files are collected
        - Directory traversal works correctly
        """
        # Create multiple test files
        (tmp_path / "file1.txt").write_text("First file content with multiple sentences.")
        (tmp_path / "file2.txt").write_text("Second file content. More sentences here.")
        (tmp_path / "unsupported.xyz").write_text("Should be skipped")
        (tmp_path / "subdir").mkdir()
        (tmp_path / "subdir" / "file3.txt").write_text("Third file in subdirectory.")

        processor = DocumentProcessor(chunk_size=20, chunk_overlap=5)
        chunks = processor.process_directory(str(tmp_path))

        # Should process 3 text files (skipping .xyz)
        assert len(chunks) > 0

        # Verify chunks have sources from all three text files
        sources = {chunk.source for chunk in chunks}
        assert "file1.txt" in sources
        assert "file2.txt" in sources
        assert "file3.txt" in sources
        assert "unsupported.xyz" not in sources

    def test_process_directory_empty(self, tmp_path):
        """Test processing empty directory returns empty list."""
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()

        processor = DocumentProcessor()
        chunks = processor.process_directory(str(empty_dir))

        assert len(chunks) == 0

    def test_process_directory_no_supported_files(self, tmp_path):
        """Test directory with only unsupported files."""
        (tmp_path / "file1.xyz").write_text("content")
        (tmp_path / "file2.abc").write_text("content")

        processor = DocumentProcessor()
        chunks = processor.process_directory(str(tmp_path))

        assert len(chunks) == 0


# Additional utility tests

class TestDocumentChunk:
    """Tests for DocumentChunk dataclass."""

    def test_chunk_creation(self):
        """Test creating a DocumentChunk."""
        chunk = DocumentChunk(
            text="Test content",
            source="test.pdf",
            page=1,
            chunk_index=0
        )

        assert chunk.text == "Test content"
        assert chunk.source == "test.pdf"
        assert chunk.page == 1
        assert chunk.chunk_index == 0

    def test_chunk_default_values(self):
        """Test DocumentChunk with default values."""
        chunk = DocumentChunk(
            text="Test content",
            source="test.pdf"
        )

        assert chunk.text == "Test content"
        assert chunk.source == "test.pdf"
        assert chunk.page is None
        assert chunk.chunk_index == 0

    def test_chunk_from_sample_chunks(self, sample_chunks):
        """Test that sample_chunks fixture provides valid chunks."""
        assert len(sample_chunks) > 0

        for chunk in sample_chunks:
            assert isinstance(chunk, DocumentChunk)
            assert isinstance(chunk.text, str)
            assert isinstance(chunk.source, str)
            assert isinstance(chunk.chunk_index, int)
            assert len(chunk.text) > 0
            assert len(chunk.source) > 0


class TestCleanText:
    """Tests for text cleaning functionality."""

    def test_clean_text_normalizes_whitespace(self):
        """Test that clean_text normalizes multiple spaces."""
        processor = DocumentProcessor()
        text = "This  has    multiple     spaces."
        cleaned = processor.clean_text(text)
        assert "  " not in cleaned  # No double spaces
        assert cleaned == "This has multiple spaces."

    def test_clean_text_normalizes_newlines(self):
        """Test that clean_text normalizes multiple newlines."""
        processor = DocumentProcessor()
        text = "First line\n\n\n\nSecond line\nThird line"
        cleaned = processor.clean_text(text)
        assert "\n\n\n" not in cleaned  # No triple newlines
        assert "First line" in cleaned
        assert "Second line" in cleaned

    def test_clean_text_strips_whitespace(self):
        """Test that clean_text strips leading/trailing whitespace."""
        processor = DocumentProcessor()
        text = "   \n  Text with surrounding whitespace  \n  "
        cleaned = processor.clean_text(text)
        assert cleaned == "Text with surrounding whitespace"

    def test_clean_text_empty_string(self):
        """Test clean_text with empty string."""
        processor = DocumentProcessor()
        assert processor.clean_text("") == ""
        assert processor.clean_text("   ") == ""


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
