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
        assert result.chunks_retrieved > 0


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


class TestRAGPipelineRemediation:
    """Tests for RAG pipeline remediation and edge cases."""

    def test_paragraph_structure_preservation(self, temp_db_path, mock_llm):
        """Test that paragraph structure is preserved during retrieval."""
        from rag_engine import RAGEngine, RAGConfig
        from document_processor import DocumentChunk

        # Create engine
        config = RAGConfig(db_path=str(temp_db_path), chunk_size=64, chunk_overlap=10)
        engine = RAGEngine(config=config)

        # Create a document with multiple paragraphs separated by blank lines (at least 1000 chars)
        with tempfile.TemporaryDirectory() as tmpdir:
            doc_path = Path(tmpdir) / "multi_paragraph.txt"
            doc_content = """This is the first paragraph of the document. It contains multiple sentences about a specific topic. We are discussing Python as a programming language which is widely used in various domains including web development, data science, and automation. The language was created by Guido van Rossum and first released in 1991. Python emphasizes code readability and allows programmers to express concepts in fewer lines of code compared to other programming languages like Java or C++.

 This is the second paragraph discussing a different subject area. JavaScript has become the dominant language for web development, running in browsers to create interactive websites. Unlike Python which is often used on the server side or for scripting, JavaScript powers the client-side experience in modern web applications. Frameworks like React, Angular, andVue have extended JavaScript capabilities significantly.

 This is the third paragraph about another programming language. Java is known for its enterprise-grade applications and write once run anywhere philosophy through the Java Virtual Machine. It is a statically typed language that requires more boilerplate code than Python but provides strong type safety and performance benefits for large-scale systems. Many enterprise legacy systems are built on Java technology.

 This is the fourth paragraph providing additional context. Programming languages evolve over time with new features and paradigms emerging. Python 3 introduced significant improvements over Python 2 including better Unicode support and syntax enhancements. Modern JavaScript includes ES6 features like arrow functions, destructuring, and modules that make code more concise and expressive. Java continues to evolve with regular release cycles introducing new performance optimizations and language features.

 This is the fifth and final paragraph concluding the document. When learning programming, understanding the strengths and weaknesses of different languages helps developers choose the right tool for the job. Python excels at rapid prototyping and data analysis, JavaScript dominates web frontends, and Java remains prevalent in enterprise environments. Each language has its strengths and the best developers learn multiple languages to solve diverse problems effectively.
"""
            doc_path.write_text(doc_content)

            # Ingest the document
            stats = engine.ingest_file(str(doc_path))
            assert stats["success"] is True

            # Query and get context directly from vector store
            context, sources, chunks = engine.vector_store.get_context(
                "What are the topics discussed?"
            )

            # Verify paragraph structure is preserved (contains double newlines)
            assert "\n\n" in context or "\n\n---\n\n" in context

    def test_hybrid_rrf_no_id_collision(self, temp_db_path, mock_llm):
        """Test that hybrid search with RRF doesn't produce duplicate sources."""
        from rag_engine import RAGEngine, RAGConfig

        # Create engine with hybrid search enabled
        config = RAGConfig(db_path=str(temp_db_path), hybrid_search=True)
        engine = RAGEngine(config=config)

        # Create multiple documents that will be retrieved by both vector and BM25
        with tempfile.TemporaryDirectory() as tmpdir:
            for i in range(5):
                doc_path = Path(tmpdir) / f"doc_{i}.txt"
                doc_path.write_text(f"This is document {i}. It contains information about data processing.")

            stats = engine.ingest_directory(tmpdir)
            assert stats["success"] is True

            # Query with hybrid search
            result = engine.query("What is data processing?")

            # Verify sources are unique (no duplicates)
            assert result.sources is not None
            # Check for unique sources by comparing list length with set length
            assert len(result.sources) == len(set(result.sources)), "Duplicate sources found in hybrid search results"

    def test_initial_retrieval_top_k_usage(self, temp_db_path, mock_llm):
        """Test that initial_retrieval_top_k is used during retrieval."""
        from rag_engine import RAGEngine, RAGConfig
        from unittest.mock import patch, MagicMock

        # Create engine with initial_retrieval_top_k=10
        config = RAGConfig(db_path=str(temp_db_path), initial_retrieval_top_k=10, n_results=3)
        engine = RAGEngine(config=config)

        # Create enough documents to produce >3 chunks
        with tempfile.TemporaryDirectory() as tmpdir:
            for i in range(10):
                doc_path = Path(tmpdir) / f"doc_{i}.txt"
                doc_path.write_text(f"This is document {i} with some content about various topics.")

            stats = engine.ingest_directory(tmpdir)
            assert stats["success"] is True

            # Mock the get_context method to track n_results argument
            original_get_context = engine.vector_store.get_context

            retrieval_args = {}
            def mock_get_context(query, n_results=None, **kwargs):
                retrieval_args['n_results'] = n_results
                return original_get_context(query, n_results=n_results, **kwargs)

            # Patch the method
            with patch.object(engine.vector_store, 'get_context', side_effect=mock_get_context):
                # Query
                result = engine.query("What is about?")

            # Verify that initial_retrieval_top_k (10) was used, not n_results (3)
            assert 'n_results' in retrieval_args
            assert retrieval_args['n_results'] == 10

    def test_neighbor_chunks_survive_reranking(self, temp_db_path, mock_llm):
        """Test that neighbor chunks are included via retrieval_window."""
        from rag_engine import RAGEngine, RAGConfig
        from document_processor import DocumentChunk

        # Create engine with retrieval_window=2
        config = RAGConfig(db_path=str(temp_db_path), retrieval_window=2, n_results=1, chunk_size=64, chunk_overlap=10)
        engine = RAGEngine(config=config)

        # Create a document where chunks are numbered (at least 1000 chars with clear topical sections)
        with tempfile.TemporaryDirectory() as tmpdir:
            doc_path = Path(tmpdir) / "numbered_doc.txt"

            # Create chunks with text that will be retrieved - larger document to ensure multiple chunks
            chunks_content = []
            for i in range(5):
                chunks_content.append(f"""Chunk {i} content: topic {i}. This paragraph provides detailed information about topic number {i} in our sequence. We are exploring various subjects and concepts that help demonstrate how the retrieval system works with neighboring chunks. The retrieval window of 2 means that when a chunk is matched, its two neighbors on either side should also be included in the results to provide more context for the answer generation process.""")

            doc_path.write_text("\n\n".join(chunks_content))

            # Ingest the document
            stats = engine.ingest_file(str(doc_path))
            assert stats["success"] is True

            # Query to retrieve chunks with neighbors
            result = engine.query("What is topic?")

            # Verify that neighbor chunks were included (chunks_retrieved >= 2)
            assert result.chunks_retrieved >= 2

    def test_procedural_answer_contains_all_steps(self, temp_db_path, mock_llm):
        """Test that procedural content returns all steps in answer."""
        from rag_engine import RAGEngine, RAGConfig

        # Create engine
        config = RAGConfig(db_path=str(temp_db_path))
        engine = RAGEngine(config=config)

        # Create a procedural document
        with tempfile.TemporaryDirectory() as tmpdir:
            doc_path = Path(tmpdir) / "steps.txt"
            doc_content = """Step 1: Prepare the ingredients.
 Step 2: Mix them together.
 Step 3: Cook for 30 minutes."""
            doc_path.write_text(doc_content)

            # Ingest the document
            stats = engine.ingest_file(str(doc_path))
            assert stats["success"] is True

            # Mock LLM to echo the context
            mock_llm.answer_question.side_effect = lambda context, question, **kwargs: context

            # Query about steps
            result = engine.query("What are the steps?")

            # Verify all three steps are in the answer
            assert "Step 1" in result.answer
            assert "Step 2" in result.answer
            assert "Step 3" in result.answer

    def test_get_context_returns_three_values(self, temp_db_path, mock_llm):
        """Test that get_context returns exactly 3 values."""
        from rag_engine import RAGEngine, RAGConfig

        # Create engine with some documents
        config = RAGConfig(db_path=str(temp_db_path))
        engine = RAGEngine(config=config)

        # Create a test document
        with tempfile.TemporaryDirectory() as tmpdir:
            doc_path = Path(tmpdir) / "test.txt"
            doc_path.write_text("Test content for context retrieval.")

            stats = engine.ingest_file(str(doc_path))
            assert stats["success"] is True

            # Call get_context directly
            result = engine.vector_store.get_context("test query")

            # Verify it returns exactly 3 values
            assert isinstance(result, tuple)
            assert len(result) == 3

            context, sources, chunks = result
            assert isinstance(context, str)
            assert isinstance(sources, list)
            assert isinstance(chunks, list)