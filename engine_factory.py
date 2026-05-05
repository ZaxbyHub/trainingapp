"""Unified engine factory for consistent RAGEngine construction across all entry points."""

from typing import Optional, Dict, Any, TYPE_CHECKING
from pathlib import Path
from config import DEFAULT_MAX_TOKENS

from app_paths import get_bundled_model_path

if TYPE_CHECKING:
    from rag_engine import RAGEngine, RAGConfig


# Cache for lazy-loaded RAGEngine and RAGConfig classes
_rag_classes_cache = None


def _get_rag_classes():
    """Lazy import RAGEngine and RAGConfig with caching to avoid circular dependencies."""
    global _rag_classes_cache
    if _rag_classes_cache is None:
        from rag_engine import RAGEngine, RAGConfig
        _rag_classes_cache = (RAGEngine, RAGConfig)
    return _rag_classes_cache


def create_engine(
    config: Optional["RAGConfig"] = None,
    gguf_path: Optional[str] = None,
    embedding_model: Optional[str] = None,
) -> "RAGEngine":
    """Create a RAGEngine with consistent configuration.

    This is the unified factory function that should be used by ALL entry points
    (GUI, CLI, API) to ensure consistent engine construction.

    Priority order for GGUF path:
    1. gguf_path parameter (explicit)
    2. RAG_GGUF_PATH environment variable
    3. None (use other backends)

    Args:
        config: RAGConfig instance (creates default if None)
        gguf_path: Path to GGUF model file (preferred)
        embedding_model: Embedding model name/path

    Returns:
        Configured RAGEngine instance
    """
    RAGEngine, RAGConfig = _get_rag_classes()

    # Normalize config
    if config is None:
        config = RAGConfig()

    # Normalize GGUF path with priority order
    final_gguf_path = _resolve_gguf_path(gguf_path)

    # Override embedding_model in config if provided
    if embedding_model is not None:
        config.embedding_model = embedding_model

    # Create engine
    return RAGEngine(
        config=config,
        gguf_path=final_gguf_path,
    )


def _resolve_gguf_path(gguf_path: Optional[str]) -> Optional[str]:
    """Resolve GGUF path with priority order.

    Priority order:
    1. gguf_path parameter (explicit)
    2. RAG_GGUF_PATH environment variable
    3. get_bundled_model_path() from app_paths
    4. None (use other backends)

    Args:
        gguf_path: Explicit GGUF path parameter

    Returns:
        Resolved GGUF path or None
    """
    import os

    # Priority 1: Explicit gguf_path parameter
    if gguf_path and gguf_path.strip():
        return gguf_path

    # Priority 2: Environment variable
    env_gguf = os.environ.get("RAG_GGUF_PATH")
    if env_gguf:
        return env_gguf

    # Priority 3: Bundled model from app_paths
    bundled_model = get_bundled_model_path()
    if bundled_model:
        return str(bundled_model)

    # Priority 4: None
    return None


def create_engine_from_settings(settings: Dict[str, Any]) -> "RAGEngine":
    """Create engine from settings dictionary (for GUI mode).

    Args:
        settings: Dictionary with keys like 'gguf_path', etc.

    Returns:
        Configured RAGEngine instance
    """
    RAGEngine, RAGConfig = _get_rag_classes()

    def _get(key, default=None):
        """Check canonical key first, then rag_ prefixed legacy key."""
        val = settings.get(key)
        if val is None:
            val = settings.get(f"rag_{key}")
        return val if val is not None else default

    # Extract RAG config parameters with defaults
    config = RAGConfig(
        db_path=_get("db_path", "./doc_qa_db"),
        chunk_size=_get("chunk_size", 512),
        chunk_overlap=_get("chunk_overlap", 100),
        n_results=_get("n_results", 4),
        max_tokens=_get("max_tokens", 512),
        temperature=_get("temperature", 0.3),
        embedding_model=_get("embedding_model", "BAAI/bge-small-en-v1.5"),
        hybrid_search=_get("hybrid_search", True),
        retrieval_window=_get("retrieval_window", 1),
        reranking_enabled=_get("reranking_enabled", False),
        initial_retrieval_top_k=_get("initial_retrieval_top_k", 12),
        rerank_top_k=_get("rerank_top_k", 4),
        reranker_model=_get("reranker_model", "cross-encoder/ms-marco-MiniLM-L6-v2"),
        min_similarity=_get("min_similarity", 0.3),
        context_truncation=_get("context_truncation", 20000),
        query_transformation_enabled=_get("query_transformation_enabled", False),
        gguf_n_ctx=_get("gguf_n_ctx", 4096),
        gguf_n_threads=_get("gguf_n_threads", 4),
    )

    return create_engine(
        config=config,
        gguf_path=settings.get("gguf_path"),
    )


def create_engine_from_env() -> "RAGEngine":
    """Create engine from environment variables (for CLI/API modes).

    This replaces the create_engine_from_env() function in rag_engine.py
    with a unified implementation.

    Environment variables:
        RAG_DB_PATH: Database path (default: ./doc_qa_db)
        RAG_CHUNK_SIZE: Chunk size (default: 512)
        RAG_CHUNK_OVERLAP: Chunk overlap (default: 100)
        RAG_N_RESULTS: Number of results (default: 4)
        RAG_MAX_TOKENS: Max tokens (default: see DEFAULT_MAX_TOKENS constant in config.py)
        RAG_TEMPERATURE: Temperature (default: 0.3)
        RAG_EMBEDDING_MODEL: Embedding model (default: BAAI/bge-small-en-v1.5)
        RAG_HYBRID_SEARCH: Enable hybrid search (default: true)
        RAG_RETRIEVAL_WINDOW: Retrieval window (default: 1)
        RAG_RERANKING_ENABLED: Enable reranking (default: false)
        RAG_RERANKER_MODEL: Reranker model (default: cross-encoder/ms-marco-MiniLM-L6-v2)
        RAG_INITIAL_RETRIEVAL_TOP_K: Initial retrieval top-k (default: 12)
        RAG_RERANK_TOP_K: Rerank top-k (default: 4)
        RAG_GGUF_PATH: Path to GGUF model

    Returns:
        Configured RAGEngine instance
    """
    import os
    RAGEngine, RAGConfig = _get_rag_classes()

    # Helper function to parse boolean from env var
    def _parse_bool(value: Optional[str], default: bool) -> bool:
        if value is None:
            return default
        return value.lower() in ("true", "1", "yes", "on")

    # Build config from centralized settings with validation
    from config import settings

    config = RAGConfig(
        db_path=settings.rag_db_path,
        chunk_size=settings.rag_chunk_size,
        chunk_overlap=settings.rag_chunk_overlap,
        n_results=settings.rag_n_results,
        min_similarity=settings.rag_min_similarity,
        max_tokens=settings.rag_max_tokens,
        temperature=settings.rag_temperature,
        embedding_model=settings.rag_embedding_model,
        hybrid_search=settings.rag_hybrid_search,
        retrieval_window=settings.rag_retrieval_window,
        reranking_enabled=settings.rag_reranking_enabled,
        initial_retrieval_top_k=getattr(settings, "rag_initial_retrieval_top_k", 12),
        rerank_top_k=getattr(settings, "rag_rerank_top_k", 4),
        reranker_model=getattr(settings, "rag_reranker_model", "cross-encoder/ms-marco-MiniLM-L6-v2"),
        gguf_n_ctx=getattr(settings, "rag_gguf_n_ctx", 4096),
        gguf_n_threads=getattr(settings, "rag_gguf_n_threads", 4),
    )

    # Get GGUF path from env var or bundled model
    gguf_path = os.environ.get("RAG_GGUF_PATH")
    if not gguf_path:
        bundled_model = get_bundled_model_path()
        if bundled_model:
            gguf_path = str(bundled_model)
            print(f"[INFO] Using bundled model: {bundled_model}")

    return create_engine(
        config=config,
        gguf_path=gguf_path,
    )
