# AFOMIS Document Q&A Assistant — Remediation Plan

**Version:** 1.0.0
**Status:** Ready for Implementation
**Last Updated:** 2026-03-27
**Source:** Comprehensive QA Audit (qa-report.md, 137 raw findings, ~114 confirmed)

---

## 1. Feature Description

Remediate all confirmed findings from the AI-hardened QA audit of the AFOMIS Document Q&A Assistant. The audit identified ~114 confirmed findings across 9 check groups spanning the entire codebase: vector store, API server, LLM interface, GUI, test suite, documentation, build scripts, and configuration.

This is a **fix phase** — modifying existing source code, tests, build scripts, and documentation to address every confirmed finding from the audit. The remediation follows the audit's recommended priority order: safety-critical fixes first, then data integrity, then consistency/correctness, then dead code, then documentation, then polish.

**Primary Goal:** Fix all ~114 confirmed audit findings in priority order, ensuring no regressions.

**Secondary Goal:** Improve test quality to actually guard against the bugs found, not just pass.

---

## 2. User Scenarios

### Scenario 1: Developer Fixing Findings
**As a** developer
**I want to** follow a prioritized remediation plan
**So that** I fix the most dangerous bugs first and don't accidentally regress

**Given** the remediation plan is approved
**When** I work through tasks in order
**Then** each task fixes one logical group of related findings
**And** each task has clear acceptance criteria I can verify

### Scenario 2: Project Lead Tracking Progress
**As a** project lead
**I want to** see which findings are fixed and which remain
**So that** I can track remediation progress against the audit report

**Given** the remediation plan has phases
**When** I check plan status
**Then** I see completed, in-progress, and pending tasks
**And** each task maps to specific audit finding IDs

---

## 3. Functional Requirements

### FR-001: Critical Safety and Regression Fixes
**MUST** Fix the most dangerous confirmed findings first: inverted regression test, error detail disclosure, None guard crashes, file size limits, GUI input validation.

### FR-002: BM25 and Vector Store Overhaul
**MUST** Fix the O(N^2) BM25 rebuild pattern, add threading synchronization for concurrent access, fix delete_document BM25 inconsistency, and add rank_bm25 to requirements.txt.

### FR-003: Configuration Default Unification
**MUST** Unify chunk_size, retrieval_window, and max_tokens defaults across RAGConfig, engine_factory, CLI, and CONFIGURATION.md to a single source of truth.

### FR-004: Dead Code Removal
**MUST** Remove dead code: seed_loader.py (zero callers), _expand_chunks_with_window (never called), unused imports, and orphan root-level test files.

### FR-005: LLM Interface Resilience
**MUST** Add None guards for type safety, runtime fallback in SmartLLM, proper HTTP error handling, and consistent error patterns across all LLM backends.

### FR-006: Data Pipeline Robustness
**MUST** Fix silent pdfplumber fallback, exception swallowing in chunking, DRY violations, god function splits, and make chunk_size configurable.

### FR-007: Test Suite Quality
**MUST** Fix inverted assertion (regression-001), tautological assertions, mock-bypassing tests, delete orphan root test files, and improve assertion quality across the suite.

### FR-008: Build Scripts and Supply Chain
**MUST** Fix PyInstaller cross-platform separator, flat copy issues, encoding problems, and ensure rank_bm25 is declared in requirements.txt.

### FR-009: Documentation Accuracy
**MUST** Fix all 8 wrong CONFIGURATION.md defaults, README inaccuracies, ARCHITECTURE.md stale claims, and USAGE.md phantom CLI flags.

### FR-010: API Server and GUI Polish
**MUST** Add input validation to API endpoints, fix CORS configuration, standardize error responses, improve settings robustness, and address god class concerns.

### FR-011: Remaining Polish
**MUST** Address remaining lower-priority findings: CLI factory consistency, vector store minor fixes, LLM interface cleanup, and build/config hardening.

---

## 4. Success Criteria

| ID | Criterion | Measurement |
|----|-----------|-------------|
| SC-001 | Finding Coverage | Every confirmed finding from qa-report.md maps to at least one remediation task |
| SC-002 | No Regression | Existing passing tests still pass after each task |
| SC-003 | Test Quality | After remediation, test suite catches the bugs it was supposed to guard against |
| SC-004 | Documentation Accuracy | Every config default, endpoint, and CLI flag in docs matches actual code |
| SC-005 | Thread Safety | Vector store operations are safe for concurrent access |
| SC-006 | Dependency Integrity | requirements.txt declares all imported packages |
| SC-007 | Build Cross-Platform | Build scripts work on Windows without hardcoded Unix paths |

---

## 5. Key Entities

- **Source Modules**: api_server.py, app_gui.py, rag_engine.py, llm_interface.py, vector_store.py, document_processor.py, engine_factory.py, app_paths.py, main.py, query_transformer.py, reranking.py, seed_loader.py, utils.py
- **Build Scripts**: build.py, scripts/build.py, scripts/build_installer.py, scripts/bundle_embedding_model.py, scripts/export_seed_chunks.py
- **Test Files**: 6 unit test files, 6 regression test files, conftest.py, 4 orphan root-level test files
- **Documentation**: README.md, ARCHITECTURE.md, CONFIGURATION.md, INSTALL.md, USAGE.md, REMEDIATION_REPORT.md
- **Configuration**: requirements.txt, build_exe.bat
- **Audit Reference**: qa-report.md (read-only), .swarm/evidence/ (read-only)

---

## 6. Edge Cases and Known Constraints

### EC-001: Local-Only Desktop App
This is a single-user localhost Windows desktop app. Do NOT add authentication, CORS hardening for remote access, or network-level security that a localhost app doesn't need.

### EC-002: Tkinter self.after() is Main-Thread
GUI updates via self.after() are main-thread scheduled. Do NOT add unnecessary thread safety for Tkinter widget operations.

### EC-003: Ollama Runs on Localhost
Ollama backend connects to localhost:11434. Do NOT add retry logic for localhost connections that don't need it.

### EC-004: No Pytest.ini
pytest configuration is in tests/conftest.py. Do not create pytest.ini.

### EC-005: phase_complete() and update_task_status() Don't Work
These swarm tools have known issues in this environment. Track progress via evidence files and .swarm/plan.md manual updates only.

---

## 7. Constraints

**In Scope:**
- Fix all ~114 confirmed findings from the QA audit
- Modify source files, test files, build scripts, and documentation
- Add missing dependencies to requirements.txt
- Delete dead code (seed_loader.py, orphan tests)
- Improve test assertion quality

**Out of Scope:**
- New features or capability additions
- Performance optimization beyond fixing the O(N^2) BM25 rebuild
- Refactoring working code purely for style (only fix confirmed bugs)
- Adding authentication or remote-access security
- Modifying qa-report.md or evidence files (read-only reference)

---

## 8. Notes

### False Positive Patterns to Avoid
- Don't add authentication/CORS hardening beyond what a localhost app needs
- Don't add retry logic for localhost connections
- Don't refactor working code just because it "could be better"
- Don't add tests for stdlib behavior

### Audit Lessons to Apply
1. **Coder fabricates data** — never delegate data compilation tasks to coder
2. **Critic makes factual errors** — cross-check critic claims against actual source code
3. **Local-only app context** — focus on correctness and robustness, not remote access hardening
4. **Tkinter self.after() is main-thread** — no unnecessary thread safety for GUI updates

### Task Dependency Ordering
- Phase 1 (safety) must complete first
- Phase 2 (vector store) before Phase 6 (data pipeline)
- Phase 7 (test fixes) depends on Phase 1 (safety fixes being in place)
- Phase 10 (GUI refactor) should come last among source code work
- Phase 11 (polish) is lowest priority

---

## 9. Clarification Log

*No open clarifications. All requirements derived from qa-report.md findings.*
