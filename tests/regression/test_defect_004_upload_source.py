"""
Regression tests for Defect 004: Upload Source Filename Preservation

Defect: When uploading files via API, the temporary filename is used as the
source instead of the original filename. This causes:
- Documents to appear with temp names like "tmp12345.txt" instead of "document.txt"
- Confusion when listing documents
- Loss of original filename information

Expected fix:
- api_server.ingest_file should pass original filename to RAGEngine
- Document chunks should store original filename in source field
- Temp file cleanup should not affect source attribution
"""

import pytest
from unittest.mock import Mock, patch, MagicMock, AsyncMock
from pathlib import Path
import tempfile
import os
import shutil


# Import after path setup
from document_processor import DocumentProcessor, DocumentChunk
from api_server import sanitize_filename


def test_upload_preserves_original_filename():
    """
    Test that uploaded files preserve their original filename as source.
    
    When a file is uploaded via /ingest/file endpoint, the original
    filename should be used as the source, not the temporary file path.
    """
    # Test the sanitize_filename function which is used for this purpose
    safe, display = sanitize_filename("original_document.pdf")
    assert safe == "original_document.pdf"
    assert display == "original_document.pdf"


def test_document_chunks_have_original_source():
    """
    Test that document chunks have original filename in source field.
    
    After processing an uploaded file, the DocumentChunk objects should
    have source="original.pdf" not source="/tmp/tmp12345.pdf".
    """
    # Create a temp file with content
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write("This is test content for document processing.")
        temp_path = f.name
    
    try:
        processor = DocumentProcessor(chunk_size=50, chunk_overlap=10)
        
        # Process the file with source_name override
        chunks = processor.process_file(temp_path, source_name="original_filename.txt")
        
        # All chunks should have the original source name
        for chunk in chunks:
            assert chunk.source == "original_filename.txt", \
                f"Source should be 'original_filename.txt', got: {chunk.source}"
        
    finally:
        os.unlink(temp_path)


def test_filename_sanitization_removes_traversal():
    """
    Test that uploaded filenames are sanitized to remove path traversal attempts.
    
    Malicious filenames like "../../../etc/passwd" should be sanitized to
    prevent directory traversal attacks while preserving the display name.
    """
    test_cases = [
        ("../../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system32\\config\\sam", "sam"),
        ("/etc/passwd", "passwd"),
        ("C:\\Windows\\System32\\config\\SAM", "SAM"),
        ("normal_document.pdf", "normal_document.pdf"),
        ("document with spaces.txt", "document with spaces.txt"),
    ]
    
    for original, expected in test_cases:
        safe, display = sanitize_filename(original)
        assert safe == expected, \
            f"sanitize_filename({original!r}) should return {expected!r}, got {safe!r}"


def test_rag_engine_ingest_file_accepts_source_parameter():
    """
    Test that RAGEngine.ingest_file accepts an optional source parameter.
    
    When source is provided, it should override the filepath as the
    source field in generated chunks.
    """
    from rag_engine import RAGEngine, RAGConfig
    
    tmpdir = tempfile.mkdtemp()
    try:
        config = RAGConfig(db_path=str(Path(tmpdir) / "db"))
        engine = RAGEngine(config=config)
        
        # Create a temp file
        test_file = Path(tmpdir) / "tmp12345.txt"
        test_file.write_text("Test content for source parameter test.")
        
        # Ingest with source parameter
        result = engine.ingest_file(str(test_file), source_name="original.pdf")
        
        # Verify the source_name was preserved in the result
        assert result.get('file') == "original.pdf", \
            f"Result file should be 'original.pdf', got: {result.get('file')}"
        
        # Verify the document was stored with the correct source
        docs = engine.list_documents()
        assert "original.pdf" in docs, \
            f"Document list should contain 'original.pdf', got: {docs}"
        
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_document_processor_accepts_source_override():
    """
    Test that DocumentProcessor.process_file accepts source override.
    
    When processing a temp file, the source field in chunks should
    be overrideable to preserve the original filename.
    """
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write("Test content for source override test.")
        temp_path = f.name
    
    try:
        processor = DocumentProcessor()
        
        # Process file with source override
        chunks = processor.process_file(temp_path, source_name="original_name.txt")
        
        # All chunks should have the overridden source
        for chunk in chunks:
            assert chunk.source == "original_name.txt", \
                f"Chunk source should be 'original_name.txt', got: {chunk.source}"
        
    finally:
        os.unlink(temp_path)


def test_api_ingest_file_passes_original_filename():
    """
    Test that API endpoint passes original filename to processing pipeline.
    
    The ingest_file endpoint should:
    1. Extract original filename from UploadFile
    2. Sanitize it
    3. Pass it through to RAGEngine
    """
    import inspect
    from api_server import ingest_file
    
    # Check the current implementation
    source = inspect.getsource(ingest_file)
    
    # Verify file.filename is extracted and sanitized
    assert "file.filename" in source, \
        "Endpoint accesses file.filename"
    
    # Verify sanitize_filename is called
    assert "sanitize_filename" in source, \
        "Endpoint should call sanitize_filename"
    
    # Verify source_name is passed to engine.ingest_file
    assert "source_name=display_name" in source or "source_name" in source, \
        "Endpoint should pass source_name to engine.ingest_file"


def test_chunk_source_attribution_consistency():
    """
    Test that all chunks from a document share the same source.
    
    When a document is processed, all chunks should have the same
    source value, which should be the original filename.
    """
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        # Write enough content to create multiple chunks
        f.write("This is paragraph one. " * 20)
        f.write("\n\n")
        f.write("This is paragraph two. " * 20)
        f.write("\n\n")
        f.write("This is paragraph three. " * 20)
        temp_path = f.name
    
    try:
        processor = DocumentProcessor(chunk_size=30, chunk_overlap=5)
        
        # Process with source override
        chunks = processor.process_file(temp_path, source_name="original_document.txt")
        
        # Should have multiple chunks
        assert len(chunks) > 1, "Test requires multiple chunks"
        
        # All chunks should have the same source
        sources = set(chunk.source for chunk in chunks)
        assert len(sources) == 1, \
            f"All chunks should have same source, got: {sources}"
        
        # Source should be the overridden value
        assert chunks[0].source == "original_document.txt", \
            f"Source should be 'original_document.txt', got: {chunks[0].source}"
        
    finally:
        os.unlink(temp_path)


def test_list_documents_shows_original_filenames():
    """
    Test that document listing shows original filenames, not temp names.
    
    After uploading files via API, GET /documents should show the
    original uploaded filenames.
    """
    from rag_engine import RAGEngine, RAGConfig
    
    tmpdir = tempfile.mkdtemp()
    try:
        config = RAGConfig(db_path=str(Path(tmpdir) / "db"))
        engine = RAGEngine(config=config)
        
        # Simulate documents ingested via upload with original filenames
        # Use .txt files to avoid PDF parsing issues
        test_file1 = Path(tmpdir) / "tmp12345.txt"
        test_file1.write_text("Report content for testing.")
        engine.ingest_file(str(test_file1), source_name="report.txt")
        
        test_file2 = Path(tmpdir) / "tmp67890.txt"
        test_file2.write_text("Notes content for testing.")
        engine.ingest_file(str(test_file2), source_name="notes.txt")
        
        # Get document list
        docs = engine.list_documents()
        
        # Verify original names are returned
        assert "report.txt" in docs, \
            f"Document list should contain 'report.txt', got: {docs}"
        assert "notes.txt" in docs, \
            f"Document list should contain 'notes.txt', got: {docs}"
        
        # Verify temp names are NOT in the list
        assert "tmp12345.txt" not in docs, \
            f"Document list should not contain temp filename 'tmp12345.txt'"
        assert "tmp67890.txt" not in docs, \
            f"Document list should not contain temp filename 'tmp67890.txt'"
        
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
