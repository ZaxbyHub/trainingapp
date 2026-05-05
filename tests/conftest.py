"""
Shared pytest fixtures for the test suite.
"""

import sys
import pytest
from pathlib import Path
from typing import List, Dict, Any
from unittest.mock import Mock, MagicMock, patch
from dataclasses import dataclass

# Pre-register optional C-extension dependencies so tests that use
# `with patch("llama_cpp.Llama"):` work regardless of collection order
# and without the optional package being installed.  setdefault is a no-op
# if the package is already installed.
sys.modules.setdefault("llama_cpp", MagicMock())

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
        "device": "cpu",
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
            chunk_index=0,
        ),
        DocumentChunk(
            text="ChromaDB is an open-source embedding database for building AI applications with embeddings.",
            source="test3.md",
            chunk_index=0,
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
def mock_embedding_model():
    """
    Mock EmbeddingModel that generates word-bag embeddings.

    This fixture provides a mock for the EmbeddingModel class used in vector_store.
    It patches the EmbeddingModel in the vector_store module to avoid requiring
    actual embedding models or sentence-transformers in tests.

    Yields:
        type: Mocked EmbeddingModel class
    """
    import numpy as np

    def _word_hash_embedding(text, dim=384):
        """Generate embedding where shared words produce similar embeddings.

        Each word sets 8 dimensions to 10.0 based on its hash.
        Texts sharing words will have overlapping 10.0 dimensions,
        producing high cosine similarity for word overlap.
        """
        words = str(text).lower().split()
        embedding = np.zeros(dim, dtype=np.float32)
        for word in words:
            word_hash = hash(word)
            for offset in range(8):
                dim_idx = (word_hash + offset * 97) % dim
                embedding[dim_idx] = 10.0
        return embedding

    class MockEmbeddingModel:
        """Mock EmbeddingModel that generates word-bag embeddings.

        This mock completely bypasses the real EmbeddingModel initialization,
        which checks for local model paths and tries to load SentenceTransformer.
        Instead, it returns deterministic word-bag embeddings.
        """

        def __init__(self, model_name=None, *args, **kwargs):
            # Do NOT call super().__init__ or access any filesystem
            # This bypasses the local_model_path.exists() check in the real EmbeddingModel
            self.model_name = model_name or "mock-model"

        def encode(self, texts, *args, **kwargs):
            """Encode multiple texts into embeddings."""
            embeddings = []
            for text in texts:
                emb = _word_hash_embedding(text)
                embeddings.append(emb)
            return np.array(embeddings)

        def encode_single(self, text, *args, **kwargs):
            """Encode single text into embedding."""
            return _word_hash_embedding(text)

    # Patch the EmbeddingModel class in vector_store module
    # This must be done before importing VectorStore to prevent
    # the real EmbeddingModel from being instantiated
    vector_store_module = __import__("vector_store", fromlist=["EmbeddingModel"])
    patcher = patch.object(vector_store_module, "EmbeddingModel", MockEmbeddingModel)
    patcher.start()

    yield MockEmbeddingModel

    # Clean up the patch
    patcher.stop()

    # Clear cached modules to ensure clean state for next test
    if "vector_store" in sys.modules:
        del sys.modules["vector_store"]


@pytest.fixture
def vector_store(temp_chroma_db, mock_llm, sample_chunks, mock_embedding_model):
    """
    Initialized VectorStore for testing.

    Creates a VectorStore instance using the temporary ChromaDB directory
    and pre-populates it with sample chunks. Uses a mock embedder to avoid
    requiring actual embedding models in tests.

    Args:
        temp_chroma_db: Temporary directory for ChromaDB storage
        mock_llm: Mock LLM (not used directly but ensures LLM context)
        sample_chunks: Sample document chunks to add to the store
        mock_embedding_model: Mocked EmbeddingModel fixture

    Yields:
        VectorStore: Initialized vector store with sample data

    Note:
        This fixture requires ChromaDB to be installed.
        The embedding model is mocked to avoid requiring sentence-transformers.
    """
    pytest.importorskip("chromadb")
    import numpy as np

    def _word_hash_embedding(text, dim=384):
        """Generate embedding where shared words produce similar embeddings.

        Each word sets 8 dimensions to 1.0 based on its hash.
        Texts sharing words will have overlapping 1.0 dimensions,
        producing high cosine similarity for word overlap.
        """
        words = str(text).lower().split()
        embedding = np.zeros(dim, dtype=np.float32)
        for word in words:
            word_hash = hash(word)
            for offset in range(8):
                dim_idx = (word_hash + offset * 97) % dim
                embedding[dim_idx] = 10.0
        return embedding

    def _deterministic_embedding(text):
        """Generate deterministic embedding where similar texts produce similar vectors."""
        return _word_hash_embedding(text)

    # Create a mock EmbeddingModel class that behaves correctly
    class MockEmbeddingModel:
        """Mock EmbeddingModel that returns deterministic embeddings."""
        def __init__(self, model_name=None):
            self.model_name = model_name or "mock-model"
        
        def encode(self, texts):
            """Encode multiple texts with deterministic embeddings."""
            return [_deterministic_embedding(str(text)).tolist() for text in texts]
        
        def encode_single(self, text):
            """Encode single text with deterministic embedding."""
            return _deterministic_embedding(str(text)).tolist()

    # Clear any cached imports first to ensure patching works
    modules_to_clear = [k for k in list(sys.modules.keys()) if k.startswith("vector_store")]
    for mod in modules_to_clear:
        del sys.modules[mod]

    # Patch the EmbeddingModel class in the vector_store module namespace
    with patch("vector_store.EmbeddingModel", MockEmbeddingModel):
        from vector_store import VectorStore

        # Create vector store with temporary path
        store = VectorStore(
            db_path=str(temp_chroma_db), embedding_model="mock-model"
        )

        # Add sample chunks
        store.add_chunks(sample_chunks)

        yield store


# Additional utility fixtures for convenience


@pytest.fixture
def empty_vector_store(temp_chroma_db, mock_embedding_model):
    """
    Empty VectorStore for testing.

    Creates a VectorStore without any chunks, useful for testing
    edge cases like empty database behavior.

    Args:
        temp_chroma_db: Temporary directory for ChromaDB storage
        mock_embedding_model: Mocked EmbeddingModel fixture

    Yields:
        VectorStore: Empty vector store ready for use

    Note:
        This fixture requires ChromaDB to be installed.
    """
    pytest.importorskip("chromadb")

    # Import VectorStore after mock_embedding_model has patched EmbeddingModel
    from vector_store import VectorStore

    with patch("vector_store.EmbeddingModel", mock_embedding_model):
        store = VectorStore(
            db_path=str(temp_chroma_db), embedding_model="mock-model"
        )

        yield store


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
    file_path.write_text(content, encoding="utf-8")
    yield file_path
