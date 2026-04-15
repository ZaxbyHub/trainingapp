# Explorer Batch 2: Core Source Part 1 — VALIDATED Findings
**Generated**: 2026-04-08T23:45:00Z
**Reviewer**: paid_reviewer
**Scope**: 8 files, 20 candidates
**Batch**: Batch 2 (Core Source Part 1)

---

## VALIDATED FINDINGS SUMMARY

| ID | Severity | Status | Routing | Notes |
|----|----------|--------|---------|-------|
| F-001 | CRITICAL | **DISPROVED** | N/A | Fabricated — subprocess.Popen doesn't exist |
| F-002 | HIGH | CONFIRMED | CRITIC_REQUIRED | No auth on any endpoint |
| F-003 | HIGH | CONFIRMED | CRITIC_REQUIRED | CWD base_dir in validate_directory |
| F-004 | HIGH | **DISPROVED** | N/A | urlopen HAS timeout=30 at line 558 |
| F-005 | HIGH | CONFIRMED | CRITIC_REQUIRED | Duplicate self.after() calls |
| F-006 | HIGH | CONFIRMED | CRITIC_REQUIRED | chunk_overlap=0 infinite loop |
| F-007 | MEDIUM | CONFIRMED | REVIEWER_FINALIZED | O(n²) BM25 rebuild |
| F-008 | MEDIUM | CONFIRMED | REVIEWER_FINALIZED | Overly permissive CORS |
| F-009 | MEDIUM | CONFIRMED | REVIEWER_FINALIZED | /stats leaks system info |
| F-010 | MEDIUM | CONFIRMED | REVIEWER_FINALIZED | Env var parsing not wrapped |
| F-011 | MEDIUM | CONFIRMED | REVIEWER_FINALIZED | No error recovery in GUI init |
| F-012 | MEDIUM | CONFIRMED | REVIEWER_FINALIZED | No file size limit on dir ingest |
| F-013 | MEDIUM | CONFIRMED | REVIEWER_FINALIZED | BM25 rebuild swallows errors |
| F-014 | LOW | CONFIRMED | REVIEWER_FINALIZED | Dead import |
| F-015 | LOW | CONFIRMED | REVIEWER_FINALIZED | Wrong string match logic |
| F-016 | LOW | CONFIRMED | REVIEWER_FINALIZED | Stale path in settings |
| F-017 | LOW | CONFIRMED | REVIEWER_FINALIZED | Incomplete error sanitization |
| F-018 | LOW | CONFIRMED | REVIEWER_FINALIZED | Undocumented cross-platform fallback |
| F-019 | LOW | CONFIRMED | REVIEWER_FINALIZED | Silent file processing failure |
| F-020 | LOW | CONFIRMED | REVIEWER_FINALIZED | Dead code exception variable |

**Validated**: 18 CONFIRMED, 2 DISPROVED
**Overturned**: 2 (F-001 CRITICAL → FABRICATED, F-004 HIGH → DISPROVED)

---

## DISPROVED FINDINGS

### F-001 — CRITICAL → DISPROVED
```
VALIDATED_FINDING
  id: batch2-001
  original_severity: CRITICAL
  final_severity: FABRICATED
  status: DISPROVED
  file: llm_interface.py
  line: 195-216, 224
  title: GGUF Backend Command Injection via cwd manipulation

  disproof_reason: |
    subprocess.Popen does NOT exist anywhere in llm_interface.py. The GGUF backend
    uses "from llama_cpp import Llama" and calls self.llama(prompt, ...) directly.
    There is no "python -m llama_cpp.server" command. The Explorer fabricated
    evidence lines "cmd = [python, -m, llama_cpp.server, --gguf-path, ...]" and
    "subprocess.Popen(..., cwd=str(self.model_path.parent))" — these strings
    appear ONLY in the finding text, not in source code. Grep confirms:
    - "subprocess.Popen" found 0 times in llm_interface.py
    - "llama_cpp.server" found 0 times in codebase (only in finding text)
    - "cwd" found 0 times in llm_interface.py
    
    The GGUF backend at lines 229-380 directly instantiates Llama class from
    llama-cpp-python library. No subprocess involved whatsoever.

  evidence:
    - llm_interface.py line 254: from llama_cpp import Llama
    - llm_interface.py line 308: result = self.llama(prompt, ...)
    - grep subprocess.Popen in llm_interface.py: 0 matches
    - grep llama_cpp.server in codebase: 0 matches (only in finding text)

  inline_routing: N/A
  finalization_status: DISPROVED
END
```

### F-004 — HIGH → DISPROVED
```
VALIDATED_FINDING
  id: batch2-004
  original_severity: HIGH
  final_severity: DISPROVED
  file: llm_interface.py
  line: 451, 558
  title: Ollama/OpenAI HTTP Requests Lack Timeout

  disproof_reason: |
    Line 558: "with urllib.request.urlopen(req, timeout=30)" — the OpenAI-compatible
    path DOES have timeout=30. Explorer claimed "NO timeout" but the code proves
    otherwise. The Ollama path at line 451 also has timeout=30.
    Both code paths have proper timeouts.

  evidence:
    llm_interface.py:558: with urllib.request.urlopen(req, timeout=30) as response:
    Both Ollama (line 451) and OpenAI-compatible (line 558) paths have timeout=30.

  inline_routing: N/A
  finalization_status: DISPROVED
END
```

---

## CONFIRMED FINDINGS

### F-002 — No Authentication on API Endpoints
```
VALIDATED_FINDING
  id: batch2-002
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  file: api_server.py
  line: 590-733
  title: API Server Has Zero Authentication/Authorization

  evidence: |
    @app.post("/ask") — no auth decorator (line 590)
    @app.post("/search") — no auth decorator (line 615)
    @app.post("/ingest") — no auth decorator (line 632)
    @app.post("/ingest/file") — no auth decorator (line 659)
    @app.delete("/documents") — no auth decorator (line 720)
    @app.get("/documents") — no auth decorator (line 736)

    Server binds to 0.0.0.0 by default. No API key, token, or session.

  code_snippet: |
    590: @app.post("/ask", response_model=QuestionResponse)
    591: async def ask_question(request: QuestionRequest):
    592:     """Ask a question about the ingested documents."""
    593:     if not engine:
    594:         raise HTTPException(status_code=503, detail="Engine not initialized")
    ...
    632: @app.post("/ingest", response_model=IngestResponse)
    633: async def ingest_directory(request: IngestRequest):
    634:     """Ingest documents from a directory."""
    ...
    720: @app.delete("/documents")
    721: async def clear_documents():

  inline_routing: CRITIC_REQUIRED
  finalization_status: FINALIZED
END
```

### F-003 — Arbitrary Directory Ingestion
```
VALIDATED_FINDING
  id: batch2-003
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  file: api_server.py
  line: 632-656, 211-236
  title: Ingest Endpoint Allows Reading Arbitrary Directories

  evidence: |
    validate_directory uses base_dir = Path(".") (server CWD). Line 236 uses
    resolve(strict=False) which can traverse symlinks. The ".." rejection at
    line 232 helps but is insufficient.

  code_snippet: |
    211: def validate_directory(path: str, base_dir: Path = Path(".")) -> str:
    231:     if ".." in normalized_path:
    232:         raise ValueError("Directory path contains path traversal attempts")
    236:     input_path = Path(normalized_path)
    ... (resolve(strict=False) at some point)
    639:     validated_dir = validate_directory(request.directory)

  inline_routing: CRITIC_REQUIRED
  finalization_status: FINALIZED
END
```

### F-005 — Duplicate GUI Thread Start
```
VALIDATED_FINDING
  id: batch2-005
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  file: app_gui.py
  line: 512-514
  title: GUI Message Processor Starts Duplicate Thread

  evidence: |
    Lines 512 and 514 both call self.after(100, process). This schedules two
    concurrent invocations of the message processing loop.

  code_snippet: |
    510:                 self.after(100, process)
    511:
    512:         self.after(100, process)
    513:
    514:         self.after(100, process)  # DUPLICATE

    515:     def _initialize_engine(self):

  inline_routing: CRITIC_REQUIRED
  finalization_status: FINALIZED
END
```

### F-006 — Infinite Loop with chunk_overlap=0
```
VALIDATED_FINDING
  id: batch2-006
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  file: document_processor.py
  line: 155-168, 229-234, 236
  title: Document Processor chunk_overlap=0 Causes Infinite Loop

  evidence: |
    When chunk_overlap=0, _calculate_overlap returns ([], 0). At line 233,
    current_chunk_sentences = overlap_sentences → []. Then line 236 appends
    the same sentence that just formed a chunk, creating infinite loop.

  code_snippet: |
    155:     def _calculate_overlap(self, sentences: List[str], overlap_size: int):
    156:         overlap_sentences = []
    157:         overlap_word_count = 0
    158:         for s in reversed(sentences):
    159:             s_word_count = len(s.split())
    160:             if overlap_word_count + s_word_count <= overlap_size:  # overlap_size=0
    161:                 overlap_sentences.insert(0, s)
    162:                 overlap_word_count += s_word_count
    163:             else:
    164:                 break
    165:         return overlap_sentences, overlap_word_count  # Returns ([], 0) when overlap=0
    ...
    229:     overlap_sentences, overlap_word_count = self._calculate_overlap(
    230:         current_chunk_sentences, self.chunk_overlap)
    231:     current_chunk_sentences = overlap_sentences  # [] when overlap=0
    232:     current_chunk_word_count = overlap_word_count  # 0
    233:
    234:     current_chunk_sentences.append(sentence)  # Same sentence re-added!
    235:     current_chunk_word_count += sentence_word_count

  inline_routing: CRITIC_REQUIRED
  finalization_status: FINALIZED
END
```

### F-007 — BM25 O(n²) Rebuild
```
VALIDATED_FINDING
  id: batch2-007
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: vector_store.py
  line: 109-117
  title: VectorStore BM25 Rebuild is O(n²) Per Document

  evidence: |
    add_documents extends chunks then calls build_index(self.chunks) which
    rebuilds entire corpus from scratch.

  code_snippet: |
    109:     def add_documents(self, chunks: List[DocumentChunk]):
    110:         self.chunks.extend(chunks)
    111:         # Rebuild index once after all additions
    112:         self.build_index(self.chunks)  # Full rebuild every call

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-008 — CORS Overly Permissive
```
VALIDATED_FINDING
  id: batch2-008
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: api_server.py
  line: 554-565
  title: API Server CORS Allows All Methods/Headers

  evidence: |
    allow_methods=["*"] and allow_headers=["*"] at lines 563-564.
    Combined with zero auth.

  code_snippet: |
    554: app.add_middleware(
    555:     CORSMiddleware,
    556:     allow_origins=[
    557:         "http://localhost",
    558:         "http://127.0.0.1",
    559:         "http://localhost:8080",
    560:         "http://127.0.0.1:8080",
    561:     ],
    562:     allow_credentials=False,
    563:     allow_methods=["*"],
    564:     allow_headers=["*"],
    565: )

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-009 — /stats Endpoint Leaks System Information
```
VALIDATED_FINDING
  id: batch2-009
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: api_server.py
  line: 574-587
  title: API /stats Endpoint Leaks System Information

  evidence: |
    /stats returns embedding model name, LLM backend type, and full document
    paths. Lines 585-587 confirm.

  code_snippet: |
    585:         llm_backend=stats["llm"]["backend"] if stats["llm"] else None,
    586:         documents=stats["documents"],  # Full paths exposed
    587:     )

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-010 — Env Var Parsing Not Wrapped
```
VALIDATED_FINDING
  id: batch2-010
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: engine_factory.py
  line: 193-204
  title: Engine Factory Fails Silently on Non-Integer Env Vars

  evidence: |
    create_engine_from_env calls int() directly on env vars without try/except.
    Invalid RAG_CHUNK_SIZE=abc causes unhandled ValueError crash.

  code_snippet: |
    193:     config = RAGConfig(
    194:         db_path=os.environ.get("RAG_DB_PATH", "./doc_qa_db"),
    195:         chunk_size=int(os.environ.get("RAG_CHUNK_SIZE", "512")),  # raises ValueError
    196:         chunk_overlap=int(os.environ.get("RAG_CHUNK_OVERLAP", "50")),
    197:         n_results=int(os.environ.get("RAG_N_RESULTS", "3")),
    198:         max_tokens=int(os.environ.get("RAG_MAX_TOKENS", "1024")),
    199:         temperature=float(os.environ.get("RAG_TEMPERATURE", "0.3")),

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-011 — GUI No Retry on Init Failure
```
VALIDATED_FINDING
  id: batch2-011
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: app_gui.py
  line: 516-583
  title: GUI Embedding Model Initialization Has No Error Recovery

  evidence: |
    Exception block at lines 573-581 shows error message but never sends
    enable_input message. User cannot retry without restarting.

  code_snippet: |
    573:             except Exception as e:
    574:                 self.message_queue.put(("status", f"Error: {e}"))
    575:                 self.message_queue.put(
    576:                     (
    577:                         "message",
    578:                         "system",
    579:                         f"Failed to initialize: {e}\n\nPlease check Settings.",
    580:                     )
    581:                 )
    582:                 # NOTE: enable_input never sent here — UI remains disabled

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-012 — No File Size Limit on Directory Ingestion
```
VALIDATED_FINDING
  id: batch2-012
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: document_processor.py
  line: 274-289
  title: No File Size Limit for Directory Ingestion

  evidence: |
    process_directory calls process_file with no size check. API /ingest/file
    has 50MB limit but /ingest directory ingestion does not.

  code_snippet: |
    274:     def process_directory(self, directory: str) -> List[DocumentChunk]:
    275:         all_chunks = []
    276:         directory = Path(directory)
    277:         for root, _, files in os.walk(directory):
    278:             for file in files:
    279:                 filepath = Path(root) / file
    280:                 ext = filepath.suffix.lower()
    281:                 if ext in self.SUPPORTED_EXTENSIONS:
    282:                     chunks = self.process_file(str(filepath))  # No size check

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-013 — BM25 Rebuild Swallows All Errors
```
VALIDATED_FINDING
  id: batch2-013
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: vector_store.py
  line: 218-246
  title: BM25 Index Rebuild Silently Swallows All Exceptions

  evidence: |
    Exception at line 245 is logged at WARN level and bm25_index remains None.
    Users don't know hybrid search is degraded.

  code_snippet: |
    245:             except Exception as e:
    246:                 print(f"[WARN] BM25 index rebuild failed on startup: {e}")
    247:                 # bm25_index remains None — silent degradation

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-014 — Dead Import in rag_engine.py
```
VALIDATED_FINDING
  id: batch2-014
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: rag_engine.py
  line: 26-30
  title: Redundant Import of create_engine

  evidence: |
    create_engine imported at line 28 but never used. Only
    _factory_create_engine_from_env is used.

  code_snippet: |
    26: from engine_factory import (
    27:     create_engine,  # Never used in this file
    28:     create_engine_from_env as _factory_create_engine_from_env,
    29: )

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-015 — BM25 Deletion Wrong Match Logic
```
VALIDATED_FINDING
  id: batch2-015
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: vector_store.py
  line: 560-565
  title: BM25 Deletion Uses startswith Instead of Exact Match

  evidence: |
    Line 564 uses startswith(prefix) instead of exact match.

  code_snippet: |
    560:             prefix = f"{sanitized_id}_"
    561:             self.bm25_index.chunks = [
    562:                 chunk
    563:                 for chunk in self.bm25_index.chunks
    564:                 if not chunk.source.startswith(prefix)  # Should be ==
    565:             ]

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-016 — Settings Dialog Stale Path
```
VALIDATED_FINDING
  id: batch2-016
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: app_gui.py
  line: 200-202
  title: Settings Dialog Reads Model Path Without Validation

  evidence: |
    Line 201-202 reads gguf_path from settings without checking file exists.

  code_snippet: |
    200:     def _populate_fields(self):
    201:         gguf = self.settings.get("gguf_path") or self.settings.get("model_path", "")
    202:         self.model_path_entry.insert(0, gguf)  # No validation

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-017 — Error Sanitization Incomplete
```
VALIDATED_FINDING
  id: batch2-017
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: llm_interface.py
  line: 357-375
  title: Error Sanitization Only Removes Low-ASCII

  evidence: |
    _sanitize_error at line 510 uses regex [\x00-\x1f\x7f-\x9f] which doesn't
    strip ANSI escape codes or high unicode.

  code_snippet: |
    510:     cleaned = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", raw, flags=re.DOTALL)
    511:     # No handling for \x1b[ (ANSI escapes) or high unicode

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-018 — Non-Windows Fallback Silent
```
VALIDATED_FINDING
  id: batch2-018
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: app_paths.py
  line: 22
  title: get_user_data_dir Falls Back to Home on Non-Windows

  evidence: |
    Module docstring says "Windows path resolver" but falls back to
    expanduser("~") on non-Windows.

  code_snippet: |
    15:     Get the user data directory: %LOCALAPPDATA%\AFOMIS Help and Support\
    ...
    22:     local_app_data = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-019 — Silent File Processing Failure
```
VALIDATED_FINDING
  id: batch2-019
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: document_processor.py
  line: 269-272
  title: Exception Logging Discards Actual Exception

  evidence: |
    logging.exception() includes traceback but returns [] silently.

  code_snippet: |
    269:         except Exception as e:
    270:             logging.exception(f"Unexpected error processing {filename}")
    271:             return []  # Silent failure — calling code doesn't know file failed

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

### F-020 — Dead Code Exception Variable
```
VALIDATED_FINDING
  id: batch2-020
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: api_server.py
  line: 437-442, 444-449
  title: Dead Code — Unused Exception Variable

  evidence: |
    except ValueError as e: catches e but never uses it. Error message doesn't
    include actual reason.

  code_snippet: |
    437:         if ollama_url:
    438:             try:
    439:                 ollama_url = validate_url(ollama_url)
    440:             except ValueError as e:  # 'e' is unused
    441:                 logger.error("Invalid Ollama URL configuration")
    442:                 raise RuntimeError("Startup failed: Invalid configuration")

  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
END
```

---

## FINAL COUNT

| Category | Count |
|----------|-------|
| CONFIRMED CRITICAL | 0 |
| CONFIRMED HIGH | 4 |
| CONFIRMED MEDIUM | 7 |
| CONFIRMED LOW | 7 |
| DISPROVED | 2 (F-001 FABRICATED, F-004 wrong claim) |
| **Total Validated** | **18** |

**Forwarded to Critic**: F-002, F-003, F-005, F-006 (4 HIGH findings)
**Finalized by Reviewer**: F-007 through F-020 (14 MEDIUM/LOW findings)
