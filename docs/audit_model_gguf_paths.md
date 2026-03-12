# Model Path vs GGUF Path Usage Audit

**Audit Date:** 2026-03-11  
**Scope:** All Python files using `model_path` or `gguf_path` parameters  
**Auditor:** Phase 15.3 Task

---

## Executive Summary

| Category | Status |
|----------|--------|
| Overall Status | **MOSTLY FIXED** - Critical issues resolved in Tasks 15.1 and 15.2 |
| Issues Found | 1 Minor inconsistency, 1 Naming concern |
| Action Required | Task 15.4 unification recommended |

### Summary
The codebase has undergone significant fixes in Tasks 15.1 and 15.2 to correct the semantic misuse of `model_path` (meant for OpenVINO models) versus `gguf_path` (meant for GGUF format models). All critical entry points now correctly pass `gguf_path` to the RAGEngine. One minor inconsistency remains in CLI mode where both parameters are passed simultaneously, which could lead to confusion but does not cause functional issues due to SmartLLM's priority logic.

---

## Entry Points Analysis

### 1. GUI Mode (app_gui.py)

**Status:** ✅ **FIXED & VERIFIED**

**Settings Dialog (Lines 145-174):**
- ✅ Saves to `"gguf_path"` key (Line 160)
- ✅ Reads from `"gguf_path"` with fallback to `"model_path"` for migration (Line 145)
- ✅ Migration code removes old `"model_path"` key from result (Lines 172-174)

**Settings Loading (Lines 211-237):**
- ✅ Default settings use `"gguf_path"` key (Line 215)
- ✅ Backward compatibility migration: old `"model_path"` → `"gguf_path"` (Lines 230-232)

**Engine Initialization (Lines 370-425):**
- ✅ Passes `gguf_path=` parameter to RAGEngine (Line 389)
- ✅ Uses `self.settings.get("gguf_path")` correctly

**UI Widget Naming (Minor Issue):**
- ⚠️ **NOTE:** Widget variable is named `model_path_entry` (Line 68) even though it holds GGUF path
  - This is a legacy naming issue that doesn't affect functionality
  - Recommendation: Rename to `gguf_path_entry` in Task 15.4

---

### 2. API Mode (api_server.py)

**Status:** ✅ **FIXED & VERIFIED**

**Environment Variable Reading (Lines 280-288):**
- ✅ Reads `RAG_GGUF_PATH` environment variable (Line 281)
- ✅ Validates GGUF path using `validate_model_path()` (Lines 283-288)

**RAGEngine Construction (Lines 326-335):**
- ✅ Passes `gguf_path=gguf_path` to RAGEngine (Line 334)
- ✅ Also passes `model_path=model_path` for OpenVINO support (Line 328)

**Environment Variable to RAGEngine Flow:**
```
RAG_GGUF_PATH (env) → gguf_path (local var) → RAGEngine(gguf_path=...)
```

**Validation:**
- ✅ Regression test `test_defect_002_api_gguf_env.py` verifies the fix
- ✅ Test confirms `RAGEngine` receives `gguf_path` from environment

---

### 3. CLI Mode (main.py)

**Status:** ⚠️ **FUNCTIONAL BUT INCONSISTENT**

**Argument Parsing (Lines 35-44):**
- ✅ Defines `--model-path` argument for OpenVINO (Line 35-36)
- ✅ Defines `--gguf-path` argument for GGUF (Line 43-44)

**Environment Variable Setting (Lines 53-62):**
- ✅ Sets `RAG_MODEL_PATH` from `--model-path` (Lines 53-54)
- ✅ Sets `RAG_GGUF_PATH` from `--gguf-path` (Lines 61-62)

**RAGEngine Construction (Lines 74-82):**
```python
engine = RAGEngine(
    config=config,
    model_path=args.model_path,      # ← OpenVINO path
    ollama_model=args.ollama_model,
    ollama_url=args.ollama_url,
    api_url=args.api_url,
    gguf_path=args.gguf_path         # ← GGUF path
)
```

**Issue:** CLI mode passes BOTH `model_path` AND `gguf_path` to RAGEngine. While SmartLLM correctly prioritizes GGUF when `gguf_path` is populated, this dual-parameter approach:
1. Creates cognitive overhead for developers
2. Makes it unclear which parameter takes precedence
3. Diverges from the single-responsibility principle

**Recommendation for Task 15.4:**
Create a unified helper that selects the appropriate path based on a single `llm_backend_type` parameter.

---

### 4. Factory Function (rag_engine.py `create_engine_from_env`)

**Status:** ✅ **VERIFIED**

**Location:** Lines 471-492

**Implementation:**
```python
def create_engine_from_env() -> RAGEngine:
    """Create RAG engine from environment variables."""
    config = RAGConfig(...)
    
    gguf_path = os.environ.get("RAG_GGUF_PATH")  # ← Line 481
    
    return RAGEngine(
        config=config,
        model_path=os.environ.get("RAG_MODEL_PATH"),
        ollama_model=os.environ.get("RAG_OLLAMA_MODEL"),
        ollama_url=os.environ.get("RAG_OLLAMA_URL"),
        api_url=os.environ.get("RAG_API_URL"),
        api_model=os.environ.get("RAG_API_MODEL"),
        device=os.environ.get("RAG_DEVICE"),
        gguf_path=gguf_path  # ← Line 491
    )
```

**Consumers:**
- ✅ `ui/app.py` → `AppController._init_rag_engine()` (Line 178)
- ❌ NOT used by `api_server.py` (has its own inline construction)

**Note:** The factory function correctly reads `RAG_GGUF_PATH` and passes it to RAGEngine. However, `api_server.py` doesn't use this factory function, creating code duplication.

---

### 5. RAGEngine Class (rag_engine.py)

**Status:** ✅ **VERIFIED**

**Constructor Signature (Lines 115-125):**
```python
def __init__(
    self,
    config: Optional[RAGConfig] = None,
    model_path: Optional[str] = None,      # ← OpenVINO
    ollama_model: Optional[str] = None,
    ollama_url: Optional[str] = None,
    api_url: Optional[str] = None,
    api_model: Optional[str] = None,
    device: Optional[str] = None,
    gguf_path: Optional[str] = None        # ← GGUF
):
```

**Storage (Line 127):**
- ✅ Stores GGUF path: `self.gguf_path = gguf_path`

**LLM Initialization (Lines 152-179):**
- ✅ Passes both `model_path` and `gguf_path` to `_init_llm()`
- ✅ Both parameters forwarded to `SmartLLM`

---

### 6. SmartLLM Class (llm_interface.py)

**Status:** ✅ **VERIFIED**

**Constructor (Lines 345-400):**
```python
def __init__(
    self,
    model_path: Optional[str] = None,
    ollama_model: Optional[str] = None,
    ollama_url: Optional[str] = None,
    api_url: Optional[str] = None,
    api_model: Optional[str] = None,
    device: Optional[str] = None,
    gguf_path: Optional[str] = None,        # ← GGUF
    gguf_n_ctx: int = 8192,
    gguf_n_threads: Optional[int] = None,
    gguf_verbose: bool = False
):
```

**Priority Logic (Lines 361-371):**
```python
if gguf_path and Path(gguf_path).exists():
    try:
        self.backend = GGUFBackend(gguf_path=gguf_path, ...)
        return  # ← GGUF takes priority, returns early
    except Exception as e:
        print(f"[WARN] GGUF failed: {e}")

if model_path and Path(model_path).exists():
    try:
        self.backend = OpenVINOLLM(model_path, device)  # ← Falls back to OpenVINO
        return
```

**Priority Order:**
1. GGUF (highest priority when `gguf_path` is populated and valid)
2. OpenVINO (fallback when `model_path` is populated)
3. OpenAI-compatible API
4. Ollama (lowest priority)

---

## UI/App Mode (ui/app.py)

**Status:** ✅ **VERIFIED**

**Settings Management (Lines 44-56, 77-99):**
- ✅ Default settings use `"gguf_path"` (Line 46)
- ✅ Auto-detects bundled GGUF model when path is empty/invalid
- ✅ Updates settings with detected path

**Engine Initialization (Lines 139-216):**
- ✅ Uses `create_engine_from_env()` factory function
- ✅ Propagates `gguf_path` from settings to `RAG_GGUF_PATH` env var (Line 175)
- ✅ Handles missing/invalid paths gracefully

**Settings Save Handler (Lines 267-317):**
- ✅ Updates `RAG_GGUF_PATH` env var when settings change (Lines 298-302)
- ✅ Reinitializes RAG engine with new settings

---

## Issues Found

| Issue | Severity | Location | Description | Recommendation |
|-------|----------|----------|-------------|----------------|
| 1 | Low | `app_gui.py:68` | Widget named `model_path_entry` but holds GGUF path | Rename to `gguf_path_entry` in Task 15.4 |
| 2 | Low | `main.py:77,81` | CLI passes both `model_path` and `gguf_path` | Use unified helper in Task 15.4 |
| 3 | Low | `api_server.py:326-335` | Inline RAGEngine construction instead of factory | Consider using `create_engine_from_env()` |
| 4 | Info | N/A | Terminology inconsistency | `validate_model_path()` validates GGUF too; consider rename |

---

## Unification Recommendations (for Task 15.4)

### 1. Create Unified Engine Construction Helper

Create a single function that handles all backend types cleanly:

```python
def create_rag_engine(
    config: RAGConfig,
    backend_type: Literal["gguf", "openvino", "ollama", "api"],
    model_path: Optional[str] = None,  # Path to model (GGUF or OpenVINO)
    ollama_model: Optional[str] = None,
    ollama_url: Optional[str] = None,
    api_url: Optional[str] = None,
    api_model: Optional[str] = None,
    device: Optional[str] = None,
) -> RAGEngine:
    """
    Unified factory for RAGEngine.
    
    Args:
        config: RAG configuration
        backend_type: Which LLM backend to use
        model_path: Path to model file (GGUF or OpenVINO depending on backend_type)
        ...
    """
    gguf_path = model_path if backend_type == "gguf" else None
    openvino_path = model_path if backend_type == "openvino" else None
    
    return RAGEngine(
        config=config,
        model_path=openvino_path,
        gguf_path=gguf_path,
        ollama_model=ollama_model if backend_type == "ollama" else None,
        ollama_url=ollama_url if backend_type == "ollama" else None,
        api_url=api_url if backend_type == "api" else None,
        api_model=api_model if backend_type == "api" else None,
        device=device,
    )
```

### 2. Rename Widget Variable (app_gui.py)

```python
# Change:
self.model_path_entry = CTkEntry(model_frame, width=350)

# To:
self.gguf_path_entry = CTkEntry(model_frame, width=350)
```

### 3. Update All Entry Points

| Entry Point | Current | Recommended |
|-------------|---------|-------------|
| `app_gui.py` | Direct RAGEngine construction | Use unified helper |
| `api_server.py` | Inline construction + validation | Use unified helper |
| `main.py` | Passes both parameters | Use unified helper with backend_type |
| `ui/app.py` | `create_engine_from_env()` | Update factory to use unified helper |

### 4. Consider Renaming `validate_model_path()`

The function validates any model path (GGUF or OpenVINO). Consider:
- `validate_file_path()` - Generic
- Keep `validate_model_path()` - But document it handles both types

---

## Appendix: Code References

### GGUF Path Usage by File

| File | Line | Usage |
|------|------|-------|
| `app_gui.py` | 145 | `self.settings.get("gguf_path") or self.settings.get("model_path", "")` |
| `app_gui.py` | 160 | `"gguf_path": self.model_path_entry.get()` |
| `app_gui.py` | 215 | Default: `"gguf_path": ""` |
| `app_gui.py` | 231-232 | Migration: `saved["gguf_path"] = saved.pop("model_path")` |
| `app_gui.py` | 389 | `gguf_path=self.settings.get("gguf_path") or None` |
| `app_gui.py` | 409, 437-438 | Display logic using `gguf_path` |
| `api_server.py` | 281 | `os.environ.get("RAG_GGUF_PATH")` |
| `api_server.py` | 285 | `validate_model_path(gguf_path, ...)` |
| `api_server.py` | 334 | `RAGEngine(..., gguf_path=gguf_path)` |
| `main.py` | 43-44 | `--gguf-path` argument |
| `main.py` | 61-62 | `os.environ["RAG_GGUF_PATH"] = args.gguf_path` |
| `main.py` | 81 | `RAGEngine(..., gguf_path=args.gguf_path)` |
| `rag_engine.py` | 124 | Constructor param: `gguf_path: Optional[str] = None` |
| `rag_engine.py` | 127 | Storage: `self.gguf_path = gguf_path` |
| `rag_engine.py` | 145, 160, 173 | Pass to `_init_llm()`, then to `SmartLLM()` |
| `rag_engine.py` | 481, 491 | `create_engine_from_env()`: read and pass `gguf_path` |
| `llm_interface.py` | 117 | `GGUFBackend.__init__(gguf_path=...)` |
| `llm_interface.py` | 353 | `SmartLLM.__init__(gguf_path=...)` |
| `llm_interface.py` | 361-368 | Priority logic: GGUF first |
| `llm_interface.py` | 364 | `GGUFBackend(gguf_path=gguf_path, ...)` |
| `ui/app.py` | 46, 78, 90 | Settings: `"gguf_path"` key |
| `ui/app.py` | 145, 175, 298-302 | Propagate `gguf_path` to env |

### Model Path Usage by File

| File | Line | Usage |
|------|------|-------|
| `api_server.py` | 271 | `os.environ.get("RAG_MODEL_PATH")` |
| `api_server.py` | 275 | `validate_model_path(model_path, ...)` |
| `api_server.py` | 328 | `RAGEngine(..., model_path=model_path)` |
| `main.py` | 35-36 | `--model-path` argument |
| `main.py` | 53-54 | `os.environ["RAG_MODEL_PATH"] = args.model_path` |
| `main.py` | 77 | `RAGEngine(..., model_path=args.model_path)` |
| `rag_engine.py` | 118 | Constructor param: `model_path: Optional[str] = None` |
| `rag_engine.py` | 145, 154, 167 | Pass to `_init_llm()`, then to `SmartLLM()` |
| `rag_engine.py` | 485 | `create_engine_from_env()`: read and pass `model_path` |
| `llm_interface.py` | 43 | `OpenVINOLLM.__init__(model_path=...)` |
| `llm_interface.py` | 347 | `SmartLLM.__init__(model_path=...)` |
| `llm_interface.py` | 373-376 | Fallback logic: OpenVINO after GGUF |
| `llm_interface.py` | 375 | `OpenVINOLLM(model_path, device)` |

### Environment Variables

| Variable | Purpose | Used By |
|----------|---------|---------|
| `RAG_GGUF_PATH` | Path to GGUF model file | `api_server.py`, `rag_engine.py`, `main.py`, `ui/app.py` |
| `RAG_MODEL_PATH` | Path to OpenVINO model | `api_server.py`, `rag_engine.py`, `main.py` |
| `RAG_OLLAMA_URL` | Ollama server URL | All entry points |
| `RAG_API_URL` | OpenAI-compatible API URL | All entry points |

---

## Conclusion

The semantic misuse of `model_path` vs `gguf_path` has been **largely resolved** through Tasks 15.1 and 15.2:

1. ✅ **GUI Mode:** Fully fixed - passes `gguf_path` correctly
2. ✅ **API Mode:** Fully fixed - reads `RAG_GGUF_PATH` and passes to RAGEngine
3. ⚠️ **CLI Mode:** Functional but passes both parameters (minor inconsistency)
4. ✅ **Factory Function:** Working correctly
5. ✅ **RAGEngine:** Correctly accepts and stores both parameters
6. ✅ **SmartLLM:** Correctly prioritizes GGUF over OpenVINO

**For Task 15.4:** Focus on creating a unified engine construction helper that eliminates the dual-parameter pattern and provides a cleaner API for all entry points.
