"""
Configuration module using Pydantic BaseSettings.

Provides centralized configuration management with validation,
type coercion, and environment variable support.
"""

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Chunk size constraints
MIN_CHUNK_SIZE = 128
MAX_CHUNK_SIZE = 8192
DEFAULT_CHUNK_SIZE = 512

# Max tokens constraints
MIN_MAX_TOKENS = 256
MAX_MAX_TOKENS = 4096
DEFAULT_MAX_TOKENS = 1024


class RAGSettings(BaseSettings):
    """RAG application settings with environment variable support."""

    # Database settings
    rag_db_path: str = Field(default="./doc_qa_db", validation_alias="RAG_DB_PATH")

    # Chunking settings
    rag_chunk_size: int = Field(default=DEFAULT_CHUNK_SIZE, validation_alias="RAG_CHUNK_SIZE")
    rag_chunk_overlap: int = Field(default=50, validation_alias="RAG_CHUNK_OVERLAP")

    # Retrieval settings
    rag_n_results: int = Field(default=3, validation_alias="RAG_N_RESULTS")
    rag_min_similarity: float = Field(default=0.3, validation_alias="RAG_MIN_SIMILARITY")
    rag_retrieval_window: int = Field(default=1, validation_alias="RAG_RETRIEVAL_WINDOW")

    # LLM settings
    rag_max_tokens: int = Field(default=DEFAULT_MAX_TOKENS, validation_alias="RAG_MAX_TOKENS")
    rag_temperature: float = Field(default=0.3, validation_alias="RAG_TEMPERATURE")

    # Model settings
    rag_embedding_model: str = Field(default="BAAI/bge-small-en-v1.5", validation_alias="RAG_EMBEDDING_MODEL")
    rag_hybrid_search: bool = Field(default=True, validation_alias="RAG_HYBRID_SEARCH")
    rag_reranking_enabled: bool = Field(default=True, validation_alias="RAG_RERANKING_ENABLED")

    # Context truncation settings
    rag_context_truncation: int = Field(default=6000, validation_alias="RAG_CONTEXT_TRUNCATION")

    # CORS settings
    rag_cors_origins: str = Field(default="http://localhost,http://127.0.0.1", validation_alias="RAG_CORS_ORIGINS")

    model_config = SettingsConfigDict(
        env_prefix="RAG_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    @field_validator("rag_min_similarity")
    @classmethod
    def validate_min_similarity(cls, v):
        """Validate min_similarity is between 0 and 1."""
        if not 0.0 <= v <= 1.0:
            raise ValueError(f"RAG_MIN_SIMILARITY must be between 0.0 and 1.0, got {v}")
        return v

    @field_validator("rag_chunk_size")
    @classmethod
    def validate_chunk_size(cls, v):
        """Validate chunk_size is within valid range."""
        if not MIN_CHUNK_SIZE <= v <= MAX_CHUNK_SIZE:
            raise ValueError(f"RAG_CHUNK_SIZE must be between {MIN_CHUNK_SIZE} and {MAX_CHUNK_SIZE}, got {v}")
        return v

    @field_validator("rag_chunk_overlap")
    @classmethod
    def validate_chunk_overlap(cls, v, info):
        """Validate chunk_overlap is non-negative and less than chunk_size."""
        if v < 0:
            raise ValueError(f"RAG_CHUNK_OVERLAP must be non-negative, got {v}")
        chunk_size = info.data.get("rag_chunk_size", 512)
        if v >= chunk_size:
            raise ValueError(
                f"RAG_CHUNK_OVERLAP ({v}) must be less than RAG_CHUNK_SIZE ({chunk_size})"
            )
        return v

    @field_validator("rag_max_tokens")
    @classmethod
    def validate_max_tokens(cls, v):
        """Validate max_tokens is within valid range."""
        if not MIN_MAX_TOKENS <= v <= MAX_MAX_TOKENS:
            raise ValueError(f"RAG_MAX_TOKENS must be between {MIN_MAX_TOKENS} and {MAX_MAX_TOKENS}, got {v}")
        return v

    @field_validator("rag_temperature")
    @classmethod
    def validate_temperature(cls, v):
        """Validate temperature is between 0 and 2."""
        if not 0.0 <= v <= 2.0:
            raise ValueError(f"RAG_TEMPERATURE must be between 0.0 and 2.0, got {v}")
        return v

    @field_validator("rag_context_truncation")
    @classmethod
    def validate_context_truncation(cls, v):
        """Validate context_truncation is a positive integer."""
        if v <= 0:
            raise ValueError(f"RAG_CONTEXT_TRUNCATION must be positive, got {v}")
        return v

    def get_cors_origins_list(self) -> list:
        """Get CORS origins as a list."""
        return [origin.strip() for origin in self.rag_cors_origins.split(",")]


# Global settings instance (lazy to avoid crash-on-load with invalid env vars)
_settings: RAGSettings | None = None


def get_settings() -> RAGSettings:
    """Lazily get or create the global settings instance."""
    global _settings
    if _settings is None:
        _settings = RAGSettings()
    return _settings


# Backwards-compatible: settings attribute proxies to the lazy instance
class _SettingsProxy:
    """Proxy attribute access to the lazily-initialized settings instance."""

    def __getattr__(self, name):
        return getattr(get_settings(), name)

    def __setattr__(self, name, value):
        return setattr(get_settings(), name, value)

    def __repr__(self):
        return repr(get_settings())


settings: RAGSettings = _SettingsProxy()  # type: ignore[assignment]
