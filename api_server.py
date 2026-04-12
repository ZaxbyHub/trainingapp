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

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator

from rag_engine import RAGEngine, RAGConfig
from security import validate_url, DEFAULT_ALLOWED_PORTS
from auth import authenticate, require_auth, get_auth_status, API_KEY, create_access_token
from config import settings

# Set up logger
logger = logging.getLogger(__name__)


def validate_model_path(path: str, base_dir: Path = Path(".")) -> str:
    """
    Validate model path to prevent path traversal and ensure safety.

    Allows absolute paths (like C:\\Models\\model.gguf) while still
    preventing directory traversal attacks.

    Args:
        path: Model path string to validate
        base_dir: Base directory to resolve relative paths against

    Returns:
        Validated model path string

    Raises:
        ValueError: If model path is invalid
    """
    if not path:
        raise ValueError("Model path cannot be empty")

    # Normalize path using unquote to handle %2e%2e encoding
    normalized_path = unquote(path)

    # Check for path traversal attempts
    if ".." in normalized_path:
        raise ValueError("Model path contains path traversal attempts")

    # Parse the input path
    input_path = Path(normalized_path)

    if input_path.is_absolute():
        # Absolute paths: resolve as-is (allows C:\\Models\\model.gguf)
        resolved_path = input_path.resolve(strict=False)
    else:
        # Relative paths: join with base_dir first, then resolve
        resolved_path = (base_dir / input_path).resolve(strict=False)

        # Verify the resolved path stays within base_dir
        try:
            resolved_path.relative_to(base_dir.resolve())
        except ValueError:
            raise ValueError("Model path is outside the allowed directory")

    # Check file/directory exists
    if not os.path.exists(resolved_path):
        raise ValueError("Model path does not exist")

    return str(resolved_path)


def validate_numeric(value: int, min_val: int, max_val: int, param_name: str) -> int:
    """
    Validate numeric value is within specified range.

    Args:
        value: Value to validate
        min_val: Minimum allowed value
        max_val: Maximum allowed value
        param_name: Name of parameter for error message

    Returns:
        Validated value

    Raises:
        ValueError: If value is out of range
    """
    if not min_val <= value <= max_val:
        raise ValueError(f"{param_name} must be between {min_val} and {max_val}")
    return value


def validate_directory(path: str, base_dir: Path = Path(".")) -> str:
    """
    Validate directory path to prevent path traversal and ensure safety.

    Args:
        path: Directory path string to validate
        base_dir: Base directory to resolve relative paths against (default: current directory)

    Returns:
        Validated directory path string

    Raises:
        ValueError: If directory path is invalid
    """
    if not path:
        raise ValueError("Directory path cannot be empty")

    # Unquote URL-encoded input
    normalized_path = unquote(path)

    # Reject any path containing ".." segments
    if ".." in normalized_path:
        raise ValueError("Directory path contains path traversal attempts")

    # Parse the input path
    input_path = Path(normalized_path)

    if input_path.is_absolute():
        # Absolute paths: resolve as-is
        resolved_path = input_path.resolve(strict=False)
    else:
        # Relative paths: join with base_dir, then resolve
        resolved_path = (base_dir / input_path).resolve(strict=False)

        # Verify the resolved path stays within base_dir
        try:
            resolved_path.relative_to(base_dir.resolve())
        except ValueError:
            raise ValueError("Directory path is outside the allowed directory")

    # Check if directory exists
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


def validate_device(device: str) -> str:
    """
    Validate device string to prevent command injection attacks.

    Args:
        device: Device string to validate (e.g., "cpu", "cuda", "mps")

    Returns:
        Validated device string

    Raises:
        ValueError: If device string contains dangerous patterns
    """
    if not device:
        raise ValueError("Device cannot be empty")

    # Reject device string if it's not a known valid value
    if device not in ("cpu", "cuda", "mps"):
        # Additional validation - check for potentially dangerous shell patterns
        dangerous_patterns = (
            ";",
            "|",
            "&",
            "&&",
            "||",
            ">",
            "<",
            "`",
            "$(",
            "'",
            '"',
        )
        if any(pattern in device for pattern in dangerous_patterns):
            raise ValueError("Device string contains dangerous shell patterns")

    return device


class QuestionRequest(BaseModel):
    """Request model for asking questions."""

    question: str = Field(..., min_length=1, max_length=2000)
    n_results: Optional[int] = Field(default=3, ge=1, le=10)

    @validator("question")
    def validate_question_not_whitespace(cls, v):
        if not v or not v.strip():
            raise ValueError("Question cannot be empty or whitespace-only")
        return v.strip()


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

        # Validate URL environment variables
        ollama_url = os.environ.get("RAG_OLLAMA_URL")
        api_url = os.environ.get("RAG_API_URL")

        if ollama_url:
            try:
                ollama_url = validate_url(ollama_url)
            except ValueError as e:
                logger.error("Invalid Ollama URL configuration: %s", e)
                raise RuntimeError("Startup failed: Invalid configuration")

        if api_url:
            try:
                api_url = validate_url(api_url)
            except ValueError as e:
                logger.error("Invalid API URL configuration: %s", e)
                raise RuntimeError("Startup failed: Invalid configuration")

        # Validate model paths
        model_path = os.environ.get("RAG_MODEL_PATH")

        if model_path is not None:
            try:
                model_path = validate_model_path(model_path, Path("."))
            except ValueError as e:
                logger.error("Invalid model path configuration: %s", e)
                raise RuntimeError("Startup failed: Invalid configuration")

        # Validate GGUF path if provided
        gguf_path = os.environ.get("RAG_GGUF_PATH")

        if gguf_path is not None:
            try:
                gguf_path = validate_model_path(gguf_path, Path("."))
            except ValueError as e:
                logger.error("Invalid GGUF path configuration: %s", e)
                raise RuntimeError("Startup failed: Invalid configuration")

        # Validate device string if provided
        device = os.environ.get("RAG_DEVICE")
        if device:
            try:
                device = validate_device(device)
            except ValueError as e:
                logger.error("Invalid device string configuration: %s", e)
                raise RuntimeError("Startup failed: Invalid configuration")

        # Validate model names if provided
        ollama_model = os.environ.get("RAG_OLLAMA_MODEL")
        api_model = os.environ.get("RAG_API_MODEL")

        if ollama_model:
            # Basic validation - ensure it's a reasonable model name
            if (
                ollama_model.startswith(".")
                or ollama_model.startswith("/")
                or ".." in ollama_model
            ):
                logger.error("Invalid Ollama model name configuration")
                raise RuntimeError("Startup failed: Invalid configuration")

        if api_model:
            # Basic validation - ensure it's a reasonable model name
            if (
                api_model.startswith(".")
                or api_model.startswith("/")
                or ".." in api_model
            ):
                logger.error("Invalid API model name configuration")
                raise RuntimeError("Startup failed: Invalid configuration")

        config = RAGConfig(
            db_path=db_path,
            chunk_size=chunk_size,
            n_results=n_results,
            max_tokens=max_tokens,
            temperature=temperature,
            embedding_model=settings.rag_embedding_model,
        )

        engine = RAGEngine(
            config=config,
            model_path=model_path,
            ollama_model=ollama_model,
            ollama_url=ollama_url,
            api_url=api_url,
            api_model=api_model,
            device=device,
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


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "Document Q&A API"}


@app.get("/auth/status")
async def auth_status():
    """Get authentication status and configuration."""
    return get_auth_status()


@app.post("/auth/token")
async def login(credentials: dict):
    """
    Login endpoint to obtain JWT token.

    Request body:
        - api_key: API key for authentication

    Returns:
        - access_token: JWT token
        - token_type: "bearer"
    """
    from auth import ENABLE_AUTH, API_KEY, create_access_token

    if not ENABLE_AUTH:
        raise HTTPException(status_code=400, detail="Authentication is disabled")

    provided_key = credentials.get("api_key")
    if not provided_key or provided_key != API_KEY:
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
    if ext not in {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".txt", ".md"}:
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


@app.get("/documents")
async def list_documents(auth: dict = Security(require_auth())):
    """List all ingested documents."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    return {"documents": engine.list_documents()}


def main():
    """Run the API server."""
    import uvicorn

    host = os.environ.get("API_HOST", "0.0.0.0")
    port = int(os.environ.get("API_PORT", "8080"))

    print(f"Starting server on {host}:{port}")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
