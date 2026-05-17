"""
RAG Engine Module
Combines document processing, vector store, and LLM for question answering.
"""

import os
import sys
import json
import time
import threading
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
from dataclasses import dataclass
import app_paths
import logging
from config import DEFAULT_MAX_TOKENS
import re

logger = logging.getLogger(__name__)

# Maximum characters of context to pass to LLM (~1 500 tokens within GGUF n_ctx budget)
# Configurable via RAG_CONTEXT_TRUNCATION environment variable, defaults to 6000

from config import settings
from document_processor import DocumentProcessor
from vector_store import VectorStore
from llm_interface import SmartLLM, InferenceConfig


def _truncate_at_sentence(text: str, max_chars: int) -> str:
    """Truncate text at the last complete sentence before max_chars."""
    if len(text) <= max_chars:
        return text
    # Scan backwards from cutoff for sentence boundary
    for i in range(max_chars - 1, max(0, max_chars - 300), -1):
        if text[i] in {'.', '!', '?'}:
            if i + 1 >= len(text) or text[i + 1] in {' ', '\n', '\t'}:
                return text[:i + 1].strip()
    # Fallback: word boundary
    for i in range(max_chars - 1, max(0, max_chars - 100), -1):
        if text[i] == ' ':
            return text[:i].strip()
    return text[:max_chars].strip()


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
        chunk_overlap: int = 100,
        n_results: int = 6,
        min_similarity: float = 0.3,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = 0.3,
        embedding_model: str = "BAAI/bge-small-en-v1.5",
        retrieval_window: int = 2,
        hybrid_search: bool = True,
        reranking_enabled: bool = True,
        reranker_model: str = "cross-encoder/ms-marco-MiniLM-L6-v2",
        query_transformation_enabled: bool = False,
        initial_retrieval_top_k: int = 30,
        rerank_top_k: int = 6,
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
        self.rerank_top_k = rerank_top_k

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
            "rerank_top_k": self.rerank_top_k,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RAGConfig":
        # Handle backward compatibility - provide defaults for new fields
        return cls(
            db_path=data.get("db_path", str(app_paths.get_vector_db_path())),
            chunk_size=data.get("chunk_size", 512),
            chunk_overlap=data.get("chunk_overlap", 100),
            n_results=data.get("n_results", 6),
            min_similarity=data.get("min_similarity", 0.3),
            max_tokens=data.get("max_tokens", DEFAULT_MAX_TOKENS),
            temperature=data.get("temperature", 0.3),
            embedding_model=data.get("embedding_model", "BAAI/bge-small-en-v1.5"),
            retrieval_window=data.get("retrieval_window", 2),
            hybrid_search=data.get("hybrid_search", True),
            reranking_enabled=data.get("reranking_enabled", True),
            reranker_model=data.get(
                "reranker_model", "cross-encoder/ms-marco-MiniLM-L6-v2"
            ),
            query_transformation_enabled=data.get(
                "query_transformation_enabled", False
            ),
            initial_retrieval_top_k=data.get("initial_retrieval_top_k", 30),
            rerank_top_k=data.get("rerank_top_k", 6),
        )


class RAGEngine:
    """
    Main RAG engine for document Q&A.
    Handles document ingestion, embedding, and question answering.
    """

    CONFIG_FILE = "rag_config.json"

    @staticmethod
    def _log_init_banner(message: str):
        """Log a section banner during initialization."""
        logger.info("=" * 50)
        logger.info(message)
        logger.info("=" * 50)

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        gguf_path: Optional[str] = None,
    ):
        self.config = config or RAGConfig()
        self.gguf_path = gguf_path

        self._log_init_banner("Initializing RAG Engine")

        self.doc_processor = DocumentProcessor(
            chunk_size=self.config.chunk_size, chunk_overlap=self.config.chunk_overlap
        )
        logger.info("[OK] Document processor ready")

        self.vector_store = VectorStore(
            db_path=self.config.db_path, embedding_model=self.config.embedding_model
        )

        self.llm: Optional[SmartLLM] = None
        # LLM will be lazily initialized on first query() call

        # Lazy-init reranker only when reranking is enabled
        self.reranker = None

        # Lazy-init QueryTransformer for query transformation
        self._query_transformer: Optional[Any] = None
        self._init_lock = threading.Lock()

        self._save_config()
        self._log_init_banner("RAG Engine Ready")

    def _init_llm(self, gguf_path: Optional[str]):
        """Initialize LLM with GGUF model only."""
        try:
            # Use root SmartLLM which auto-detects GGUF model
            self.llm = SmartLLM(gguf_path=gguf_path)
            logger.info("[OK] LLM initialized: %s", self.llm.get_info()["backend"])
        except Exception as e:
            logger.warning("[WARN] LLM not available: %s", e)
            logger.info("  RAG engine will work for document ingestion only.")
            self.llm = None

    def _ensure_llm(self):
        """Lazily initialize LLM on first use."""
        if self.llm is None:
            self._init_llm(self.gguf_path)

    def _ensure_query_transformer(self):
        """Lazily initialize QueryTransformer once."""
        if self._query_transformer is None and self.config.query_transformation_enabled and self.llm:
            with self._init_lock:
                if self._query_transformer is None:  # Double-check
                    try:
                        from query_transformer import QueryTransformer
                        self._query_transformer = QueryTransformer(self.llm)
                    except Exception as e:
                        logger.warning("QueryTransformer init failed: %s", e)
                        self._query_transformer = None  # Mark as failed to avoid retry

    def _save_config(self):
        """Save configuration to database directory."""
        try:
            config_path = Path(self.config.db_path) / self.CONFIG_FILE
            with open(config_path, "w") as f:
                json.dump(self.config.to_dict(), f, indent=2)
        except Exception as e:
            logger.error("Failed to save configuration to %s: %s", self.config.db_path, e)

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
        cancellation_event: Optional[threading.Event] = None,
        stream_callback: Optional[callable] = None,
    ) -> QueryResult:
        """
        Answer a question using RAG.

        Args:
            question: The question to answer
            n_results: Number of context chunks to retrieve (overrides config)
            conversation_history: Optional list of prior turns as
                [{"role": "user"/"assistant", "content": "..."}].
                Used for follow-up query detection and passed to the LLM.
            cancellation_event: Optional threading.Event that signals cancellation.
                If set, the query will stop at the next checkpoint and return
                a cancelled result.

        Returns:
            QueryResult with answer and metadata
        """
        # Lazily initialize LLM on first query
        self._ensure_llm()
        
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
        # Determine number of chunks to retrieve (always at least 1)

        # Apply query transformation if enabled
        self._ensure_query_transformer()
        if self._query_transformer is not None:
            try:
                retrieval_query = self._query_transformer.transform_step_back(question)
            except Exception as e:
                logger.warning("Query transformation failed, using original query: %s", e)
                retrieval_query = question
        else:
            retrieval_query = question

        # Checkpoint (a): After query transformation
        if cancellation_event is not None and cancellation_event.is_set():
            logger.info("Query cancelled by user")
            return QueryResult(
                question=question,
                answer="[Cancelled]",
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
            )

        # Handle greeting directly
        if len(words) <= 3 and any(
            keyword in question.lower() for keyword in greeting_keywords
        ):
            try:
                answer = self.llm.answer_question(
                    question,
                    "",
                    [],
                    config=InferenceConfig(max_tokens=self.config.max_tokens),
                    conversation_history=conversation_history,
                    stream_callback=stream_callback,
                    cancellation_event=cancellation_event,
                )
            except Exception as e:
                if "cancelled" in str(e).lower():
                    logger.info("Query cancelled during greeting LLM generation")
                    return QueryResult(
                        question=question,
                        answer="[Cancelled]",
                        sources=[],
                        context_length=0,
                        inference_time=time.time() - start_time,
                        chunks_retrieved=0,
                    )
                raise
            return QueryResult(
                question=question,
                answer=answer,
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
            )

        # Follow-up query detection
        if conversation_history is not None and conversation_history:
            last_user_msg = next(
                (
                    m.get("content", "")
                    for m in reversed(conversation_history)
                    if isinstance(m, dict) and m.get("role") == "user" and m.get("content", "").strip()
                ),
                None,
            )
            if last_user_msg:
                question_lower = question.lower().strip()
                should_combine = False

                # Pattern 1: Pronoun/anaphora references
                anaphora_pattern = r'\b(it|this|that|these|those|the above|the previous)\b'
                if re.search(anaphora_pattern, question_lower):
                    should_combine = True

                # Pattern 2: Very short non-wh questions
                if len(question.split()) <= 4:
                    wh_words = {'what', 'who', 'when', 'where', 'which', 'how', 'why'}
                    if not any(question_lower.startswith(w) for w in wh_words):
                        should_combine = True

                # Pattern 3: Continuation keywords
                followup_words = {
                    'more', 'elaborate', 'detail', 'explain', 'expand', 'further',
                    'also', 'another', 'compare', 'difference', 'versus', 'vs',
                    'similar', 'unlike', 'elaborate', 'deeper',
                }
                if any(w in question_lower.split() for w in followup_words):
                    should_combine = True

                if should_combine:
                    retrieval_query = f"{last_user_msg} {question}"
                    logger.info("Follow-up detected — retrieval query: '%s'", retrieval_query[:80])

        # Retrieve context — hybrid (BM25+vector+RRF) if enabled, else vector-only
        context, sources, retrieved_chunks = self.vector_store.get_context(
            retrieval_query,
            n_results=self.config.initial_retrieval_top_k,
            min_similarity=self.config.min_similarity,
            hybrid_search=self.config.hybrid_search,
            retrieval_window=self.config.retrieval_window,
        )

        # Checkpoint (b): After vector store retrieval
        if cancellation_event is not None and cancellation_event.is_set():
            logger.info("Query cancelled by user")
            return QueryResult(
                question=question,
                answer="[Cancelled]",
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
            )
        effective_top_k = n_results if n_results is not None else self.config.rerank_top_k

        # Guard against effective_top_k <= 0
        if effective_top_k <= 0:
            effective_top_k = 1

        # Guard against None from get_context() returning (None, None, None)
        if retrieved_chunks is None:
            retrieved_chunks = []

        # Initialize chunks_retrieved for later use
        chunks_retrieved = len(retrieved_chunks)

        # Apply cross-encoder reranking if enabled
        if self.config.reranking_enabled and context:
            if self.reranker is None:
                try:
                    from reranking import CrossEncoderReranker
                    self.reranker = CrossEncoderReranker(self.config.reranker_model)
                except Exception as e:
                    logger.warning("Reranker initialization failed: %s", e)
                    self.reranker = None

            rerank_chunks = retrieved_chunks

            if rerank_chunks and self.reranker is not None:
                reranked = self.reranker.rerank(question, rerank_chunks, top_k=effective_top_k)
                if reranked:
                    context = "\n\n---\n\n".join(chunk.text for chunk, _ in reranked)
                    sources = list(dict.fromkeys(chunk.source for chunk, _ in reranked))
                    chunks_retrieved = len(reranked)
                else:
                    reranked = [(chunk, 0.0) for chunk in rerank_chunks[:effective_top_k]]
                    context = "\n\n---\n\n".join(chunk.text for chunk, _ in reranked)
                    sources = list(dict.fromkeys(chunk.source for chunk, _ in reranked))
                    chunks_retrieved = len(reranked)
        else:
            # Non-reranking path: truncate to n_results or config.n_results
            final_top_k = n_results if n_results is not None else self.config.n_results
            if final_top_k <= 0:
                final_top_k = 1
            final_chunks = retrieved_chunks[:final_top_k]
            context = "\n\n---\n\n".join(chunk.text for chunk in final_chunks)
            sources = list(dict.fromkeys(chunk.source for chunk in final_chunks))
            chunks_retrieved = len(final_chunks)

        # Checkpoint (c): After reranking (or non-reranking path)
        if cancellation_event is not None and cancellation_event.is_set():
            logger.info("Query cancelled by user")
            return QueryResult(
                question=question,
                answer="[Cancelled]",
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
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
            # Check cancellation before returning empty-context fallback
            if cancellation_event is not None and cancellation_event.is_set():
                logger.info("Query cancelled by user (empty context)")
                return QueryResult(
                    question=question,
                    answer="[Cancelled]",
                    sources=[],
                    context_length=0,
                    inference_time=time.time() - start_time,
                    chunks_retrieved=chunks_retrieved,
                )
            return QueryResult(
                question=question,
                answer="I couldn't find any relevant information in the documents to answer your question.",
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
            )

        # Pre-truncate context to stay within LLM context budget
        safe_context = _truncate_at_sentence(context, settings.rag_context_truncation)

        # Checkpoint (d): Before calling LLM - the main generation boundary
        if cancellation_event is not None and cancellation_event.is_set():
            logger.info("Query cancelled by user")
            return QueryResult(
                question=question,
                answer="[Cancelled]",
                sources=[],
                context_length=0,
                inference_time=time.time() - start_time,
                chunks_retrieved=0,
            )

        # Use answer_question instead of generate for proper RAG handling
        try:
            answer = self.llm.answer_question(
                question=question,
                context=safe_context,
                sources=sources,
                config=InferenceConfig(max_tokens=self.config.max_tokens),
                conversation_history=conversation_history,
                stream_callback=stream_callback,
                cancellation_event=cancellation_event,
            )
        except Exception as e:
            if "cancelled" in str(e).lower():
                logger.info("Query cancelled during LLM generation")
                return QueryResult(
                    question=question,
                    answer="[Cancelled]",
                    sources=[],
                    context_length=0,
                    inference_time=time.time() - start_time,
                    chunks_retrieved=chunks_retrieved,
                )
            raise

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
            chunks_retrieved=chunks_retrieved,
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


if __name__ == "__main__":
    import sys

    engine = RAGEngine()

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
