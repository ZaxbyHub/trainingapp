"""
Document Q&A API Server
FastAPI-based REST API for the RAG system.
"""

import os
import json
import re
import socket
import logging
import unicodedata
from typing import Optional, Set, Tuple, List
from pathlib import Path
from contextlib import asynccontextmanager
from urllib.parse import urlparse, unquote
import ipaddress

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Security, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import uuid
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator

from rag_engine import RAGEngine, RAGConfig
from security import validate_url, DEFAULT_ALLOWED_PORTS
from auth import authenticate, require_auth, get_auth_status, API_KEY, create_access_token
from config import settings

# Set up logger
logger = logging.getLogger(__name__)


def _resolve_and_validate_path(path: str, base_dir: Path = Path(".")) -> Path:
    """Shared path resolution and validation for model and directory paths."""
    normalized_path = unquote(path)
    
    if not path:
        raise ValueError("Path cannot be empty")
    
    if ".." in normalized_path:
        raise ValueError("Path contains path traversal attempts")
    
    # Reject null bytes — can truncate paths on some systems
    if "\x00" in normalized_path:
        raise ValueError("Path contains null bytes")
    
    input_path = Path(normalized_path)
    
    if input_path.is_absolute():
        resolved_path = input_path.resolve(strict=False)
    else:
        resolved_path = (base_dir / input_path).resolve(strict=False)
        try:
            resolved_path.relative_to(base_dir.resolve())
        except ValueError:
            raise ValueError("Path is outside the allowed directory")
    
    return resolved_path


def validate_model_path(path: str, base_dir: Path = Path(".")) -> str:
    """Validate model path to prevent path traversal and ensure safety."""
    if not path:
        raise ValueError("Model path cannot be empty")
    resolved_path = _resolve_and_validate_path(path, base_dir)
    if not os.path.exists(resolved_path):
        raise ValueError("Model path does not exist")
    return str(resolved_path)


def validate_directory(path: str, base_dir: Path = Path(".")) -> str:
    """Validate directory path to prevent path traversal and ensure safety."""
    if not path:
        raise ValueError("Directory path cannot be empty")
    resolved_path = _resolve_and_validate_path(path, base_dir)
    if not os.path.isdir(resolved_path):
        raise ValueError("Directory does not exist")
    return str(resolved_path)


# Windows reserved names
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
}


def sanitize_filename(filename: str) -> Tuple[str, str]:
    """
    Sanitize filename for safe filesystem storage while preserving display name.

    Args:
        filename: Original filename from upload

    Returns:
        Tuple of (sanitized_filename, display_name)
        - sanitized_filename: Safe filename for filesystem storage
        - display_name: Original (or cleaned) name for UI/metadata display

    Raises:
        ValueError: If filename is empty or invalid
    """
    if not filename:
        raise ValueError("Filename cannot be empty")

    # Step 1: Strip directory components
    basename = os.path.basename(filename)

    # Step 2: Normalize Unicode (NFKC to prevent homograph attacks)
    normalized = unicodedata.normalize("NFKC", basename)

    # Step 3: Remove null bytes and control characters
    cleaned = "".join(
        char for char in normalized if char.isprintable() and ord(char) > 31
    )

    # Step 4: Replace path separators and dangerous characters
    # Replace backslashes, forward slashes, colons with underscores
    cleaned = cleaned.replace("\\", "_").replace("/", "_").replace(":", "_")

    # Step 5: Check for Windows reserved names (case-insensitive)
    name_without_ext = Path(cleaned).stem.upper()
    if name_without_ext in WINDOWS_RESERVED_NAMES:
        # Prepend underscore to make it safe
        stem = Path(cleaned).stem
        suffix = Path(cleaned).suffix
        cleaned = f"_{stem}{suffix}"

    # Step 6: Limit length (255 chars is typical filesystem max)
    if len(cleaned) > 255:
        stem = Path(cleaned).stem[:250]
        suffix = Path(cleaned).suffix
        cleaned = f"{stem}{suffix}"

    # Step 7: Ensure we have something left
    if not cleaned or cleaned == "." or cleaned == ".." or cleaned.strip() == "":
        raise ValueError("Filename is invalid after sanitization")

    # Return sanitized name and display name (display uses sanitized for safety)
    return cleaned, cleaned


# Global engine instance
engine: Optional[RAGEngine] = None


class QuestionRequest(BaseModel):
    """Request model for asking questions."""

    question: str = Field(..., min_length=1, max_length=2000)
    n_results: Optional[int] = Field(default=6, ge=1, le=10)

    @validator("question")
    def validate_question_not_whitespace(cls, v):
        if not v or not v.strip():
            raise ValueError("Question cannot be empty or whitespace-only")
        return v.strip()


class LoginRequest(BaseModel):
    """Request model for authentication."""

    api_key: str = Field(..., description="API key for authentication")


class DocumentInfo(BaseModel):
    """Document with metadata."""

    id: str = Field(..., description="Document source path")
    chunk_count: int = Field(..., description="Number of chunks for this document")


class DocumentsResponse(BaseModel):
    """Response model for listing documents."""

    documents: List[DocumentInfo]
    total: int


class QuestionResponse(BaseModel):
    """Response model for question answers."""

    question: str
    answer: str
    sources: List[str]
    context_length: int
    inference_time: float


class SearchRequest(BaseModel):
    """Request model for document search."""

    query: str = Field(..., min_length=1, max_length=500)
    n_results: int = Field(default=5, ge=1, le=20)

    @validator("query")
    def validate_query_not_whitespace(cls, v):
        if not v or not v.strip():
            raise ValueError("Query cannot be empty or whitespace-only")
        return v.strip()


class SearchResult(BaseModel):
    """Single search result."""

    text: str
    source: str
    similarity: float


class IngestRequest(BaseModel):
    """Request model for document ingestion."""

    directory: str


class IngestResponse(BaseModel):
    """Response model for ingestion."""

    success: bool
    documents: int = 0
    chunks_added: int = 0
    message: Optional[str] = None


class StatsResponse(BaseModel):
    """Response model for engine statistics."""

    document_count: int
    chunk_count: int
    embedding_model: str
    llm_backend: Optional[str]
    documents: List[str] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan handler for startup/shutdown."""
    global engine

    print("Starting Document Q&A API Server...")

    try:
        # Use centralized settings with Pydantic validation
        db_path = settings.rag_db_path
        chunk_size = settings.rag_chunk_size
        n_results = settings.rag_n_results
        max_tokens = settings.rag_max_tokens
        temperature = settings.rag_temperature

        # Validate GGUF path if provided
        gguf_path = os.environ.get("RAG_GGUF_PATH")

        if gguf_path is not None:
            try:
                gguf_path = validate_model_path(gguf_path, Path("."))
            except ValueError as e:
                logger.error("Invalid GGUF path configuration: %s", e)
                raise RuntimeError("Startup failed: Invalid configuration")

        config = RAGConfig(
            db_path=db_path,
            chunk_size=chunk_size,
            n_results=n_results,
            max_tokens=max_tokens,
            temperature=temperature,
            embedding_model=settings.rag_embedding_model,
            chunk_overlap=settings.rag_chunk_overlap,
            min_similarity=settings.rag_min_similarity,
            retrieval_window=settings.rag_retrieval_window,
            hybrid_search=settings.rag_hybrid_search,
            reranking_enabled=settings.rag_reranking_enabled,
            reranker_model=settings.rag_reranker_model,
            query_transformation_enabled=False,
            initial_retrieval_top_k=settings.rag_initial_retrieval_top_k,
            rerank_top_k=settings.rag_rerank_top_k,
        )

        engine = RAGEngine(
            config=config,
            gguf_path=gguf_path,
        )

        yield

    except Exception as e:
        logger.error("Startup configuration error: %s", e)
        raise RuntimeError(f"Startup failed: {e}")

    print("Shutting down...")


app = FastAPI(
    title="Document Q&A API",
    description="RAG-based document question answering API",
    version="1.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins_list(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Return user-friendly validation error messages."""
    errors = exc.errors()
    detail_lines = []
    for err in errors:
        loc = ".".join(str(l) for l in err["loc"])
        detail_lines.append(f"{loc}: {err['msg']}")
    return JSONResponse(
        status_code=422,
        content={
            "detail": "Request validation failed",
            "errors": detail_lines,
        },
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all handler — logs the error and returns a safe 500 response."""
    corr_id = str(uuid.uuid4())[:8]
    logger.error("Unhandled exception [%s] %s: %s", corr_id, type(exc).__name__, exc)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An internal error occurred. If the problem persists, contact support with "
            f"correlation ID {corr_id}.",
            "correlation_id": corr_id,
        },
    )


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "service": "Document Q&A API",
        "version": "1.1.2",
        "docs": "/docs",
        "auth_status": "/auth/status",
    }


@app.get("/auth/status")
async def auth_status():
    """Get authentication status and configuration."""
    return get_auth_status()


@app.post("/auth/token")
async def login(request: LoginRequest):
    """
    Login endpoint to obtain JWT token.

    Returns:
        - access_token: JWT token
        - token_type: "bearer"
    """
    from auth import ENABLE_AUTH, API_KEY, create_access_token

    if not ENABLE_AUTH:
        raise HTTPException(
            status_code=503,
            detail="Authentication is not enabled on this server. "
            "Check /auth/status for current configuration.",
        )

    if request.api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

    access_token = create_access_token(data={"sub": "api_user"})
    return {"access_token": access_token, "token_type": "bearer"}


@app.get("/stats", response_model=StatsResponse)
async def get_stats(auth: dict = Security(require_auth())):
    """Get engine statistics."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    stats = engine.get_stats()
    return StatsResponse(
        document_count=stats["document_count"],
        chunk_count=stats["chunk_count"],
        embedding_model=stats["embedding_model"],
        llm_backend=stats["llm"]["backend"] if stats["llm"] else None,
        documents=stats.get("documents", []),
    )


@app.post("/ask", response_model=QuestionResponse)
async def ask_question(
    request: QuestionRequest, auth: dict = Security(require_auth())
):
    """Ask a question about the ingested documents."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    if not engine.llm:
        raise HTTPException(status_code=503, detail="No LLM backend available")

    try:
        result = engine.query(request.question, n_results=request.n_results)
        return QuestionResponse(
            question=result.question,
            answer=result.answer,
            sources=result.sources,
            context_length=result.context_length,
            inference_time=result.inference_time,
        )
    except Exception as e:
        logger.error("Error in ask_question: %s", e)
        raise HTTPException(
            status_code=500, detail="An error occurred processing your question"
        )


@app.post("/search", response_model=List[SearchResult])
async def search_documents(
    request: SearchRequest, auth: dict = Security(require_auth())
):
    """Search documents without generating an answer."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    try:
        results = engine.search_documents(request.query, n_results=request.n_results)
        return [
            SearchResult(text=doc, source=meta.get("source", "Unknown"), similarity=sim)
            for doc, meta, sim in results
        ]
    except Exception as e:
        logger.error("Error in search_documents: %s", e)
        raise HTTPException(status_code=500, detail="An error occurred during search")


@app.post("/ingest", response_model=IngestResponse)
async def ingest_directory(
    request: IngestRequest, auth: dict = Security(require_auth())
):
    """Ingest documents from a directory."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    try:
        validated_dir = validate_directory(request.directory)
    except ValueError as e:
        logger.error("Invalid directory path: %s", e)
        raise HTTPException(status_code=400, detail="Invalid directory path")

    try:
        stats = engine.ingest_directory(validated_dir)
        return IngestResponse(
            success=stats["success"],
            documents=stats.get("documents", 0),
            chunks_added=stats.get("chunks_added", 0),
            message=stats.get("message"),
        )
    except Exception as e:
        logger.error("Error in ingest_directory: %s", e)
        raise HTTPException(
            status_code=500, detail="Error processing directory ingestion"
        )


@app.post("/ingest/file")
async def ingest_file(
    file: UploadFile = File(...), auth: dict = Security(require_auth())
):
    """Ingest a single uploaded file."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")

    # Check file size (50MB limit)
    MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB in bytes
    file_size = 0
    file_content = await file.read()
    file_size = len(file_content)
    await file.seek(0)  # Reset file pointer for later processing

    if file_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is 50MB. Uploaded file is {file_size / (1024 * 1024):.1f}MB",
        )

    # Sanitize filename
    try:
        safe_filename, display_name = sanitize_filename(file.filename)
    except ValueError as e:
        logger.error("Invalid filename: %s", e)
        raise HTTPException(status_code=400, detail="Invalid filename")

    ext = Path(safe_filename).suffix.lower()
    if ext not in {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".txt", ".md", ".xlsx"}:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    import tempfile

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        # Use sanitized display name as source
        stats = engine.ingest_file(tmp_path, source_name=display_name)

        return IngestResponse(
            success=stats["success"],
            documents=1 if stats["success"] else 0,
            chunks_added=stats.get("chunks_added", 0),
            message=stats.get("message"),
        )
    except Exception as e:
        logger.error("Error in ingest_file: %s", e)
        raise HTTPException(
            status_code=500, detail="An error occurred ingesting the file"
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.delete("/documents")
async def clear_documents(auth: dict = Security(require_auth())):
    """Clear all ingested documents."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    try:
        engine.clear_documents()
        return {"status": "cleared"}
    except Exception as e:
        logger.error("Error in clear_documents: %s", e)
        raise HTTPException(
            status_code=500, detail="An error occurred clearing documents"
        )


@app.get("/documents", response_model=DocumentsResponse)
async def list_documents(auth: dict = Security(require_auth())):
    """List all ingested documents."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    docs = engine.get_all_documents()
    return DocumentsResponse(documents=docs, total=len(docs))


def main():
    """Run the API server."""
    import uvicorn

    host = os.environ.get("API_HOST", "0.0.0.0")
    port = int(os.environ.get("API_PORT", "8080"))

    print(f"Starting server on {host}:{port}")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
