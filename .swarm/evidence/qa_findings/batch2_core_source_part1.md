# Explorer Batch 2: Core Source Part 1 — Candidate Findings
**Generated**: 2026-04-08T23:05:00Z
**Scope**: 8 files (main.py, api_server.py, rag_engine.py, document_processor.py, vector_store.py, llm_interface.py, app_gui.py, reranking.py)
**Explorer**: paid_explorer
**Total Findings**: 20 (1 CRITICAL, 5 HIGH, 7 MEDIUM, 7 LOW)

---

## CRITICAL (1)

### F-001 — Command Injection via subprocess.Popen cwd
```
CANDIDATE_FINDING
  id: batch2-001
  group: 2
  provisional_severity: CRITICAL
  confidence: HIGH
  file: llm_interface.py
  line: 195-216, 224
  title: GGUF Backend Command Injection via cwd manipulation
  problem: |
    subprocess.Popen uses cwd=str(self.model_path.parent) which changes working directory
    to the folder containing the model. If that folder contains malicious executables
    named 'python', 'python.exe', or 'pip', they will be invoked. Model path passed
    unquoted to subprocess without escaping.
  fix: |
    Use absolute path to Python interpreter (sys.executable).
    Validate model_path.parent doesn't contain executables.
    Use subprocess with explicit env PATH pinning.
  evidence: |
    cmd = ["python", "-m", "llama_cpp.server", "--gguf-path", str(self.model_path), ...]
    self._process = subprocess.Popen(cmd, ..., cwd=str(self.model_path.parent))
    The cwd change introduces PATH precedence attack surface.
  disprove_attempt: |
    Checked if model_path validation exists in callers — basic path traversal check exists
    but no executable validation in model directory. No PATH pinning in subprocess.
    UNDISPROVED — attack surface exists.
  ai_pattern: wrapper-delegates-to-subprocess-without-sandboxing
  size: M
END
```

---

## HIGH (5)

### F-002 — No Authentication on API Endpoints
```
CANDIDATE_FINDING
  id: batch2-002
  group: 2
  provisional_severity: HIGH
  confidence: HIGH
  file: api_server.py
  line: 590-733
  title: API Server Has Zero Authentication/Authorization
  problem: |
    All endpoints (/ask, /ingest, /ingest/file, /search, /documents, /clear) are completely
    unauthenticated. Server binds to 0.0.0.0 by default, making APIs accessible to any
    machine on the network. No API key, token, or session mechanism.
  fix: |
    Add API key middleware (X-API-Key header validation).
    Or add OAuth2/JWT bearer token support.
    Or bind to 127.0.0.1 only by default with opt-in for 0.0.0.0.
  evidence: |
    @app.post("/ask") — no auth decorator
    @app.post("/ingest") — no auth decorator
    All endpoints lack authentication checks.
  disprove_attempt: |
    Checked for auth middleware in file — none found.
    Checked for API key validation in request handlers — none found.
    CORS is restricted to localhost but doesn't protect direct API calls.
    UNDISPROVED — no auth exists.
  ai_pattern: fastapi-scaffold-without-security-middleware
  size: L
END
```

### F-003 — Arbitrary Directory Ingestion
```
CANDIDATE_FINDING
  id: batch2-003
  group: 2
  provisional_severity: HIGH
  confidence: HIGH
  file: api_server.py
  line: 632-656
  title: Ingest Endpoint Allows Reading Arbitrary Directories
  problem: |
    validate_directory uses base_dir = Path(".") (server CWD). Relative paths like
    ../../../Windows/System32 can resolve outside CWD. Containment check may fail
    if server CWD is deep. No file size limits on directory ingestion (only single
    file uploads have 50MB limit).
  fix: |
    Use absolute base_dir from config (not CWD).
    Add path canonicalization and strict containment check.
    Add file size limits for directory ingestion.
    Add MIME type verification beyond suffix.
  evidence: |
    validated_dir = validate_directory(request.directory)  # base_dir defaults to Path(".")
    stats = engine.ingest_directory(validated_dir)
    API file upload has 50MB limit but directory ingestion has no limits.
  disprove_attempt: |
    validate_directory does have containment check but uses resolve(strict=False)
    which can traverse symlinks. base_dir being CWD is fragile.
    UNDISPROVED — path traversal risk exists.
  ai_pattern: path-validation-without-canonicalization
  size: M
END
```

### F-004 — HTTP Requests Lack Timeout
```
CANDIDATE_FINDING
  id: batch2-004
  group: 7
  provisional_severity: HIGH
  confidence: HIGH
  file: llm_interface.py
  line: 451, 558
  title: Ollama/OpenAI HTTP Requests Lack Timeout
  problem: |
    Ollama generate has timeout=30 but OpenAI-compatible path at line 558 calls
    urlopen without timeout argument. Non-responsive API endpoint causes FastAPI
    worker thread to hang indefinitely. GGUF subprocess also has no timeout.
  fix: |
    Add timeout=30 to OpenAI-compatible urlopen call.
    Add timeout to GGUF subprocess communication.
  evidence: |
    with urllib.request.urlopen(req, timeout=30) as response:  # Ollama — HAS timeout
    with urllib.request.urlopen(req) as response:              # OpenAI — NO timeout
  disprove_attempt: |
    Confirmed: OpenAI path lacks timeout parameter.
    Confirmed: GGUF subprocess has no timeout on communicate().
    UNDISPROVED — hang risk exists.
  ai_pattern: copy-paste-divergence-between-similar-backends
  size: S
END
```

### F-005 — Duplicate GUI Thread Start
```
CANDIDATE_FINDING
  id: batch2-005
  group: 1
  provisional_severity: HIGH
  confidence: HIGH
  file: app_gui.py
  line: 512-514
  title: GUI Message Processor Starts Duplicate Thread
  problem: |
    _start_message_processor calls self.after(100, process) twice (lines 512 and 514).
    Each call schedules one invocation. Both run concurrently, doubling message
    processing rate and creating race conditions on queue consumption.
  fix: |
    Remove duplicate self.after(100, process) call on line 514.
  evidence: |
    self.after(100, process)   # line 512
    self.after(100, process)   # line 514 — DUPLICATE
  disprove_attempt: |
    Visual inspection confirms duplicate call.
    Race condition would cause out-of-order message handling.
    UNDISPROVED — duplicate exists.
  ai_pattern: copy-paste-error
  size: S
END
```

### F-006 — Infinite Loop with chunk_overlap=0
```
CANDIDATE_FINDING
  id: batch2-006
  group: 1
  provisional_severity: HIGH
  confidence: MEDIUM
  file: document_processor.py
  line: 155-168, 229-234
  title: Document Processor chunk_overlap=0 Causes Infinite Loop
  problem: |
    When chunk_overlap=0, _calculate_overlap returns ([], 0). At line 234:
    current_chunk_sentences = overlap_sentences → []. Then loop continues and
    appends same sentence that just formed chunk. Creates infinite loop with
    memory growing until OOM.
  fix: |
    Add guard: if chunk_overlap == 0: skip overlap logic entirely.
    Or ensure loop termination condition is independent of overlap.
  evidence: |
    def _calculate_overlap(...):
        if overlap_word_count + s_word_count <= overlap_size:  # overlap_size=0
            # never enters, returns ([], 0)
    current_chunk_sentences = overlap_sentences  # [] when overlap=0
  disprove_attempt: |
    Condition requires chunk_overlap=0 AND single sentence filling chunk exactly.
    Edge case but reachable via CLI --chunk-overlap 0.
    UNDISPROVED — infinite loop possible.
  ai_pattern: boundary-condition-not-handled
  size: M
END
```

---

## MEDIUM (7)

### F-007 — BM25 O(n²) Rebuild
```
CANDIDATE_FINDING
  id: batch2-007
  group: 7
  provisional_severity: MEDIUM
  confidence: HIGH
  file: vector_store.py
  line: 109-117
  title: VectorStore BM25 Rebuild is O(n²) Per Document
  problem: |
    add_documents extends chunks then calls build_index(self.chunks) which rebuilds
    entire corpus from scratch. Adding N documents sequentially = O(1+2+...+N) = O(N²).
    No incremental BM25 update exists.
  fix: |
    Implement incremental BM25 update or batch additions.
    Only rebuild index after batch is complete.
  evidence: |
    def add_documents(self, chunks: List[DocumentChunk]):
        self.chunks.extend(chunks)
        self.build_index(self.chunks)  # Full rebuild every call
  disprove_attempt: |
    add_chunks does batch extension but individual callers may add one-by-one.
    Confirmed no incremental update method exists.
    UNDISPROVED — O(N²) behavior exists.
  ai_pattern: algorithmic-inefficiency
  size: M
END
```

### F-008 — CORS Overly Permissive
```
CANDIDATE_FINDING
  id: batch2-008
  group: 2
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: api_server.py
  line: 554-565
  title: API Server CORS Allows All Methods/Headers
  problem: |
    allow_methods=["*"] and allow_headers=["*"] are overly permissive.
    Combined with zero auth, any website can make cross-origin API calls.
  fix: |
    Restrict to specific methods: ["GET", "POST"].
    Restrict to specific headers: ["Content-Type", "Authorization"].
  evidence: |
    allow_methods=["*"],
    allow_headers=["*"]
  disprove_attempt: |
    allow_credentials=False prevents cookie theft but not CSRF via other techniques.
    UNDISPROVED — overly permissive.
  ai_pattern: overly-permissive-cors
  size: S
END
```

### F-009 — /stats Endpoint Leaks System Information
```
CANDIDATE_FINDING
  id: batch2-009
  group: 2
  provisional_severity: MEDIUM
  confidence: HIGH
  file: api_server.py
  line: 574-587
  title: API /stats Endpoint Leaks System Information
  problem: |
    /stats returns embedding model name, LLM backend type, full document filenames/paths.
    Useful for reconnaissance: embedding model helps craft adversarial inputs;
    document names help with targeted data theft.
  fix: |
    Redact sensitive fields from public /stats endpoint.
    Add authentication requirement for detailed stats.
  evidence: |
    embedding_model=stats["embedding_model"],
    llm_backend=stats["llm"]["backend"],
    documents=stats["documents"]  # Full paths exposed
  disprove_attempt: |
    Information is useful for debugging but leaks system details.
    UNDISPROVED — info leak exists.
  ai_pattern: information-disclosure
  size: S
END
```

### F-010 — Env Var Parsing Not Wrapped
```
CANDIDATE_FINDING
  id: batch2-010
  group: 1
  provisional_severity: MEDIUM
  confidence: HIGH
  file: engine_factory.py
  line: 193-204
  title: Engine Factory Fails Silently on Non-Integer Env Vars
  problem: |
    create_engine_from_env calls int() directly on env vars without try/except.
    Invalid RAG_CHUNK_SIZE=abc causes unhandled ValueError crash.
    No validation on range (negative chunk sizes, zero results).
  fix: |
    Wrap int() calls in try/except with user-friendly error messages.
    Add range validation (chunk_size > 0, n_results > 0).
  evidence: |
    chunk_size=int(os.environ.get("RAG_CHUNK_SIZE", "512")),  # raises ValueError
    n_results=int(os.environ.get("RAG_N_RESULTS", "3")),      # raises ValueError
  disprove_attempt: |
    api_server.py wraps env parsing in try/except but engine_factory doesn't.
    UNDISPROVED — crash risk exists.
  ai_pattern: inconsistent-error-handling
  size: S
END
```

### F-011 — GUI No Retry on Init Failure
```
CANDIDATE_FINDING
  id: batch2-011
  group: 1
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: app_gui.py
  line: 516-583
  title: GUI Embedding Model Initialization Has No Error Recovery
  problem: |
    If RAGEngine.__init__ fails, self.engine remains None. Error message shown
    but "Ask" button never re-enabled. User cannot retry; must restart application.
  fix: |
    Send enable_input message in except block.
    Add retry button or auto-retry logic.
  evidence: |
    except Exception as e:
        self.message_queue.put(("status", f"Error: {e}"))
        # enable_input never sent in except block
  disprove_attempt: |
    User is stuck with disabled UI after error.
    UNDISPROVED — no recovery path.
  ai_pattern: incomplete-error-recovery
  size: M
END
```

### F-012 — No File Size Limit on Directory Ingestion
```
CANDIDATE_FINDING
  id: batch2-012
  group: 2
  provisional_severity: MEDIUM
  confidence: HIGH
  file: document_processor.py
  line: 274-289
  title: No File Size Limit for Directory Ingestion
  problem: |
    process_directory calls process_file which reads entire files into memory.
    2GB file renamed to .pdf will be processed, consuming massive memory.
    API has 50MB limit but directory ingestion has no limits.
  fix: |
    Add file size check before processing.
    Add streaming/chunked processing for large files.
  evidence: |
    for file in files:
        chunks = self.process_file(str(filepath))  # No size check
    API file upload: @app.post("/ingest/file") has 50MB limit.
    Directory ingestion: @app.post("/ingest") has no size limits.
  disprove_attempt: |
    Single file upload has limit but directory doesn't.
    UNDISPROVED — DoS risk exists.
  ai_pattern: inconsistent-validation
  size: M
END
```

### F-013 — BM25 Rebuild Swallows All Errors
```
CANDIDATE_FINDING
  id: batch2-013
  group: 1
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: vector_store.py
  line: 218-246
  title: BM25 Index Rebuild Silently Swallows All Exceptions
  problem: |
    If ChromaDB returns corrupted data, DocumentChunk construction fails,
    exception is swallowed, bm25_index remains None. Hybrid search falls back
    to vector-only silently. Users don't know BM25 is broken.
  fix: |
    Log error at ERROR level (not just WARN).
    Surface BM25 status in /stats endpoint.
    Add health check for BM25 index.
  evidence: |
    except Exception as e:
        print(f"[WARN] BM25 index rebuild failed on startup: {e}")
        # bm25_index remains None
  disprove_attempt: |
    Silent failure means users don't know hybrid search is degraded.
    UNDISPROVED — silent degradation exists.
  ai_pattern: silent-failure-swallows-errors
  size: S
END
```

---

## LOW (7)

### F-014 — Dead Import in rag_engine.py
```
CANDIDATE_FINDING
  id: batch2-014
  group: 6
  provisional_severity: LOW
  confidence: HIGH
  file: rag_engine.py
  line: 26-30
  title: Redundant Import of create_engine_from_env
  problem: |
    create_engine imported but never used (rag_engine defines its own RAGEngine.__init__).
    Only _factory_create_engine_from_env is used via deprecated wrapper.
    Dead import adds to module load time.
  fix: |
    Remove unused create_engine import.
  evidence: |
    from engine_factory import (
        create_engine,  # Never used
        create_engine_from_env as _factory_create_engine_from_env,
    )
  disprove_attempt: |
    Confirmed: create_engine not referenced in file.
    UNDISPROVED — dead code exists.
  ai_pattern: dead-code
  size: S
END
```

### F-015 — BM25 Deletion Wrong Match Logic
```
CANDIDATE_FINDING
  id: batch2-015
  group: 1
  provisional_severity: LOW
  confidence: MEDIUM
  file: vector_store.py
  line: 560-565
  title: BM25 Deletion Uses startswith Instead of Exact Match
  problem: |
    BM25 deletion uses startswith(prefix) instead of exact match.
    Document doc_1.pdf would match doc_1.pdf_backup if existed.
    Document report.pdf would never match because prefix is report.pdf_.
  fix: |
    Use exact match: chunk.source == sanitized_id
  evidence: |
    if not chunk.source.startswith(prefix):  # Should be == sanitized_id
  disprove_attempt: |
    startswith is wrong logic for document deletion.
    UNDISPROVED — bug exists.
  ai_pattern: wrong-string-matching-logic
  size: S
END
```

### F-016 — Settings Dialog Stale Path
```
CANDIDATE_FINDING
  id: batch2-016
  group: 6
  provisional_severity: LOW
  confidence: MEDIUM
  file: app_gui.py
  line: 200-202
  title: Settings Dialog Reads Model Path Without Validation
  problem: |
    Settings dialog pre-fills GGUF path from saved settings without validating
    file still exists. If model moved/deleted, GUI tries to use stale path.
  fix: |
    Add file existence check when loading settings.
    Show warning if model file not found.
  evidence: |
    gguf = self.settings.get("gguf_path") or self.settings.get("model_path", "")
    self.model_path_entry.insert(0, gguf)  # No validation
  disprove_attempt: |
    Backend will fail later with opaque error.
    UNDISPROVED — stale path risk exists.
  ai_pattern: stale-data-not-validated
  size: S
END
```

### F-017 — Error Sanitization Incomplete
```
CANDIDATE_FINDING
  id: batch2-017
  group: 2
  provisional_severity: LOW
  confidence: LOW
  file: llm_interface.py
  line: 357-375
  title: Error Sanitization Only Removes Low-ASCII
  problem: |
    _sanitize_error strips control characters (0x00-0x1F, 0x7F-0x9F) but not
    high-unicode, ANSI escape codes, or null bytes embedded in strings.
  fix: |
    Add ANSI escape code stripping.
    Use unicode normalization.
  evidence: |
    cleaned = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", raw, flags=re.DOTALL)
    # No handling for \x1b[ (ANSI escapes) or high unicode
  disprove_attempt: |
    Low risk — control chars are main concern. ANSI codes cosmetic.
    LOW severity justified.
    UNDISPROVED but LOW severity appropriate.
  ai_pattern: incomplete-sanitization
  size: S
END
```

### F-018 — Non-Windows Fallback Silent
```
CANDIDATE_FINDING
  id: batch2-018
  group: 3
  provisional_severity: LOW
  confidence: MEDIUM
  file: app_paths.py
  line: 22
  title: get_user_data_dir Falls Back to Home on Non-Windows
  problem: |
    Module documented as "Windows path resolver" but falls back to expanduser("~")
    on non-Windows. Silent cross-platform behavior could cause path inconsistencies.
  fix: |
    Document cross-platform behavior explicitly.
    Or raise error on non-Windows platforms.
  evidence: |
    local_app_data = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
  disprove_attempt: |
    Fallback works but is undocumented behavior.
    UNDISPROVED — cross-platform risk exists.
  ai_pattern: undocumented-cross-platform-behavior
  size: S
END
```

### F-019 — Silent File Processing Failure
```
CANDIDATE_FINDING
  id: batch2-019
  group: 1
  provisional_severity: LOW
  confidence: MEDIUM
  file: document_processor.py
  line: 269-272
  title: Exception Logging Discards Actual Exception
  problem: |
    logging.exception() includes traceback but exception object e is not propagated.
    Calling code in process_directory never sees that a file failed. Silent failure.
  fix: |
    Return error indicator or raise custom exception.
    Or collect failed files and report at end.
  evidence: |
    except Exception as e:
        logging.exception(f"Unexpected error processing {filename}")
        return []  # Silent failure
  disprove_attempt: |
    process_directory continues loop without knowing file failed.
    UNDISPROVED — silent failure exists.
  ai_pattern: silent-failure
  size: S
END
```

### F-020 — Dead Code Exception Variable
```
CANDIDATE_FINDING
  id: batch2-020
  group: 6
  provisional_severity: LOW
  confidence: HIGH
  file: api_server.py
  line: 437-442, 444-449
  title: Dead Code — Unused Exception Variable
  problem: |
    except ValueError as e: catches e but never uses it. Not a bug but dead code
    signaling incomplete error handling. Logged message doesn't include actual reason.
  fix: |
    Include e in logged error message.
    Or use except ValueError: if truly not needed.
  evidence: |
    except ValueError as e:  # 'e' is unused
        logger.error("Invalid Ollama URL configuration")
  disprove_attempt: |
    Dead code pattern confirmed. Not a bug but incomplete.
    UNDISPROVED — dead code exists.
  ai_pattern: dead-code
  size: S
END
```

---

## SUMMARY BY SEVERITY

| Severity | Count | Files |
|----------|-------|-------|
| CRITICAL | 1 | llm_interface.py |
| HIGH | 5 | api_server.py (2), llm_interface.py, app_gui.py, document_processor.py |
| MEDIUM | 7 | vector_store.py (2), api_server.py (2), engine_factory.py, app_gui.py, document_processor.py |
| LOW | 7 | rag_engine.py, vector_store.py, app_gui.py, llm_interface.py, app_paths.py, document_processor.py, api_server.py |

**Total**: 20 findings across 8 files
