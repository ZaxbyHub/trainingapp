"""
Integration tests for RAG engine with real dependencies.

These tests use the actual VectorStore and DocumentProcessor, with only
the LLM backend mocked. This provides real confidence that the RAG pipeline
works correctly with actual document ingestion and retrieval.

Run with: pytest tests/integration/test_rag_engine_integration.py -v -m integration
"""

import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Mark all tests in this module as integration tests
pytestmark = pytest.mark.integration


@pytest.fixture
def temp_db_path():
    """Create a temporary directory for the vector database.
    
    Note: Uses ignore_cleanup_errors=True because ChromaDB on Windows keeps 
    SQLite files locked briefly after test completion. This is a known 
    Windows/ChromaDB compatibility issue, not a code bug.
    """
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        yield Path(tmpdir) / "test_db"


@pytest.fixture
def mock_llm():
    """Create a mock LLM that returns predictable answers."""
    with patch('rag_engine.SmartLLM') as mock_smart_llm:
        mock_llm_instance = MagicMock()
        
        def mock_answer(context, question, **kwargs):
            """Generate a mock answer based on context."""
            if not context or not context.strip():
                return "I don't have enough information to answer that."
            
            # Extract key terms from context for a contextual answer
            context_lower = context.lower()
            if "python" in context_lower:
                return "Python is a programming language mentioned in the documents."
            elif "rag" in context_lower or "retrieval" in context_lower:
                return "RAG (Retrieval-Augmented Generation) combines document retrieval with text generation."
            else:
                return f"Based on the context provided: {context[:100]}..."
        
        mock_llm_instance.answer_question.side_effect = mock_answer
        mock_smart_llm.return_value = mock_llm_instance
        
        yield mock_llm_instance


class TestRAGEngineWithRealVectorStore:
    """Tests for RAG engine with real VectorStore and mocked LLM."""
    
    def test_ingest_file(self, temp_db_path, mock_llm):
        """Test ingesting a file with real vector store."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create a temporary text file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write("Python is a high-level programming language. It is widely used for web development, data science, and automation.")
            temp_file = f.name
        
        try:
            # Create engine with real vector store
            config = RAGConfig(db_path=str(temp_db_path))
            engine = RAGEngine(config=config)
            
            # Ingest the file
            stats = engine.ingest_file(temp_file)
            
            # Verify ingestion stats
            assert stats["success"] is True
            assert stats["chunks_added"] > 0
            
            # Verify documents are tracked
            docs = engine.list_documents()
            assert any(".txt" in doc for doc in docs)
        finally:
            Path(temp_file).unlink(missing_ok=True)
    
    def test_ingest_directory(self, temp_db_path, mock_llm):
        """Test ingesting a directory with real vector store."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create a temporary directory with files
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create test files
            (Path(tmpdir) / "doc1.txt").write_text("Python was created by Guido van Rossum.")
            (Path(tmpdir) / "doc2.txt").write_text("JavaScript is used for web development.")
            
            # Create engine
            config = RAGConfig(db_path=str(temp_db_path))
            engine = RAGEngine(config=config)
            
            # Ingest directory
            stats = engine.ingest_directory(tmpdir)
            
            # Verify ingestion
            assert stats["success"] is True
            assert stats["documents"] >= 2
            
            # Verify documents are tracked
            docs = engine.list_documents()
            assert len(docs) >= 2
    
    def test_query_retrieves_context(self, temp_db_path, mock_llm):
        """Test that query retrieves relevant context from real vector store."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create engine
        config = RAGConfig(db_path=str(temp_db_path))
        engine = RAGEngine(config=config)
        
        # Create and ingest documents about Python
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "python_history.txt").write_text(
                "Python is a programming language created by Guido van Rossum."
            )
            (Path(tmpdir) / "javascript.txt").write_text(
                "JavaScript is used for web development alongside HTML and CSS."
            )
            
            engine.ingest_directory(tmpdir)
        
        # Query about Python
        result = engine.query("Who created Python?")
        
        # Verify query result structure
        assert result.question == "Who created Python?"
        assert isinstance(result.answer, str)
        assert len(result.answer) > 0
        
        # Verify sources are returned
        assert isinstance(result.sources, list)
        
        # Verify the answer mentions Python (from context)
        assert "Python" in result.answer or "programming" in result.answer.lower()
    
    def test_query_with_no_documents(self, temp_db_path, mock_llm):
        """Test query when no documents have been ingested."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create engine with empty database
        config = RAGConfig(db_path=str(temp_db_path))
        engine = RAGEngine(config=config)
        
        # Query without any documents
        result = engine.query("What is Python?")
        
        # Should return fallback message
        assert "couldn't find" in result.answer.lower() or "don't have" in result.answer.lower()
        assert result.sources == []
        assert result.chunks_retrieved == 0
    
    def test_clear_documents(self, temp_db_path, mock_llm):
        """Test clearing all documents from vector store."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create engine and ingest documents
        config = RAGConfig(db_path=str(temp_db_path))
        engine = RAGEngine(config=config)
        
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "doc1.txt").write_text("Document 1 content")
            (Path(tmpdir) / "doc2.txt").write_text("Document 2 content")
            engine.ingest_directory(tmpdir)
        
        # Verify documents exist
        assert len(engine.list_documents()) >= 2
        
        # Clear documents
        engine.clear_documents()
        
        # Verify documents are cleared
        assert len(engine.list_documents()) == 0
        
        # Query should return no results
        result = engine.query("What is in the documents?")
        assert result.sources == []
    
    def test_get_stats(self, temp_db_path, mock_llm):
        """Test getting engine statistics."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create engine
        config = RAGConfig(db_path=str(temp_db_path))
        engine = RAGEngine(config=config)
        
        # Get initial stats
        stats = engine.get_stats()
        
        # Verify stats structure
        assert isinstance(stats, dict)
        
        # Ingest a document
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "stats_test.txt").write_text("Test content for statistics")
            engine.ingest_directory(tmpdir)
        
        # Get updated stats
        stats = engine.get_stats()
        assert isinstance(stats, dict)


class TestRAGEngineQueryBehavior:
    """Tests for RAG engine query behavior with real retrieval."""
    
    def test_query_with_multiple_results(self, temp_db_path, mock_llm):
        """Test query retrieves multiple relevant chunks."""
        from rag_engine import RAGEngine, RAGConfig
        
        config = RAGConfig(db_path=str(temp_db_path), n_results=3)
        engine = RAGEngine(config=config)
        
        # Create and ingest multiple related documents
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "ml_intro.txt").write_text(
                "Machine learning is a subset of artificial intelligence."
            )
            (Path(tmpdir) / "deep_learning.txt").write_text(
                "Deep learning uses neural networks with many layers."
            )
            (Path(tmpdir) / "neural_networks.txt").write_text(
                "Neural networks are inspired by biological neurons."
            )
            engine.ingest_directory(tmpdir)
        
        # Query about machine learning
        result = engine.query("What is machine learning?", n_results=3)
        
        # Verify multiple chunks were retrieved
        assert result.chunks_retrieved > 0
        assert result.chunks_retrieved <= 3  # Respects n_results parameter
        
        # Verify context was used
        assert result.context_length > 0
    
    def test_query_respects_n_results_parameter(self, temp_db_path, mock_llm):
        """Test that n_results parameter limits retrieved chunks."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create engine with n_results=2
        config = RAGConfig(db_path=str(temp_db_path), n_results=2)
        engine = RAGEngine(config=config)
        
        # Create and ingest multiple documents
        with tempfile.TemporaryDirectory() as tmpdir:
            for i in range(5):
                (Path(tmpdir) / f"doc{i}.txt").write_text(
                    f"Document {i} contains information about topic {i}."
                )
            engine.ingest_directory(tmpdir)
        
        # Query with default n_results
        result = engine.query("What are the topics?")
        
        # Should respect the n_results setting
        assert result.chunks_retrieved <= 2


class TestRAGEngineErrorHandling:
    """Tests for RAG engine error handling."""
    
    def test_query_without_llm(self, temp_db_path):
        """Test query fails gracefully when LLM is not available."""
        from rag_engine import RAGEngine, RAGConfig
        
        # Create engine with LLM that fails to initialize
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm.side_effect = Exception("LLM initialization failed")
            
            config = RAGConfig(db_path=str(temp_db_path))
            engine = RAGEngine(config=config)
            
            # LLM should be None
            assert engine.llm is None
            
            # Query should raise RuntimeError
            with pytest.raises(RuntimeError, match="LLM not initialized"):
                engine.query("Test question")
    
    def test_ingest_nonexistent_file(self, temp_db_path, mock_llm):
        """Test ingesting a non-existent file."""
        from rag_engine import RAGEngine, RAGConfig
        
        config = RAGConfig(db_path=str(temp_db_path))
        engine = RAGEngine(config=config)
        
        # Try to ingest non-existent file
        stats = engine.ingest_file("/nonexistent/path/file.txt")
        
        # Should handle gracefully
        assert stats["success"] is False
        assert "error" in stats or stats.get("chunks", stats.get("chunks_added", 0)) == 0
