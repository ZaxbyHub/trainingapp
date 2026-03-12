# Bug Ledger - Document Q&A Application

**Generated:** 2026-03-11  
**Status:** Baseline Analysis Complete  
**Total Confirmed Defects:** 6

---

## Summary

This document provides a comprehensive ledger of 6 confirmed defects identified during baseline testing of the Document Q&A Application. Each defect includes root cause analysis, reproduction steps, code evidence, and proposed fixes.

---

## DEFECT-001: GUI GGUF Wiring Mismatch

| Field | Value |
|-------|-------|
| **Defect ID** | DEFECT-001 |
| **Title** | GUI GGUF Parameter Wiring Mismatch |
| **Severity** | Critical |
| **Fix Status** | Pending |

### Description
The GUI settings dialog persists the GGUF model path under the key `gguf_path`, but when initializing the RAG engine in `_initialize_engine()`, the code passes this value to the `model_path` parameter instead of `gguf_path`. This creates a parameter naming inconsistency that may cause the GGUF model to not be properly recognized or loaded.

### Root Cause
In `app_gui.py`, the `SettingsDialog._save()` method stores the model path as `"gguf_path"` (line 160), and `_load_settings()` also uses `"gguf_path"` (line 215). However, in `_initialize_engine()` (line 389), the code passes this value to the `model_path` parameter of `RAGEngine`:

```python
self.engine = RAGEngine(
    config=config,
    model_path=self.settings.get("gguf_path") or None,  # WRONG: should be gguf_path=
    ...
)
```

While `RAGEngine` accepts both `model_path` and `gguf_path` parameters, the semantic mismatch creates confusion and may lead to incorrect routing of the GGUF path in downstream components (`SmartLLM`).

### Affected Files
| File | Line Numbers | Description |
|------|--------------|-------------|
| `app_gui.py` | 160 | Settings saved as `gguf_path` |
| `app_gui.py` | 389 | Passed to `model_path=` instead of `gguf_path=` |
| `app_gui.py` | 145 | Field population reads both keys for backward compat |

### Reproduction Steps
1. Open the GUI application
2. Navigate to Settings → LLM Settings
3. Select a GGUF model file using the Browse button
4. Save settings
5. Restart the application or reinitialize the engine
6. Observe that the GGUF model may not be properly loaded despite being configured

### Expected Behavior
The GGUF path should be consistently passed as `gguf_path` to match the parameter naming convention used throughout the codebase.

### Actual Behavior
The GGUF path is passed as `model_path`, which may cause:
- Confusion in the `SmartLLM` initialization logic
- Potential failure to load the GGUF model if `model_path` is interpreted differently
- Inconsistent parameter naming across GUI and API entry points

### Code Evidence

**app_gui.py - SettingsDialog._save() (lines 158-175):**
```python
def _save(self):
    self.result = {
        "gguf_path": self.model_path_entry.get(),  # Saved as gguf_path
        ...
    }
```

**app_gui.py - _initialize_engine() (lines 387-393):**
```python
self.engine = RAGEngine(
    config=config,
    model_path=self.settings.get("gguf_path") or None,  # Passed as model_path
    ollama_model=self.settings.get("ollama_model"),
    ollama_url=self.settings.get("ollama_url"),
    api_url=self.settings.get("api_url") or None
)
```

**rag_engine.py - RAGEngine.__init__ (lines 115-125):**
```python
def __init__(
    self,
    config: Optional[RAGConfig] = None,
    model_path: Optional[str] = None,
    ollama_model: Optional[str] = None,
    ollama_url: Optional[str] = None,
    api_url: Optional[str] = None,
    api_model: Optional[str] = None,
    device: Optional[str] = None,
    gguf_path: Optional[str] = None  # <-- Accepts gguf_path
):
```

### Proposed Fix
Change line 389 in `app_gui.py` from:
```python
model_path=self.settings.get("gguf_path") or None,
```
to:
```python
gguf_path=self.settings.get("gguf_path") or None,
```

### Regression Test
```python
def test_gui_gguf_wiring():
    """Verify GGUF path is passed correctly to RAGEngine."""
    app = DocumentQAApp()
    app.settings["gguf_path"] = "/path/to/model.gguf"
    
    with patch('app_gui.RAGEngine') as mock_engine:
        app._initialize_engine()
        call_kwargs = mock_engine.call_args.kwargs
        
        assert "gguf_path" in call_kwargs
        assert call_kwargs["gguf_path"] == "/path/to/model.gguf"
        assert "model_path" not in call_kwargs or call_kwargs["model_path"] is None
```

---

## DEFECT-002: API Missing GGUF Environment Variable Support

| Field | Value |
|-------|-------|
| **Defect ID** | DEFECT-002 |
| **Title** | API Missing GGUF Environment Variable Support |
| **Severity** | Critical |
| **Fix Status** | Pending |

### Description
The FastAPI lifespan function does not read the `RAG_GGUF_PATH` environment variable at all. The API server completely lacks support for configuring GGUF models via environment variables, while the GUI and other entry points support this feature.

### Root Cause
The API server does not read `RAG_GGUF_PATH` from environment at all. The lifespan function only reads `RAG_MODEL_PATH` and other config vars, completely omitting GGUF support. The code at line 271 reads `RAG_MODEL_PATH`, not `RAG_GGUF_PATH`:

```python
# Line 271 - Only MODEL_PATH is read, GGUF_PATH is never read
model_path = os.environ.get("RAG_MODEL_PATH")

# Lines 273-278 - Only MODEL_PATH is validated
if model_path is not None:
    try:
        model_path = validate_model_path(model_path, Path("."))
    except ValueError as e:
        logger.error("Invalid model path configuration")
        raise HTTPException(status_code=500, detail="Invalid configuration")

# Lines 316-324 - RAGEngine constructed without gguf_path
engine = RAGEngine(
    config=config,
    model_path=model_path,
    ollama_model=ollama_model,
    ollama_url=ollama_url,
    api_url=api_url,
    api_model=api_model,
    device=device
    # MISSING: gguf_path parameter entirely
)
```

Note that `rag_engine.py` has `create_engine_from_env()` (lines 481-492) that properly reads `RAG_GGUF_PATH`. The API server could potentially use this factory function instead of manually constructing RAGEngine.

### Affected Files
| File | Line Numbers | Description |
|------|--------------|-------------|
| `api_server.py` | 271 | Only RAG_MODEL_PATH is read, RAG_GGUF_PATH is missing |
| `api_server.py` | 273-278 | No validation for GGUF path |
| `api_server.py` | 316-324 | RAGEngine constructed without gguf_path parameter |

### Reproduction Steps
1. Set the environment variable: `export RAG_GGUF_PATH=/path/to/model.gguf`
2. Start the API server: `python api_server.py`
3. Check the engine stats: `curl http://localhost:8080/stats`
4. Observe that the GGUF model is not loaded (grep for "gguf" in api_server.py returns no matches)
5. The server starts without any attempt to read RAG_GGUF_PATH

### Expected Behavior
The API server should read `RAG_GGUF_PATH` from environment variables, validate the path, and pass it as `gguf_path` to the `RAGEngine` constructor, matching the behavior of other entry points.

### Actual Behavior
The `RAG_GGUF_PATH` environment variable is completely ignored. The API server has no code to read or use this variable, preventing GGUF model configuration via environment in the API server.

### Code Evidence

**api_server.py - Lifespan function (lines 270-278):**
```python
# Validate model paths
model_path = os.environ.get("RAG_MODEL_PATH")  # ONLY MODEL_PATH

if model_path is not None:
    try:
        model_path = validate_model_path(model_path, Path("."))
    except ValueError as e:
        logger.error("Invalid model path configuration")
        raise HTTPException(status_code=500, detail="Invalid configuration")

# NOTE: No RAG_GGUF_PATH reading or validation exists
```

**api_server.py - RAGEngine construction (lines 316-324):**
```python
engine = RAGEngine(
    config=config,
    model_path=model_path,  # model_path only
    ollama_model=ollama_model,
    ollama_url=ollama_url,
    api_url=api_url,
    api_model=api_model,
    device=device
    # MISSING: gguf_path parameter - not passed at all
)
```

**rag_engine.py - Factory function with proper GGUF support (lines 481-492):**
```python
@staticmethod
def create_engine_from_env(config: Optional[RAGConfig] = None) -> "RAGEngine":
    """Create RAGEngine from environment variables."""
    import os

    return RAGEngine(
        config=config,
        model_path=os.environ.get("RAG_MODEL_PATH"),
        ollama_model=os.environ.get("RAG_OLLAMA_MODEL"),
        ollama_url=os.environ.get("RAG_OLLAMA_URL"),
        api_url=os.environ.get("RAG_API_URL"),
        api_model=os.environ.get("RAG_API_MODEL"),
        device=os.environ.get("RAG_DEVICE"),
        gguf_path=os.environ.get("RAG_GGUF_PATH"),  # Properly reads GGUF path
    )
```

### Proposed Fix
Add code to read `RAG_GGUF_PATH` from environment, validate it, and pass it to RAGEngine:

**Option 1: Add GGUF support to existing lifespan function**
```python
# After line 278, add:
gguf_path = os.environ.get("RAG_GGUF_PATH")
if gguf_path is not None:
    try:
        gguf_path = validate_model_path(gguf_path, Path("."))
    except ValueError as e:
        logger.error("Invalid GGUF path configuration: %s", e)
        raise HTTPException(status_code=500, detail="Invalid GGUF configuration")

# Update RAGEngine constructor (lines 316-324):
engine = RAGEngine(
    config=config,
    model_path=model_path,
    ollama_model=ollama_model,
    ollama_url=ollama_url,
    api_url=api_url,
    api_model=api_model,
    device=device,
    gguf_path=gguf_path  # ADD THIS LINE
)
```

**Option 2: Use the factory function (recommended)**
Replace manual RAGEngine construction with the existing factory:
```python
# Instead of manual construction, use:
engine = RAGEngine.create_engine_from_env(config)
```

### Regression Test
```python
def test_api_gguf_env_var_wiring():
    """Verify RAG_GGUF_PATH environment variable is read and passed to RAGEngine."""
    os.environ["RAG_GGUF_PATH"] = "/path/to/model.gguf"
    
    with patch('api_server.RAGEngine') as mock_engine:
        # Simulate lifespan startup
        async with lifespan(app):
            pass
        
        call_kwargs = mock_engine.call_args.kwargs
        assert "gguf_path" in call_kwargs
        assert call_kwargs["gguf_path"] == "/path/to/model.gguf"

def test_api_gguf_path_validation():
    """Verify RAG_GGUF_PATH is validated before being passed to RAGEngine."""
    os.environ["RAG_GGUF_PATH"] = "/invalid/path/model.gguf"
    
    with pytest.raises(HTTPException) as exc_info:
        async with lifespan(app):
            pass
    
    assert exc_info.value.status_code == 500
    assert "Invalid GGUF configuration" in exc_info.value.detail
```

---

## DEFECT-003: URL Validation Over-Hardening

| Field | Value |
|-------|-------|
| **Defect ID** | DEFECT-003 |
| **Title** | URL Validation Over-Hardening |
| **Severity** | High |
| **Fix Status** | Pending |

### Description
The `validate_url()` function in `api_server.py` is overly restrictive, rejecting localhost addresses, private IP addresses, and non-standard ports. This breaks legitimate use cases such as local Ollama instances running at `http://localhost:11434` or local OpenAI-compatible endpoints.

### Root Cause
The `validate_url()` function (lines 27-74) implements several security checks that are too aggressive for the intended use cases:

1. **Localhost rejection (lines 57-59):**
   ```python
   if parsed.hostname in ('localhost', '127.0.0.1', '::1'):
       raise ValueError("URL must not point to localhost")
   ```

2. **Private IP rejection (lines 62-68):**
   ```python
   ip_addr = ipaddress.ip_address(parsed.hostname)
   if ip_addr.is_private:
       raise ValueError("URL must not point to private IP addresses")
   ```

3. **Non-standard port rejection (lines 70-72):**
   ```python
   if parsed.port and parsed.port not in (80, 443):
       raise ValueError("URL must use standard ports (80 or 443)")
   ```

These restrictions prevent the API server from connecting to:
- Local Ollama instances (`http://localhost:11434`)
- Private network LLM servers (`http://192.168.1.100:8080`)
- Dockerized services (`http://172.17.0.2:8000`)

### Affected Files
| File | Line Numbers | Description |
|------|--------------|-------------|
| `api_server.py` | 27-74 | validate_url() function |
| `api_server.py` | 256-268 | Ollama URL validation |
| `api_server.py` | 263-268 | API URL validation |

### Reproduction Steps
1. Set environment variable for local Ollama:
   ```bash
   export RAG_OLLAMA_URL=http://localhost:11434
   ```
2. Start the API server: `python api_server.py`
3. The server will fail to start with error: "Invalid configuration"
4. Logs will show: "URL must not point to localhost" or "URL must use standard ports"

Alternatively, test the validation directly:
```python
from api_server import validate_url
validate_url("http://localhost:11434")  # Raises ValueError
validate_url("http://192.168.1.100:8080")  # Raises ValueError
validate_url("http://10.0.0.5:11434")  # Raises ValueError
```

### Expected Behavior
The URL validation should allow:
- Localhost addresses for local development and testing
- Private IP addresses for on-premise deployments
- Non-standard ports (commonly used by Ollama, localAI, etc.)

Security should be enforced through other means (TLS, authentication) rather than blanket IP/port restrictions.

### Actual Behavior
The validation rejects all localhost, private IP, and non-standard port URLs, making it impossible to use local LLM services.

### Code Evidence

**api_server.py - validate_url() (lines 27-74):**
```python
def validate_url(url: str) -> str:
    """Validate URL to prevent injection attacks."""
    if not url:
        raise ValueError("URL cannot be empty")
    
    parsed = urlparse(url)
    if not parsed.scheme:
        raise ValueError("URL must have a scheme (http/https)")
    
    if parsed.scheme not in ('http', 'https'):
        raise ValueError("URL scheme must be http or https")
    
    # Reject userinfo in URL (user:pass@host)
    if parsed.username or parsed.password:
        raise ValueError("URL must not contain userinfo")
    
    # Reject localhost and private IP addresses - TOO RESTRICTIVE
    if parsed.hostname:
        if parsed.hostname in ('localhost', '127.0.0.1', '::1'):
            raise ValueError("URL must not point to localhost")  # BREAKS LOCAL OLLAMA
        
        try:
            ip_addr = ipaddress.ip_address(parsed.hostname)
            if ip_addr.is_private:
                raise ValueError("URL must not point to private IP addresses")  # BREAKS PRIVATE SERVERS
        except ValueError:
            pass
    
    # Reject non-standard ports - TOO RESTRICTIVE
    if parsed.port and parsed.port not in (80, 443):
        raise ValueError("URL must use standard ports (80 or 443)")  # BREAKS OLLAMA DEFAULT PORT
    
    return url
```

### Proposed Fix
Remove or relax the localhost, private IP, and port restrictions. Instead, focus on preventing actual injection attacks:

```python
def validate_url(url: str, allow_local: bool = True) -> str:
    """Validate URL to prevent injection attacks."""
    if not url:
        raise ValueError("URL cannot be empty")
    
    parsed = urlparse(url)
    if not parsed.scheme:
        raise ValueError("URL must have a scheme (http/https)")
    
    if parsed.scheme not in ('http', 'https'):
        raise ValueError("URL scheme must be http or https")
    
    # Reject userinfo in URL (user:pass@host)
    if parsed.username or parsed.password:
        raise ValueError("URL must not contain userinfo")
    
    # Only restrict localhost/private IPs if explicitly disabled
    if not allow_local:
        if parsed.hostname:
            if parsed.hostname in ('localhost', '127.0.0.1', '::1'):
                raise ValueError("URL must not point to localhost")
            
            try:
                ip_addr = ipaddress.ip_address(parsed.hostname)
                if ip_addr.is_private:
                    raise ValueError("URL must not point to private IP addresses")
            except ValueError:
                pass
    
    # Remove port restrictions - common LLM ports (11434 for Ollama, 8000, 8080, etc.)
    # Port validation removed - let the connection attempt fail naturally if port is invalid
    
    return url
```

Alternatively, add an environment variable to control strictness:
```python
allow_local = os.environ.get("RAG_ALLOW_LOCAL_URLS", "true").lower() == "true"
```

### Regression Test
```python
def test_url_validation_allows_local():
    """Verify URL validation allows localhost and common LLM ports."""
    # Should NOT raise
    assert validate_url("http://localhost:11434") == "http://localhost:11434"
    assert validate_url("http://127.0.0.1:11434") == "http://127.0.0.1:11434"
    assert validate_url("http://192.168.1.100:8080") == "http://192.168.1.100:8080"
    assert validate_url("http://10.0.0.5:8000") == "http://10.0.0.5:8000"
    
    # Should still reject malicious URLs
    with pytest.raises(ValueError, match="scheme"):
        validate_url("ftp://localhost:11434")
    with pytest.raises(ValueError, match="userinfo"):
        validate_url("http://user:pass@localhost:11434")
```

---

## DEFECT-004: Upload Source Identity Loss

| Field | Value |
|-------|-------|
| **Defect ID** | DEFECT-004 |
| **Title** | Upload Source Identity Loss in File Ingestion |
| **Severity** | Medium |
| **Fix Status** | Pending |

### Description
When a file is uploaded via the `/ingest/file` API endpoint, it is written to a temporary file with a random name (e.g., `/tmp/tmpabc123.pdf`). The `DocumentProcessor` then uses this temporary filename as the source identifier instead of the original filename. This causes:
- Loss of original document identity in the vector store
- Meaningless source names in search results (e.g., "tmpabc123" instead of "contract.pdf")
- Potential collisions if temp names overlap
- User confusion when viewing source attributions

### Root Cause
In `api_server.py`, the `/ingest/file` endpoint (lines 438-466) creates a temporary file using `NamedTemporaryFile`, which generates a random filename:

```python
with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
    content = await file.read()
    tmp.write(content)
    tmp_path = tmp.name  # e.g., "/tmp/tmpabc123.pdf"

stats = engine.ingest_file(tmp_path)  # Passes temp path
```

The `DocumentProcessor.process_file()` method (line 212-228 in `document_processor.py`) extracts the source from the filepath using `Path(filepath).name`, which gets the temporary filename instead of the original.

### Affected Files
| File | Line Numbers | Description |
|------|--------------|-------------|
| `api_server.py` | 438-466 | /ingest/file endpoint |
| `api_server.py` | 450-455 | Temporary file creation loses original name |
| `document_processor.py` | 212-228 | process_file() uses filepath.basename as source |
| `rag_engine.py` | 238-258 | ingest_file() passes path directly to processor |

### Reproduction Steps
1. Upload a file via the API:
   ```bash
   curl -X POST -F "file=@/path/to/important_contract.pdf" http://localhost:8080/ingest/file
   ```
2. Query the document:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"question": "What is the contract about?"}' \
     http://localhost:8080/ask
   ```
3. Observe the sources in the response - they will show random temp names like "tmpabc123.pdf" instead of "important_contract.pdf"

### Expected Behavior
The original filename should be preserved as the source identifier throughout the ingestion process.

### Actual Behavior
The temporary filename is used as the source, causing:
- Loss of document identity
- Meaningless source names in responses
- Poor user experience when tracing answers back to documents

### Code Evidence

**api_server.py - /ingest/file endpoint (lines 438-466):**
```python
@app.post("/ingest/file")
async def ingest_file(file: UploadFile = File(...)):
    """Ingest a single uploaded file."""
    if not engine:
        raise HTTPException(status_code=503, detail="Engine not initialized")
    
    ext = Path(file.filename).suffix.lower()  # Original filename available here
    ...
    
    import tempfile
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name  # Random temp name: /tmp/tmpabc123.pdf
        
        stats = engine.ingest_file(tmp_path)  # Loses original filename!
        
        os.unlink(tmp_path)
        ...
```

**document_processor.py - process_file() (lines 212-228):**
```python
def process_file(self, filepath: str) -> List[DocumentChunk]:
    """Process a single file and return chunks."""
    filepath = str(filepath)
    filename = Path(filepath).name  # Gets "tmpabc123.pdf" not original name
    
    try:
        text = self.extract_document(filepath)
        ...
        chunks = self.chunk_text(text, filename)  # Uses temp name as source
        ...
```

### Proposed Fix
Modify the `/ingest/file` endpoint to pass the original filename to `ingest_file()`, and update the `ingest_file()` method in `RAGEngine` to accept an optional `source_name` parameter:

**Option 1: Add source_name parameter (preferred)**
```python
# api_server.py
@app.post("/ingest/file")
async def ingest_file(file: UploadFile = File(...)):
    ...
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    
    # Pass original filename as source_name
    stats = engine.ingest_file(tmp_path, source_name=file.filename)
    ...

# rag_engine.py
def ingest_file(self, filepath: str, source_name: Optional[str] = None) -> Dict[str, Any]:
    ...
    # Override the source in chunks before adding to vector store
    if source_name:
        for chunk in chunks:
            chunk.source = source_name
    ...
```

**Option 2: Pass source through metadata**
Modify `process_file()` to accept an optional `source_override` parameter.

### Regression Test
```python
def test_upload_preserves_filename():
    """Verify uploaded files retain their original filename as source."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    # Create a test file
    test_content = b"This is a test document about AI."
    
    response = client.post(
        "/ingest/file",
        files={"file": ("my_document.pdf", test_content, "application/pdf")}
    )
    
    assert response.status_code == 200
    
    # Query and check sources
    response = client.post("/ask", json={"question": "What is this about?"})
    data = response.json()
    
    assert "my_document.pdf" in data["sources"]
    # Ensure no temp names appear
    assert not any("tmp" in s for s in data["sources"])
```

---

## DEFECT-005: GUI/API Upload Surface Mismatch

| Field | Value |
|-------|-------|
| **Defect ID** | DEFECT-005 |
| **Title** | GUI/API Upload Surface Mismatch |
| **Severity** | Medium |
| **Fix Status** | Pending |

### Description
The GUI and API expose different document ingestion capabilities:
- **GUI**: Uses `askdirectory()` - only supports folder-based ingestion
- **API**: Exposes `/ingest` (folder) AND `/ingest/file` (single file)

This creates a feature mismatch where API users can upload individual files but GUI users cannot, leading to inconsistent user experience and potential confusion.

### Root Cause
In `app_gui.py`, the `_ingest_documents()` method (lines 454-494) only uses `filedialog.askdirectory()`:

```python
def _ingest_documents(self):
    """Open directory picker and ingest documents."""
    directory = filedialog.askdirectory(title="Select Document Folder")
    if not directory:
        return
    ...
    stats = self.engine.ingest_directory(directory, callback)
```

There is no option for users to select and upload individual files through the GUI, even though:
1. The API supports it via `/ingest/file`
2. The `RAGEngine` supports it via `ingest_file()`
3. tkinter provides `askopenfilename()` for single file selection

### Affected Files
| File | Line Numbers | Description |
|------|--------------|-------------|
| `app_gui.py` | 454-494 | _ingest_documents() uses askdirectory() only |
| `api_server.py` | 415-436 | /ingest supports directory |
| `api_server.py` | 438-466 | /ingest/file supports single file |

### Reproduction Steps
1. Open the GUI application
2. Click the "Ingest" button
3. Observe that only a folder picker dialog appears
4. Try to select a single PDF file - cannot be done directly
5. Compare to API where `curl -F "file=@doc.pdf" /ingest/file` works fine

### Expected Behavior
The GUI should provide both options:
- "Ingest Folder" - existing directory-based ingestion
- "Ingest File" - new single file ingestion (matching API capability)

### Actual Behavior
GUI only supports folder ingestion, forcing users to:
- Create temporary folders for single files
- Use the API directly for single file uploads
- Work around the limitation with unnecessary steps

### Code Evidence

**app_gui.py - _ingest_documents() (lines 454-494):**
```python
def _ingest_documents(self):
    """Open directory picker and ingest documents."""
    directory = filedialog.askdirectory(title="Select Document Folder")
    if not directory:
        return
    
    if not self.engine:
        messagebox.showerror("Error", "Engine not initialized")
        return
    
    self.ask_button.configure(state="disabled")
    self.question_entry.configure(state="disabled")
    
    def ingest():
        try:
            def callback(msg, progress):
                self.message_queue.put(("status", msg))
                self.message_queue.put(("progress", progress))
            
            stats = self.engine.ingest_directory(directory, callback)  # Directory only!
            ...
```

**api_server.py - Both endpoints available (lines 415-466):**
```python
@app.post("/ingest", response_model=IngestResponse)
async def ingest_directory(request: IngestRequest):
    """Ingest documents from a directory."""
    ...

@app.post("/ingest/file")
async def ingest_file(file: UploadFile = File(...)):
    """Ingest a single uploaded file."""
    ...
```

### Proposed Fix
Add a file ingestion option to the GUI. Two approaches:

**Option 1: Split button with dropdown (preferred UX)**
```python
def _create_widgets(self):
    ...
    # Replace single Ingest button with split button or menu
    ingest_menu = CTkOptionMenu(
        top_bar,
        values=["Ingest Folder", "Ingest File"],
        command=self._handle_ingest_choice
    )
    ingest_menu.pack(side="right", padx=5)

def _handle_ingest_choice(self, choice):
    if choice == "Ingest Folder":
        self._ingest_documents_folder()
    else:
        self._ingest_documents_file()

def _ingest_documents_file(self):
    """Open file picker and ingest single file."""
    filepath = filedialog.askopenfilename(
        title="Select Document File",
        filetypes=[
            ("Documents", "*.pdf *.docx *.doc *.pptx *.ppt *.txt *.md"),
            ("PDF files", "*.pdf"),
            ("Word files", "*.docx *.doc"),
            ("PowerPoint files", "*.pptx *.ppt"),
            ("Text files", "*.txt *.md"),
            ("All files", "*.*")
        ]
    )
    if not filepath:
        return
    
    def ingest():
        try:
            stats = self.engine.ingest_file(filepath)
            ...
```

**Option 2: Add separate button**
Add a second button next to "Ingest" labeled "Ingest File".

### Regression Test
```python
def test_gui_file_ingestion():
    """Verify GUI supports single file ingestion."""
    from unittest.mock import patch, MagicMock
    
    app = DocumentQAApp()
    app.engine = MagicMock()
    app.engine.ingest_file.return_value = {
        "success": True,
        "chunks_added": 5
    }
    
    # Mock the file dialog to return a test file
    with patch('app_gui.filedialog.askopenfilename', return_value="/path/to/doc.pdf"):
        with patch.object(app, '_add_message') as mock_msg:
            app._ingest_documents_file()
            
            # Verify ingest_file was called with the selected path
            app.engine.ingest_file.assert_called_once_with("/path/to/doc.pdf")
```

---

## DEFECT-006: Build Path Drift

| Field | Value |
|-------|-------|
| **Defect ID** | DEFECT-006 |
| **Title** | Build Path Drift - PyInstaller Spec References Obsolete Entry Point |
| **Severity** | High |
| **Fix Status** | Pending |

### Description
The PyInstaller specification file (`AFOMIS.spec`) references `ui/app.py` as the entry point (line 15), but the main/actual entry point for the GUI application appears to be `app_gui.py` at the project root. Additionally, the working codebase is split between top-level files (`app_gui.py`, `main.py`, `api_server.py`) and the `ui/` package (`ui/app.py`).

This causes:
- Build produces non-functional executable (wrong entry point)
- Confusion about which file is the "real" entry point
- Maintenance overhead from duplicate/diverging code paths
- Risk of building from stale code in `ui/app.py`

### Root Cause
The `AFOMIS.spec` file at line 15 specifies:
```python
a = Analysis(
    ['ui/app.py'],  # Entry point
    ...
)
```

However:
1. The `app_gui.py` at project root contains a complete, standalone GUI implementation with `DocumentQAApp` class
2. The `ui/app.py` contains a different implementation with `DocumentQApp` and `AppController` classes
3. Both files appear to be maintained, but `app_gui.py` is more complete and referenced in other contexts
4. The build spec hasn't been updated to reflect the current entry point

### Affected Files
| File | Line Numbers | Description |
|------|--------------|-------------|
| `AFOMIS.spec` | 15 | Entry point references `ui/app.py` |
| `AFOMIS.spec` | 17-23 | Data files may need updating |
| `app_gui.py` | 1-545 | Top-level GUI (appears to be current) |
| `ui/app.py` | 1-603 | Alternative GUI implementation |
| `main.py` | 1-4718 | Another entry point |

### Reproduction Steps
1. Examine the build spec:
   ```bash
   cat AFOMIS.spec | grep "Analysis"
   ```
   Shows: `['ui/app.py']` as entry point

2. Compare the two entry points:
   ```bash
   head -20 app_gui.py  # Shows DocumentQAApp class
   head -20 ui/app.py   # Shows DocumentQApp class
   ```

3. Build the application:
   ```bash
   pyinstaller AFOMIS.spec --clean
   ```

4. Run the built executable - may exhibit different behavior than running `python app_gui.py` directly

### Expected Behavior
The build spec should reference the correct, current entry point (`app_gui.py` or `main.py` depending on intended use).

### Actual Behavior
The build spec references `ui/app.py`, which may be:
- Out of sync with recent changes
- A legacy/deprecated entry point
- Missing features present in `app_gui.py`

### Code Evidence

**AFOMIS.spec - Entry point configuration (line 15):**
```python
# Analysis configuration
a = Analysis(
    ['ui/app.py'],  # Entry point - IS THIS CORRECT?
    pathex=[os.getcwd()],
    binaries=collect_dynamic_libs('llama_cpp'),
    datas=[
        ('bundled_models', 'bundled_models'),
        ('seed_data', 'seed_data'),
        ('ui', 'ui'),                          # UI package included
        ('models', 'models'),
    ],
    ...
)
```

**app_gui.py - Standalone GUI entry point (lines 178-545):**
```python
class DocumentQAApp(CTk):
    """Main application window."""
    ...

def main():
    """Main entry point."""
    if not GUI_AVAILABLE:
        print("GUI not available. Install customtkinter:")
        print("  pip install customtkinter")
        sys.exit(1)
    
    app = DocumentQAApp()
    app.mainloop()

if __name__ == "__main__":
    main()
```

**ui/app.py - Alternative GUI entry point (lines 554-603):**
```python
class DocumentQApp:
    """Main application class."""
    
    def __init__(self):
        """Initialize the application."""
        ...

def main():
    """Main entry point."""
    app = DocumentQApp()
    app.run()

if __name__ == "__main__":
    main()
```

### Proposed Fix
**Option 1: Update spec to use app_gui.py (if that's the current entry point)**
```python
a = Analysis(
    ['app_gui.py'],  # Updated entry point
    pathex=[os.getcwd()],
    binaries=collect_dynamic_libs('llama_cpp'),
    datas=[
        ('bundled_models', 'bundled_models'),
        ('seed_data', 'seed_data'),
        ('ui', 'ui'),  # Still include ui package if used
        ('models', 'models'),
        ('app_paths.py', '.'),  # May need additional top-level modules
    ],
    ...
)
```

**Option 2: Consolidate to single entry point**
- Choose one entry point (`app_gui.py` or `ui/app.py`)
- Remove or deprecate the other
- Update all documentation and build scripts

**Option 3: Separate specs for different entry points**
- Create `AFOMIS_GUI.spec` for `app_gui.py`
- Create `AFOMIS_API.spec` for `api_server.py`
- Update build scripts accordingly

### Regression Test
```python
def test_build_spec_entry_point():
    """Verify build spec references correct entry point."""
    import ast
    
    with open('AFOMIS.spec', 'r') as f:
        spec_content = f.read()
    
    # Check that entry point file exists
    if "['app_gui.py']" in spec_content:
        assert os.path.exists('app_gui.py'), "Entry point app_gui.py must exist"
    elif "['ui/app.py']" in spec_content:
        assert os.path.exists('ui/app.py'), "Entry point ui/app.py must exist"
    else:
        raise AssertionError("Build spec must reference a valid entry point")
    
    # Verify the entry point has main() function
    entry_point = 'app_gui.py' if "['app_gui.py']" in spec_content else 'ui/app.py'
    with open(entry_point, 'r') as f:
        tree = ast.parse(f.read())
    
    has_main = any(
        isinstance(node, ast.FunctionDef) and node.name == 'main'
        for node in ast.walk(tree)
    )
    assert has_main, f"{entry_point} must have a main() function"
```

---

## Appendix: Defect Priority Matrix

| Defect ID | Severity | Effort | Risk if Not Fixed | Recommended Priority |
|-----------|----------|--------|-------------------|---------------------|
| DEFECT-001 | Critical | Low | GGUF model won't load in GUI | P1 |
| DEFECT-002 | Critical | Low | GGUF model won't load in API | P1 |
| DEFECT-003 | High | Low | Local LLM usage impossible | P1 |
| DEFECT-004 | Medium | Medium | Poor UX, lost document identity | P2 |
| DEFECT-005 | Medium | Low | Feature gap GUI vs API | P3 |
| DEFECT-006 | High | Medium | Build produces broken executable | P1 |

---

## Appendix: Fix Verification Checklist

Before marking each defect as resolved, verify:

- [ ] **DEFECT-001**: GUI passes GGUF path as `gguf_path=` parameter
- [ ] **DEFECT-002**: API lifespan passes `gguf_path=` to RAGEngine
- [ ] **DEFECT-003**: Localhost URLs (http://localhost:11434) are accepted
- [ ] **DEFECT-004**: Uploaded files show original filename in sources
- [ ] **DEFECT-005**: GUI has option to ingest single files
- [ ] **DEFECT-006**: Build spec references correct entry point and builds successfully

---

*End of Bug Ledger*
