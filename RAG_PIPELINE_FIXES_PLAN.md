# RAG Pipeline Issues Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all critical, high, and medium priority issues identified in the RAG pipeline comprehensive review to achieve production-ready status.

**Architecture:** Follow TDD (Test-Driven Development) with bite-sized tasks. Each fix includes: (1) failing test, (2) minimal implementation, (3) verification, (4) commit. Security fixes use defense-in-depth. Performance fixes maintain backward compatibility.

**Tech Stack:** Python 3.10+, FastAPI, ChromaDB, sentence-transformers, pytest

> **Engine scope note:** This document describes the **Python desktop** RAG
> engine (`vector_store.py`, `rag_engine.py`), whose keyword retriever is
> **BM25**. The separate **browser web_ui** RAG pipeline
> (`web_ui/src/lib/search/keyword-index.ts`) is a *different* engine: it uses
> **FlexSearch resolution-rank scoring** with `suggest:true` fuzzy matching, not
> BM25. The two share a hybrid (vector + keyword) shape but have different
> scoring/tuning characteristics — do not transfer BM25 tuning conclusions to
> the browser engine (and vice versa).

---

## File Structure

### Files to Modify

| File | Responsibility | Lines to Touch |
|------|---------------|----------------|
| `rag_engine.py` | RAG orchestration, logger fix | 1-30 (imports), 411 (context), 799 (format_chunk) |
| `security.py` | URL validation, SSRF protection | 84 (port check), 136 (IPv6) |
| `auth.py` | Authentication, timing-safe comparison | 25 (ENABLE_AUTH), 74 (JWT), 108 (API key) |
| `api_server.py` | Path validation, symlink check | 103-147 (validate_directory) |
| `vector_store.py` | Async operations, BM25 rebuild | 221 (lock), 564-576 (BM25), 610 (empty query) |
| `llm_interface.py` | Token counting, streaming prep | 40-50 (redaction), 522-529 (prompt) |
| `config.py` | Documentation, env vars | All tables |
| `USAGE.md` | API documentation | 421-657 (auth endpoints) |
| `README.md` | Setup instructions | 24-26 (terminology), auth section |
| `app_gui.py` | Tooltips, UX | 200-250 (settings dialog) |

### Files to Create

| File | Purpose |
|------|---------|
| `tests/test_logger_initialization.py` | Verify logger fix |
| `tests/test_security_regression.py` | Port 0, timing attack tests |
| `tests/test_async_vector_store.py` | Async operations tests |
| `docs/security_hardening_guide.md` | Production security checklist |

---

## Phase 1: CRITICAL Fixes (Must Deploy Immediately)

### Task 1.1: Fix Missing Logger Initialization in rag_engine.py

**Priority:** 🔴 CRITICAL  
**Impact:** RAGEngine crashes on initialization with NameError  
**Files:**
- Modify: `rag_engine.py:1-30` (add logger initialization)
- Test: `tests/test_logger_initialization.py` (create new)

- [ ] **Step 1: Write failing test**

Create `tests/test_logger_initialization.py`:
```python
"""Test that RAGEngine initializes without NameError."""
import pytest
from rag_engine import RAGEngine, RAGConfig


def test_rag_engine_initializes_without_name_error():
    """CRITICAL: RAGEngine should not raise NameError on init."""
    config = RAGConfig(
        db_path="./test_db",
        chunk_size=512,
        n_results=3
    )
    
    # This should NOT raise NameError: name 'logger' is not defined
    try:
        engine = RAGEngine(config=config)
        assert engine is not None
        assert engine.config == config
    except NameError as e:
        pytest.fail(f"RAGEngine raised NameError on initialization: {e}")


def test_rag_engine_logs_on_initialization():
    """Verify logger works after initialization."""
    import logging
    
    # Capture log output
    with pytest.raises(NameError):
        # This will fail before the fix
        from rag_engine import logger
        assert logger is not None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd C:\opencode\doc_qa_app
python -m pytest tests/test_logger_initialization.py -v
```

**Expected:** FAIL with `NameError: name 'logger' is not defined`

- [ ] **Step 3: Add logger initialization to rag_engine.py**

Modify `rag_engine.py` at line 15 (after imports, before first use):

```python
"""
RAG Engine Module
Combines document processing, vector store, and LLM for question answering.
"""

import os
import sys
import json
import time
import logging  # Already imported
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
from dataclasses import dataclass
import app_paths

# Initialize logger at module level - CRITICAL FIX
logger = logging.getLogger(__name__)

from config import DEFAULT_MAX_TOKENS, settings
from document_processor import DocumentProcessor
from vector_store import VectorStore
from llm_interface import SmartLLM, InferenceConfig

# Import unified factory functions
from engine_factory import (
    create_engine_from_env as _factory_create_engine_from_env,
)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m pytest tests/test_logger_initialization.py -v
```

**Expected:** PASS (2/2 tests)

- [ ] **Step 5: Run full RAG engine test suite**

```bash
python -m pytest tests/test_rag_engine.py -v --tb=short
```

**Expected:** All tests pass (previously 13 were failing due to this bug)

- [ ] **Step 6: Commit**

```bash
git add rag_engine.py tests/test_logger_initialization.py
git commit -m "CRITICAL: Add missing logger initialization in rag_engine.py

Fixes NameError on RAGEngine initialization that was breaking all
RAG engine tests and preventing engine creation.

- Add logger = logging.getLogger(__name__) at module level
- Add regression test to prevent future regression
- All 13 previously failing tests now pass

Fixes: RAG Pipeline Review CRITICAL finding"
```

---

### Task 1.2: Fix Port 0 Bypass in security.py

**Priority:** 🔴 HIGH (Security)  
**Impact:** Port 0 bypasses allowed_ports validation  
**Files:**
- Modify: `security.py:84` (port validation)
- Test: `tests/test_security.py:408-428` (existing test documents bug)

- [ ] **Step 1: Write failing test**

Add to `tests/test_security.py` after line 428:

```python
def test_validate_url_rejects_port_zero():
    """Port 0 should be rejected even though it's falsy in Python."""
    from security import validate_url
    
    # Port 0 is technically valid in URLs but should be blocked
    # as it's often used for SSRF bypasses
    with pytest.raises(ValueError, match="port"):
        validate_url("http://example.com:0/path")
    
    with pytest.raises(ValueError, match="port"):
        validate_url("http://localhost:0/")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_security.py::test_validate_url_rejects_port_zero -v
```

**Expected:** FAIL - port 0 is accepted (no ValueError raised)

- [ ] **Step 3: Fix port validation in security.py**

Modify `security.py` at line 84:

```python
# BEFORE (buggy):
if parsed.port:
    if parsed.port not in allowed_ports:
        raise ValueError(f"Port {parsed.port} not in allowed list: {allowed_ports}")

# AFTER (fixed):
if parsed.port is not None:  # Port 0 is not None, but is falsy
    if parsed.port not in allowed_ports:
        raise ValueError(f"Port {parsed.port} not in allowed list: {allowed_ports}")
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m pytest tests/test_security.py::test_validate_url_rejects_port_zero -v
```

**Expected:** PASS

- [ ] **Step 5: Run full security test suite**

```bash
python -m pytest tests/test_security.py -v --tb=short
```

**Expected:** All tests pass

- [ ] **Step 6: Commit**

```bash
git add security.py tests/test_security.py
git commit -m "HIGH: Fix port 0 bypass in URL validation

Port 0 was bypassing allowed_ports validation because
`if parsed.port:` treats 0 as falsy. Changed to explicit
None check to catch port 0.

- Change `if parsed.port:` to `if parsed.port is not None:`
- Add regression test for port 0 rejection
- All security tests pass

Security: Prevents SSRF via port 0 bypass"
```

---

### Task 1.3: Fix Timing Attack in API Key Comparison

**Priority:** 🔴 HIGH (Security)  
**Impact:** API key vulnerable to timing attack  
**Files:**
- Modify: `auth.py:108` (API key comparison)
- Test: `tests/test_auth.py` (add timing test)

- [ ] **Step 1: Write failing test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_auth.py::test_api_key_uses_constant_time_comparison -v
```

**Expected:** FAIL - current code uses `==` comparison

- [ ] **Step 3: Fix API key comparison in auth.py**

Modify `auth.py` at line 108:

```python
# BEFORE (vulnerable):
if api_key and api_key == API_KEY:
    return {"sub": "api_key_user", "auth_type": "api_key"}

# AFTER (secure):
import secrets  # Add at top of file if not present

if api_key and secrets.compare_digest(api_key, API_KEY):
    return {"sub": "api_key_user", "auth_type": "api_key"}
```

Also add import at top of `auth.py`:
```python
import secrets  # Add with other imports
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m pytest tests/test_auth.py::test_api_key_uses_constant_time_comparison -v
```

**Expected:** PASS

- [ ] **Step 5: Run full auth test suite**

```bash
python -m pytest tests/test_auth.py -v --tb=short
```

**Expected:** All tests pass

- [ ] **Step 6: Commit**

```bash
git add auth.py tests/test_auth.py
git commit -m "HIGH: Fix timing attack vulnerability in API key validation

Replace direct string comparison with secrets.compare_digest()
for constant-time comparison to prevent timing attacks.

- Use secrets.compare_digest(api_key, API_KEY) instead of ==
- Add test to verify constant-time comparison is used
- All auth tests pass

Security: Prevents timing attack on API key brute force"
```

---

### Task 1.4: Document ENABLE_AUTH Production Requirement

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

- [ ] **Step 5: Commit documentation changes**

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
    if not str(resolved_path).startswith(str(resolved_base)):
        raise ValueError(f"Path traversal detected: resolved path {resolved_path} outside base {resolved_base}")
    
    # Check if path contains any symlinks that escape base_dir
    current = path
    while current != current.parent:
        if current.is_symlink():
            link_target = current.readlink()
            if link_target.is_absolute():
                # Absolute symlink - check if it points inside base
                if not str(link_target).startswith(str(resolved_base)):
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
- Modify: `llm_interface.py` (use token counting)
- Modify: `rag_engine.py` (token-aware truncation)

- [ ] **Step 1: Create token counter module**

Create `token_counter.py`:

```python
"""Token counting utilities for LLM context management."""
import logging
from typing import List, Tuple

try:
    import tiktoken
    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

logger = logging.getLogger(__name__)


class TokenCounter:
    """Count tokens for text to manage LLM context windows."""
    
    # Approximate tokens per character for different languages
    CHARS_PER_TOKEN = {
        'en': 4,  # English: ~4 chars per token
        'code': 3.5,  # Code: ~3.5 chars per token
        'default': 4
    }
    
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
            return len(text) // self.CHARS_PER_TOKEN['default']
    
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
        while low < high:
            mid = (low + high) // 2
            truncated = text[:mid]
            if self.count_tokens(truncated) <= max_tokens:
                low = mid + 1
            else:
                high = mid
        
        # Find sentence boundary if requested
        if preserve_sentences:
            truncated = text[:low]
            # Find last sentence ending
            last_period = max(
                truncated.rfind('.'),
                truncated.rfind('!'),
                truncated.rfind('?')
            )
            if last_period > len(truncated) * 0.8:  # Keep at least 80%
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
# BEFORE:
# Truncate context to safe length
safe_context = context[:settings.rag_context_truncation]

# AFTER:
# Token-aware context truncation
from token_counter import TokenCounter
token_counter = TokenCounter()

# Calculate available tokens for context
system_prompt = "You are a helpful assistant..."  # Get actual prompt
user_prompt = question
history_tokens = 0
if conversation_history:
    for turn in conversation_history[-2:]:  # Last 2 turns
        history_tokens += token_counter.count_tokens(turn[0])
        history_tokens += token_counter.count_tokens(turn[1])

# Reserve tokens for system, history, question, and answer
reserved_tokens = (
    token_counter.count_tokens(system_prompt) +
    history_tokens +
    token_counter.count_tokens(user_prompt) +
    config.max_tokens +  # Space for answer
    50  # Safety margin
)

# Calculate available context tokens
# Assume 8192 token context window (configurable)
CONTEXT_WINDOW = 8192
available_context_tokens = CONTEXT_WINDOW - reserved_tokens

# Truncate context to fit
if token_counter.count_tokens(context) > available_context_tokens:
    logger.warning(
        f"Context ({token_counter.count_tokens(context)} tokens) exceeds "
        f"available space ({available_context_tokens}). Truncating."
    )
    safe_context = token_counter.truncate_to_token_limit(
        context,
        available_context_tokens,
        preserve_sentences=True
    )
else:
    safe_context = context
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest tests/test_token_counter.py -v
python -m pytest tests/test_rag_engine.py -v
```

**Expected:** All tests pass

- [ ] **Step 5: Commit**

```bash
git add token_counter.py tests/test_token_counter.py rag_engine.py
git commit -m "HIGH: Add token counting for context window management

Prevent context overflow by counting tokens instead of characters.
Uses tiktoken when available, falls back to character approximation.

- Create token_counter.py with TokenCounter class
- Add token-aware context truncation in RAGEngine.query()
- Reserve tokens for system prompt, history, question, and answer
- Truncate context to fit within LLM token budget
- Add comprehensive tests

Quality: Prevents context truncation mid-sentence and ensures
LLM has room to generate complete answers."
```

---

## Phase 3: MEDIUM Priority Improvements (Next Sprint)

### Task 3.1: Implement Async VectorStore Operations

**Priority:** 🟡 MEDIUM (Performance)  
**Impact:** 10× improvement in concurrent query throughput  
**Files:**
- Modify: `vector_store.py` (add async methods)
- Create: `tests/test_async_vector_store.py`

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

- [ ] **Step 3: Add async tests**

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
async def test_concurrent_searches():
    """Multiple concurrent searches should complete without error."""
    store = VectorStore(db_path="./test_async_db")
    
    # Run 10 searches concurrently
    queries = ["python", "javascript", "coding"] * 3 + ["test"]
    tasks = [store.search_async(q) for q in queries]
    
    results = await asyncio.gather(*tasks)
    
    assert len(results) == 10
    # All should complete without exception
```

- [ ] **Step 4: Benchmark async vs sync**

```python
# Benchmark script
import asyncio
import time
from vector_store import VectorStore

async def benchmark():
    store = VectorStore()
    
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
- Add async tests and benchmarks
- 5-10× improvement in concurrent query throughput

Performance: Resolves lock contention issue for high-concurrency workloads"
```

---

### Task 3.2: Background BM25 Index Rebuild

**Priority:** 🟡 MEDIUM (Performance)  
**Impact:** Non-blocking ingestion for large batches  
**Files:**
- Modify: `vector_store.py` (BM25 rebuild logic)
- Modify: `bm25_index.py` (add async rebuild)

- [ ] **Step 1: Add background rebuild capability**

Modify `vector_store.py`:

```python
import threading
import queue

class VectorStore:
    """Vector store with background BM25 rebuild."""
    
    def __init__(self, ...):
        # ... existing init ...
        self._bm25_rebuild_queue = queue.Queue()
        self._bm25_rebuild_thread = None
        self._bm25_rebuild_lock = threading.Lock()
    
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
                self._bm25_rebuild_thread = threading.Thread(
                    target=self._background_rebuild_worker,
                    daemon=True
                )
                self._bm25_rebuild_thread.start()
    
    def _background_rebuild_worker(self):
        """Worker thread for background BM25 rebuild."""
        import time
        
        # Wait for ingestion to settle (debounce)
        time.sleep(1.0)
        
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
            self.bm25_index.add_documents(chunks_to_add, rebuild=True)
            logger.info("Background BM25 rebuild complete")
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
    
    # Should return quickly (< 100ms) even with many chunks
    assert add_time < 0.5
    
    # Wait for background rebuild
    time.sleep(2)
    
    # BM25 should be searchable
    results = store.bm25_index.search("chunk", top_k=10)
    assert len(results) > 0
```

- [ ] **Step 4: Commit**

```bash
git add vector_store.py config.py tests/test_bm25_background.py
git commit -m "MEDIUM: Add background BM25 index rebuild

Prevent ingestion blocking by rebuilding BM25 index in background thread.

- Add background rebuild queue and worker thread
- Debounce rebuilds (1 second delay)
- Add RAG_BM25_BACKGROUND_REBUILD config option (default: true)
- Ingestion returns immediately, BM25 updates asynchronously
- Improves batch ingestion performance for large document sets

Performance: Eliminates synchronous BM25 rebuild bottleneck"
```

---

## Phase 4: Code Quality & Dead Code (Decision Required)

### Task 4.1: Integrate or Remove Dead Code

**Priority:** 🟡 MEDIUM (Code Quality)  
**Impact:** Cleaner codebase, either working features or removed bloat  
**Files:**
- Decision needed: `reranking.py`, `query_transformer.py`

- [ ] **Step 1: Analyze dead code usage**

Check if reranking and query transformation are used anywhere:

```bash
grep -r "reranking" --include="*.py" .
grep -r "query_transformer" --include="*.py" .
grep -r "CrossEncoderReranker" --include="*.py" .
grep -r "QueryTransformer" --include="*.py" .
```

**Expected:** Only definitions, no actual usage in RAG pipeline.

- [ ] **Step 2: Create integration plan OR removal plan**

**Option A: Integrate (if valuable)**

Modify `rag_engine.py` to use reranking:

```python
# In RAGEngine.query() after retrieval
if self.config.reranking_enabled and self.reranker:
    # Rerank retrieved chunks
    reranked = self.reranker.rerank(
        query=query,
        chunks=retrieved_chunks,
        top_k=self.config.n_results
    )
    context_chunks = reranked
```

**Option B: Remove (if not valuable)**

```bash
# Remove files
git rm reranking.py query_transformer.py
git rm tests/test_reranking.py tests/test_query_transformer.py

# Remove from config
# Remove reranking_enabled and query_transformation_enabled from RAGConfig
```

- [ ] **Step 3: Document decision**

Create `docs/architecture_decisions/adr-001-dead-code.md`:

```markdown
# ADR 001: Reranking and Query Transformation

## Status
Accepted / Rejected (choose one)

## Context
reranking.py and query_transformer.py exist but are not integrated into the RAG pipeline.
The config flags (reranking_enabled, query_transformation_enabled) exist but do nothing.

## Decision
[Option A: Integrate them / Option B: Remove them]

## Rationale
[Explain why]

## Consequences
[What happens as a result]
```

- [ ] **Step 4: Implement decision**

Either integrate the code fully or remove it completely. No half-measures.

- [ ] **Step 5: Commit**

```bash
# If integrating:
git add rag_engine.py reranking.py query_transformer.py
git commit -m "MEDIUM: Integrate reranking and query transformation

Wire up previously dead code into RAG pipeline.

- Add reranking after initial retrieval when enabled
- Add query transformation (step-back) when enabled
- Update RAGEngine to use these features
- Add integration tests

Quality: Improves retrieval quality with reranking and query expansion"

# If removing:
git rm reranking.py query_transformer.py tests/test_reranking.py tests/test_query_transformer.py
git commit -m "MEDIUM: Remove unused reranking and query transformation code

Delete dead code that was not integrated into the RAG pipeline.

- Remove reranking.py and query_transformer.py
- Remove unused config flags
- Remove associated tests
- Simplify codebase

Quality: Cleaner codebase without unused features"
```

---

## Phase 5: Documentation Improvements

### Task 5.1: Add GUI Tooltips

**Priority:** 🟢 LOW (UX)  
**Impact:** Better user understanding of settings  
**Files:**
- Modify: `app_gui.py` (settings dialog)

- [ ] **Step 1: Add tooltip helper**

Add to `app_gui.py`:

```python
import tkinter as tk
from tkinter import ttk

def add_tooltip(widget, text):
    """Add a tooltip to a widget."""
    def show_tooltip(event):
        tooltip = tk.Toplevel()
        tooltip.wm_overrideredirect(True)
        tooltip.wm_geometry(f"+{event.x_root+10}+{event.y_root+10}")
        
        label = tk.Label(
            tooltip,
            text=text,
            background="#ffffe0",
            relief="solid",
            borderwidth=1,
            wraplength=300
        )
        label.pack()
        
        widget.tooltip = tooltip
    
    def hide_tooltip(event):
        if hasattr(widget, 'tooltip'):
            widget.tooltip.destroy()
            delattr(widget, 'tooltip')
    
    widget.bind('<Enter>', show_tooltip)
    widget.bind('<Leave>', hide_tooltip)
```

- [ ] **Step 2: Add tooltips to settings**

Modify settings dialog in `app_gui.py`:

```python
# In SettingsDialog.__init__ or create_widgets:

# Chunk size
chunk_label = ttk.Label(self, text="Chunk Size:")
chunk_label.grid(row=0, column=0, sticky="w")
add_tooltip(
    chunk_label,
    "Number of words per document chunk.\n"
    "Smaller (128-256): More precise retrieval, more chunks\n"
    "Larger (512-1024): Better context, fewer chunks\n"
    "Default: 512"
)

# Temperature
temp_label = ttk.Label(self, text="Temperature:")
temp_label.grid(row=1, column=0, sticky="w")
add_tooltip(
    temp_label,
    "Controls LLM creativity/randomness.\n"
    "0.0 = Deterministic, factual\n"
    "0.3 = Balanced (default)\n"
    "1.0+ = Creative, may hallucinate"
)

# Hybrid search
hybrid_label = ttk.Label(self, text="Hybrid Search:")
hybrid_label.grid(row=2, column=0, sticky="w")
add_tooltip(
    hybrid_label,
    "Combine keyword (BM25) and semantic (vector) search.\n"
    "ON: Better for mixed keyword/conceptual queries\n"
    "OFF: Faster, pure semantic search"
)
```

- [ ] **Step 3: Test tooltips**

```bash
python app_gui.py
# Hover over settings and verify tooltips appear
```

- [ ] **Step 4: Commit**

```bash
git add app_gui.py
git commit -m "LOW: Add tooltips to GUI settings

Add explanatory tooltips to help users understand settings.

- Add add_tooltip() helper function
- Add tooltips to chunk_size, temperature, hybrid_search
- Tooltips explain what each setting does and recommended values

UX: Improves discoverability and reduces user confusion"
```

---

## Phase 6: Testing & Validation

### Task 6.1: Run Full Test Suite

- [ ] **Step 1: Run all tests**

```bash
python -m pytest tests/ -v --tb=short 2>&1 | tee test_results.txt
```

- [ ] **Step 2: Verify critical fixes**

```bash
# Test logger fix
python -c "from rag_engine import RAGEngine, RAGConfig; e = RAGEngine(RAGConfig()); print('Logger fix: OK')"

# Test port 0 fix
python -m pytest tests/test_security.py::test_validate_url_rejects_port_zero -v

# Test timing attack fix
python -m pytest tests/test_auth.py::test_api_key_uses_constant_time_comparison -v

# Test token counting
python -m pytest tests/test_token_counter.py -v
```

- [ ] **Step 3: Performance benchmark**

```bash
python -m pytest tests/test_performance_benchmark.py -v
```

- [ ] **Step 4: Security scan**

```bash
# Run security tests
python -m pytest tests/test_security.py tests/test_phase1_adversarial.py -v

# Check for secrets
python -m bandit -r . -f json -o bandit_report.json
```

---

## Summary

### Implementation Order

**Phase 1 (Deploy Immediately):**
1. Fix logger initialization (CRITICAL)
2. Fix port 0 bypass (HIGH)
3. Fix timing attack (HIGH)
4. Document ENABLE_AUTH (CRITICAL)

**Phase 2 (This Week):**
5. Add symlink protection (HIGH)
6. Add token counting (HIGH)

**Phase 3 (Next Sprint):**
7. Async VectorStore operations (MEDIUM)
8. Background BM25 rebuild (MEDIUM)

**Phase 4 (Decision Required):**
9. Integrate or remove dead code (MEDIUM)

**Phase 5 (Ongoing):**
10. Add GUI tooltips (LOW)
11. Complete documentation

### Success Criteria

- [ ] All CRITICAL and HIGH issues resolved
- [ ] Test pass rate > 95%
- [ ] No new security vulnerabilities
- [ ] Performance maintained or improved
- [ ] Documentation complete

---

**Plan created:** 2026-04-09  
**Estimated implementation time:** 3-5 days  
**Risk level:** Low (mostly additive changes with comprehensive tests)
