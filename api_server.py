"""
Document Q&A API Server
FastAPI-based REST API for the RAG system.
"""

import os
import sys
import json
import re
import socket
import logging
import asyncio
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
from llm_interface import QueryCancelled
from security import validate_url, validate_device, DEFAULT_ALLOWED_PORTS
from auth import authenticate, require_auth, get_auth_status, API_KEY, create_access_token
from config import settings, get_settings

# SSE streaming support (pip install sse-starlette)
try:
    from sse_starlette.sse import EventSourceResponse
    HAS_SSE = True
except ImportError:
    HAS_SSE = False

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


class BatchFileResult(BaseModel):
    """Result for a single file in batch ingestion."""

    filename: str
    success: bool
    chunks_added: int = 0
    error: Optional[str] = None


class BatchIngestResponse(BaseModel):
    """Response model for batch ingestion."""

    total_files: int
    successful: int
    failed: int
    results: List[BatchFileResult]


class SettingsResponse(BaseModel):
    """Response model for settings."""

    chunk_size: int
    chunk_overlap: int
    n_results: int
    min_similarity: float
    temperature: float
    max_tokens: int
    hybrid_search: bool
    reranking_enabled: bool
    context_truncation: int
    retrieval_window: int
    initial_retrieval_top_k: int
    rerank_top_k: int


class SettingsUpdateRequest(BaseModel):
    """Request model for updating settings."""

    rag_chunk_size: Optional[int] = Field(default=None, ge=128, le=8192)
    rag_chunk_overlap: Optional[int] = Field(default=None, ge=0)
    rag_n_results: Optional[int] = Field(default=None, ge=1, le=10)
    rag_min_similarity: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    rag_temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    rag_max_tokens: Optional[int] = Field(default=None, ge=256, le=4096)
    rag_hybrid_search: Optional[bool] = None
    rag_reranking_enabled: Optional[bool] = None
    rag_context_truncation: Optional[int] = Field(default=None, ge=1)
    rag_retrieval_window: Optional[int] = Field(default=None, ge=0)
    rag_initial_retrieval_top_k: Optional[int] = Field(default=None, ge=1, le=50)
    rag_rerank_top_k: Optional[int] = Field(default=None, ge=1, le=20)


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
            context_truncation=settings.rag_context_truncation,
            gguf_n_ctx=settings.rag_gguf_n_ctx,
            gguf_n_threads=settings.rag_gguf_n_threads,
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
    version="2.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins_list(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


@app.middleware("http")
async def cross_origin_isolation(request: Request, call_next):
    """Send COOP/COEP so the served HTML5 archive can use SharedArrayBuffer
    (required for wllama's multi-threaded WASM inference).

    Only emitted when this server is actually serving the offline web archive
    (`_web_archive_dir` resolved at startup). Pure API-only deployments don't
    need cross-origin isolation, and emitting COOP/COEP there would needlessly
    affect external API consumers and iframe embedders."""
    response = await call_next(request)
    if _web_archive_dir is not None:
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return response


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
    """Serve the web archive's index at the root when bundled; otherwise return
    a JSON health payload. (`_web_archive_dir` is assigned at module load, below.)"""
    if _web_archive_dir is not None:
        from fastapi.responses import FileResponse

        return FileResponse(str(_web_archive_dir / "index.html"))
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
        result = await asyncio.to_thread(engine.query, request.question, n_results=request.n_results)
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
        results = await asyncio.to_thread(engine.search_documents, request.query, n_results=request.n_results)
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
        stats = await asyncio.to_thread(engine.ingest_directory, validated_dir)
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
            tmp.write(file_content)
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


if HAS_SSE:
    @app.post("/ask/stream")
    async def ask_question_stream(
        request: QuestionRequest, auth: dict = Security(require_auth())
    ):
        """Ask a question with SSE streaming response."""
        if not engine:
            raise HTTPException(status_code=503, detail="Engine not initialized")

        if not engine.llm:
            raise HTTPException(status_code=503, detail="No LLM backend available")

        async def event_generator():
            queue = asyncio.Queue()
            sources = []
            context_length = 0
            inference_time = 0.0
            loop = asyncio.get_event_loop()

            def stream_callback(token: str):
                # Called from background thread — put token into async queue
                loop.call_soon_threadsafe(queue.put_nowait, {"token": token})

            # Run query in thread, callback will feed queue
            query_future = asyncio.to_thread(
                engine.query,
                request.question,
                n_results=request.n_results,
                stream_callback=stream_callback,
            )

            try:
                while True:
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=0.1)
                        yield {"event": "message", "data": json.dumps(msg)}
                    except asyncio.TimeoutError:
                        if query_future.done():
                            break
                        continue

                # Drain remaining queue items
                while not queue.empty():
                    msg = queue.get_nowait()
                    yield {"event": "message", "data": json.dumps(msg)}

                result = query_future.result()  # Raises if query failed
                sources = result.sources
                context_length = result.context_length
                inference_time = result.inference_time

                yield {
                    "event": "message",
                    "data": json.dumps({
                        "done": True,
                        "sources": sources,
                        "context_length": context_length,
                        "inference_time": inference_time,
                    }),
                }
            except QueryCancelled:
                yield {
                    "event": "message",
                    "data": json.dumps({
                        "done": True,
                        "cancelled": True,
                        "sources": sources,
                    }),
                }
            except Exception as e:
                logger.error("Error in ask_question_stream: %s", e)
                yield {
                    "event": "error",
                    "data": json.dumps({"error": "An error occurred processing your question"}),
                }

        return EventSourceResponse(event_generator())


@app.post("/ingest/batch", response_model=BatchIngestResponse)
async def ingest_batch(
    files: List[UploadFile] = File(...), auth: dict = Security(require_auth())
):
    """Ingest multiple files in a single request (max 20 files)."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    MAX_BATCH_FILES = 20
    MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB

    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files. Maximum is {MAX_BATCH_FILES} per request.",
        )

    results = []
    successful = 0
    failed = 0

    import tempfile

    for file in files:
        if not file.filename:
            results.append(BatchFileResult(
                filename="unknown",
                success=False,
                error="Filename is required",
            ))
            failed += 1
            continue

        # Check file size
        file_content = await file.read()
        file_size = len(file_content)

        if file_size > MAX_FILE_SIZE:
            results.append(BatchFileResult(
                filename=file.filename,
                success=False,
                error=f"File too large. Maximum size is 50MB.",
            ))
            failed += 1
            continue

        # Sanitize filename
        try:
            safe_filename, display_name = sanitize_filename(file.filename)
        except ValueError as e:
            results.append(BatchFileResult(
                filename=file.filename,
                success=False,
                error="Invalid filename",
            ))
            failed += 1
            continue

        ext = Path(safe_filename).suffix.lower()
        if ext not in {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".txt", ".md", ".xlsx"}:
            results.append(BatchFileResult(
                filename=file.filename,
                success=False,
                error=f"Unsupported file type: {ext}",
            ))
            failed += 1
            continue

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(file_content)
                tmp_path = tmp.name

            stats = engine.ingest_file(tmp_path, source_name=display_name)

            if stats["success"]:
                successful += 1
                results.append(BatchFileResult(
                    filename=file.filename,
                    success=True,
                    chunks_added=stats.get("chunks_added", 0),
                ))
            else:
                failed += 1
                results.append(BatchFileResult(
                    filename=file.filename,
                    success=False,
                    error=stats.get("message", "Unknown error"),
                ))
        except Exception as e:
            logger.error("Error in ingest_batch for file %s: %s", file.filename, e)
            failed += 1
            results.append(BatchFileResult(
                filename=file.filename,
                success=False,
                error="An error occurred ingesting the file",
            ))
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)

    return BatchIngestResponse(
        total_files=len(files),
        successful=successful,
        failed=failed,
        results=results,
    )


@app.get("/settings", response_model=SettingsResponse)
async def get_settings_endpoint(auth: dict = Security(require_auth())):
    """Get current RAG settings (excludes sensitive values)."""
    s = get_settings()
    return SettingsResponse(
        chunk_size=s.rag_chunk_size,
        chunk_overlap=s.rag_chunk_overlap,
        n_results=s.rag_n_results,
        min_similarity=s.rag_min_similarity,
        temperature=s.rag_temperature,
        max_tokens=s.rag_max_tokens,
        hybrid_search=s.rag_hybrid_search,
        reranking_enabled=s.rag_reranking_enabled,
        context_truncation=s.rag_context_truncation,
        retrieval_window=s.rag_retrieval_window,
        initial_retrieval_top_k=s.rag_initial_retrieval_top_k,
        rerank_top_k=s.rag_rerank_top_k,
    )


@app.put("/settings", response_model=SettingsResponse)
async def update_settings(
    request: SettingsUpdateRequest, auth: dict = Security(require_auth())
):
    """Update RAG settings."""
    s = get_settings()

    # Update only provided fields
    if request.rag_chunk_size is not None:
        s.rag_chunk_size = request.rag_chunk_size
    if request.rag_chunk_overlap is not None:
        s.rag_chunk_overlap = request.rag_chunk_overlap
    if request.rag_n_results is not None:
        s.rag_n_results = request.rag_n_results
    if request.rag_min_similarity is not None:
        s.rag_min_similarity = request.rag_min_similarity
    if request.rag_temperature is not None:
        s.rag_temperature = request.rag_temperature
    if request.rag_max_tokens is not None:
        s.rag_max_tokens = request.rag_max_tokens
    if request.rag_hybrid_search is not None:
        s.rag_hybrid_search = request.rag_hybrid_search
    if request.rag_reranking_enabled is not None:
        s.rag_reranking_enabled = request.rag_reranking_enabled
    if request.rag_context_truncation is not None:
        s.rag_context_truncation = request.rag_context_truncation
    if request.rag_retrieval_window is not None:
        s.rag_retrieval_window = request.rag_retrieval_window
    if request.rag_initial_retrieval_top_k is not None:
        s.rag_initial_retrieval_top_k = request.rag_initial_retrieval_top_k
    if request.rag_rerank_top_k is not None:
        s.rag_rerank_top_k = request.rag_rerank_top_k

    # Cross-field validation
    if s.rag_chunk_overlap >= s.rag_chunk_size:
        raise HTTPException(
            status_code=400,
            detail="rag_chunk_overlap must be less than rag_chunk_size",
        )

    return SettingsResponse(
        chunk_size=s.rag_chunk_size,
        chunk_overlap=s.rag_chunk_overlap,
        n_results=s.rag_n_results,
        min_similarity=s.rag_min_similarity,
        temperature=s.rag_temperature,
        max_tokens=s.rag_max_tokens,
        hybrid_search=s.rag_hybrid_search,
        reranking_enabled=s.rag_reranking_enabled,
        context_truncation=s.rag_context_truncation,
        retrieval_window=s.rag_retrieval_window,
        initial_retrieval_top_k=s.rag_initial_retrieval_top_k,
        rerank_top_k=s.rag_rerank_top_k,
    )


def _resolve_web_archive_dir() -> Optional[Path]:
    """Locate the packaged HTML5 web archive (web_ui/dist), if present.

    Resolution order: WEB_UI_DIST env var → PyInstaller bundle (sys._MEIPASS) →
    repo-local web_ui/dist. Returns None if no built archive is available.
    """
    candidates = []
    env_dir = os.environ.get("WEB_UI_DIST")
    if env_dir:
        candidates.append(Path(env_dir))
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "web_ui_dist")
    candidates.append(Path(__file__).resolve().parent / "web_ui" / "dist")

    for c in candidates:
        if c and (c / "index.html").is_file():
            return c
    return None


# Serve the self-contained HTML5 archive (with its packaged models) at the root,
# AFTER all API routes so /ask, /auth, etc. take precedence. The COOP/COEP
# middleware above applies to these responses too, enabling wllama's WASM threads.
_web_archive_dir = _resolve_web_archive_dir()
if _web_archive_dir is not None:
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_web_archive_dir), html=True), name="web")
    logger.info("Serving HTML5 web archive from %s", _web_archive_dir)
else:
    logger.info("No web_ui/dist archive found; serving API only.")


def main():
    """Run the API server."""
    import uvicorn

    host = os.environ.get("API_HOST", "0.0.0.0")  # nosec: B104 — intentional, configurable via API_HOST env var
    port = int(os.environ.get("API_PORT", "8080"))

    print(f"Starting server on {host}:{port}")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
