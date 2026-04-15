# Reviewer Batch 7: Validation Results
**Validated**: 2026-04-09T00:20:00Z
**Scope**: 14 candidates from Batch 7 (Cross-Boundary)
**Reviewer**: paid_reviewer
**Results**: 14 confirmed, 0 disproved, 0 overturned

---

## HIGH Findings (8) — Routed to Critic

### CANDIDATE-001 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch7-001
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  boundary: API
  file_a: USAGE.md
  file_b: api_server.py
  line_a: 479
  line_b: 623
  title: /search endpoint returns SearchResult objects, not tuples as documented
  problem: |
    USAGE.md:479 documents tuple unpacking `for doc, meta, score in matches:` but 
    api_server.py:623-626 returns List[SearchResult] Pydantic objects with fields 
    (text, source, similarity) — attempting tuple unpacking on Pydantic models raises 
    TypeError at runtime.
  fix: |
    Update USAGE.md to show correct SearchResult object attribute access.
  evidence_a: |
    USAGE.md: "for doc, meta, score in matches:"
  evidence_b: |
    api_server.py: "return [SearchResult(text=doc, source=meta.get('source', 'Unknown'), similarity=sim) for ...]"
  ai_pattern: Contract Drift - API Response Schema Mismatch
  size: S
END
```

### CANDIDATE-002 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch7-002
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  boundary: Config
  file_a: CONFIGURATION.md
  file_b: api_server.py
  line_a: 43
  line_b: 518
  title: RAG_MIN_SIMILARITY env var documented but never read by api_server.py lifespan
  problem: |
    CONFIGURATION.md:43 documents RAG_MIN_SIMILARITY env var, but api_server.py:518-525 
    RAGConfig construction omits min_similarity parameter despite RAGConfig.__init__ 
    accepting it (rag_engine.py:54).
  fix: |
    Add min_similarity to api_server.py RAGConfig constructor.
  evidence_a: |
    CONFIGURATION.md: "| `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |"
  evidence_b: |
    api_server.py: RAGConfig construction missing min_similarity parameter
  ai_pattern: Config Cascade - Documented Env Var Never Read
  size: S
END
```

### CANDIDATE-004 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch7-004
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  boundary: GUI
  file_a: app_gui.py
  file_b: api_server.py
  line_a: 526
  line_b: 518
  title: app_gui.py doesn't pass device/embedding_model/reranking_enabled to RAGEngine
  problem: |
    app_gui.py:526-540 passes only 5 RAGConfig fields + 5 RAGEngine params; 
    api_server.py:518-536 passes embedding_model, device, reranking_enabled, 
    hybrid_search, retrieval_window — GUI initialization is missing these fields 
    causing feature gaps.
  fix: |
    Add missing parameters to app_gui.py RAGConfig and RAGEngine initialization.
  evidence_a: |
    app_gui.py: RAGConfig with 5 fields, RAGEngine missing device/embedding_model
  evidence_b: |
    api_server.py: RAGConfig with embedding_model, RAGEngine with device
  ai_pattern: Contract Drift - Missing Parameters at Factory Boundary
  size: M
END
```

### CANDIDATE-005 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch7-005
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  boundary: Import
  file_a: api_server.py
  file_b: llm_interface.py
  line_a: 32
  line_b: 36
  title: Duplicate validate_url() with divergent SSRF security policies
  problem: |
    api_server.py:32-97 and llm_interface.py:36-104 both define validate_url() with 
    divergent SSRF policies — api_server version has allow_local parameter allowing 
    private IPs when True, while llm_interface version unconditionally rejects private 
    IPs — duplicate symbol with security divergence.
  fix: |
    Consolidate to single validate_url() implementation with consistent security policy.
  evidence_a: |
    api_server.py: "if ip_addr.is_private and not allow_local:"
  evidence_b: |
    llm_interface.py: "for network in PRIVATE_NETWORKS: if ip in network:"
  ai_pattern: Phantom Export / Duplicate Symbol with Divergent Semantics
  size: M
END
```

### CANDIDATE-009 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch7-009
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  boundary: Test
  file_a: tests/test_phase1_adversarial.py
  file_b: api_server.py
  line_a: 144
  line_b: 32
  title: Empty test_validate_device_rejects_backticks imports wrong function
  problem: |
    test_phase1_adversarial.py:144-150 function test_validate_device_rejects_backticks 
    imports validate_url (not validate_device) and has empty body — docstring claims to 
    test device validation but imports wrong function and has no assertions.
  fix: |
    Remove empty test or implement proper device validation test.
  evidence_a: |
    tests/test_phase1_adversarial.py: "from api_server import validate_url" in test_validate_device_rejects_backticks
  evidence_b: |
    api_server.py: device validation embedded in lifespan function
  ai_pattern: Empty Test / Wrong Function Imported
  size: S
END
```

### CANDIDATE-010 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch7-010
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  boundary: Test
  file_a: tests/test_phase1_adversarial.py
  file_b: api_server.py
  line_a: 177
  line_b: 32
  title: Empty test_validate_device_rejects_dangerous_patterns is a pure no-op
  problem: |
    test_phase1_adversarial.py:177-181 test_validate_device_rejects_dangerous_patterns 
    has only `pass` statement — zero test coverage, no assertions, no imports, provides 
    no validation value.
  fix: |
    Remove empty test or implement proper validation.
  evidence_a: |
    tests/test_phase1_adversarial.py: "def test_validate_device_rejects_dangerous_patterns(): ... pass"
  ai_pattern: Empty Test - No-Op Pass Statement
  size: S
END
```

### CANDIDATE-012 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch7-012
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  boundary: API
  file_a: USAGE.md
  file_b: api_server.py
  line_a: 788
  line_b: 590
  title: USAGE.md documents streaming /ask endpoint but no streaming implementation exists
  problem: |
    USAGE.md:788-809 shows streaming example with `stream=True` and `response.iter_lines()` 
    expecting SSE chunks, but api_server.py:599-612 /ask endpoint returns single JSONResponse — 
    no StreamingResponse, no SSE, no streaming implementation exists.
  fix: |
    Remove streaming section from USAGE.md or implement streaming in api_server.py.
  evidence_a: |
    USAGE.md: "response = requests.post(..., stream=True)" and "for line in response.iter_lines():"
  evidence_b: |
    api_server.py: "@app.post('/ask', response_model=QuestionResponse)" returning single response
  ai_pattern: Streaming Fabrication - Docs Describe Non-Existent Feature
  size: L
END
```

---

## MEDIUM Findings (5) — Finalized Inline

### CANDIDATE-003 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch7-003
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  boundary: Config
  file_a: CONFIGURATION.md
  file_b: engine_factory.py
  line_a: 43
  line_b: 193
  title: RAG_MIN_SIMILARITY also absent from engine_factory.create_engine_from_env
  problem: |
    engine_factory.py:193-204 create_engine_from_env() also does not read 
    RAG_MIN_SIMILARITY from environment — same root cause as CANDIDATE-002 but 
    affects CLI path instead of API path.
  fix: |
    Add min_similarity parameter to engine_factory.py RAGConfig constructor.
  evidence_a: |
    CONFIGURATION.md: "| `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |"
  evidence_b: |
    engine_factory.py: RAGConfig construction missing min_similarity
  ai_pattern: Config Cascade - Documented Env Var Never Read
  size: S
END
```

### CANDIDATE-006 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch7-006
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  boundary: GUI
  file_a: app_gui.py
  file_b: rag_engine.py
  line_a: 230
  line_b: 48
  title: GUI chunk_size range (128-2048) vs API (100-10000) — three different ranges
  problem: |
    app_gui.py:230 validates chunk_size range 128-2048, api_server.py:429 validates 
    100-10000 — three different ranges across codebase create inconsistent behavior.
  fix: |
    Standardize chunk_size validation to single range across all entry points.
  evidence_a: |
    app_gui.py: "if not (128 <= chunk_size <= 2048):"
  evidence_b: |
    api_server.py: "chunk_size = validate_numeric(chunk_size, 100, 10000, 'chunk_size')"
  ai_pattern: Config Cascade - Conflicting Validation Ranges Across Entry Points
  size: S
END
```

### CANDIDATE-007 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch7-007
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  boundary: GUI
  file_a: app_gui.py
  file_b: rag_engine.py
  line_a: 244
  line_b: 48
  title: GUI max_tokens range (256-4096) vs API (100-4000) — conflict at 4096
  problem: |
    app_gui.py:244 allows max_tokens up to 4096, api_server.py:430 clamps at 4000 — 
    user could configure 4096 in GUI but API would reject it.
  fix: |
    Align max_tokens validation ranges across GUI and API.
  evidence_a: |
    app_gui.py: "if not (256 <= max_tokens <= 4096):"
  evidence_b: |
    api_server.py: "max_tokens = validate_numeric(max_tokens, 100, 4000, 'max_tokens')"
  ai_pattern: Contract Drift - Conflicting Validation Ranges
  size: S
END
```

### CANDIDATE-013 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch7-013
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  boundary: Config
  file_a: llm_interface.py
  file_b: api_server.py
  line_a: 36
  line_b: 60
  title: llm_interface.validate_url allows username-only URLs; api_server rejects them
  problem: |
    api_server.py:60-62 explicitly rejects URLs with userinfo (username:password), 
    but llm_interface.py:36-104 validate_url has no userinfo check — URL like 
    `http://user@example.com` passes llm_interface but fails api_server.
  fix: |
    Add userinfo check to llm_interface.py validate_url matching api_server policy.
  evidence_a: |
    llm_interface.py: No check for parsed.username
  evidence_b: |
    api_server.py: "if parsed.username or parsed.password: raise ValueError(...)"
  ai_pattern: Contract Drift - Inconsistent Input Validation Policy
  size: S
END
```

### CANDIDATE-014 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch7-014
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  boundary: Config
  file_a: api_server.py
  file_b: engine_factory.py
  line_a: 524
  line_b: 200
  title: api_server.py hardcodes embedding_model ignoring RAG_EMBEDDING_MODEL env var
  problem: |
    api_server.py:524 hardcodes embedding_model="BAAI/bge-small-en-v1.5" ignoring 
    RAG_EMBEDDING_MODEL env var, while engine_factory.py:200 correctly reads 
    os.environ.get("RAG_EMBEDDING_MODEL") — inconsistent embedding model selection 
    across entry points.
  fix: |
    Replace hardcoded value with os.environ.get("RAG_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5").
  evidence_a: |
    api_server.py: "embedding_model='BAAI/bge-small-en-v1.5'"
  evidence_b: |
    engine_factory.py: "embedding_model=os.environ.get('RAG_EMBEDDING_MODEL', 'BAAI/bge-small-en-v1.5')"
  ai_pattern: Config Cascade - Hardcoded Value Ignores Env Var
  size: S
END
```

---

## LOW Findings (2) — Finalized Inline

### CANDIDATE-011 → CONFIRMED LOW
```
VALIDATED_FINDING
  id: batch7-011
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  boundary: Config
  file_a: app_paths.py
  file_b: CONFIGURATION.md
  line_a: 15
  line_b: 26
  title: AFOMIS legacy product name persists in app_paths.py docstrings and paths
  problem: |
    app_paths.py:2,15,23 persists "AFOMIS Help and Support" legacy product name 
    in docstrings and path construction — cosmetic staleness.
  fix: |
    Update app_paths.py docstrings to reference "Document Q&A Assistant".
  evidence_a: |
    app_paths.py: "user_data_dir = Path(local_app_data) / 'AFOMIS Help and Support'"
  evidence_b: |
    CONFIGURATION.md: "%LOCALAPPDATA%\\AFOMIS Help and Support\\settings.json"
  ai_pattern: Stale Scaffold - Legacy Product Name in Code
  size: S
END
```

### CANDIDATE-015 → CONFIRMED LOW
```
VALIDATED_FINDING
  id: batch7-015
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  boundary: API
  file_a: api_server.py
  file_b: USAGE.md
  line_a: 556
  line_b: 556
  title: CORS allow_origins uses string literals instead of env-configurable list
  problem: |
    api_server.py:556-561 CORS allow_origins is hardcoded string list instead of 
    env-configurable — cannot change CORS policy without code modification.
  fix: |
    Make CORS origins configurable via environment variable.
  evidence_a: |
    api_server.py: "allow_origins=['http://localhost', 'http://127.0.0.1', ...]"
  ai_pattern: Hardcoded Configuration - Non-Configurable Security Setting
  size: S
END
```

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Total Reviewed | 14 |
| Confirmed | 14 |
| Disproved | 0 |
| Overturned | 0 |

### Final Severity Distribution
- **HIGH**: 8 findings (entering Critic challenge)
- **MEDIUM**: 5 findings (finalized)
- **LOW**: 2 findings (finalized)

### Routing Decisions

**To Critic (HIGH)**: batch7-001, batch7-002, batch7-004, batch7-005, batch7-009, batch7-010, batch7-012

**Finalized (MEDIUM)**: batch7-003, batch7-006, batch7-007, batch7-013, batch7-014

**Finalized (LOW)**: batch7-011, batch7-015

---

## Key Patterns Confirmed

1. **Configuration Cascade Failures**: 4 findings (RAG_MIN_SIMILARITY not wired, embedding_model hardcoded, validation range conflicts)
2. **Contract Drift**: 4 findings (API response format, GUI missing parameters, validation policy divergence, streaming fabrication)
3. **Security Policy Divergence**: 1 finding (duplicate validate_url with different SSRF policies)
4. **Empty Tests**: 2 findings (test_phase1_adversarial.py no-op tests)
5. **Stale Branding**: 1 finding (AFOMIS legacy name)
