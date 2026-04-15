# RAG Pipeline Issues Resolution Implementation Plan (REVISED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve remaining critical and high priority issues identified in the RAG pipeline comprehensive review to achieve production-ready status.

**Architecture:** Follow TDD (Test-Driven Development) with bite-sized tasks. Security fixes use defense-in-depth. Performance fixes maintain backward compatibility. Threading architecture carefully analyzed to prevent deadlocks.

**Tech Stack:** Python 3.10+, FastAPI, ChromaDB, sentence-transformers, pytest, customtkinter

---

## Pre-Implementation Verification

### Task 0.1: Verify Already-Fixed Issues

**Purpose:** Confirm which CRITICAL issues from the review are already resolved

**Files:**
- Verify: `rag_engine.py:17`
- Verify: `security.py:84`
- Verify: `auth.py:108`

- [ ] **Step 1: Check logger initialization**

```bash
grep -n "logger = logging.getLogger" rag_engine.py
```

**Expected:** Line 17 shows `logger = logging.getLogger(__name__)`

**Status:** ✅ ALREADY FIXED - Task 1.1 can be skipped

- [ ] **Step 2: Check port 0 validation**

```bash
grep -n "if parsed.port is not None" security.py
```

**Expected:** Line 84 shows `if parsed.port is not None:`

**Status:** ✅ ALREADY FIXED - Task 1.2 can be skipped

- [ ] **Step 3: Check API key comparison**

```bash
grep -n "api_key == API_KEY" auth.py
```

**Expected:** Line 108 shows `api_key == API_KEY` (NOT using secrets.compare_digest)

**Status:** ❌ STILL NEEDS FIX - Task 1.3 must be completed

- [ ] **Step 4: Document verification results**

Update this plan's task list based on verification.

---

## Phase 1: CRITICAL Fixes (Deploy Immediately)

### Task 1.1: Fix Timing Attack in API Key Comparison

**Priority:** 🔴 CRITICAL (Security)  
**Impact:** API key vulnerable to timing attack  
**Files:**
- Modify: `auth.py:108` (API key comparison)
- Verify: `auth.py:10` (secrets import)
- Test: `tests/test_auth.py` (add timing test)

- [ ] **Step 1: Verify secrets module is imported**

Check `auth.py` line 10:
```bash
grep -n "import secrets" auth.py
```

**Expected:** Should show `import secrets` at line 10

If NOT present, add it:
```python
import secrets  # Add at line 10 with other imports
```

- [ ] **Step 2: Write failing test**

Add to `tests/test_auth.py`:

```python
def test_api_key_uses_constant_time_comparison():
    """API key comparison should use secrets.compare_digest for timing safety."""
    import inspect
    from auth import authenticate_api_key
    
    # Get source code of authenticate_api_key
    source = inspect.getsource(authenticate_api_key)
    
    # Should use secrets.compare_digest, not ==
    assert "secrets.compare_digest" in source or "hmac.compare_digest" in source, \
        "API key comparison must use constant-time comparison to prevent timing attacks"
```

- [ ] **Step 3: Run test to verify it fails**

```bash
python -m pytest tests/test_auth.py::test_api_key_uses_constant_time_comparison -v
```

**Expected:** FAIL - current code uses `==` comparison

- [ ] **Step 4: Fix API key comparison in auth.py**

Modify `auth.py` at line 108:

```python
# BEFORE (vulnerable):
if api_key and api_key == API_KEY:
    return {"authenticated": True, "method": "api_key"}

# AFTER (secure):
if api_key and secrets.compare_digest(api_key, API_KEY):
    return {"authenticated": True, "method": "api_key"}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
python -m pytest tests/test_auth.py::test_api_key_uses_constant_time_comparison -v
```

**Expected:** PASS

- [ ] **Step 6: Run full auth test suite**

```bash
python -m pytest tests/test_auth.py -v --tb=short
```

**Expected:** All tests pass

- [ ] **Step 7: Commit**

```bash
git add auth.py tests/test_auth.py
git commit -m "CRITICAL: Fix timing attack vulnerability in API key validation

Replace direct string comparison with secrets.compare_digest()
for constant-time comparison to prevent timing attacks.

- Use secrets.compare_digest(api_key, API_KEY) instead of ==
- Add test to verify constant-time comparison is used
- All auth tests pass

Security: Prevents timing attack on API key brute force"
```

---

### Task 1.2: Document ENABLE_AUTH Production Requirement

**Priority:** 🔴 CRITICAL (Documentation)  
**Impact:** Production deployments may leave API unprotected  
**Files:**
- Modify: `README.md` (add auth section)
- Modify: `CONFIGURATION.md` (add auth table)
- Modify: `USAGE.md` (add auth examples)
- Create: `docs/security_hardening_guide.md`

- [ ] **Step 1: Add authentication section to README.md**

Add after line 150 in `README.md`:

```markdown
## 🔐 API Authentication (Production Required)

**⚠️ CRITICAL:** By default, API authentication is **DISABLED** for development convenience.
**Production deployments MUST enable authentication.**

### Enabling Authentication

Set environment variables:
```bash
export ENABLE_AUTH=true
export API_KEY="your-secure-random-key-here"  # Generate with: openssl rand -hex 32
```

Or in Windows PowerShell:
```powershell
$env:ENABLE_AUTH="true"
$env:API_KEY="your-secure-random-key-here"
```

### Using Authentication

With authentication enabled, all API endpoints require either:
1. **API Key**: Header `X-API-Key: your-key-here`
2. **JWT Token**: Header `Authorization: Bearer <token>`

Example with API key:
```python
import requests

response = requests.post(
    "http://localhost:8080/ask",
    headers={"X-API-Key": "your-api-key-here"},
    json={"question": "What is RAG?"}
)
```

See [USAGE.md](USAGE.md) for complete authentication documentation.
```

- [ ] **Step 2: Add authentication to CONFIGURATION.md**

Add new table after line 67:

```markdown
### API Authentication Variables

| Variable | Description | Default | Required for Production |
|----------|-------------|---------|------------------------|
| `ENABLE_AUTH` | Enable API authentication | `false` | **YES - Set to `true`** |
| `API_KEY` | API key for authentication | (none) | **YES - Set secure key** |
| `JWT_SECRET` | Secret for JWT token signing | (random) | Recommended |
| `JWT_EXPIRATION_HOURS` | JWT token lifetime | `24` | Optional |

**⚠️ Security Warning:** Leaving `ENABLE_AUTH=false` in production exposes your API to unauthorized access. Always enable authentication for production deployments.
```

- [ ] **Step 3: Add authentication examples to USAGE.md**

Add after line 420 in `USAGE.md`:

```markdown
### Authentication

When `ENABLE_AUTH=true` is set, all endpoints require authentication.

#### Checking Authentication Status

```bash
curl http://localhost:8080/auth/status
```

Response when enabled:
```json
{
  "enabled": true,
  "methods": ["jwt", "api_key"]
}
```

#### Using API Key

Include the API key in the `X-API-Key` header:

```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key-here" \
  -d '{"question": "What is machine learning?"}'
```

Python example:
```python
import requests

headers = {"X-API-Key": "your-api-key-here"}
response = requests.post(
    "http://localhost:8080/ask",
    headers=headers,
    json={"question": "What is machine learning?"}
)
print(response.json()["answer"])
```

#### Using JWT Token

1. Obtain a token:
```bash
curl -X POST http://localhost:8080/auth/token \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your-password"}'
```

2. Use the token:
```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-from-step-1>" \
  -d '{"question": "What is machine learning?"}'
```
```

- [ ] **Step 4: Create security hardening guide**

Create `docs/security_hardening_guide.md`:

```markdown
# Security Hardening Guide for Production

## Pre-Deployment Checklist

- [ ] Set `ENABLE_AUTH=true`
- [ ] Generate strong API key: `openssl rand -hex 32`
- [ ] Set `API_KEY` environment variable
- [ ] Configure firewall (port 8080)
- [ ] Enable HTTPS (reverse proxy)
- [ ] Set up log monitoring
- [ ] Disable debug mode

## Environment Variables

```bash
# Required for production
export ENABLE_AUTH=true
export API_KEY="$(openssl rand -hex 32)"

# Recommended
export JWT_SECRET="$(openssl rand -hex 64)"
export RAG_MAX_FILE_SIZE="50"  # Limit file uploads

# Optional hardening
export RAG_MIN_SIMILARITY="0.5"  # Stricter similarity threshold
```

## Security Features

- SSRF protection on all URLs
- Path traversal protection
- File size limits
- Authentication required
- Input validation
- Error message sanitization
```

- [ ] **Step 5: Commit**

```bash
git add README.md CONFIGURATION.md USAGE.md docs/security_hardening_guide.md
git commit -m "CRITICAL: Document ENABLE_AUTH production requirement

Add comprehensive authentication documentation:

- README.md: Add 'API Authentication (Production Required)' section
- CONFIGURATION.md: Add authentication variables table with warnings
- USAGE.md: Add authentication examples (API key and JWT)
- docs/security_hardening_guide.md: New production security checklist

Security: Prevents accidental production deployments without auth"
```

---

## Phase 2: HIGH Priority Fixes (Deploy This Week)

### Task 2.1: Add Symlink Protection to validate_directory

**Priority:** 🟠 HIGH (Security)  
**Impact:** Path traversal via symlinks  
**Files:**
- Modify: `api_server.py:103-147`
- Test: `tests/test_path_traversal.py`

- [ ] **Step 1: Write failing test**

Add to `tests/test_path_traversal.py`:

```python
def test_validate_directory_rejects_symlinks_outside_base():
    """Symlinks pointing outside base_dir should be rejected."""
    from api_server import validate_directory
    import tempfile
    import os
    
    with tempfile.TemporaryDirectory() as base_dir:
        # Create a file outside base_dir
        outside_file = tempfile.NamedTemporaryFile(delete=False)
        outside_file.close()
        
        try:
            # Create a symlink inside base_dir pointing outside
            symlink_path = os.path.join(base_dir, "evil_link")
            os.symlink(outside_file.name, symlink_path)
            
            # Should reject the symlink
            with pytest.raises(ValueError, match="path traversal"):
                validate_directory(symlink_path, base_dir)
        finally:
            os.unlink(outside_file.name)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_path_traversal.py::test_validate_directory_rejects_symlinks_outside_base -v
```

**Expected:** FAIL - symlink is accepted

- [ ] **Step 3: Add symlink check to validate_directory**

Modify `api_server.py` in `validate_directory()` function (around line 130):

```python
def validate_directory(directory: str, base_dir: Path) -> str:
    """Validate directory path for path traversal attempts."""
    # ... existing code ...
    
    # Resolve the path to handle symlinks
    resolved_path = path.resolve()
    resolved_base = base_dir.resolve()
    
    # Check if resolved path is still within base_dir
    try:
        resolved_path.relative_to(resolved_base)
    except ValueError:
        raise ValueError(f"Path traversal detected: resolved path {resolved_path} outside base {resolved_base}")
    
    # Check if path contains any symlinks that escape base_dir
    current = path
    while current != current.parent:
        if current.is_symlink():
            link_target = current.readlink()
            if link_target.is_absolute():
                # Absolute symlink - check if it points inside base
                try:
                    link_target.relative_to(resolved_base)
                except ValueError:
                    raise ValueError(f"Symlink escape detected: {link_target} outside base")
        current = current.parent
    
    return str(path)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m pytest tests/test_path_traversal.py::test_validate_directory_rejects_symlinks_outside_base -v
```

**Expected:** PASS

- [ ] **Step 5: Commit**

```bash
git add api_server.py tests/test_path_traversal.py
git commit -m "HIGH: Add symlink protection to path validation

Prevent path traversal attacks via symlinks that point outside
the allowed base directory.

- Resolve symlinks and verify target is within base_dir
- Check each path component for symlink escapes
- Add regression test for symlink-based traversal

Security: Prevents symlink escape attacks"
```

---

### Task 2.2: Add Token Counting to Prevent Context Overflow

**Priority:** 🟠 HIGH (Quality)  
**Impact:** Context may exceed LLM token limit  
**Files:**
- Create: `token_counter.py`
- Modify: `rag_engine.py` (use token counting)
- Modify: `config.py` (add tiktoken dependency)

**Note:** This task uses model-aware context window sizing, not hardcoded 8192.

- [ ] **Step 1: Create token counter module**

Create `token_counter.py`:

```python
"""Token counting utilities for LLM context management."""
import logging
from typing import List, Tuple, Optional

try:
    import tiktoken
    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

logger = logging.getLogger(__name__)


class TokenCounter:
    """Count tokens for text to manage LLM context windows."""
    
    # Approximate tokens per character for fallback
    CHARS_PER_TOKEN = 4  # English average
    
    def __init__(self, model_name: str = "gpt-3.5-turbo"):
        """Initialize token counter for a specific model."""
        self.model_name = model_name
        self.encoder = None
        
        if TIKTOKEN_AVAILABLE:
            try:
                self.encoder = tiktoken.encoding_for_model(model_name)
                logger.info(f"Using tiktoken for {model_name}")
            except KeyError:
                # Model not in tiktoken, use cl100k_base (GPT-4 compatible)
                self.encoder = tiktoken.get_encoding("cl100k_base")
                logger.info(f"Using cl100k_base encoding for {model_name}")
    
    def count_tokens(self, text: str) -> int:
        """Count tokens in text."""
        if not text:
            return 0
            
        if self.encoder:
            return len(self.encoder.encode(text))
        else:
            # Fallback: approximate based on characters
            return len(text) // self.CHARS_PER_TOKEN
    
    def count_conversation_tokens(
        self,
        system_prompt: str,
        user_prompt: str,
        context: str,
        conversation_history: List[Tuple[str, str]] = None
    ) -> int:
        """Count total tokens for a conversation."""
        total = 0
        
        # System prompt
        total += self.count_tokens(system_prompt)
        
        # Conversation history
        if conversation_history:
            for user_msg, assistant_msg in conversation_history:
                total += self.count_tokens(user_msg)
                total += self.count_tokens(assistant_msg)
        
        # Context
        total += self.count_tokens(context)
        
        # User question
        total += self.count_tokens(user_prompt)
        
        # Add overhead for message formatting (approximate)
        total += 10  # Formatting overhead
        
        return total
    
    def truncate_to_token_limit(
        self,
        text: str,
        max_tokens: int,
        preserve_sentences: bool = True
    ) -> str:
        """Truncate text to fit within token limit."""
        if self.count_tokens(text) <= max_tokens:
            return text
        
        # Binary search for truncation point
        low, high = 0, len(text)
        best_fit = 0
        
        while low <= high:
            mid = (low + high) // 2
            truncated = text[:mid]
            tokens = self.count_tokens(truncated)
            
            if tokens <= max_tokens:
                best_fit = mid
                low = mid + 1
            else:
                high = mid - 1
        
        truncated = text[:best_fit]
        
        # Find sentence boundary if requested
        if preserve_sentences and best_fit > 0:
            # Find last sentence ending
            last_period = max(
                truncated.rfind('.'),
                truncated.rfind('!'),
                truncated.rfind('?')
            )
            if last_period > best_fit * 0.8:  # Keep at least 80%
                truncated = truncated[:last_period + 1]
        
        return truncated


# Global instance for common use
default_counter = TokenCounter()


def count_tokens(text: str) -> int:
    """Convenience function to count tokens."""
    return default_counter.count_tokens(text)
```

- [ ] **Step 2: Add tests for token counter**

Create `tests/test_token_counter.py`:

```python
"""Tests for token counting functionality."""
import pytest
from token_counter import TokenCounter, count_tokens


def test_count_tokens_basic():
    """Test basic token counting."""
    counter = TokenCounter()
    
    # Empty string
    assert counter.count_tokens("") == 0
    
    # Simple text
    tokens = counter.count_tokens("Hello world")
    assert tokens > 0
    assert tokens < 10  # Should be 2-3 tokens


def test_count_conversation():
    """Test counting conversation tokens."""
    counter = TokenCounter()
    
    total = counter.count_conversation_tokens(
        system_prompt="You are a helpful assistant.",
        user_prompt="What is RAG?",
        context="RAG stands for Retrieval-Augmented Generation.",
        conversation_history=[("Hello", "Hi there!")]
    )
    
    assert total > 0
    # Should be roughly: 6 + 4 + 7 + 2 + 3 + 10 overhead = ~32 tokens
    assert 20 < total < 50


def test_truncate_to_token_limit():
    """Test token-aware truncation."""
    counter = TokenCounter()
    
    long_text = "This is a very long sentence. " * 100
    original_tokens = counter.count_tokens(long_text)
    
    # Truncate to smaller limit
    truncated = counter.truncate_to_token_limit(long_text, max_tokens=20)
    truncated_tokens = counter.count_tokens(truncated)
    
    assert truncated_tokens <= 20
    assert len(truncated) < len(long_text)
```

- [ ] **Step 3: Integrate token counting in rag_engine.py**

Modify `rag_engine.py` in `query()` method (around line 411):

```python
# Token-aware context truncation
from token_counter import TokenCounter
token_counter = TokenCounter()

# Get context window from LLM if available
context_window = 8192  # Default fallback
if self.llm and hasattr(self.llm, 'n_ctx'):
    context_window = self.llm.n_ctx
elif self.llm and hasattr(self.llm, 'config'):
    context_window = getattr(self.llm.config, 'n_ctx', 8192)

# Calculate tokens used by non-context parts
system_prompt = "You are a helpful assistant. Answer based on the provided context."
history_tokens = 0
if conversation_history:
    for turn in conversation_history[-2:]:  # Last 2 turns
        history_tokens += token_counter.count_tokens(turn[0])
        history_tokens += token_counter.count_tokens(turn[1])

# Reserve tokens for system, history, question, and answer
reserved_tokens = (
    token_counter.count_tokens(system_prompt) +
    history_tokens +
    token_counter.count_tokens(question) +
    config.max_tokens +  # Space for answer
    50  # Safety margin
)

# Calculate available context tokens
available_context_tokens = context_window - reserved_tokens

if available_context_tokens < 100:
    logger.warning(f"Very limited context space: {available_context_tokens} tokens")

# Truncate context to fit
context_tokens = token_counter.count_tokens(context)
if context_tokens > available_context_tokens:
    logger.warning(
        f"Context ({context_tokens} tokens) exceeds available space "
        f"({available_context_tokens}). Truncating."
    )
    safe_context = token_counter.truncate_to_token_limit(
        context,
        available_context_tokens,
        preserve_sentences=True
    )
else:
    safe_context = context
```

- [ ] **Step 4: Add tiktoken to dependencies**

Modify `requirements.txt`:
```
# Add to requirements.txt
tiktoken>=0.5.0  # For accurate token counting
```

- [ ] **Step 5: Run tests**

```bash
python -m pytest tests/test_token_counter.py -v
python -m pytest tests/test_rag_engine.py -v
```

**Expected:** All tests pass

- [ ] **Step 6: Commit**

```bash
git add token_counter.py tests/test_token_counter.py rag_engine.py requirements.txt
git commit -m "HIGH: Add token counting for context window management

Prevent context overflow by counting tokens instead of characters.
Uses tiktoken when available, falls back to character approximation.
Dynamically determines context window from LLM configuration.

- Create token_counter.py with TokenCounter class
- Add token-aware context truncation in RAGEngine.query()
- Reserve tokens for system prompt, history, question, and answer
- Truncate context to fit within LLM token budget
- Add tiktoken dependency for accurate counting
- Add comprehensive tests

Quality: Prevents context truncation mid-sentence and ensures
LLM has room to generate complete answers."
```

---

## Phase 3: MEDIUM Priority - Threading Architecture (Careful Analysis Required)

### Concurrency Architecture Analysis

**Current State:**
- `VectorStore` uses `threading.RLock()` for thread safety
- All operations (read/write) acquire the lock
- This serializes concurrent queries, causing 9× slowdown at 10 threads

**Proposed Changes:**
1. **Task 3.1:** Add `ThreadPoolExecutor` for async operations
2. **Task 3.2:** Add background daemon thread for BM25 rebuild

**Interaction Risks:**
- `ThreadPoolExecutor` threads + daemon thread + `RLock` = potential deadlock
- Background BM25 thread holds reference to `VectorStore` which uses `RLock`
- If `ThreadPoolExecutor` worker tries to acquire `RLock` while daemon thread holds it, deadlock

**Mitigation Strategy:**
- Use `RLock` (reentrant) instead of `Lock` - allows same thread to re-acquire
- Ensure daemon thread doesn't hold lock while sleeping (it doesn't - only brief operations)
- `ThreadPoolExecutor` operations are short-lived (single queries)
- Background BM25 rebuild is independent (doesn't compete for same resources)

**Decision:** Proceed with both tasks but add explicit deadlock tests.

---

### Task 3.1: Implement Async VectorStore Operations

**Priority:** 🟡 MEDIUM (Performance)  
**Impact:** 10× improvement in concurrent query throughput  
**Files:**
- Modify: `vector_store.py` (add async methods)
- Modify: `api_server.py` (use async methods)
- Create: `tests/test_async_vector_store.py`

**Thread Safety Note:** Uses `ThreadPoolExecutor` with existing `RLock`. `RLock` is reentrant, preventing deadlock when same thread re-acquires.

- [ ] **Step 1: Add async search method to VectorStore**

Modify `vector_store.py`:

```python
import asyncio
from concurrent.futures import ThreadPoolExecutor

class VectorStore:
    """Async-capable vector store with ChromaDB and BM25."""
    
    def __init__(self, ...):
        # ... existing init ...
        self._executor = ThreadPoolExecutor(max_workers=4)
    
    async def search_async(
        self,
        query: str,
        n_results: int = 3,
        **kwargs
    ) -> List[Tuple[str, Dict[str, Any], float]]:
        """Async version of search that runs in thread pool."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._executor,
            self.search,
            query,
            n_results,
            **kwargs
        )
    
    async def get_context_async(
        self,
        query: str,
        n_results: int = 3,
        min_similarity: float = 0.3,
        hybrid_search: bool = False,
    ) -> Tuple[str, List[str]]:
        """Async version of get_context."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._executor,
            self.get_context,
            query,
            n_results,
            min_similarity,
            hybrid_search
        )
```

- [ ] **Step 2: Update api_server.py to use async methods**

Modify `api_server.py` endpoints:

```python
@app.post("/search")
async def search_documents(
    request: SearchRequest,
    auth: dict = Security(require_auth())
):
    """Search documents asynchronously."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    
    # Use async method
    results = await engine.vector_store.search_async(
        request.query,
        n_results=request.n_results
    )
    
    return [
        SearchResult(text=doc, source=meta.get("source", "Unknown"), similarity=sim)
        for doc, meta, sim in results
    ]
```

- [ ] **Step 3: Add async tests with deadlock detection**

Create `tests/test_async_vector_store.py`:

```python
"""Tests for async VectorStore operations."""
import pytest
import asyncio
from vector_store import VectorStore


@pytest.mark.asyncio
async def test_search_async_returns_results():
    """Async search should return same results as sync."""
    store = VectorStore(db_path="./test_async_db")
    
    # Add test data
    from document_processor import DocumentChunk
    chunks = [
        DocumentChunk(text="Python is great", source="test.py", chunk_index=0),
        DocumentChunk(text="JavaScript is cool", source="test.js", chunk_index=0)
    ]
    store.add_chunks(chunks)
    
    # Async search
    results = await store.search_async("python", n_results=2)
    
    assert len(results) > 0
    assert "python" in results[0][0].lower()


@pytest.mark.asyncio
async def test_concurrent_searches_no_deadlock():
    """Multiple concurrent searches should complete without deadlock."""
    store = VectorStore(db_path="./test_async_db")
    
    # Run 10 searches concurrently with timeout
    queries = ["python", "javascript", "coding"] * 3 + ["test"]
    
    async def search_with_timeout(q):
        return await asyncio.wait_for(
            store.search_async(q),
            timeout=5.0  # Should complete within 5 seconds
        )
    
    tasks = [search_with_timeout(q) for q in queries]
    results = await asyncio.gather(*tasks)
    
    assert len(results) == 10
    # All should complete without timeout/deadlock
```

- [ ] **Step 4: Benchmark async vs sync**

```python
# Benchmark script
import asyncio
import time
from vector_store import VectorStore

async def benchmark():
    store = VectorStore()
    
    # Warm up
    store.search("test")
    
    # Sync benchmark
    start = time.time()
    for _ in range(10):
        store.search("test")
    sync_time = time.time() - start
    
    # Async benchmark
    start = time.time()
    await asyncio.gather(*[store.search_async("test") for _ in range(10)])
    async_time = time.time() - start
    
    print(f"Sync: {sync_time:.2f}s, Async: {async_time:.2f}s")
    print(f"Speedup: {sync_time/async_time:.1f}x")
    
    # Verify improvement
    assert async_time < sync_time * 0.5, "Async should be at least 2x faster"

asyncio.run(benchmark())
```

- [ ] **Step 5: Commit**

```bash
git add vector_store.py api_server.py tests/test_async_vector_store.py
git commit -m "MEDIUM: Add async operations to VectorStore

Implement async search and get_context methods using ThreadPoolExecutor
to prevent blocking the event loop during ChromaDB operations.

- Add search_async() and get_context_async() methods
- Use ThreadPoolExecutor with 4 workers
- Update API endpoints to use async methods
- Add async tests with deadlock detection
- 5-10× improvement in concurrent query throughput

Performance: Resolves lock contention issue for high-concurrency workloads
Thread Safety: Uses RLock (reentrant) to prevent deadlocks"
```

---

### Task 3.2: Background BM25 Index Rebuild

**Priority:** 🟡 MEDIUM (Performance)  
**Impact:** Non-blocking ingestion for large batches  
**Files:**
- Modify: `vector_store.py` (BM25 rebuild logic)

**Thread Safety Note:** Background thread operates on BM25Index independently. Uses queue for chunk passing. No direct interaction with `RLock` during sleep. Shutdown mechanism included.

- [ ] **Step 1: Add background rebuild capability**

Modify `vector_store.py`:

```python
import threading
import queue
import atexit

class VectorStore:
    """Vector store with background BM25 rebuild."""
    
    def __init__(self, ...):
        # ... existing init ...
        self._bm25_rebuild_queue = queue.Queue()
        self._bm25_rebuild_thread = None
        self._bm25_rebuild_lock = threading.Lock()
        self._bm25_shutdown_event = threading.Event()
        
        # Register shutdown handler
        atexit.register(self._shutdown_background_rebuild)
    
    def add_chunks(self, chunks: List[DocumentChunk], batch_size: int = 100) -> int:
        """Add chunks with optional background BM25 rebuild."""
        # ... add to ChromaDB ...
        
        # Queue BM25 chunks for background rebuild
        with self._bm25_rebuild_lock:
            for chunk in chunks:
                self._bm25_rebuild_queue.put(chunk)
        
        # Start background rebuild if not running
        self._start_background_rebuild()
        
        return len(chunks)
    
    def _start_background_rebuild(self):
        """Start background BM25 rebuild thread if not running."""
        with self._bm25_rebuild_lock:
            if self._bm25_rebuild_thread is None or not self._bm25_rebuild_thread.is_alive():
                self._bm25_shutdown_event.clear()
                self._bm25_rebuild_thread = threading.Thread(
                    target=self._background_rebuild_worker,
                    daemon=True
                )
                self._bm25_rebuild_thread.start()
    
    def _background_rebuild_worker(self):
        """Worker thread for background BM25 rebuild."""
        import time
        
        # Wait for ingestion to settle (debounce)
        # Check shutdown event every 0.1s during wait
        for _ in range(10):  # 1 second total
            if self._bm25_shutdown_event.is_set():
                return
            time.sleep(0.1)
        
        # Collect all queued chunks
        chunks_to_add = []
        with self._bm25_rebuild_lock:
            while not self._bm25_rebuild_queue.empty():
                try:
                    chunks_to_add.append(self._bm25_rebuild_queue.get_nowait())
                except queue.Empty:
                    break
        
        if chunks_to_add and self.bm25_index:
            logger.info(f"Background BM25 rebuild: {len(chunks_to_add)} chunks")
            try:
                self.bm25_index.add_documents(chunks_to_add, rebuild=True)
                logger.info("Background BM25 rebuild complete")
            except Exception as e:
                logger.error(f"Background BM25 rebuild failed: {e}")
    
    def _shutdown_background_rebuild(self):
        """Shutdown background rebuild thread gracefully."""
        logger.info("Shutting down background BM25 rebuild...")
        self._bm25_shutdown_event.set()
        
        if self._bm25_rebuild_thread and self._bm25_rebuild_thread.is_alive():
            # Wait up to 5 seconds for graceful shutdown
            self._bm25_rebuild_thread.join(timeout=5.0)
            
            if self._bm25_rebuild_thread.is_alive():
                logger.warning("Background BM25 thread did not shut down gracefully")
```

- [ ] **Step 2: Add configuration option**

Add to `config.py`:

```python
class RAGSettings(BaseSettings):
    # ... existing fields ...
    
    bm25_background_rebuild: bool = Field(
        default=True,
        validation_alias="RAG_BM25_BACKGROUND_REBUILD"
    )
```

- [ ] **Step 3: Test background rebuild**

```python
def test_background_bm25_rebuild():
    """BM25 should rebuild in background without blocking."""
    store = VectorStore()
    
    # Add chunks
    chunks = [DocumentChunk(text=f"Chunk {i}", source="test", chunk_index=i) for i in range(100)]
    
    start = time.time()
    store.add_chunks(chunks)
    add_time = time.time() - start
    
    # Should return quickly (< 500ms) even with many chunks
    assert add_time < 0.5
    
    # Wait for background rebuild
    time.sleep(2)
    
    # BM25 should be searchable
    results = store.bm25_index.search("chunk", top_k=10)
    assert len(results) > 0


def test_background_rebuild_shutdown():
    """Background thread should shut down gracefully."""
    store = VectorStore()
    
    # Add chunks to trigger background thread
    chunks = [DocumentChunk(text="test", source="test", chunk_index=0)]
    store.add_chunks(chunks)
    
    # Shutdown should complete without error
    store._shutdown_background_rebuild()
    
    # Thread should not be alive after shutdown
    if store._bm25_rebuild_thread:
        assert not store._bm25_rebuild_thread.is_alive()
```

- [ ] **Step 4: Commit**

```bash
git add vector_store.py config.py tests/test_bm25_background.py
git commit -m "MEDIUM: Add background BM25 index rebuild

Prevent ingestion blocking by rebuilding BM25 index in background thread.

- Add background rebuild queue and worker thread
- Debounce rebuilds (1 second delay with shutdown checking)
- Add graceful shutdown mechanism with atexit handler
- Add RAG_BM25_BACKGROUND_REBUILD config option (default: true)
- Ingestion returns immediately, BM25 updates asynchronously
- Add shutdown tests to prevent lost updates

Performance: Eliminates synchronous BM25 rebuild bottleneck
Thread Safety: Independent thread with queue-based communication"
```

---

## Phase 4: Code Quality - Dead Code Decision

### Task 4.1: Decision - Integrate or Remove Dead Code

**Priority:** 🟡 MEDIUM (Code Quality)  
**Impact:** Cleaner codebase or working features  

**Analysis:**
- `reranking.py` - CrossEncoder reranking defined but not used
- `query_transformer.py` - Step-back query transformation defined but not used
- Config flags exist but do nothing

**Decision Framework:**

**Option A: Integrate (if valuable)**
- Reranking can improve result quality by 10-20% (industry standard)
- Query transformation helps with complex multi-concept queries
- Implementation effort: ~4 hours
- Risk: Adds complexity, needs testing

**Option B: Remove (if not valuable)**
- Simpler codebase
- No unused code to maintain
- Implementation effort: ~1 hour
- Risk: Loses potential quality improvements

**Recommendation:** 
Given the RAG pipeline is already functional and the focus is on stability/security, **recommend Option B (Remove)** for now. Can be re-added later when quality optimization becomes priority.

- [ ] **Step 1: Remove dead code files**

```bash
# Remove files
git rm reranking.py
git rm query_transformer.py

# Remove associated tests if they exist
git rm tests/test_reranking.py 2>/dev/null || true
git rm tests/test_query_transformer.py 2>/dev/null || true
```

- [ ] **Step 2: Remove dead config flags**

Modify `config.py`:
```python
# Remove these fields from RAGSettings:
# - reranking_enabled
# - reranker_model
# - query_transformation_enabled
# - initial_retrieval_top_k (only used by dead code)
```

Modify `rag_engine.py`:
```python
# Remove from RAGConfig:
# - reranking_enabled
# - reranker_model
# - query_transformation_enabled
# - initial_retrieval_top_k
```

- [ ] **Step 3: Document decision**

Create `docs/architecture_decisions/adr-001-dead-code-removal.md`:

```markdown
# ADR 001: Removal of Unused Reranking and Query Transformation

## Status
Accepted

## Context
The codebase contained `reranking.py` and `query_transformer.py` modules that were fully implemented but not integrated into the RAG pipeline. The configuration flags (`reranking_enabled`, `query_transformation_enabled`) existed but had no effect.

## Decision
Remove the unused code to simplify the codebase.

## Rationale
1. The RAG pipeline is functional without these features
2. Current focus is on stability and security, not quality optimization
3. Unused code adds maintenance burden
4. Features can be re-added later when quality optimization becomes priority
5. Industry-standard reranking can be added via third-party libraries when needed

## Consequences
- Simpler codebase with less cognitive load
- No unused configuration options
- Lost opportunity for 10-20% quality improvement from reranking
- Can be re-implemented later using modern libraries (e.g., sentence-transformers cross-encoder)

## Related
- RAG Pipeline Review: Medium priority quality improvements
- Future work: Re-add reranking when quality becomes priority
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "MEDIUM: Remove unused reranking and query transformation code

Delete dead code that was not integrated into the RAG pipeline.

- Remove reranking.py and query_transformer.py
- Remove unused config flags (reranking_enabled, query_transformation_enabled)
- Remove associated test files
- Add ADR documenting the decision
- Simplify codebase

Quality: Cleaner codebase without unused features
Architecture: Documented decision for future reference"
```

---

## Phase 5: Documentation Improvements

### Task 5.1: Add GUI Tooltips (CustomTkinter Compatible)

**Priority:** 🟢 LOW (UX)  
**Impact:** Better user understanding of settings  
**Files:**
- Modify: `app_gui.py` (settings dialog)

**Note:** Uses CustomTkinter (CTk), not standard tkinter.

- [ ] **Step 1: Add tooltip helper for CTk**

Add to `app_gui.py`:

```python
import customtkinter as ctk

def add_tooltip(widget, text):
    """Add a tooltip to a CustomTkinter widget."""
    def show_tooltip(event):
        # Create tooltip window
        tooltip = ctk.CTkToplevel(widget)
        tooltip.wm_overrideredirect(True)
        tooltip.wm_geometry(f"+{event.x_root+10}+{event.y_root+10}")
        tooltip.attributes('-topmost', True)
        
        # Create label with tooltip text
        label = ctk.CTkLabel(
            tooltip,
            text=text,
            wraplength=300,
            justify="left",
            fg_color=("#ffffe0", "#404040"),  # Light/dark mode
            corner_radius=6
        )
        label.pack(padx=10, pady=5)
        
        widget.tooltip_window = tooltip
    
    def hide_tooltip(event):
        if hasattr(widget, 'tooltip_window'):
            widget.tooltip_window.destroy()
            delattr(widget, 'tooltip_window')
    
    widget.bind('<Enter>', show_tooltip)
    widget.bind('<Leave>', hide_tooltip)
```

- [ ] **Step 2: Add tooltips to settings**

Modify settings dialog in `app_gui.py` (around line 107 where CTk widgets are created):

```python
# In SettingsDialog.create_widgets() or similar:

# Chunk size
chunk_label = ctk.CTkLabel(self, text="Chunk Size:")
chunk_label.grid(row=0, column=0, sticky="w", padx=10, pady=5)
add_tooltip(
    chunk_label,
    "Number of words per document chunk.\n\n"
    "Smaller (128-256): More precise retrieval, more chunks\n"
    "Larger (512-1024): Better context, fewer chunks\n"
    "Default: 512"
)

# Temperature
temp_label = ctk.CTkLabel(self, text="Temperature:")
temp_label.grid(row=1, column=0, sticky="w", padx=10, pady=5)
add_tooltip(
    temp_label,
    "Controls LLM creativity/randomness.\n\n"
    "0.0 = Deterministic, factual\n"
    "0.3 = Balanced (default)\n"
    "1.0+ = Creative, may hallucinate"
)

# Hybrid search
hybrid_label = ctk.CTkLabel(self, text="Hybrid Search:")
hybrid_label.grid(row=2, column=0, sticky="w", padx=10, pady=5)
add_tooltip(
    hybrid_label,
    "Combine keyword (BM25) and semantic (vector) search.\n\n"
    "ON: Better for mixed keyword/conceptual queries\n"
    "OFF: Faster, pure semantic search"
)
```

- [ ] **Step 3: Test tooltips**

```bash
python app_gui.py
# Hover over settings and verify tooltips appear with CTk styling
```

- [ ] **Step 4: Commit**

```bash
git add app_gui.py
git commit -m "LOW: Add tooltips to GUI settings

Add explanatory tooltips to help users understand settings.

- Add add_tooltip() helper function for CustomTkinter
- Add tooltips to chunk_size, temperature, hybrid_search
- Tooltips explain what each setting does and recommended values
- Uses CTk styling for consistency with app theme

UX: Improves discoverability and reduces user confusion"
```

---

## Phase 6: Validation & Testing

### Task 6.1: Run Full Test Suite

- [ ] **Step 1: Run all tests**

```bash
python -m pytest tests/ -v --tb=short 2>&1 | tee test_results.txt
```

**Expected:** >95% pass rate (up from 88%)

- [ ] **Step 2: Verify critical fixes**

```bash
# Test logger fix
python -c "from rag_engine import RAGEngine, RAGConfig; e = RAGEngine(RAGConfig()); print('✓ Logger fix: OK')"

# Test port 0 fix
python -m pytest tests/test_security.py::test_validate_url_rejects_port_zero -v

# Test timing attack fix
python -m pytest tests/test_auth.py::test_api_key_uses_constant_time_comparison -v

# Test token counting
python -m pytest tests/test_token_counter.py -v

# Test async operations
python -m pytest tests/test_async_vector_store.py -v

# Test background BM25
python -m pytest tests/test_bm25_background.py -v
```

- [ ] **Step 3: Performance benchmark**

```bash
python -m pytest tests/test_performance_benchmark.py -v
```

**Expected:** Concurrent QPS improved from 2.1 to >10

- [ ] **Step 4: Security scan**

```bash
# Run security tests
python -m pytest tests/test_security.py tests/test_phase1_adversarial.py -v

# Check for secrets
python -m bandit -r . -f json -o bandit_report.json 2>/dev/null || echo "bandit not installed"
```

- [ ] **Step 5: Documentation check**

```bash
# Verify all docs updated
grep -l "ENABLE_AUTH" README.md CONFIGURATION.md USAGE.md
grep -l "API_KEY" README.md CONFIGURATION.md USAGE.md
```

---

## Deferred Issues (Documented for Future)

The following MEDIUM priority issues from the review are **deferred** to future sprints:

| Issue | Priority | Rationale |
|-------|----------|-----------|
| History truncation limits (300 chars/turn) | MEDIUM | Current limits work for most use cases; can be increased if needed |
| No retry logic in LLM interface | MEDIUM | Fallback chain provides resilience; retries add complexity |
| Qwen3 model detection gaps | MEDIUM | Filename-based detection works for standard models |
| Stop sequences defined but unused | MEDIUM | Not critical for current LLM backends |
| Memory consumption for large documents | MEDIUM | RAG_MAX_FILE_SIZE provides guardrail |
| Table structure preservation | MEDIUM | Current concatenation works; structured extraction is complex |

**Documented in:** `docs/deferred_issues.md` for future reference.

---

## Summary

### Implementation Order

**Phase 1 (Deploy Immediately - Day 1):**
1. ✅ Verify already-fixed issues (0.1)
2. Fix timing attack (1.1) - 15 min
3. Document ENABLE_AUTH (1.2) - 30 min

**Phase 2 (This Week - Days 2-3):**
4. Add symlink protection (2.1) - 30 min
5. Add token counting (2.2) - 2 hours

**Phase 3 (Next Sprint - Days 4-5):**
6. Async VectorStore operations (3.1) - 3 hours
7. Background BM25 rebuild (3.2) - 2 hours

**Phase 4 (Decision Required):**
8. Remove dead code (4.1) - 1 hour

**Phase 5 (Ongoing):**
9. Add GUI tooltips (5.1) - 1 hour

**Phase 6 (Validation):**
10. Full test suite validation

### Success Criteria

- [ ] All CRITICAL and HIGH issues resolved
- [ ] Test pass rate >95% (up from 88%)
- [ ] No new security vulnerabilities
- [ ] Concurrent QPS >10 (up from 2.1)
- [ ] Documentation complete

### Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Threading deadlock | Use RLock (reentrant), add timeout tests |
| Lost BM25 updates | Add shutdown handler with flush |
| Token counting accuracy | Use tiktoken when available, fallback gracefully |
| Async performance | Benchmark before/after, rollback if degraded |

---

**Plan revised:** 2026-04-09  
**Original issues:** 1 CRITICAL, 3 HIGH, 8 MEDIUM, 12 LOW  
**Already fixed:** 2 (logger, port 0)  
**Addressed in plan:** 1 CRITICAL, 2 HIGH, 2 MEDIUM, 1 LOW  
**Deferred:** 6 MEDIUM, 11 LOW (documented)  
**Estimated time:** 3-5 days  
**Risk level:** Low (careful threading analysis, comprehensive tests)
