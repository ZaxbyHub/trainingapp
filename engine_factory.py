"""Unified engine factory for consistent RAGEngine construction across all entry points."""

from typing import Optional, Dict, Any, TYPE_CHECKING
from pathlib import Path

if TYPE_CHECKING:
    from rag_engine import RAGEngine, RAGConfig


def create_engine(
    config: Optional["RAGConfig"] = None,
    gguf_path: Optional[str] = None,
    model_path: Optional[str] = None,  # For backward compatibility
    ollama_model: Optional[str] = None,
    ollama_url: Optional[str] = None,
    api_url: Optional[str] = None,
    api_model: Optional[str] = None,
    device: Optional[str] = None,
    embedding_model: Optional[str] = None,
) -> "RAGEngine":
    """Create a RAGEngine with consistent configuration.

    This is the unified factory function that should be used by ALL entry points
    (GUI, CLI, API) to ensure consistent engine construction.

    Priority order for GGUF path:
    1. gguf_path parameter (explicit)
    2. model_path parameter (backward compatibility)
    3. RAG_GGUF_PATH environment variable
    4. None (use other backends)

    Args:
        config: RAGConfig instance (creates default if None)
        gguf_path: Path to GGUF model file (preferred)
        model_path: Path to model (backward compatibility, maps to gguf_path)
        ollama_model: Ollama model name
        ollama_url: Ollama server URL
        api_url: OpenAI-compatible API URL
        api_model: API model name
        device: Device for inference (cpu, cuda, etc.)
        embedding_model: Embedding model name/path

    Returns:
        Configured RAGEngine instance
    """
    from rag_engine import (
        RAGEngine,
        RAGConfig,
    )  # Lazy import to avoid circular dependency

    # Normalize config
    if config is None:
        config = RAGConfig()

    # Normalize GGUF path with priority order
    final_gguf_path = _resolve_gguf_path(gguf_path, model_path)

    # Override embedding_model in config if provided
    if embedding_model is not None:
        config.embedding_model = embedding_model

    # Create engine
    return RAGEngine(
        config=config,
        gguf_path=final_gguf_path,
        model_path=None,  # Don't pass model_path to avoid confusion
        ollama_model=ollama_model,
        ollama_url=ollama_url,
        api_url=api_url,
        api_model=api_model,
        device=device,
    )


def _resolve_gguf_path(
    gguf_path: Optional[str], model_path: Optional[str]
) -> Optional[str]:
    """Resolve GGUF path with priority order.

    Priority order:
    1. gguf_path parameter (explicit)
    2. model_path parameter (backward compatibility)
    3. RAG_GGUF_PATH environment variable
    4. None (use other backends)

    Args:
        gguf_path: Explicit GGUF path parameter
        model_path: Backward compatibility model_path parameter

    Returns:
        Resolved GGUF path or None
    """
    import os

    # Priority 1: Explicit gguf_path parameter
    if gguf_path:
        return gguf_path

    # Priority 2: Backward compatibility model_path
    if model_path:
        return model_path

    # Priority 3: Environment variable
    env_gguf = os.environ.get("RAG_GGUF_PATH")
    if env_gguf:
        return env_gguf

    # Priority 4: None
    return None


def create_engine_from_settings(settings: Dict[str, Any]) -> "RAGEngine":
    """Create engine from settings dictionary (for GUI mode).

    Args:
        settings: Dictionary with keys like 'gguf_path', 'ollama_url', etc.

    Returns:
        Configured RAGEngine instance
    """
    from rag_engine import (
        RAGEngine,
        RAGConfig,
    )  # Lazy import to avoid circular dependency

    # Extract RAG config parameters with defaults
    config = RAGConfig(
        db_path=settings.get("db_path", "./doc_qa_db"),
        chunk_size=settings.get("chunk_size", 512),
        chunk_overlap=settings.get("chunk_overlap", 50),
        n_results=settings.get("n_results", 3),
        max_tokens=settings.get("max_tokens", 1024),
        temperature=settings.get("temperature", 0.3),
        embedding_model=settings.get("embedding_model", "BAAI/bge-small-en-v1.5"),
        hybrid_search=settings.get("hybrid_search", True),
        retrieval_window=settings.get("retrieval_window", 1),
        reranking_enabled=settings.get("reranking_enabled", False),
    )

    return create_engine(
        config=config,
        gguf_path=settings.get("gguf_path"),
        model_path=settings.get("model_path"),  # Backward compat
        ollama_model=settings.get("ollama_model"),
        ollama_url=settings.get("ollama_url"),
        api_url=settings.get("api_url"),
        api_model=settings.get("api_model"),
        device=settings.get("device"),
    )


def create_engine_from_env() -> "RAGEngine":
    """Create engine from environment variables (for CLI/API modes).

    This replaces the create_engine_from_env() function in rag_engine.py
    with a unified implementation.

    Environment variables:
        RAG_DB_PATH: Database path (default: ./doc_qa_db)
        RAG_CHUNK_SIZE: Chunk size (default: 512)
        RAG_CHUNK_OVERLAP: Chunk overlap (default: 50)
        RAG_N_RESULTS: Number of results (default: 3)
        RAG_MAX_TOKENS: Max tokens (default: 512)
        RAG_TEMPERATURE: Temperature (default: 0.3)
        RAG_EMBEDDING_MODEL: Embedding model (default: BAAI/bge-small-en-v1.5)
        RAG_HYBRID_SEARCH: Enable hybrid search (default: true)
        RAG_RETRIEVAL_WINDOW: Retrieval window (default: 1)
        RAG_RERANKING_ENABLED: Enable reranking (default: false)
        RAG_GGUF_PATH: Path to GGUF model
        RAG_MODEL_PATH: Backward compat path to model
        RAG_OLLAMA_MODEL: Ollama model name
        RAG_OLLAMA_URL: Ollama server URL
        RAG_API_URL: OpenAI-compatible API URL
        RAG_API_MODEL: API model name
        RAG_DEVICE: Device for inference

    Returns:
        Configured RAGEngine instance
    """
    import os
    from rag_engine import (
        RAGEngine,
        RAGConfig,
    )  # Lazy import to avoid circular dependency

    # Helper function to parse boolean from env var
    def _parse_bool(value: Optional[str], default: bool) -> bool:
        if value is None:
            return default
        return value.lower() in ("true", "1", "yes", "on")

    # Build config from environment with safe type conversion
    config = RAGConfig(
        db_path=os.environ.get("RAG_DB_PATH", "./doc_qa_db"),
        chunk_size=int(os.environ.get("RAG_CHUNK_SIZE", "512")),
        chunk_overlap=int(os.environ.get("RAG_CHUNK_OVERLAP", "50")),
        n_results=int(os.environ.get("RAG_N_RESULTS", "3")),
        max_tokens=int(os.environ.get("RAG_MAX_TOKENS", "1024")),
        temperature=float(os.environ.get("RAG_TEMPERATURE", "0.3")),
        embedding_model=os.environ.get("RAG_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"),
        hybrid_search=_parse_bool(os.environ.get("RAG_HYBRID_SEARCH"), True),
        retrieval_window=int(os.environ.get("RAG_RETRIEVAL_WINDOW", "1")),
        reranking_enabled=_parse_bool(os.environ.get("RAG_RERANKING_ENABLED"), False),
    )

    return create_engine(
        config=config,
        gguf_path=os.environ.get("RAG_GGUF_PATH"),
        model_path=os.environ.get("RAG_MODEL_PATH"),  # Backward compat
        ollama_model=os.environ.get("RAG_OLLAMA_MODEL"),
        ollama_url=os.environ.get("RAG_OLLAMA_URL"),
        api_url=os.environ.get("RAG_API_URL"),
        api_model=os.environ.get("RAG_API_MODEL"),
        device=os.environ.get("RAG_DEVICE"),
    )
