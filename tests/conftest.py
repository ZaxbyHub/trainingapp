"""
Shared pytest fixtures for the test suite.
"""

import pytest
from pathlib import Path
from typing import List, Dict, Any
from unittest.mock import Mock, MagicMock
from dataclasses import dataclass


# Try to import from project modules, handle gracefully for test env
try:
    from document_processor import DocumentChunk
    from vector_store import VectorStore
    from llm_interface import SmartLLM, InferenceConfig
    MODULES_AVAILABLE = True
except ImportError:
    MODULES_AVAILABLE = False
    # Create stub classes for tests when modules aren't available
    @dataclass
    class DocumentChunk:
        text: str
        source: str
        page: int = None
        chunk_index: int = 0


@pytest.fixture
def temp_chroma_db(tmp_path):
    """
    Temporary ChromaDB directory for testing.

    Uses pytest's tmp_path fixture which automatically cleans up
    after the test completes.

    Yields:
        Path: Path to temporary directory for ChromaDB storage
    """
    db_path = tmp_path / "chroma_db"
    db_path.mkdir()
    yield db_path
    # tmp_path is automatically cleaned up by pytest


@pytest.fixture
def mock_llm(monkeypatch):
    """
    Mock LLM that returns canned responses.

    This fixture creates a mock of the SmartLLM class with predictable
    responses for testing purposes without requiring actual LLM inference.

    Returns:
        Mock: Mocked SmartLLM instance with predefined responses
    """
    # Create mock instance
    mock = MagicMock(spec=SmartLLM)

    # Set up generate() to return a canned response
    mock.generate.return_value = "This is a test answer about the query."

    # Set up answer_question() to return a canned response
    mock.answer_question.return_value = "Test answer based on context."

    # Set up get_info() to return backend info
    mock.get_info.return_value = {
        "backend": "mock",
        "model": "test-model",
        "device": "cpu"
    }

    yield mock


@pytest.fixture
def sample_chunks() -> List[DocumentChunk]:
    """
    Sample DocumentChunk list for testing.

    Provides a variety of document chunks from different sources
    with diverse content for testing chunking, retrieval, and RAG.

    Returns:
        List[DocumentChunk]: List of 4 sample document chunks
    """
    return [
        DocumentChunk(
            text="Python is a high-level programming language known for its simplicity and readability.",
            source="test1.pdf",
            page=1,
            chunk_index=0
        ),
        DocumentChunk(
            text="Machine learning is a subset of artificial intelligence that enables systems to learn from data.",
            source="test1.pdf",
            page=2,
            chunk_index=1
        ),
        DocumentChunk(
            text="Natural language processing involves the interaction between computers and human language.",
            source="test2.txt",
            chunk_index=0
        ),
        DocumentChunk(
            text="ChromaDB is an open-source embedding database for building AI applications with embeddings.",
            source="test3.md",
            chunk_index=0
        ),
    ]


@pytest.fixture
def sample_pdf_bytes() -> bytes:
    """
    Sample PDF file bytes for testing.

    Creates a minimal valid PDF document in memory that can be
    written to a temporary file for PDF processing tests.

    Returns:
        bytes: Valid PDF document bytes
    """
    # Minimal valid PDF structure
    pdf_content = b"""%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj
2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj
3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
>>
endobj
4 0 obj
<<
/Length 44
>>
stream
BT
/F1 12 Tf
100 700 Td
(Test PDF Content) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000206 00000 n
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
296
%%EOF
"""
    return pdf_content


@pytest.fixture
def vector_store(temp_chroma_db, mock_llm, sample_chunks):
    """
    Initialized VectorStore for testing.

    Creates a VectorStore instance using the temporary ChromaDB directory
    and pre-populates it with sample chunks. Uses a mock embedder to avoid
    requiring actual embedding models in tests.

    Args:
        temp_chroma_db: Temporary directory for ChromaDB storage
        mock_llm: Mock LLM (not used directly but ensures LLM context)
        sample_chunks: Sample document chunks to add to the store

    Yields:
        VectorStore: Initialized vector store with sample data

    Note:
        This fixture requires ChromaDB and sentence-transformers to be installed.
        If not available, it will skip the test.
    """
    pytest.importorskip("chromadb")
    pytest.importorskip("sentence_transformers")

    from vector_store import VectorStore

    # Create vector store with temporary path
    store = VectorStore(
        db_path=str(temp_chroma_db),
        embedding_model="BAAI/bge-small-en-v1.5"
    )

    # Add sample chunks
    store.add_chunks(sample_chunks)

    yield store

    # Cleanup is handled by temp_chroma_db fixture


# Additional utility fixtures for convenience


@pytest.fixture
def empty_vector_store(temp_chroma_db):
    """
    Empty VectorStore for testing.

    Creates a VectorStore without any chunks, useful for testing
    edge cases like empty database behavior.

    Args:
        temp_chroma_db: Temporary directory for ChromaDB storage

    Yields:
        VectorStore: Empty vector store ready for use
    """
    pytest.importorskip("chromadb")
    pytest.importorskip("sentence_transformers")

    from vector_store import VectorStore

    store = VectorStore(
        db_path=str(temp_chroma_db),
        embedding_model="BAAI/bge-small-en-v1.5"
    )

    yield store


@pytest.fixture
def inference_config():
    """
    Default InferenceConfig for testing.

    Provides a standard inference configuration that can be
    customized in individual tests if needed.

    Returns:
        InferenceConfig: Configuration with typical test values
    """
    pytest.importorskip("llm_interface")

    from llm_interface import InferenceConfig

    return InferenceConfig(
        max_tokens=128,
        temperature=0.3,
        top_p=0.9,
        do_sample=True
    )


@pytest.fixture
def sample_text_file(tmp_path):
    """
    Sample text file for testing document processor.

    Creates a temporary text file with sample content.

    Args:
        tmp_path: Pytest temporary path fixture

    Yields:
        Path: Path to the temporary text file
    """
    file_path = tmp_path / "sample.txt"
    content = """This is a sample text file for testing.

It contains multiple paragraphs and various
types of content for document processing tests.

The third paragraph provides additional data for testing."""
    file_path.write_text(content, encoding='utf-8')
    yield file_path
