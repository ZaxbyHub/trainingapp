# Comprehensive QA Audit Report — AFOMIS Document Q&A Assistant

**Audit Date**: March 2026  
**Methodology**: AI-Hardened Codebase Review (9 check groups, 9 phases)  
**Auditor**: modelrelay swarm (automated multi-agent audit)  
**Scope**: Full codebase — 17 source files, 16 evidence bundles, 137 raw findings  

---

## Executive Summary

This report presents the findings of a comprehensive AI-hardened QA audit of the AFOMIS Document Q&A Assistant, a local-only Windows desktop RAG application. The audit covered 9 phases across configuration, data layer, API/engine, GUI, test suite, documentation, and cross-boundary verification.

**Key Numbers:**
- **137 raw findings** identified across 16 evidence files (phases 2-8)
- **11 false positives** removed during audit
- **7 additional false positives** identified by critic validation (Phase 9.1/9.2)
- **Architect overrode 5 critic false-positive claims** after source verification
- **Net: 137 raw → ~114 confirmed findings** after full validation

**Top Risks:**
1. **BM25 O(N^2) rebuild on every document addition** — makes batch ingestion impractical for large document sets
2. **Race conditions in vector store** — concurrent access to shared BM25 index without synchronization
3. **Inverted regression test assertion** — test_defect_003 passes when the fix is broken, providing false confidence
4. **3 API endpoints leak internal error details** via str(e) — exposes file paths, model details, stack traces
5. **CONFIGURATION.md has 8 wrong defaults** — every user receives misleading configuration guidance

---

## Findings Count Table

| Severity | Raw Count | After Full Validation | Notes |
|----------|-----------|---------------------|-------|
| CRITICAL | 2 | 1 | seedloader-001 downgraded (dead code) |
| HIGH | 40 | ~32 | 4 downgraded to MEDIUM, 2 false positive, ~2 overridden |
| MEDIUM | 64 | ~56 | Several critic false positives overridden by architect |
| LOW | 31 | ~25 | ~6 false positives confirmed or overridden |
| **Total** | **137** | **~114 confirmed** | ~23 false positives total (16%) |

### By Check Group

| Group | Description | Count |
|-------|-------------|-------|
| 1 | Broken stubs, dead code, wiring | 30 |
| 2 | Trust boundaries, input validation | 17 |
| 3 | Cross-platform compatibility | 2 |
| 4 | Documentation claims verification | 30 |
| 5 | AI smells, stale patterns | 13 |
| 6 | Tech debt, hardcoded values | 21 |
| 7 | Performance, I/O | 5 |
| 8 | Test quality | 19 |
| 9 | Supply chain | 9 |

### By Phase

| Phase | Description | Count |
|-------|-------------|-------|
| 2 | Config, Infrastructure, Supply Chain | 30 |
| 3 | Data Layer | 39 |
| 4 | API and Engine Layer | 53 |
| 5 | GUI Module | 15 |
| 6 | Test Suite | 30 |
| 7 | Documentation | 23 |
| 8 | Cross-Boundary Verification | 7 |

### By File (Top 10)

| File | Findings |
|------|----------|
| llm_interface.py | 20 |
| api_server.py | 18 |
| app_gui.py | 15 |
| vector_store.py | 13 |
| CONFIGURATION.md | 11 |
| rag_engine.py | 12 |
| seed_loader.py | 9 |
| scripts/build_installer.py | 7 |
| test_defect_002_api_gguf_env.py | 3 |
| engine_factory.py | 3 |

---

## AI Pattern Distribution

| Pattern | Count | Example Finding |
|---------|-------|----------------|
| Happy-path-only error handling | 10 | vectorstore-005, gui-001, api-007 |
| Type safety gaps | 9 | llm-003, llm-004, api-004 |
| Overly broad exception catching with information disclosure | 5 | api-007, api-008, api-009 |
| Inconsistent patterns across backends | 4 | llm-010, llm-011, llm-013 |
| Stale API usage / dead code | 4 | llm-005, engine-001, datapipeline-006 |
| Static analysis instead of runtime test | 3 | regression-004, regression-005, regression-006 |
| Copy-paste patterns | 3 | api-001, api-002, datapipeline-004 |
| Hardcoded configuration values | 5 | engine-008, engine-009, datapipeline-010 |

---

## CRITICAL Findings

### CRITICAL-1: BM25 O(N^2) rebuild on every document addition
- **ID**: vectorstore-001 | **Group**: 7 | **File**: vector_store.py:95-116
- **Problem**: `add_document()` appends to `self.chunks` then rebuilds the entire BM25Okapi index from scratch. For N chunks, this is O(N) per call. Batch `add_chunks()` calls `add_document()` per chunk, making it O(N^2) total.
- **Fix**: Replace with batch accumulation + single rebuild. Collect pending chunks, rebuild BM25 index when a threshold is reached or explicitly triggered.
- **Critic**: CONFIRMED. True positive probability 95%.
- **Impact**: Makes batch ingestion of large document sets impractical. Known issue EC-003.

### CRITICAL-2: Race condition in add_chunks concurrent access
- **ID**: vectorstore-002 | **Group**: 2 | **File**: vector_store.py:246-312
- **Problem**: `add_chunks()` modifies shared state (collection + bm25_index) without thread synchronization. GUI spawns threads for ingestion. Concurrent calls corrupt the BM25 index.
- **Fix**: Add `threading.Lock` around critical sections, or use queue-based background processing.
- **Critic**: CONFIRMED. True positive probability 80%.
- **Impact**: Data corruption during concurrent ingestion. Affects GUI mode where ingestion runs in background threads.

---

## HIGH Findings

### Data Layer

| ID | File:Line | Title | Critic Verdict |
|----|-----------|-------|---------------|
| vectorstore-003 | vector_store.py:537 | Hybrid search stale index reference race condition | CONFIRMED (subsumed by -002) |
| vectorstore-004 | vector_store.py:503 | delete_document leaves BM25 index in inconsistent state | CONFIRMED |
| vectorstore-005 | vector_store.py:302 | add_chunks calls per-document BM25 rebuild in loop | CONFIRMED |
| datapipeline-001 | document_processor.py:46 | Silent fallback to pypdf masks missing pdfplumber dependency | CONFIRMED |
| seedloader-002 | seed_loader.py:116 | Direct dict key access on unvalidated JSON | CONFIRMED |

### API Layer

| ID | File:Line | Title | Critic Verdict |
|----|-----------|-------|---------------|
| api-004 | api_server.py:600 | file.filename is str/None — potential TypeError | CONFIRMED |
| api-005 | api_server.py:612 | No file size limit on uploaded files | CONFIRMED |
| api-007 | api_server.py:626 | /ingest/file leaks internal error details via str(e) | CONFIRMED |
| api-008 | api_server.py:546 | /ask endpoint leaks internal error details via str(e) | CONFIRMED |
| api-009 | api_server.py:566 | /search endpoint leaks internal error details via str(e) | CONFIRMED |

### Engine Layer

| ID | File:Line | Title | Critic Verdict |
|----|-----------|-------|---------------|
| engine-001 | rag_engine.py:271 | Dead code: _expand_chunks_with_window never called | CONFIRMED |
| engine-002 | main.py:72 | CLI mode bypasses engine_factory — chunk_size 256 vs 512 | CONFIRMED |
| llm-009 | llm_interface.py:378 | No runtime fallback — init success does not guarantee generate success | CONFIRMED |

### Test Suite

| ID | File:Line | Title | Critic Verdict |
|----|-----------|-------|---------------|
| regression-001 | test_defect_003_url_validation.py:173 | **INVERTED ASSERTION** — test passes when fix is broken | CONFIRMED |
| unittest-001 | test_llm_interface.py:350 | Assertion always passes: empty string in any string | CONFIRMED |
| unittest-002 | test_rag_engine.py:152 | Overly permissive assertion matches any 'answer' substring | CONFIRMED |
| unittest-003 | tests/conftest.py:249 | Unused fixture inference_config | CONFIRMED |
| regression-002 | test_defect_001_gui_gguf_wiring.py:112 | Mock bypasses actual settings migration code | CONFIRMED |
| regression-003 | test_defect_001_gui_gguf_wiring.py:258 | Test creates expected dict but never calls actual code | CONFIRMED |
| regression-004 | test_defect_002_api_gguf_env.py:40 | Tests source strings instead of runtime behavior | CONFIRMED |
| regression-005 | test_defect_002_api_gguf_env.py:86 | String inspection verifies source text, not runtime behavior | CONFIRMED |
| regression-006 | test_defect_002_api_gguf_env.py:267 | Env var completeness test uses source string matching | CONFIRMED |

### GUI

| ID | File:Line | Title | Critic Verdict |
|----|-----------|-------|---------------|
| gui-001 | app_gui.py:169 | Unvalidated numeric input in settings save — ValueError crash | CONFIRMED |
| gui-002 | app_gui.py:183 | God class: DocumentQAApp is 552 lines | CONFIRMED |

### Documentation

| ID | File:Line | Title | Critic Verdict |
|----|-----------|-------|---------------|
| doc-001 | ARCHITECTURE.md:578 | /ask/stream endpoint documented but does not exist | CONFIRMED |
| doc-002 | README.md:20 | Model name inconsistency: Qwen3-1.7B vs Qwen2.5-1.5B | CONFIRMED |
| configdoc-001 | CONFIGURATION.md:26 | Settings path contradicts code | CONFIRMED |
| configdoc-002 | CONFIGURATION.md:264 | Backend priority order swapped | CONFIRMED |
| configdoc-003 | CONFIGURATION.md:40 | RAG_CHUNK_SIZE default 256 vs actual 512 | CONFIRMED |
| configdoc-004 | CONFIGURATION.md:38 | RAG_DB_PATH default misleading | CONFIRMED |
| configdoc-005 | CONFIGURATION.md:61 | Phantom env vars RAG_TOP_P, RAG_DO_SAMPLE | CONFIRMED |
| configdoc-006 | CONFIGURATION.md:69 | RAG_RETRIEVAL_WINDOW default 0 vs actual 1 | CONFIRMED |
| configdoc-007 | USAGE.md:367 | CLI --reranking flag does not exist | CONFIRMED |

### Cross-Boundary

| ID | Files | Title | Critic Verdict |
|----|-------|-------|---------------|
| cross-001 | rag_engine.py, engine_factory.py, app_gui.py | chunk_size default inconsistent across 3 code paths | CONFIRMED |
| cross-002 | rag_engine.py, engine_factory.py | retrieval_window default inconsistent | CONFIRMED |
| cross-003 | app_gui.py, engine_factory.py | GUI bypasses engine_factory — missing advanced config fields | CONFIRMED |

---

## Claim Ledger

| Status | Count | Key Examples |
|--------|-------|-------------|
| CONTRADICTED | 12 | Settings path (paths-007, configdoc-001), backend priority (engine-017, configdoc-002), chunk_size default (configdoc-003), 7 more CONFIGURATION.md defaults |
| UNSUPPORTED | 6 | /ask/stream endpoint (doc-001), phantom env vars (configdoc-005), CLI flags that do not exist (configdoc-007, configdoc-011) |
| STALE | 7 | Model name (doc-002), CLI args (doc-003), version mismatch (doc-006), test suite count (remreport-003) |
| STEALTH_CHANGED | 2 | Remediation report: only 1/4 duplicates deleted (remreport-001), BM25 'incremental' mischaracterized (remreport-002) |
| PARTIALLY_SUPPORTED | 1 | Path documentation incomplete (paths-008) |

---

## False Positives

**Removed during audit (11)**: Various overstated severity for local-only app context, Tkinter self.after() thread safety misreads, indentation-based misreads.

**Removed during critic validation (7)**:
- llm-005, llm-006: Streaming code no longer exists in codebase
- llm-008: re.sub None path guarded by dict.get() default
- seedloader-003, seedloader-004: Bugs exist but unreachable (SeedDataLoader has zero callers)
- vectorstore-012: batch_size already has type annotation
- vectorstore-013: sys IS used at line 48

**Critic false positives OVERRIDDEN by architect (5)**:
- paths-003: Critic said FALSE_POSITIVE (claimed used in llm_interface.py:370). **Architect verified**: grep shows no callers — finding CONFIRMED.
- paths-010: Critic said FALSE_POSITIVE. **Architect verified**: docstring line 63 says "Creates the directory" but function does not — finding CONFIRMED.
- gui-003: Critic said FALSE_POSITIVE. **Architect verified**: grep shows no runtime callers — finding CONFIRMED.
- unittest-005: Critic said FALSE_POSITIVE (claimed line uses >=). **Architect verified**: line 153 uses `== 0.85` — finding CONFIRMED.
- gui-011-015: Critic said FILE_NOT_FOUND. **Architect verified**: app_gui.py exists at 552 lines — all 5 findings CONFIRMED.

---

## Compound Severity Elevations

| Target | Findings | Recommendation |
|--------|----------|----------------|
| vector_store.py add/add_document | 6 findings (2 CRITICAL, 2 HIGH, 2 MEDIUM) | Treat as CRITICAL subsystem — #1 priority for remediation |
| api_server.py /ingest/file | 4 findings (3 HIGH, 1 MEDIUM) | Treat as CRITICAL endpoint — path traversal + crash + exhaustion + disclosure |
| api_server.py /ask | 3 findings (2 HIGH, 1 MEDIUM) | HIGH endpoint — error disclosure + unsanitized input |
| llm_interface.py SmartLLM | 4 findings (1 HIGH, 3 MEDIUM) | HIGH subsystem — type safety + no runtime fallback |
| CONFIGURATION.md defaults | 8 findings (7 HIGH, 1 MEDIUM) | CRITICAL documentation — 8 wrong defaults mislead every user |

---

## Supply Chain Findings

| ID | Severity | Title |
|----|----------|-------|
| config-001 | CRITICAL | rank_bm25 not in requirements.txt (imported in vector_store.py) |
| config-002 | MEDIUM | No upper bounds on package versions |
| build-001 | HIGH | PyInstaller separator incompatible with Unix |
| build-002 | HIGH | os.chdir breaks relative path resolution |
| build-006 | HIGH | copy_app_files flat directory causes file overwrites |

---

## Recommended Remediation Order

1. **FIX vector_store.py BM25 thread safety and O(N) rebuild** — #1 performance and correctness risk. Add threading.Lock and batch rebuild pattern.
2. **FIX regression test inversion (regression-001)** — The test guarding URL validation fix is inverted. It passes when the fix is broken.
3. **FIX api_server.py error disclosure** — Replace str(e) with generic messages in /ingest/file, /ask, and /search. Add file size limits and None check on file.filename.
4. **FIX GUI settings input validation (gui-001)** — Wrap int()/float() conversions in try/except.
5. **FIX CONFIGURATION.md defaults** — Update all 8 wrong defaults (settings path, backend priority, chunk_size, retrieval_window, DB path, phantom env vars, JSON examples).
6. **FIX chunk_size/retrieval_window default unification** — Centralize defaults to one value across RAGConfig, engine_factory, and CLI.
7. **REMOVE dead code** — SeedDataLoader (seed_loader.py), _expand_chunks_with_window, unused imports and functions.
8. **FIX test quality** — Fix 8 HIGH test findings (3 tautological assertions, 3 mock bypasses, 2 string inspections).
9. **FIX build scripts** — Cross-platform separators, flat copy, encoding issues.
10. **ADD rank_bm25 to requirements.txt** — Currently imported but not declared as dependency.

---

## Coverage Notes

- **Phases audited**: All 9 phases completed (inventory, config, data, API/engine, GUI, tests, documentation, cross-boundary, synthesis)
- **Files audited**: 17 source files across src/, scripts/, tests/, and documentation
- **Evidence**: 16 evidence JSON files in .swarm/evidence/ phases 2-8
- **Known edge cases verified**: EC-002 (pre-existing test failure), EC-003 (BM25 rebuild confirmed), EC-006 (path mismatch confirmed), EC-007 (backend priority confirmed)
- **False positive rate**: ~16% (23/137 removed after full validation including architect overrides)
- **Critic validation**: Phase 9.1 validated 42 CRITICAL+HIGH findings. Phase 9.2 validated 95 MEDIUM+LOW findings. Architect cross-checked 6 critic claims and overrode 5.

---

*Report generated by modelrelay swarm. All findings cite exact file paths and line numbers. Evidence files available in .swarm/evidence/.*
