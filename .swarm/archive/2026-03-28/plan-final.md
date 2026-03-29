<!-- PLAN_STATUS: COMPLETE -->
<!-- COMPLETION_DATE: 2026-03-28 -->
<!-- TOTAL_TASKS: 55 -->
<!-- COMPLETED_TASKS: 55 -->
<!-- VERIFICATION_STATUS: PASSED -->

<!-- PLAN_HASH: 2x1c4zakuzheg -->
# AFOMIS Document QA Assistant — Remediation Plan
Swarm: modelrelay
Phase: COMPLETE | Updated: 2026-03-28 | Status: 100% FINISHED

---
## Phase 1: Critical Safety and Regression Fixes [COMPLETE]
- [x] 1.1: Fix inverted regression test assertion in tests/regression/test_defect_003_url_validation.py line 173. The test currently passes when the URL validation fix is broken (assertion is inverted). Correct the assertion so the test fails when the fix is removed. Finding: regression-001. [SMALL]
- [x] 1.2: Fix error detail disclosure in api_server.py: replace str(e) with generic error messages in /ingest/file (line 626), /ask (line 546), and /search (line 566). Return user-friendly messages without exposing internal paths, model details, or stack traces. Findings: api-007, api-008, api-009. [SMALL] (depends: 1.1)
- [x] 1.3: Add None guard for file.filename in api_server.py line 600. file.filename can be None (malformed multipart request), which would cause TypeError in sanitize_filename. Return 400 Bad Request when filename is None. Finding: api-004. [SMALL] (depends: 1.2)
- [x] 1.4: Add file size limit to /ingest/file endpoint in api_server.py line 612. Cap uploaded file size (e.g., 50MB default) to prevent resource exhaustion. Return 413 Payload Too Large when exceeded. Finding: api-005. [SMALL] (depends: 1.3)
- [x] 1.5: Fix unvalidated numeric input in app_gui.py settings save (line 169). Wrap int() and float() conversions in try/except ValueError to prevent crashes when users enter non-numeric values in settings fields. Finding: gui-001. [SMALL]

---
## Phase 2: BM25 and Vector Store Overhaul [COMPLETE]
- [x] 2.1: Replace per-document BM25 rebuild in vector_store.py add_document() (line 95-116) with batch accumulation pattern. Collect pending chunks and rebuild BM25Okapi index once after all chunks are added, not on every single add_document call. This fixes the O(N^2) batch ingestion problem. Finding: vectorstore-001, vectorstore-005. [MEDIUM] (depends: 1.1)
- [x] 2.2: Add threading.Lock to vector_store.py for thread-safe concurrent access to shared BM25 index and ChromaDB collection. Protect add_chunks(), delete_document(), and hybrid_search() with a lock. This fixes race conditions when GUI spawns ingestion threads. Finding: vectorstore-002, vectorstore-003. [MEDIUM] (depends: 2.1)
- [x] 2.3: Fix delete_document BM25 inconsistency in vector_store.py line 503. After deleting from ChromaDB, also rebuild the BM25 index so it stays in sync. Currently delete removes from ChromaDB but leaves stale entries in BM25. Finding: vectorstore-004. [SMALL] (depends: 2.2)
- [x] 2.4: Add corpus size limit or warning in vector_store.py. When BM25 index grows large (e.g., >10000 chunks), log a performance warning. This addresses the known limitation EC-003 without blocking functionality. Finding: vectorstore-008. [SMALL] (depends: 2.1)
- [x] 2.5: Add rank_bm25 to requirements.txt. Currently imported in vector_store.py but not declared as a dependency. Finding: config-001. [SMALL] (depends: 2.1)

---
## Phase 3: Configuration and Default Unification [COMPLETE]
- [x] 3.1: Unify chunk_size default across RAGConfig (512), engine_factory, and CLI (main.py line 72 uses 256). Make all three code paths use the same default value of 512. Update CLI argument default in main.py. Findings: engine-002, cross-001, configdoc-003. [SMALL] (depends: 2.2)
- [x] 3.2: Unify retrieval_window default across RAGConfig (1), engine_factory, and CONFIGURATION.md (documents 0). Make all code paths use default of 1. Update any code or docs that still reference 0. Findings: cross-002, configdoc-006. [SMALL] (depends: 3.1)
- [x] 3.3: Unify max_tokens default. Verify RAGConfig, engine_factory, and all LLM backends use consistent max_tokens default (1024 recommended). Fix any that use 512. Findings: engine-008, engine-009. [SMALL]
- [x] 3.4: Fix settings path documentation in CONFIGURATION.md line 26. Currently documents AppData/DocumentQA/app_settings.json but actual code uses %LOCALAPPDATA%/AFOMIS Help and Support/settings.json via app_paths.py. Finding: configdoc-001, paths-007. [SMALL] (depends: 3.1)

---
## Phase 4: Dead Code Removal [COMPLETE]
- [x] 4.1: Delete seed_loader.py entirely. SeedDataLoader has zero callers — it is dead code. Remove the file and any imports referencing it. Finding: seedloader-001 (dead code), seedloader-003, seedloader-004 (unreachable bugs). [SMALL]
- [x] 4.2: Remove dead methods and imports across the codebase: _expand_chunks_with_window in rag_engine.py line 271 (never called), unused imports identified in the audit. Findings: engine-001, plus various unused import findings. [SMALL]
- [x] 4.3: Remove dead path functions from app_paths.py. Functions that exist but have no callers should be removed or marked deprecated with a comment explaining why they are kept. Finding: paths-003, gui-003, paths-010. [SMALL]
- [x] 4.4: Review get_resource_path usage in app_paths.py. Verify it is correctly used for PyInstaller frozen app detection and that the _MEIPASS fallback works. Finding: paths-008 (partially supported documentation). [SMALL] (depends: 4.3)

---
## Phase 5: LLM Interface Resilience [COMPLETE]
- [x] 5.1: Add None guards in llm_interface.py for type safety. Fix lines where dict.get() results could be None but are used without checking (lines 378, 413, 481). Add proper None checks before attribute access. Findings: llm-003, llm-004, llm-007, llm-008. [SMALL] (depends: 3.3)
- [x] 5.2: Add runtime fallback in SmartLLM generate method. If the primary backend's generate() call fails at runtime (not just init), fall back to the next available backend. Currently init success is assumed to guarantee generate success. Finding: llm-009. [SMALL]
- [x] 5.3: Fix HTTP error handling in Ollama and OpenAI backends in llm_interface.py. Handle connection refused, timeout, and non-200 status codes with user-friendly error messages instead of raw exception propagation. Findings: llm-010, llm-011, llm-013. [SMALL] (depends: 5.1)
- [x] 5.4: Fix re.sub None safety in llm_interface.py line 203. The second argument to re.sub can be None, causing TypeError. Add a guard. Finding: llm-008. [SMALL] (depends: 5.1)
- [x] 5.5: Fix API key header handling. Verify API keys are passed correctly in request headers for OpenAI backend. Ensure no keys are logged or exposed in error messages. Finding: llm-012. [SMALL]
- [x] 5.6: Add connection verification to LLM backend init. When initializing Ollama or OpenAI backends, verify the connection is reachable before marking the backend as available. Finding: llm-017. [SMALL] (depends: 5.3)

**Phase 5 Notes**: Original audit findings (llm-003 through llm-017) fully addressed. Additional security hardening identified (SEC-001 through SEC-008) documented in context.md as known limitations for future security phase.

---
## Phase 6: Data Pipeline Robustness [COMPLETE]
- [x] 6.1: Fix silent pdfplumber fallback in document_processor.py line 46. When pdfplumber is not installed, the code silently falls back to pypdf without warning the user. Add a logging.warning() so users know they are running with degraded PDF extraction. Finding: datapipeline-001. [SMALL]
- [x] 6.2: Fix exception swallowing in document_processor.py chunking methods. Broad except clauses that silently discard errors should log the exception at minimum. Identify all bare except or overly broad Exception catches and add logging. Finding: datapipeline-009. [SMALL] (depends: 6.1)
- [x] 6.3: DRY refactor in document_processor.py. The audit identified copy-paste patterns (datapipeline-004) and duplicated chunking logic. Consolidate duplicated chunking code into shared helper functions. Finding: datapipeline-004. [MEDIUM] (depends: 6.2)
- [x] 6.4: Fix type safety gaps in document_processor.py. Lines 91-95 access .text and .table attributes on BaseShape without type checking. Add isinstance guards or proper type annotations. Findings: datapipeline-011, datapipeline-012, datapipeline-013. [SMALL]
- [x] 6.5: Make chunk_size and chunk_overlap configurable in document_processor.py. Currently these may be hardcoded. Ensure they accept values from RAGConfig. Finding: datapipeline-010. [SMALL] (depends: 3.1)

**Phase 6 Notes**: Task 6.5 was already implemented - DocumentProcessor constructor accepts chunk_size/chunk_overlap, and RAGEngine passes values from RAGConfig.

---
## Phase 7: Test Suite Quality [COMPLETE]
- [x] 7.1: Fix inverted regression test assertion in test_defect_003_url_validation.py. This is the same as task 1.1 but covers the full test file review — verify all assertions in the file test the correct behavior. Finding: regression-001. [SMALL] (depends: 1.1)
- [x] 7.2: Fix tautological assertions in test files: test_llm_interface.py line 350 (empty string in any string always passes), test_rag_engine.py line 152 (overly permissive substring match), unused fixture inference_config in conftest.py line 249. Findings: unittest-001, unittest-002, unittest-003. [SMALL]
- [x] 7.3: Fix mock-bypassing regression tests: test_defect_001_gui_gguf_wiring.py line 112 (mock bypasses settings migration), line 258 (test creates expected dict but never calls actual code), and test_defect_002_api_gguf_env.py lines 40/86/267 (string inspection instead of runtime behavior). Make tests actually exercise the code they claim to guard. Findings: regression-002, regression-003, regression-004, regression-005, regression-006. [LARGE] (depends: 1.1)
- [x] 7.4: Delete orphan root-level test files: test_gguf_path_wiring_final.py, test_main_gguf_path.py, test_phase1_adversarial.py, test_phase1_fixes.py. These are duplicates of tests already in tests/. Finding: orphan-tests from phase 6.3. [SMALL] (depends: 7.1)
- [x] 7.5: Improve assertion quality across all test files. Replace generic assertTrue/assertFalse with specific assertions (assertEqual, assertRaises, assertIn, etc.) where the audit identified weak assertions. Finding: unittest-004, unittest-005. [MEDIUM] (depends: 7.2)

---
## Phase 8: Build Scripts and Supply Chain [COMPLETE]
- [x] 8.1: Fix PyInstaller cross-platform separator in build.py. Replace hardcoded Unix path separators with os.path.join or Path objects. Finding: build-001. [SMALL]
- [x] 8.2: Fix os.chdir in scripts/build.py that breaks relative path resolution. Either eliminate chdir or use absolute paths. Finding: build-002. [SMALL] (depends: 8.1)
- [x] 8.3: Fix encoding issues in scripts/build_installer.py. Ensure file operations use explicit UTF-8 encoding. Finding: build-003. [SMALL]
- [x] 8.4: Fix hardcoded values in build scripts. Replace magic numbers, paths, and strings with named constants or configuration. Finding: build-004, build-005. [SMALL] (depends: 8.2)
- [x] 8.5: Fix copy_app_files flat directory issue in scripts/build_installer.py that can cause file overwrites. Use proper directory structure in the copy. Finding: build-006. [SMALL] (depends: 8.3)

---
## Phase 9: Documentation Accuracy [COMPLETE]
- [x] 9.1: Fix all 8 wrong CONFIGURATION.md defaults: settings path (line 26), backend priority order (line 264), chunk_size (line 40), DB path (line 38), phantom env vars RAG_TOP_P/RAG_DO_SAMPLE (line 61), retrieval_window (line 69), and JSON examples. Findings: configdoc-001 through configdoc-010. [MEDIUM]
- [x] 9.2: Fix README.md inaccuracies: model name inconsistency Qwen3-1.7B vs Qwen2.5-1.5B (line 20), and any other stale claims identified in the audit. Finding: doc-002, doc-003, doc-005, doc-006. [SMALL]
- [x] 9.3: Fix ARCHITECTURE.md stale claims: remove /ask/stream endpoint (line 578) that does not exist, update any other stale architecture descriptions. Finding: doc-001, doc-004, doc-007. [SMALL] (depends: 9.2)
- [x] 9.4: Fix USAGE.md phantom CLI flag --reranking (line 367) that does not exist. Remove or document actual CLI flags available. Finding: configdoc-007. [SMALL] (depends: 9.3)

---
## Phase 10: API Server and GUI Polish [COMPLETE]
- [x] 10.1: Add input validation to remaining API endpoints in api_server.py. Validate query text in /ask and /search endpoints — reject empty or whitespace-only queries with 400 Bad Request. Finding: api-001, api-002. [SMALL]
- [x] 10.2: Fix CORS configuration in api_server.py. Verify CORS settings are appropriate for a localhost-only app. Ensure no overly permissive origins. Finding: api-006. [SMALL] (depends: 10.1)
- [x] 10.3: Standardize error response format in api_server.py. All endpoints should return errors in a consistent JSON format with 'error' and 'detail' fields. Findings: api-014, api-015. [SMALL] (depends: 10.1)
- [x] 10.4: Improve GUI settings robustness in app_gui.py. Add validation for all settings fields before saving: check numeric ranges, verify paths exist, validate model file paths. Finding: gui-001 (extended), gui-005, gui-006. [MEDIUM] (depends: 1.5)
- [x] 10.5: Begin god class refactor of app_gui.py (552 lines). Extract settings management into a separate SettingsPanel class or module. This is a first-pass refactor — do NOT attempt full decomposition. Finding: gui-002. [LARGE] (depends: 10.4)
- [x] 10.6: Fix GUI thread safety concerns. Verify that background thread operations (document ingestion, query processing) do not directly modify Tkinter widgets. Use self.after() for all GUI updates from background threads. Finding: gui-003. [SMALL] (depends: 10.5)

---
## Phase 11: Remaining Polish [PENDING]
- [x] 11.1: Fix CLI factory consistency in main.py. Ensure CLI mode uses engine_factory for construction (currently bypasses it), and that all CLI arguments are properly wired to RAGConfig. Finding: engine-002 (extended), cross-003. [SMALL] (depends: 10.5)
- [x] 11.2: Fix remaining vector_store.py issues: clean up .pkl shim in BM25Index save/load(), remove any remaining dead code or stale comments. Finding: EC-004 (.pkl compatibility shim). [SMALL] (depends: 2.3)
- [x] 11.3: Fix remaining llm_interface.py issues: inconsistent patterns across backends, any remaining type safety gaps not covered in Phase 5. Findings: llm-010, llm-011, llm-013, llm-014. [SMALL] (depends: 5.3)
- [x] 11.4: Fix remaining build and configuration issues: add version upper bounds to requirements.txt (config-002), clean up any remaining hardcoded values in config files. Finding: config-002. [SMALL] (depends: 8.4)
- [x] 11.5: Fix remaining path function and docstring issues in app_paths.py and other modules. Ensure docstrings match actual function behavior (paths-010). Clean up any remaining audit findings below HIGH severity. Findings: various LOW/MEDIUM from all phases. [SMALL] (depends: 11.1)

---
## Phase 12: Final Verification and Report Update [PENDING]
- [x] 12.1: Run full test suite and verify all tests pass after remediation. Fix any tests broken by the remediation changes. This is the final verification gate before the remediation is considered complete. [MEDIUM] (depends: 11.5)
- [x] 12.2: Cross-check qa-report.md against current codebase state. Verify every finding has been addressed. Update REMEDIATION_REPORT.md to reflect the remediation performed. Do NOT modify qa-report.md. [MEDIUM] (depends: 12.1)
