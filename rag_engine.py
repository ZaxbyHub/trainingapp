"""
RAG Engine Module
Combines document processing, vector store, and LLM for question answering.
"""

import os
import sys
import json
import time
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
from dataclasses import dataclass
import app_paths
import logging

logger = logging.getLogger(__name__)

# Maximum characters of context to pass to LLM (~1 500 tokens within GGUF n_ctx budget)
_SAFE_CONTEXT_CHARS = 6000


from document_processor import DocumentProcessor
from vector_store import VectorStore
from llm_interface import SmartLLM, InferenceConfig

# Import unified factory functions
from engine_factory import (
    create_engine,
    create_engine_from_env as _factory_create_engine_from_env,
)


@dataclass
class QueryResult:
    """Result of a RAG query."""

    question: str
    answer: str
    sources: List[str]
    context_length: int
    inference_time: float
    chunks_retrieved: int


class RAGConfig:
    """Configuration for RAG engine."""

    def __init__(
        self,
        db_path: str = str(app_paths.get_vector_db_path()),
        chunk_size: int = 512,
        chunk_overlap: int = 50,
        n_results: int = 3,
        min_similarity: float = 0.3,
        max_tokens: int = 1024,
        temperature: float = 0.3,
        embedding_model: str = "BAAI/bge-small-en-v1.5",
        retrieval_window: int = 1,
        hybrid_search: bool = True,
        reranking_enabled: bool = False,
        reranker_model: str = "cross-encoder/ms-marco-MiniLM-L-2-v2",
        query_transformation_enabled: bool = False,
        initial_retrieval_top_k: int = 20,
    ):
        self.db_path = db_path
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.n_results = n_results
        self.min_similarity = min_similarity
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.embedding_model = embedding_model
        self.retrieval_window = retrieval_window
        self.hybrid_search = hybrid_search
        self.reranking_enabled = reranking_enabled
        self.reranker_model = reranker_model
        self.query_transformation_enabled = query_transformation_enabled
        self.initial_retrieval_top_k = initial_retrieval_top_k

    def to_dict(self) -> Dict[str, Any]:
        return {
            "db_path": self.db_path,
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "n_results": self.n_results,
            "min_similarity": self.min_similarity,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "embedding_model": self.embedding_model,
            "retrieval_window": self.retrieval_window,
            "hybrid_search": self.hybrid_search,
            "reranking_enabled": self.reranking_enabled,
            "reranker_model": self.reranker_model,
            "query_transformation_enabled": self.query_transformation_enabled,
            "initial_retrieval_top_k": self.initial_retrieval_top_k,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RAGConfig":
        # Handle backward compatibility - provide defaults for new fields
        return cls(
            db_path=data.get("db_path", str(app_paths.get_vector_db_path())),
            chunk_size=data.get("chunk_size", 512),
            chunk_overlap=data.get("chunk_overlap", 50),
            n_results=data.get("n_results", 3),
            min_similarity=data.get("min_similarity", 0.3),
            max_tokens=data.get("max_tokens", 1024),
            temperature=data.get("temperature", 0.3),
            embedding_model=data.get("embedding_model", "BAAI/bge-small-en-v1.5"),
            retrieval_window=data.get("retrieval_window", 1),
            hybrid_search=data.get("hybrid_search", True),
            reranking_enabled=data.get("reranking_enabled", False),
            reranker_model=data.get(
                "reranker_model", "cross-encoder/ms-marco-MiniLM-L-2-v2"
            ),
            query_transformation_enabled=data.get(
                "query_transformation_enabled", False
            ),
            initial_retrieval_top_k=data.get("initial_retrieval_top_k", 20),
        )


class RAGEngine:
    """
    Main RAG engine for document Q&A.
    Handles document ingestion, embedding, and question answering.
    """

    CONFIG_FILE = "rag_config.json"

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        model_path: Optional[str] = None,
        ollama_model: Optional[str] = None,
        ollama_url: Optional[str] = None,
        api_url: Optional[str] = None,
        api_model: Optional[str] = None,
        device: Optional[str] = None,
        gguf_path: Optional[str] = None,
    ):
        self.config = config or RAGConfig()
        self.gguf_path = gguf_path

        logger.info("=" * 50)
        logger.info("Initializing RAG Engine")
        logger.info("=" * 50)

        self.doc_processor = DocumentProcessor(
            chunk_size=self.config.chunk_size, chunk_overlap=self.config.chunk_overlap
        )
        logger.info("[OK] Document processor ready")

        self.vector_store = VectorStore(
            db_path=self.config.db_path, embedding_model=self.config.embedding_model
        )

        self.llm: Optional[SmartLLM] = None
        self._init_llm(
            model_path, ollama_model, ollama_url, api_url, api_model, device, gguf_path
        )

        self._save_config()
        logger.info("=" * 50)
        logger.info("RAG Engine Ready")
        logger.info("=" * 50)

    def _init_llm(
        self,
        model_path: Optional[str],
        ollama_model: Optional[str],
        ollama_url: Optional[str],
        api_url: Optional[str],
        api_model: Optional[str],
        device: Optional[str],
        gguf_path: Optional[str],
    ):
        """Initialize LLM with fallback chain."""
        try:
            # Use root SmartLLM which auto-detects GGUF model
            # Parameters are passed as-is; GGUF takes priority
            self.llm = SmartLLM(
                model_path=model_path,
                ollama_model=ollama_model,
                ollama_url=ollama_url,
                api_url=api_url,
                api_model=api_model,
                device=device,
                gguf_path=gguf_path,
            )
            logger.info("[OK] LLM initialized: %s", self.llm.get_info()["backend"])
        except Exception as e:
            logger.warning("[WARN] LLM not available: %s", e)
            logger.info("  RAG engine will work for document ingestion only.")
            self.llm = None

    def _save_config(self):
        """Save configuration to database directory."""
        config_path = Path(self.config.db_path) / self.CONFIG_FILE
        with open(config_path, "w") as f:
            json.dump(self.config.to_dict(), f, indent=2)

    def ingest_directory(self, directory: str, callback=None) -> Dict[str, Any]:
        """
        Ingest all documents from a directory.

        Args:
            directory: Path to directory containing documents
            callback: Optional callback(message, progress) for UI updates

        Returns:
            Statistics about the ingestion
        """
        start_time = time.time()
        directory_path = Path(directory)

        if not directory_path.exists():
            raise FileNotFoundError(f"Directory not found: {directory_path}")

        if callback:
            callback("Scanning directory...", 0)

        chunks = self.doc_processor.process_directory(str(directory_path))

        if not chunks:
            return {
                "success": False,
                "message": "No documents found or processed",
                "documents": 0,
                "chunks_total": 0,
                "chunks_added": 0,
                "time_seconds": time.time() - start_time,
            }

        if callback:
            callback(f"Embedding {len(chunks)} chunks...", 50)

        added = self.vector_store.add_chunks(chunks)

        elapsed = time.time() - start_time

        stats = {
            "success": True,
            "documents": len(set(c.source for c in chunks)),
            "chunks_total": len(chunks),
            "chunks_added": added,
            "time_seconds": elapsed,
        }

        if callback:
            callback(f"[OK] Ingested {stats['documents']} documents", 100)

        return stats

    def ingest_file(
        self, filepath: str, source_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """Ingest a single file."""
        start_time = time.time()

        # Use provided source_name or fall back to filename from path
        display_name = source_name if source_name else Path(filepath).name

        chunks = self.doc_processor.process_file(filepath, source_name=display_name)

        if not chunks:
            return {"success": False, "message": "Failed to process file", "chunks": 0}

        added = self.vector_store.add_chunks(chunks)

        return {
            "success": True,
            "file": display_name,
            "chunks_added": added,
            "time_seconds": time.time() - start_time,
        }

    def query(
        self,
        question: str,
        n_results: Optional[int] = None,
        conversation_history: Optional[list] = None,
    ) -> QueryResult:
        """
        Answer a question using RAG.

        Args:
            question: The question to answer
            n_results: Number of context chunks to retrieve (overrides config)
            conversation_history: Optional list of prior turns as
                [{"role": "user"/"assistant", "content": "..."}].
                Used for follow-up query detection and passed to the LLM.

        Returns:
            QueryResult with answer and metadata
        """
        if not self.llm:
            raise RuntimeError("LLM not initialized. Cannot answer questions.")

        start_time = time.time()

        # Check for greetings - handle directly without RAG
        greeting_keywords = {
            "hello",
            "hi",
            "hey",
            "greetings",
            "good morning",
            "good afternoon",
            "good evening",
            "howdy",
            "what's up",
            "sup",
            "yo",
        }
        words = question.lower().split()
        if len(words) <= 3 and any(
            keyword in question.lower() for keyword in greeting_keywords
        ):
            # Handle greeting directly
            answer = self.llm.answer_question(
                question,
                "",
                [],
                config=InferenceConfig(max_tokens=self.config.max_tokens),
                conversation_history=conversation_history,
            )
            return QueryResult(
                question=question,
                answer=answer,
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
            )

        # Determine number of chunks to retrieve (always at least 1)
        n = n_results if n_results is not None else self.config.n_results
        n = max(1, n)

        # Follow-up query detection
        retrieval_query = question
        if conversation_history is not None and conversation_history:
            # Check if there are any assistant messages in history
            has_assistant = any(
                isinstance(m, dict) and m.get("role") == "assistant"
                for m in conversation_history
            )
            if has_assistant:
                # Check if question is short or contains follow-up keywords
                is_short = len(question.split()) <= 6
                followup_keywords = {
                    "more",
                    "elaborate",
                    "detail",
                    "detailed",
                    "explain",
                    "expand",
                    "deeper",
                    "further",
                    "again",
                }
                has_keyword = any(
                    keyword in question.lower() for keyword in followup_keywords
                )

                if is_short or has_keyword:
                    # Find last user message in conversation history
                    last_user_content = None
                    for msg in reversed(conversation_history):
                        if isinstance(msg, dict) and msg.get("role") == "user":
                            content = msg.get("content", "")
                            if content and content.strip():
                                last_user_content = content
                                break

                    if last_user_content:
                        retrieval_query = last_user_content
                        print(
                            f"[INFO] Follow-up detected — retrieval query: '{retrieval_query[:80]}'"
                        )

        # Retrieve context — hybrid (BM25+vector+RRF) if enabled, else vector-only
        context, sources = self.vector_store.get_context(
            retrieval_query,
            n_results=n,
            min_similarity=self.config.min_similarity,
            hybrid_search=self.config.hybrid_search,
        )

        # Diagnostic logging
        logger.debug(
            "Context type: %s, len: %s",
            type(context),
            len(context) if context else "None",
        )
        logger.debug("Sources: %s", sources)
        logger.debug("Context preview: %s", context[:200] if context else "None")

        if not context:
            return QueryResult(
                question=question,
                answer="I couldn't find any relevant information in the documents to answer your question.",
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
            )

        # Pre-truncate context to stay within LLM context budget
        safe_context = context[:_SAFE_CONTEXT_CHARS]

        # Use answer_question instead of generate for proper RAG handling
        answer = self.llm.answer_question(
            question=question,
            context=safe_context,
            sources=sources,
            config=InferenceConfig(max_tokens=self.config.max_tokens),
            conversation_history=conversation_history,
        )

        # Post-process: if LLM says it can't find information but we retrieved chunks, provide helpful fallback
        fallback_phrases = [
            "i could not find this information",
            "i couldn't find any relevant information",
            "the documents do not contain information",
            "i don't have information",
        ]

        if any(phrase in answer.lower() for phrase in fallback_phrases) and sources:
            # LLM couldn't match question to retrieved context
            # Provide a more helpful response
            stats = self.vector_store.get_stats()
            doc_count = stats.get("document_count", 0)
            chunk_count = stats.get("chunk_count", 0)

            answer = (
                f"I retrieved {len(sources)} relevant document(s) but couldn't find specific information to answer '{question}'. "
                f"The database contains {doc_count} documents with {chunk_count} chunks total. "
                f"Try asking a more specific question about the content of these documents: {', '.join(sources[:3])}"
            )

        return QueryResult(
            question=question,
            answer=answer,
            sources=sources,
            context_length=len(safe_context),
            inference_time=time.time() - start_time,
            chunks_retrieved=len(sources),
        )

    def search_documents(
        self, query: str, n_results: int = 5
    ) -> List[Tuple[str, Dict, float]]:
        """Search documents without generating an answer."""
        return self.vector_store.search(query, n_results)

    def get_stats(self) -> Dict[str, Any]:
        """Get engine statistics."""
        stats = self.vector_store.get_stats()
        stats["config"] = self.config.to_dict()
        if self.llm:
            stats["llm"] = self.llm.get_info()
        else:
            stats["llm"] = None
        return stats

    def clear_documents(self):
        """Clear all ingested documents."""
        self.vector_store.clear()

    def list_documents(self) -> List[str]:
        """List all ingested documents."""
        return self.vector_store.get_stats()["documents"]

    def get_all_documents(self) -> List[Dict[str, Any]]:
        """Get all ingested documents with metadata.

        Returns a list of dicts with keys:
            id (str): document source path
            chunk_count (int): number of chunks for this document
        """
        metadata = self.vector_store.metadata or {}
        docs_meta = metadata.get("documents", {})
        return [
            {"id": source, "chunk_count": meta.get("chunks", 0)}
            for source, meta in docs_meta.items()
        ]

    def delete_document(self, doc_id: str) -> bool:
        """Delete a document and all its chunks from the vector store.

        Args:
            doc_id: The document source path / ID to delete.

        Returns:
            True if document existed and was removed, False otherwise.
        """
        return self.vector_store.delete_document(doc_id)


def create_engine_from_env() -> RAGEngine:
    """Create engine from environment variables.

    DEPRECATED: This function is now a wrapper around engine_factory.create_engine_from_env()
    for backward compatibility. New code should import directly from engine_factory.

    Returns:
        Configured RAGEngine instance
    """
    import warnings

    warnings.warn(
        "create_engine_from_env() is deprecated, use engine_factory directly",
        DeprecationWarning,
        stacklevel=2,
    )
    return _factory_create_engine_from_env()


if __name__ == "__main__":
    import sys

    engine = RAGEngine(ollama_model="phi3:mini", ollama_url="http://localhost:11434")

    if len(sys.argv) > 1:
        path = sys.argv[1]
        if os.path.isdir(path):
            stats = engine.ingest_directory(path)
            print(f"\nIngestion stats: {stats}")
        elif os.path.isfile(path):
            stats = engine.ingest_file(path)
            print(f"\nIngestion stats: {stats}")

    print("\nEngine stats:")
    print(json.dumps(engine.get_stats(), indent=2))

    if engine.llm:
        while True:
            question = input("\nAsk a question (or 'quit'): ").strip()
            if question.lower() in ["quit", "exit", "q"]:
                break

            result = engine.query(question)
            print(f"\nAnswer: {result.answer}")
            print(f"Sources: {result.sources}")
            print(f"Time: {result.inference_time:.2f}s")
