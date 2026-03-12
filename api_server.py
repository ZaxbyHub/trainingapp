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
from typing import Optional, List, Set, Tuple
from pathlib import Path
from contextlib import asynccontextmanager
from urllib.parse import urlparse, unquote
import ipaddress

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from rag_engine import RAGEngine, RAGConfig

# Set up logger
logger = logging.getLogger(__name__)

# Default allowed ports for URL validation
DEFAULT_ALLOWED_PORTS = {80, 443, 11434}  # HTTP, HTTPS, Ollama


def validate_url(
    url: str, 
    allow_local: bool = False,
    allowed_ports: Optional[set] = None
) -> str:
    """
    Validate URL to prevent injection attacks.

    Args:
        url: URL string to validate
        allow_local: If True, allow localhost and private IPs for local backends
        allowed_ports: Set of allowed port numbers. If None, uses DEFAULT_ALLOWED_PORTS

    Returns:
        Validated URL string

    Raises:
        ValueError: If URL is invalid
    """
    if not url:
        raise ValueError("URL cannot be empty")
    
    # Check for scheme
    parsed = urlparse(url)
    if not parsed.scheme:
        raise ValueError("URL must have a scheme (http/https)")
    
    if parsed.scheme not in ('http', 'https'):
        raise ValueError("URL scheme must be http or https")
    
    # Reject userinfo in URL (user:pass@host)
    if parsed.username or parsed.password:
        raise ValueError("URL must not contain userinfo (username:password)")
    
    # Check for localhost and private IP addresses
    if parsed.hostname:
        # Check for localhost
        if parsed.hostname in ('localhost', '127.0.0.1', '::1'):
            if not allow_local:
                raise ValueError("URL must not point to localhost")
        
        # Check for private IP addresses
        if parsed.hostname:
            try:
                ip_addr = ipaddress.ip_address(parsed.hostname)
            except ValueError:
                # Not an IP address, skip IP checks
                pass
            else:
                # Successfully parsed as IP - check if private
                if ip_addr.is_private and not allow_local:
                    raise ValueError("URL must not point to private IP addresses")
    
    # Port validation
    if parsed.port:
        # Use provided allowed_ports or default
        ports = allowed_ports if allowed_ports is not None else DEFAULT_ALLOWED_PORTS

        if parsed.port not in ports:
            raise ValueError(
                f"URL port {parsed.port} is not in allowed ports: {sorted(ports)}. "
                f"Use standard ports or explicitly configure the port."
            )

    # DNS rebinding protection - resolve hostname and validate IP
    if parsed.hostname:
        _resolve_and_validate_host(parsed.hostname, allow_local)

    return url


def _resolve_and_validate_host(hostname: str, allow_local: bool) -> None:
    """Resolve hostname and validate IP against whitelist.

    Args:
        hostname: Hostname to resolve
        allow_local: Whether to allow local/private IPs

    Raises:
        ValueError: If resolved IP is not in whitelist
    """
    if not hostname:
        return

    try:
        # Resolve hostname to IP(s)
        addr_info = socket.getaddrinfo(hostname, None)

        for info in addr_info:
            ip_str = info[4][0]
            try:
                ip_addr = ipaddress.ip_address(ip_str)

                # Check if IP is localhost
                if ip_addr.is_loopback and not allow_local:
                    raise ValueError(f"Hostname resolves to loopback: {ip_str}")

                # Check if IP is private
                if ip_addr.is_private and not allow_local:
                    raise ValueError(f"Hostname resolves to private IP: {ip_str}")

            except ValueError:
                # Not a valid IP, skip
                continue

    except socket.gaierror:
        # Hostname resolution failed - this is OK for validation
        # (actual connection will fail later if invalid)
        pass


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
    if '..' in normalized_path:
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
    if '..' in normalized_path:
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
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
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
    normalized = unicodedata.normalize('NFKC', basename)
    
    # Step 3: Remove null bytes and control characters
    cleaned = ''.join(char for char in normalized if char.isprintable() and ord(char) > 31)
    
    # Step 4: Replace path separators and dangerous characters
    # Replace backslashes, forward slashes, colons with underscores
    cleaned = cleaned.replace('\\', '_').replace('/', '_').replace(':', '_')
    
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
    if not cleaned or cleaned == '.' or cleaned == '..' or cleaned.strip() == '':
        raise ValueError("Filename is invalid after sanitization")
    
    # Return sanitized name and display name (display uses sanitized for safety)
    return cleaned, cleaned


# Global engine instance
engine: Optional[RAGEngine] = None


class QuestionRequest(BaseModel):
    """Request model for asking questions."""
    question: str = Field(..., min_length=1, max_length=2000)
    n_results: Optional[int] = Field(default=3, ge=1, le=10)


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
    documents: List[str]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan handler for startup/shutdown."""
    global engine
    
    print("Starting Document Q&A API Server...")
    
    try:
        # Validate environment variables before creating RAGConfig and RAGEngine
        db_path = os.environ.get("RAG_DB_PATH", "./doc_qa_db")
        chunk_size = int(os.environ.get("RAG_CHUNK_SIZE", "512"))
        n_results = int(os.environ.get("RAG_N_RESULTS", "3"))
        max_tokens = int(os.environ.get("RAG_MAX_TOKENS", "512"))
        temperature = float(os.environ.get("RAG_TEMPERATURE", "0.3"))
        
        # Validate numeric values
        chunk_size = validate_numeric(chunk_size, 100, 10000, "chunk_size")
        max_tokens = validate_numeric(max_tokens, 100, 4000, "max_tokens")
        n_results = validate_numeric(n_results, 1, 20, "n_results")
        
        # Validate URL environment variables
        ollama_url = os.environ.get("RAG_OLLAMA_URL")
        api_url = os.environ.get("RAG_API_URL")
        
        if ollama_url:
            try:
                ollama_url = validate_url(ollama_url, allow_local=True)
            except ValueError as e:
                logger.error("Invalid Ollama URL configuration")
                raise HTTPException(status_code=500, detail="Invalid configuration")
        
        if api_url:
            try:
                api_url = validate_url(api_url)
            except ValueError as e:
                logger.error("Invalid API URL configuration")
                raise HTTPException(status_code=500, detail="Invalid configuration")
        
        # Validate model paths
        model_path = os.environ.get("RAG_MODEL_PATH")
        
        if model_path is not None:
            try:
                model_path = validate_model_path(model_path, Path("."))
            except ValueError as e:
                logger.error("Invalid model path configuration")
                raise HTTPException(status_code=500, detail="Invalid configuration")
        
        # Validate GGUF path if provided
        gguf_path = os.environ.get("RAG_GGUF_PATH")

        if gguf_path is not None:
            try:
                gguf_path = validate_model_path(gguf_path, Path("."))
            except ValueError as e:
                logger.error("Invalid GGUF path configuration")
                raise HTTPException(status_code=500, detail="Invalid configuration")
        
        # Validate device string if provided
        device = os.environ.get("RAG_DEVICE")
        if device:
            # Basic validation - ensure it's a reasonable device string
            if device not in ("cpu", "cuda", "mps"):
                # Additional validation - check for potentially dangerous patterns
                dangerous_patterns = (";", "|", "&", "&&", "||", ">", "<", "`", "$(", "'", "\"")
                if any(pattern in device for pattern in dangerous_patterns):
                    logger.error("Invalid device string configuration")
                    raise HTTPException(status_code=500, detail="Invalid configuration")
        
        # Validate model names if provided
        ollama_model = os.environ.get("RAG_OLLAMA_MODEL")
        api_model = os.environ.get("RAG_API_MODEL")
        
        if ollama_model:
            # Basic validation - ensure it's a reasonable model name
            if ollama_model.startswith(".") or ollama_model.startswith("/") or ".." in ollama_model:
                logger.error("Invalid Ollama model name configuration")
                raise HTTPException(status_code=500, detail="Invalid configuration")
        
        if api_model:
            # Basic validation - ensure it's a reasonable model name
            if api_model.startswith(".") or api_model.startswith("/") or ".." in api_model:
                logger.error("Invalid API model name configuration")
                raise HTTPException(status_code=500, detail="Invalid configuration")
        
        config = RAGConfig(
            db_path=db_path,
            chunk_size=chunk_size,
            n_results=n_results,
            max_tokens=max_tokens,
            temperature=temperature,
            embedding_model="BAAI/bge-small-en-v1.5"
        )
        
        engine = RAGEngine(
            config=config,
            model_path=model_path,
            ollama_model=ollama_model,
            ollama_url=ollama_url,
            api_url=api_url,
            api_model=api_model,
            device=device,
            gguf_path=gguf_path
        )
        
        yield
        
    except Exception as e:
        logger.error("Startup configuration error")
        raise HTTPException(status_code=500, detail="Invalid configuration")
    
    print("Shutting down...")


app = FastAPI(
    title="Document Q&A API",
    description="RAG-based document question answering API",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "Document Q&A API"}


@app.get("/stats", response_model=StatsResponse)
async def get_stats():
    """Get engine statistics."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    
    stats = engine.get_stats()
    return StatsResponse(
        document_count=stats["document_count"],
        chunk_count=stats["chunk_count"],
        embedding_model=stats["embedding_model"],
        llm_backend=stats["llm"]["backend"] if stats["llm"] else None,
        documents=stats["documents"]
    )


@app.post("/ask", response_model=QuestionResponse)
async def ask_question(request: QuestionRequest):
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
            inference_time=result.inference_time
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search", response_model=List[SearchResult])
async def search_documents(request: SearchRequest):
    """Search documents without generating an answer."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    
    try:
        results = engine.search_documents(request.query, n_results=request.n_results)
        return [
            SearchResult(
                text=doc,
                source=meta.get("source", "Unknown"),
                similarity=sim
            )
            for doc, meta, sim in results
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ingest", response_model=IngestResponse)
async def ingest_directory(request: IngestRequest):
    """Ingest documents from a directory."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    
    try:
        validated_dir = validate_directory(request.directory)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    
    try:
        stats = engine.ingest_directory(validated_dir)
        return IngestResponse(
            success=stats["success"],
            documents=stats.get("documents", 0),
            chunks_added=stats.get("chunks_added", 0),
            message=stats.get("message")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail="Error processing directory ingestion")


@app.post("/ingest/file")
async def ingest_file(file: UploadFile = File(...)):
    """Ingest a single uploaded file."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")

    # Sanitize filename
    try:
        safe_filename, display_name = sanitize_filename(file.filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid filename: {e}")

    ext = Path(safe_filename).suffix.lower()
    if ext not in {'.pdf', '.docx', '.doc', '.pptx', '.ppt', '.txt', '.md'}:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    import tempfile
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        # Use sanitized display name as source
        stats = engine.ingest_file(tmp_path, source_name=display_name)

        os.unlink(tmp_path)

        return IngestResponse(
            success=stats["success"],
            documents=1 if stats["success"] else 0,
            chunks_added=stats.get("chunks_added", 0),
            message=stats.get("message")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/documents")
async def clear_documents():
    """Clear all ingested documents."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    
    try:
        engine.clear_documents()
        return {"status": "cleared"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/documents")
async def list_documents():
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
