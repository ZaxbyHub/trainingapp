# Explorer Batch 7: Cross-Boundary — Candidate Findings
**Generated**: 2026-04-09T00:15:00Z
**Scope**: Cross-boundary contract/integration seam verification
**Explorer**: paid_explorer
**Total Findings**: 14 (0 CRITICAL, 8 HIGH, 5 MEDIUM, 2 LOW, 1 retracted)

---

## HIGH (8)

### CANDIDATE-001 — API Response Format Mismatch
```
CANDIDATE_FINDING
  id: batch7-001
  group: 1
  provisional_severity: HIGH
  confidence: HIGH
  boundary: API
  file_a: USAGE.md
  file_b: api_server.py
  line_a: 478
  line_b: 623
  title: /search endpoint returns SearchResult objects, not tuples as documented
  problem: |
    USAGE.md documents the /search endpoint response as a list of tuples:
    `for doc, meta, score in matches:` (line 478-480), implying (text, metadata_dict, similarity_float).
    But api_server.py lines 623-626 converts results to SearchResult Pydantic objects
    with schema {text, source, similarity}. The caller cannot unpack these as tuples.
  fix: |
    Update USAGE.md line 479 to show: `for result in matches: print(f"[{result.similarity:.3f}] {result.text}")`
  evidence_a: |
    USAGE.md line 478-481:
    ```
    matches = response.json()
    for doc, meta, score in matches:
        print(f"[{score:.3f}] {doc}")
    ```
  evidence_b: |
    api_server.py lines 623-626:
    ```python
    results = engine.search_documents(request.query, n_results=request.n_results)
    return [
        SearchResult(text=doc, source=meta.get("source", "Unknown"), similarity=sim)
        for doc, meta, sim in results
    ]
    ```
  disprove_attempt: |
    The SearchResult class (api_server.py:380-386) has .dict() serialization which
    produces {text, source, similarity}. A caller unpacking as `doc, meta, score` would
    get text=SearchResult, meta="Unknown", score=sim on first iteration, then fail on
    subsequent iterations. This is a real contract mismatch confirmed by examining
    the SearchResult Pydantic model and its serialization.
  ai_pattern: Contract Drift - API Response Schema Mismatch
  size: S
END
```

### CANDIDATE-002 — RAG_MIN_SIMILARITY Not Wired (API)
```
CANDIDATE_FINDING
  id: batch7-002
  group: 3
  provisional_severity: HIGH
  confidence: HIGH
  boundary: Config
  file_a: CONFIGURATION.md
  file_b: api_server.py
  line_a: 43
  line_b: 518
  title: RAG_MIN_SIMILARITY env var documented but never read by api_server.py lifespan
  problem: |
    CONFIGURATION.md line 43 documents RAG_MIN_SIMILARITY as a valid env var with default 0.3.
    RAGConfig (rag_engine.py:54) has min_similarity=0.3 as a field.
    But api_server.py lifespan (lines 518-525) constructs RAGConfig without reading any
    RAG_MIN_SIMILARITY env var, and the field is not in the constructor call.
    The documented configuration option silently has no effect when running via API.
  fix: |
    Add to api_server.py lifespan, after line 425:
    `min_similarity = float(os.environ.get("RAG_MIN_SIMILARITY", "0.3"))`
    and include it in the RAGConfig constructor at line 518.
  evidence_a: |
    CONFIGURATION.md line 43:
    | `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |
  evidence_b: |
    api_server.py lines 518-525 — RAGConfig construction does NOT include min_similarity:
    ```python
    config = RAGConfig(
        db_path=db_path,
        chunk_size=chunk_size,
        n_results=n_results,
        max_tokens=max_tokens,
        temperature=temperature,
        embedding_model="BAAI/bge-small-en-v1.5",
    )
    ```
  disprove_attempt: |
    engine_factory.py create_engine_from_env() also does NOT read RAG_MIN_SIMILARITY
    (lines 193-204). This is a systemic config cascade failure — the env var exists
    in documentation and the field exists in RAGConfig but neither factory path wires it.
  ai_pattern: Config Cascade - Documented Env Var Never Read
  size: S
END
```

### CANDIDATE-004 — GUI Missing Parameters
```
CANDIDATE_FINDING
  id: batch7-004
  group: 1
  provisional_severity: HIGH
  confidence: HIGH
  boundary: GUI
  file_a: app_gui.py
  file_b: api_server.py
  line_a: 526
  line_b: 527
  title: app_gui.py doesn't pass device/embedding_model/reranking_enabled to RAGEngine
  problem: |
    app_gui.py _initialize_engine (lines 526-540) constructs RAGConfig and RAGEngine
    directly without using the engine_factory. It passes only 6 parameters while
    api_server.py lifespan passes 11 parameters. Specifically missing:
    - device (from settings, never read)
    - embedding_model (settings dialog doesn't expose it)
    - reranking_enabled (present in settings but not passed)
    - hybrid_search (present in settings but not passed)
    - retrieval_window (present in settings but not passed)
    Users who configure these via Settings dialog find they have no effect.
  fix: |
    Either use engine_factory.create_engine_from_settings() in app_gui.py,
    or explicitly add all missing fields to the RAGConfig and RAGEngine constructor calls.
  evidence_a: |
    app_gui.py lines 526-540:
    ```python
    config = RAGConfig(
        db_path=self.settings["db_path"],
        chunk_size=self.settings["chunk_size"],
        n_results=self.settings["n_results"],
        max_tokens=self.settings["max_tokens"],
        temperature=self.settings["temperature"],
    )
    self.engine = RAGEngine(
        config=config,
        gguf_path=self.settings.get("gguf_path") or None,
        ollama_model=self.settings.get("ollama_model"),
        ollama_url=self.settings.get("ollama_url"),
        api_url=self.settings.get("api_url") or None,
    )
    ```
  evidence_b: |
    api_server.py lines 518-536 — RAGConfig and RAGEngine with all fields:
    ```python
    config = RAGConfig(
        db_path=db_path, chunk_size=chunk_size, n_results=n_results,
        max_tokens=max_tokens, temperature=temperature,
        embedding_model="BAAI/bge-small-en-v1.5",
    )
    engine = RAGEngine(
        config=config, model_path=model_path, ollama_model=ollama_model,
        ollama_url=ollama_url, api_url=api_url, api_model=api_model,
        device=device, gguf_path=gguf_path,
    )
    ```
  disprove_attempt: |
    app_gui.py settings dialog (lines 267-279) DOES collect hybrid_search,
    retrieval_window, and reranking_enabled values. But _initialize_engine
    never reads them from self.settings. This is a confirmed disconnect between
    the settings dialog and engine initialization.
  ai_pattern: Contract Drift - Missing Parameters at Factory Boundary
  size: M
END
```

### CANDIDATE-005 — Duplicate validate_url with Divergent Security
```
CANDIDATE_FINDING
  id: batch7-005
  group: 5
  provisional_severity: HIGH
  confidence: HIGH
  boundary: Import
  file_a: api_server.py
  file_b: llm_interface.py
  line_a: 32
  line_b: 36
  title: Duplicate validate_url() with divergent SSRF security policies
  problem: |
    Both api_server.py (line 32) and llm_interface.py (line 36) define validate_url().
    api_server.py's version rejects private IPs only when allow_local=False (the default),
    but DOES allow public IPs to pass through. llm_interface.py's version ALWAYS rejects
    private IPs (10.x, 172.16.x, 192.168.x, link-local) after DNS resolution.
    Additionally, api_server.py uses socket resolution while llm_interface.py uses socket.getaddrinfo.
    If any code path imports from the wrong module or mixes the two, SSRF protection
    is inconsistent. OllamaLLM and OpenAICompatibleLLM use llm_interface.validate_url (stronger)
    while api_server.py uses its own (weaker default for private IPs).
  fix: |
    Remove one of the two validate_url() implementations. Prefer keeping llm_interface.py's
    version (stronger SSRF protection) and have api_server.py import from llm_interface.
  evidence_a: |
    api_server.py:32-97 — validate_url allows public IPs:
    ```python
    def validate_url(url: str, allow_local: bool = False, ...):
        ...
        if ip_addr.is_private and not allow_local:
            raise ValueError("URL must not point to private IP addresses")
    ```
  evidence_b: |
    llm_interface.py:36-104 — validate_url always rejects private IPs:
    ```python
    def validate_url(url: str) -> None:
        ...
        for network in PRIVATE_NETWORKS:
            if ip in network:
                raise ValueError(f"URL points to private/reserved IP range: {ip}")
        # Note: no allow_local parameter; loopback is handled separately
    ```
  disprove_attempt: |
    api_server.py validate_url IS called with allow_local=True for Ollama URLs (line 439),
    but the default allow_local=False does allow non-private IPs to pass through unvalidated.
    The OllamaLLM (llm_interface.py:394) uses llm_interface.validate_url which is stricter.
    The inconsistency means API startup validation is weaker than LLM backend validation.
  ai_pattern: Phantom Export / Duplicate Symbol with Divergent Semantics
  size: M
END
```

### CANDIDATE-009 — Empty Test with Wrong Import
```
CANDIDATE_FINDING
  id: batch7-009
  group: 6
  provisional_severity: HIGH
  confidence: HIGH
  boundary: Test
  file_a: tests/test_phase1_adversarial.py
  file_b: api_server.py
  line_a: 144
  line_b: 32
  title: Empty test_validate_device_rejects_backticks imports wrong function
  problem: |
    test_phase1_adversarial.py:144-150 is an empty test (just `pass`) with a misleading name.
    The docstring says "Test that validate_device() rejects backticks" but line 146 imports
    validate_url instead: `from api_server import validate_url`. The actual device validation
    logic is in api_server.py lifespan (lines 476-492) and cannot be tested in isolation
    because it's embedded in the startup function. This test provides zero coverage.
  fix: |
    Either implement the test properly using a direct device validation function,
    or remove the empty test. The device validation logic should be extracted to
    a standalone validate_device() function for testability.
  evidence_a: |
    test_phase1_adversarial.py:144-150:
    ```python
    def test_validate_device_rejects_backticks():
        """Test that validate_device() rejects backticks and $(cmd)"""
        from api_server import validate_url  # <-- WRONG FUNCTION
        
        # This validation happens in lifespan function, so we check the logic pattern
        # Check the validation logic in api_server.py for device validation
    ```
  evidence_b: |
    api_server.py:476-492 — device validation embedded in lifespan, not testable:
    ```python
    if device:
        if device not in ("cpu", "cuda", "mps"):
            dangerous_patterns = (";", "|", "&", "&&", ...)
            if any(pattern in device for pattern in dangerous_patterns):
                logger.error("Invalid device string configuration")
                raise RuntimeError("Startup failed: Invalid configuration")
    ```
  disprove_attempt: |
    The test body is `pass` (line 151) so it always passes regardless of implementation.
    It imports validate_url but never calls it. This is a pure no-op test.
  ai_pattern: Empty Test / Wrong Function Imported
  size: S
END
```

### CANDIDATE-010 — Empty Test Pure No-Op
```
CANDIDATE_FINDING
  id: batch7-010
  group: 6
  provisional_severity: HIGH
  confidence: HIGH
  boundary: Test
  file_a: tests/test_phase1_adversarial.py
  file_b: api_server.py
  line_a: 177
  line_b: 32
  title: Empty test_validate_device_rejects_dangerous_patterns is a pure no-op
  problem: |
    test_phase1_adversarial.py:177-181 is another empty test with only `pass`.
    It claims to test device dangerous pattern detection but has no assertions,
    no calls to any validation function, and no imports. It provides zero test coverage.
  fix: |
    Remove the empty test or implement proper validation of device string patterns.
  evidence_a: |
    test_phase1_adversarial.py:177-181:
    ```python
    def test_validate_device_rejects_dangerous_patterns():
        """Test that device validation rejects dangerous patterns"""
        # This validation is in the lifespan function...
        pass
    ```
  disprove_attempt: |
    Test body is just `pass`. Always passes. Zero coverage. Confirmed.
  ai_pattern: Empty Test - No-Op Pass Statement
  size: S
END
```

### CANDIDATE-012 — Streaming API Fabricated
```
CANDIDATE_FINDING
  id: batch7-012
  group: 1
  provisional_severity: HIGH
  confidence: HIGH
  boundary: API
  file_a: USAGE.md
  file_b: api_server.py
  line_a: 788
  line_b: 590
  title: USAGE.md documents streaming /ask endpoint but no streaming implementation exists
  problem: |
    USAGE.md lines 788-809 shows a complete streaming example for the /ask endpoint
    using `stream=True` and `response.iter_lines()`. api_server.py has no streaming
    implementation for /ask — the endpoint (lines 590-612) returns a single JSON response.
    No StreamingResponse, no background generation, no SSE, no line-by-line output.
    The documentation section header "Real-time Streaming (Python)" at line 788 describes
    fabricated functionality that doesn't exist.
  fix: |
    Either implement streaming for the /ask endpoint (using FastAPI StreamingResponse
    with async generator), or remove the streaming section from USAGE.md.
  evidence_a: |
    USAGE.md lines 796-808:
    ```python
    response = requests.post(
        f"{BASE_URL}/ask",
        json={"question": "Tell me about the project"},
        stream=True
    )
    for line in response.iter_lines():
        if line:
            data = json.loads(line.decode())
            if data.get('type') == 'chunk':
                print(data['text'], end='', flush=True)
    ```
  evidence_b: |
    api_server.py:590-612 — /ask returns single JSON response, no streaming:
    ```python
    @app.post("/ask", response_model=QuestionResponse)
    async def ask_question(request: QuestionRequest):
        ...
        result = engine.query(request.question, n_results=request.n_results)
        return QuestionResponse(...)  # Single response, not streamed
    ```
  disprove_attempt: |
    grep 'stream' api_server.py returns no results. No StreamingResponse imports.
    No async generator endpoints. Confirmed: streaming is documented but unimplemented.
  ai_pattern: Streaming Fabrication - Docs Describe Non-Existent Feature
  size: L
END
```

---

## MEDIUM (5)

### CANDIDATE-003 — RAG_MIN_SIMILARITY Not Wired (CLI)
```
CANDIDATE_FINDING
  id: batch7-003
  group: 3
  provisional_severity: MEDIUM
  confidence: HIGH
  boundary: Config
  file_a: CONFIGURATION.md
  file_b: engine_factory.py
  line_a: 43
  line_b: 193
  title: RAG_MIN_SIMILARITY also absent from engine_factory.create_engine_from_env
  problem: |
    Same as batch7-002 but for engine_factory.py create_engine_from_env().
    CONFIGURATION.md documents RAG_MIN_SIMILARITY env var (line 43) but the factory
    function at rag_engine.py:502-518 and engine_factory.py:152-232 never reads it.
    Users who set RAG_MIN_SIMILARITY for CLI usage would find it has no effect.
  fix: |
    Add to engine_factory.py create_engine_from_env() around line 199:
    `min_similarity=float(os.environ.get("RAG_MIN_SIMILARITY", "0.3")),`
  evidence_a: |
    CONFIGURATION.md line 43:
    | `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |
  evidence_b: |
    engine_factory.py lines 193-204 — RAGConfig construction:
    ```python
    config = RAGConfig(
        db_path=os.environ.get("RAG_DB_PATH", "./doc_qa_db"),
        chunk_size=int(os.environ.get("RAG_CHUNK_SIZE", "512")),
        ...
    )
    # No min_similarity read
    ```
  disprove_attempt: |
    Same as batch7-002: rag_engine.py:502-518 (deprecated wrapper) also doesn't read it.
    Confirmed across all three code paths that create RAGConfig from env vars.
  ai_pattern: Config Cascade - Documented Env Var Never Read
  size: S
END
```

### CANDIDATE-006 — Conflicting chunk_size Validation Ranges
```
CANDIDATE_FINDING
  id: batch7-006
  group: 1
  provisional_severity: MEDIUM
  confidence: HIGH
  boundary: GUI
  file_a: app_gui.py
  file_b: rag_engine.py
  line_a: 229
  line_b: 48
  title: GUI settings dialog allows chunk_size values outside RAGConfig default bounds
  problem: |
    app_gui.py SettingsDialog validation (lines 229-233) accepts chunk_size 128-2048.
    But RAGConfig.__init__ (rag_engine.py:48) has chunk_size default range validation
    (implicitly uses int conversion with no bounds in __init__). The GUI's validation
    range is narrower than what might be reasonable (RAGConfig chunk_size has no explicit
    min/max bounds in the constructor). More critically, api_server.py validate_numeric
    accepts chunk_size 100-10000 (line 429), creating three different validation ranges
    for the same parameter across three entry points.
  fix: |
    Standardize chunk_size validation to a single range across all entry points.
    Recommendation: 128-4096 (or similar). Update all three locations to match.
  evidence_a: |
    app_gui.py:229-233:
    ```python
    chunk_size = int(self.chunk_size_entry.get() or 512)
    if not (128 <= chunk_size <= 2048):
        errors.append(f"Chunk Size must be between 128 and 2048")
    ```
  evidence_b: |
    rag_engine.py:48-51 — RAGConfig.__init__ signature has no explicit bounds:
    ```python
    def __init__(self, chunk_size: int = 512, ...):
    ```
    api_server.py:429 — different bounds:
    ```python
    chunk_size = validate_numeric(chunk_size, 100, 10000, "chunk_size")
    ```
  disprove_attempt: |
    RAGConfig.__init__ does no range validation at construction time. The actual
    chunk_size is only used by DocumentProcessor which accepts any positive int.
    The inconsistency is in user-facing validation across entry points, not in
    runtime behavior. Still a UX inconsistency that could confuse users.
  ai_pattern: Config Cascade - Conflicting Validation Ranges Across Entry Points
  size: S
END
```

### CANDIDATE-007 — Conflicting max_tokens Validation Ranges
```
CANDIDATE_FINDING
  id: batch7-007
  group: 1
  provisional_severity: MEDIUM
  confidence: HIGH
  boundary: GUI
  file_a: app_gui.py
  file_b: rag_engine.py
  line_a: 243
  line_b: 48
  title: GUI settings dialog allows max_tokens values outside API server bounds
  problem: |
    app_gui.py SettingsDialog (line 243) accepts max_tokens 256-4096.
    api_server.py validate_numeric (line 430) accepts max_tokens 100-4000.
    The GUI allows 4096 but the API server clamps at 4000. If a user sets 4096
    via GUI, saves, then runs queries via API server, the API will reject that value.
  fix: |
    Align max_tokens validation range to 256-4096 in api_server.py:430, matching GUI.
  evidence_a: |
    app_gui.py:243-247:
    ```python
    max_tokens = int(self.max_tokens_entry.get() or 1024)
    if not (256 <= max_tokens <= 4096):
        errors.append(f"Max Tokens must be between 256 and 4096")
    ```
  evidence_b: |
    api_server.py:430:
    ```python
    max_tokens = validate_numeric(max_tokens, 100, 4000, "max_tokens")
    ```
  disprove_attempt: |
    This only affects the GUI entry point vs API server. CLI would use engine_factory
    which has no validation at construction time either. The inconsistency means
    a user setting 4096 via GUI then restarting with API server would hit a startup
    validation error. Confirmed mismatch between lines 243 and 430.
  ai_pattern: Contract Drift - Conflicting Validation Ranges
  size: S
END
```

### CANDIDATE-013 — Inconsistent Userinfo Validation
```
CANDIDATE_FINDING
  id: batch7-013
  group: 1
  provisional_severity: MEDIUM
  confidence: HIGH
  boundary: Config
  file_a: llm_interface.py
  file_b: api_server.py
  line_a: 36
  line_b: 61
  title: llm_interface.validate_url allows username-only URLs; api_server rejects them
  problem: |
    llm_interface.py validate_url() has no check for username without password.
    api_server.py validate_url() line 61-62 explicitly rejects both username AND password:
    `if parsed.username or parsed.password: raise ValueError("URL must not contain userinfo")`.
    This means `http://user@example.com:11434` would be accepted by OllamaLLM's init
    (llm_interface.py:394 calls validate_url) but rejected by api_server.py if used there.
    The SSRF policy for userinfo is stricter in api_server.py than in llm_interface.py.
  fix: |
    Add userinfo check to llm_interface.py validate_url() matching api_server.py policy.
  evidence_a: |
    llm_interface.py:36-104 — validate_url has no username check:
    ```python
    def validate_url(url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(...)
        # No check for parsed.username here
    ```
  evidence_b: |
    api_server.py:61-62:
    ```python
    if parsed.username or parsed.password:
        raise ValueError("URL must not contain userinfo (username:password)")
    ```
  disprove_attempt: |
    OllamaLLM.__init__ at line 394 calls validate_url from llm_interface.
    A URL like `http://admin@example.com:11434` would pass llm_interface validation
    but be rejected if the same URL were used in api_server context.
    The api_server.py policy is stricter (rejects username-only).
  ai_pattern: Contract Drift - Inconsistent Input Validation Policy
  size: S
END
```

### CANDIDATE-014 — Hardcoded embedding_model
```
CANDIDATE_FINDING
  id: batch7-014
  group: 3
  provisional_severity: MEDIUM
  confidence: HIGH
  boundary: Config
  file_a: api_server.py
  file_b: engine_factory.py
  line_a: 524
  line_b: 200
  title: api_server.py hardcodes embedding_model ignoring RAG_EMBEDDING_MODEL env var
  problem: |
    api_server.py lifespan line 524 hardcodes `embedding_model="BAAI/bge-small-en-v1.5"`
    when constructing RAGConfig, ignoring any RAG_EMBEDDING_MODEL env var.
    engine_factory.py create_engine_from_env() (line 200) correctly reads
    `RAG_EMBEDDING_MODEL` from env. If a user sets RAG_EMBEDDING_MODEL before
    starting the API server, it will be silently ignored.
  fix: |
    Replace hardcoded value in api_server.py:524 with:
    `embedding_model=os.environ.get("RAG_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")`
  evidence_a: |
    api_server.py:524:
    ```python
    embedding_model="BAAI/bge-small-en-v1.5",  # hardcoded
    ```
  evidence_b: |
    engine_factory.py:200:
    ```python
    embedding_model=os.environ.get("RAG_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"),
    ```
  disprove_attempt: |
    CONFIRMED. api_server.py does not read RAG_EMBEDDING_MODEL env var.
    Users starting API server with RAG_EMBEDDING_MODEL set would get no effect.
  ai_pattern: Config Cascade - Hardcoded Value Ignores Env Var
  size: S
END
```

---

## LOW (2)

### CANDIDATE-011 — AFOMIS Legacy Name
```
CANDIDATE_FINDING
  id: batch7-011
  group: 9
  provisional_severity: LOW
  confidence: HIGH
  boundary: Config
  file_a: app_paths.py
  file_b: CONFIGURATION.md
  line_a: 15
  line_b: 26
  title: AFOMIS legacy product name persists in app_paths.py docstrings and paths
  problem: |
    app_paths.py lines 15-25 hardcode "AFOMIS Help and Support" in docstrings and
    path construction. CONFIGURATION.md line 26 also references this stale name.
    The product is now "Document Q&A Assistant" per app_gui.py:289. Settings and
    data files are still written to the old path location, which is a path hygiene issue.
  fix: |
    Update app_paths.py docstrings to reference "Document Q&A Assistant".
    Update CONFIGURATION.md line 26 to match.
  evidence_a: |
    app_paths.py lines 15-25:
    ```python
    def get_user_data_dir() -> Path:
        """
        Get the user data directory: %LOCALAPPDATA%\AFOMIS Help and Support\
        ...
        """
        user_data_dir = Path(local_app_data) / "AFOMIS Help and Support"
    ```
  evidence_b: |
    CONFIGURATION.md line 26:
    ```
    - GUI settings: `%LOCALAPPDATA%\AFOMIS Help and Support\settings.json`
    ```
  disprove_attempt: |
    The actual path construction uses "AFOMIS Help and Support" string literal.
    This is not a runtime bug (the directory works fine), but a stale branding
    issue. The functional impact is low since the directory name is cosmetic.
  ai_pattern: Stale Scaffold - Legacy Product Name in Code
  size: S
END
```

### CANDIDATE-015 — Hardcoded CORS Origins
```
CANDIDATE_FINDING
  id: batch7-015
  group: 1
  provisional_severity: LOW
  confidence: MEDIUM
  boundary: API
  file_a: api_server.py
  file_b: USAGE.md
  line_a: 554
  line_b: 554
  title: CORS allow_origins uses string literals instead of env-configurable list
  problem: |
    api_server.py lines 554-564 hardcodes CORS allow_origins with specific localhost
    variants. USAGE.md doesn't document CORS configuration. The allowed origins
    `["http://localhost", "http://127.0.0.1", "http://localhost:8080", "http://127.0.0.1:8080"]`
    should ideally be configurable for production deployments. For local development
    this is fine, but the hardcoding means users cannot test API from different origins.
  fix: |
    Make CORS origins configurable via environment variable, e.g.:
    `allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost,http://127.0.0.1,...").split(",")`
  evidence_a: |
    api_server.py:554-564:
    ```python
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost",
            "http://127.0.0.1",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
        ],
    ```
  disprove_attempt: |
    For a local-only API server, this hardcoding is acceptable. But it prevents
    testing the API from a browser at http://localhost:3000 (React dev server)
    or other common development origins. Low severity but worth noting.
  ai_pattern: Hardcoded Configuration - Non-Configurable Security Setting
  size: S
END
```

---

## Retracted (1)

### CANDIDATE-008 — RETRACTED
```
RETRACTED_FINDING
  id: batch7-008
  status: RETRACTED
  reason: |
    Upon re-examination, SmartLLM.__init__ DOES pass device to both GGUFBackend
    (line 651-658) and OpenVINOLLM (line 662-665). The device parameter flows
    correctly through the chain. Initial analysis was incorrect.
  ai_pattern: Parameter Shadowing - misread, device IS passed correctly
END
```

---

## Summary by Severity

| Severity | Count | Primary Pattern |
|----------|-------|----------------|
| CRITICAL | 0 | — |
| HIGH | 8 | Contract Drift (4), Config Cascade (2), Empty Tests (2) |
| MEDIUM | 5 | Config Cascade (3), Contract Drift (2) |
| LOW | 2 | Stale Scaffold (1), Hardcoded Config (1) |

**Total**: 14 findings across cross-boundary analysis

**Key Patterns**:
1. **Configuration Cascade Failures**: 5 findings about env vars documented but not wired (RAG_MIN_SIMILARITY, RAG_EMBEDDING_MODEL)
2. **Contract Drift**: 4 findings about API/GUI boundaries with mismatched parameters or validation ranges
3. **Security Policy Divergence**: 2 findings about validate_url() having inconsistent SSRF policies
4. **Empty Tests**: 2 findings about test_phase1_adversarial.py tests that provide zero coverage
5. **Streaming Fabrication**: 1 finding about documented streaming API that doesn't exist

**Most Critical**:
- batch7-004: GUI doesn't pass 5 key settings to RAGEngine (device, embedding_model, reranking, hybrid_search, retrieval_window)
- batch7-005: Two validate_url() functions with different security policies create SSRF bypass risk
- batch7-012: Complete streaming API section in docs but zero implementation
