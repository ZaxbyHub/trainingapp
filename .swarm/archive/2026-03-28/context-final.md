# Context — Comprehensive Codebase QA Review
Swarm: modelrelay
Updated: 2026-03-27

---

## Project Summary
AI-hardened QA audit of a Python RAG document QA application (AFOMIS). ~3,800 lines core source, ~5,200 lines tests, ~1,700 lines scripts/build, 6 doc files. Not a feature build — discovery-only producing qa-report.md.

---

## Decisions
- **Plan structure**: 9 phases, 22 tasks, serial-batched per original methodology
- **Batching order**: Config → Data → API/Engine → GUI → Tests → Docs → Cross-Boundary → Critique → Report
- **Phase 1**: Marked COMPLETE — inventory already produced from explorer dispatch
- **pytest.ini**: Does not exist; pytest config handled via conftest.py
- **Orphan files**: 4 root-level test files confirmed duplicates of tests/ counterparts

---

## Patterns
- **Explorer dispatch pattern**: Each audit task → modelrelay_explorer with file scope + check groups → structured FINDING format
- **Evidence persistence**: Each explorer returns findings → architect writes to .swarm/evidence/qa-findings-{scope}.json
- **Synthesis approach**: Structured 8-step process in task 8.2, output to .swarm/evidence/qa-synthesis.json
- **Critic batching**: CRITICAL/HIGH findings validated in small batches by file/subsystem (10-15 per batch)

---

## File Map (from Phase 1 Inventory)

| File | Lines | Role |
|------|-------|------|
| api_server.py | 666 | FastAPI REST API server |
| app_gui.py | 552 | CustomTkinter GUI application |
| rag_engine.py | 524 | RAG orchestration |
| llm_interface.py | 503 | LLM backends (GGUF/OpenVINO/Ollama/OpenAI) |
| vector_store.py | 644 | ChromaDB + BM25 hybrid search |
| document_processor.py | 262 | PDF/DOCX/PPTX extraction and chunking |
| engine_factory.py | 207 | Unified factory for RAGEngine |
| app_paths.py | 147 | Windows path resolver |
| build.py | 237 | PyInstaller build script |
| main.py | 131 | CLI entry point |
| reranking.py | 87 | CrossEncoder reranking |
| seed_loader.py | 149 | Seed data loader |
| query_transformer.py | 53 | Query transformation |
| utils.py | 23 | RRF utility |

## Trust Boundaries
- **HTTP Inputs**: 4 endpoints (ask, search, ingest, ingest/file)
- **Env Vars**: 15+ RAG_* variables

## Known Security Limitations (Post-Phase 5)

The following security hardening items were identified during QA but are **deferred** as they exceed the original audit scope:

| ID | Issue | Severity | Rationale for Deferral |
|----|-------|----------|------------------------|
| SEC-001 | SSRF validation incomplete (IPv4-mapped IPv6 bypass) | MEDIUM | Local-only app; base_url is admin-configured, not user input |
| SEC-002 | _sanitize_error() truncation logic edge case | LOW | Requires specific short error messages; low exploitability |
| SEC-003 | Backend name in error messages may leak info | LOW | Backend names are generic ("Ollama", "GGUF"), not sensitive |
| SEC-004 | Missing prompt validation in answer_question | MEDIUM | generate() validates; answer_question delegates to generate() |
| SEC-005 | Timeout inconsistency (5s vs 30s) | LOW | _verify_connection is quick check; generate is actual workload |
| SEC-006 | Debug printing exposes internal state | LOW | Local app; prints go to console, not logs accessible remotely |
| SEC-007 | get_info() leaks model paths | LOW | Model paths are admin-configured; not user-facing in production |
| SEC-008 | OpenAI default api_key "not-required" | LOW | Literal is placeholder; actual key required by real endpoints |

**Original Audit Findings Status: COMPLETE**
- llm-003, llm-004, llm-007, llm-008 (None guards) ✅
- llm-009 (Runtime fallback) ✅
- llm-010, llm-011, llm-013 (HTTP error handling) ✅
- llm-012 (API key handling) ✅
- llm-017 (Connection verification) ✅

**Note**: Additional security hardening can be addressed in a future security-focused phase if threat model changes (e.g., if app becomes network-accessible).
- **File I/O**: document_processor, vector_store, seed_loader, api_server (temp files)
- **URL Fetches**: llm_interface (Ollama/OpenAI backends)
- **Subprocess**: build.py, scripts/build.py (build-time only)

## Orphan Files
- test_gguf_path_wiring_final.py (root) → duplicate of tests/test_gguf_path_wiring_final.py
- test_main_gguf_path.py (root) → duplicate of tests/test_main_gguf_path.py
- test_phase1_adversarial.py (root) → duplicate of tests/test_phase1_adversarial.py
- test_phase1_fixes.py (root) → duplicate of tests/test_phase1_fixes.py

## Pre-Known Edge Cases
- EC-006: CONFIGURATION.md references AppData/DocumentQA but code uses AFOMIS Help and Support
- EC-007: Backend priority order conflicts between README and CONFIGURATION docs
- EC-002: Pre-existing test failure in test_validate_url_rejects_non_standard_port_9999
- EC-003: BM25 O(N) rebuild on every add_document call
- EC-004: .pkl → .json compatibility shim in vector_store.py

---

## Phase Metrics
phase_number: 0 | total_tool_calls: 0 | coder_revisions: 0 | reviewer_rejections: 0
test_failures: 0 | security_findings: 0 | integration_issues: 0

## Agent Activity

| Tool | Calls | Success | Failed | Avg Duration |
|------|-------|---------|--------|--------------|
| read | 4753 | 4753 | 0 | 46ms |
| bash | 2783 | 2783 | 0 | 4477ms |
| edit | 1610 | 1610 | 0 | 1294ms |
| grep | 1437 | 1437 | 0 | 267ms |
| task | 815 | 815 | 0 | 137886ms |
| glob | 674 | 674 | 0 | 31ms |
| test_runner | 665 | 665 | 0 | 157ms |
| write | 263 | 263 | 0 | 10466ms |
| update_task_status | 202 | 202 | 0 | 15ms |
| todowrite | 191 | 191 | 0 | 5ms |
| pre_check_batch | 163 | 163 | 0 | 1871ms |
| save_plan | 114 | 114 | 0 | 2ms |
| lint | 66 | 66 | 0 | 2152ms |
| declare_scope | 62 | 62 | 0 | 1ms |
| phase_complete | 55 | 55 | 0 | 16ms |
| diff | 51 | 51 | 0 | 20ms |
| retrieve_summary | 49 | 49 | 0 | 3ms |
| check_gate_status | 44 | 44 | 0 | 0ms |
| write_retro | 28 | 28 | 0 | 4ms |
| invalid | 23 | 23 | 0 | 2ms |
| imports | 21 | 21 | 0 | 17ms |
| todo_extract | 12 | 12 | 0 | 2ms |
| mystatus | 12 | 12 | 0 | 1809ms |
| secretscan | 7 | 7 | 0 | 822ms |
| apply_patch | 6 | 6 | 0 | 182ms |
| symbols | 5 | 5 | 0 | 1ms |
| completion_verify | 5 | 5 | 0 | 1ms |
| evidence_check | 4 | 4 | 0 | 51ms |
| knowledgeAdd | 4 | 4 | 0 | 2ms |
| skill | 3 | 3 | 0 | 27ms |
| webfetch | 3 | 3 | 0 | 199ms |
| checkpoint | 2 | 2 | 0 | 14ms |
| knowledgeRecall | 2 | 2 | 0 | 3ms |
| curator_analyze | 1 | 1 | 0 | 5ms |
| todoread | 1 | 1 | 0 | 6ms |
