# UX Fix Plan — All Blocking Issues

## Issue Inventory

### API/Developer Experience (7 issues)
| # | Issue | File | Severity |
|---|-------|------|----------|
| A1 | `POST /auth/token` uses untyped `dict` — Swagger can't show expected shape `{"api_key": "..."}` | api_server.py | Blocking |
| A2 | `GET /documents` returns untyped dict — not visible in Swagger schema | api_server.py | Blocking |
| A3 | No discovery path for initial API key — `/docs` gives no clue what value to use | api_server.py | Blocking |
| A4 | Auth disabled returns 400 — consumer sees "bad request" not "auth not enabled" | api_server.py | Blocking |
| A5 | Root `GET /` returns only `{"status": "ok"}` — no version, no links, no get-started info | api_server.py | Blocking |
| A6 | 500 errors expose internal messages — `"An error occurred processing your question"` is not actionable | api_server.py | Blocking |
| A7 | Raw Pydantic validation messages exposed directly — need consumer-friendly translation | api_server.py | Blocking |

### Error Handling (2 issues)
| # | Issue | File | Severity |
|---|-------|------|----------|
| B1 | Raw backend errors leak to GUI users verbatim (e.g. `Connection refused`) | app_gui.py:680,727 | Blocking |
| B2 | OpenAI-compatible URLError missing "Is it running?" hint that Ollama has | llm_interface.py:501 | Blocking |

### Settings/GUI (3 issues)
| # | Issue | File | Severity |
|---|-------|------|----------|
| C1 | No backend selection mechanism — users configure all fields with no way to select active backend | app_gui.py | Blocking |
| C2 | No "Test Configuration" before save — requires full restart cycle to validate | app_gui.py | Blocking |
| C3 | No active backend indicator in Settings dialog after save | app_gui.py | Blocking |

### Chat Fallback (1 issue)
| # | Issue | File | Severity |
|---|-------|------|----------|
| D1 | `chat_complete()` bypasses fallback chain — only tries `backends[0]`, never tries Ollama if GGUF is first | llm_interface.py:678-699 | Blocking |

---

## Phase 1 — Chat Fallback Fix (D1)

**Root cause:** `llm_interface.py` `answer_question()` (used by GUI) only tries `backends[0].chat_complete()` for GGUF, falls back to `generate()` only on exception. Meanwhile `generate()` (used by API) properly loops through all backends. Result: GUI silently fails if GGUF is first and broken; API properly falls back.

**Fix:** Rewrite `answer_question()` to loop through backends the same way `generate()` does:

```python
# llm_interface.py ~line 678
# Before (only tries backends[0]):
if isinstance(self.backends[0], GGUFBackend):
    try:
        return self.backends[0].chat_complete(...)
    except Exception:
        pass  # Falls back to generate()
# Then generate() is called

# After (tries all backends):
for backend in self.backends:
    try:
        if isinstance(backend, GGUFBackend):
            return backend.chat_complete(...)
        else:
            return backend.generate(prompt, config)
    except Exception:
        continue
raise RuntimeError(f"All LLM backends failed")
```

**Files:** `llm_interface.py` — `answer_question()` method (~lines 678-699)
**Risk:** Low — aligns GUI behavior with API behavior, removes dead-code path

---

## Phase 2 — API Type Safety (A1, A2, A3, A5)

### A1 — Add `LoginRequest` Pydantic model for `/auth/token`
```python
# api_server.py
class LoginRequest(BaseModel):
    api_key: str = Field(..., description="API key for authentication")
```
And update the endpoint:
```python
@router.post("/auth/token")
async def login(request: LoginRequest):
    ...
```

### A2 — Add typed `DocumentsResponse` for `/documents`
**Correction:** `engine.list_documents()` returns `List[str]` (just source filenames). Use `engine.get_all_documents()` which returns `List[Dict]` with `id` and `chunk_count`.

```python
class DocumentInfo(BaseModel):
    id: str = Field(..., description="Document source path")
    chunk_count: int = Field(..., description="Number of chunks")

class DocumentsResponse(BaseModel):
    documents: List[DocumentInfo]
    total: int
```

Update the endpoint to use `engine.get_all_documents()` and return `DocumentsResponse`:
```python
@app.get("/documents")
async def list_documents(auth: dict = Security(require_auth())):
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    docs = engine.get_all_documents()
    return DocumentsResponse(documents=docs, total=len(docs))
```

### A3 — Improve root endpoint `GET /`
Change from:
```python
{"status": "ok", "service": "Document Q&A API"}
```
To:
```python
{
    "service": "Document Q&A API",
    "version": "1.1.2",
    "docs": "/docs",
    "auth_status": "/auth/status"
}
```

### A4 — Handle auth disabled at `/auth/token` with better error
Change from returning HTTP 400 ("Authentication is disabled") to HTTP 503:
```python
if not ENABLE_AUTH:
    raise HTTPException(
        status_code=503,
        detail="Authentication is not enabled on this server. "
               "Check /auth/status for current configuration."
    )
```
HTTP 503 ("Service Unavailable") is more accurate than 400 ("Bad Request") because auth being disabled is a server configuration state, not a client request error.

**Files:** `api_server.py`
**Risk:** Low — all additive type improvements, no behavioral changes

---

## Phase 3 — API Error Handling (A6, A7)

### A6 — Custom exception handlers for 500-level errors
Add a global exception handler in FastAPI:
```python
@app.exception_handler(RuntimeError)
async def runtime_error_handler(request, exc):
    return JSONResponse(
        status_code=500,
        content={"detail": "An error occurred. Please check your input and try again."}
    )
```

### A7 — Custom validation error handler
```python
@app.exception_handler(RequestValidationError)
async def validation_handler(request, exc):
    errors = []
    for err in exc.errors():
        field = ".".join(str(loc) for loc in err["loc"])
        errors.append(f"{field}: {err['msg']}")
    return JSONResponse(
        status_code=422,
        content={"detail": "Validation failed", "errors": errors}
    )
```

**Files:** `api_server.py`
**Risk:** Low — improves error messages only

---

## Phase 4 — Error Handling UX (B1, B2)

### B1 — Wrap raw backend errors in GUI
In `app_gui.py` lines ~680 and ~727, wrap raw exceptions:
```python
# Before:
except Exception as e:
    messagebox.showerror("Error", f"Query failed: {e}")

# After:
except Exception as e:
    error_msg = str(e)
    if "Connection refused" in error_msg or "ConnectionReset" in error_msg:
        user_msg = "Could not connect to the LLM backend. Check your settings."
    elif "timeout" in error_msg.lower():
        user_msg = "The LLM backend timed out. Try again or check your settings."
    elif "401" in error_msg or "403" in error_msg:
        user_msg = "Authentication failed. Check your API credentials in Settings."
    elif "500" in error_msg or "Internal" in error_msg:
        user_msg = "The LLM backend encountered an internal error. Try again later."
    else:
        user_msg = f"Query failed: {type(e).__name__}. Check your Settings."
    messagebox.showerror("Error", user_msg)
```

### B2 — Add "Is it running?" hint to OpenAI-compatible error
```python
# llm_interface.py line ~501
# Before:
raise RuntimeError(f"Cannot connect to OpenAI-compatible endpoint at {self.base_url}")

# After:
raise RuntimeError(f"Cannot connect to OpenAI-compatible endpoint at {self.base_url}. Is the server running?")
```

**Files:** `app_gui.py`, `llm_interface.py`
**Risk:** Low — user-facing message improvements

---

## Phase 5 — Settings/GUI Backend Selection (C1, C2, C3)

### C1 — Add backend selection UI (radio group)
In the Settings dialog, replace the four separate backend entry fields with a radio group:
- Radio: "GGUF (Local Model File)" → shows GGUF Path + Browse
- Radio: "Ollama (Local Service)" → shows Ollama URL + Ollama Model
- Radio: "OpenAI-Compatible API" → shows API URL
- Radio: "Auto (try all)" → uses fallback order

Or simpler: add a label above the LLM section: *"Only one backend is needed. If multiple are configured, they are tried in priority order: GGUF → Ollama → API."*

### C2 — Add "Test Connection" button
Add a "Test" button next to the Ollama URL field (and similar for API URL) in the Settings dialog. GGUF path already has a Browse button which validates file existence.

```python
# In _create_widgets(), after ollama_url_entry:
ollama_test_frame = CTkFrame(main_frame)
ollama_test_frame.pack(fill="x", pady=(0, 10))
self.ollama_url_entry = CTkEntry(ollama_test_frame, width=350)
self.ollama_url_entry.pack(side="left", padx=(0, 5))
CTkButton(ollama_test_frame, text="Test", width=70,
          command=self._test_ollama).pack(side="left")

def _test_ollama(self):
    url = self.ollama_url_entry.get().strip()
    if not url:
        messagebox.showerror("Test Failed", "Ollama URL is empty")
        return
    try:
        from llm_interface import OllamaLLM
        llm = OllamaLLM(url=url, model=self.ollama_model_entry.get().strip() or "phi3:mini")
        # Quick health check
        info = llm.get_info()
        messagebox.showinfo("Success", f"Ollama connected: {info.get('model', 'unknown model')}")
    except Exception as e:
        messagebox.showerror("Test Failed", f"Could not connect to Ollama:\n{e}")
```

Similar button for API URL (validate URL format + do a minimal health check).

### C3 — Show active backend in main window status bar
After `App._initialize_engine()` succeeds, update the main window status bar to show the active backend:

```python
# In App._initialize_engine(), after engine initialization succeeds:
if engine.llm:
    info = engine.llm.get_info()
    backend_name = info.get("backend", "unknown")
    model_name = info.get("model", "")
    self.status_label.configure(text=f"Backend: {backend_name}" +
                                (f" ({model_name})" if model_name else ""))
```

This requires adding `get_info()` to `SmartLLM` if not already present (it delegates to `backends[0].get_info()` which all backends implement).

**Files:** `app_gui.py`
**Risk:** Medium — UI changes, but additive and non-breaking

---

## Implementation Order

1. **Phase 1 (D1)** — Chat fallback fix — CRITICAL functional bug
2. **Phase 2 (A1-A5)** — API types + root endpoint — 30 min
3. **Phase 3 (A6-A7)** — API error handlers — 20 min
4. **Phase 4 (B1-B2)** — Error wrapping — 30 min
5. **Phase 5 (C1-C3)** — Settings UI — 60 min

---

## Test Plan

| Phase | Tests to Run |
|-------|--------------|
| Phase 1 | `test_llm_interface.py` — all SmartLLM tests pass; GUI integration |
| Phase 2 | `test_api.py` — /auth and /documents tests pass |
| Phase 3 | `test_api.py` — validation error tests pass |
| Phase 4 | Manual GUI test — trigger each error type |
| Phase 5 | Manual GUI test — configure each backend |

---

## Files to Modify

| File | Phases |
|------|--------|
| `llm_interface.py` | Phase 1, 4 (B2) |
| `api_server.py` | Phase 2, 3 |
| `app_gui.py` | Phase 4 (B1), 5 |

---

## Issues NOT Addressed (Out of Scope)

- Migration silent notification (non-blocking)
- Tooltips on settings fields (non-blocking)
- Ollama model name in status bar (non-blocking)
- `model_path_entry` variable naming (maintenance)
