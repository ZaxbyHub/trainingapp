# Comprehensive Codebase QA Review — AI-Hardened Edition

**Version:** 1.0.0  
**Status:** Ready for Implementation  
**Last Updated:** 2026-03-27

---

## 1. Feature Description

Conduct a deep, AI-hardened QA audit of the Document Q&A Assistant (AFOMIS) codebase. This is **not a feature build** — it is a structured discovery process that finds every problem in existing shipped code and produces a comprehensive, evidence-backed report (`qa-report.md`).

The codebase is a Python RAG application (~3,800 lines of core source, ~5,200 lines of tests, ~1,700 lines of scripts/build) that has undergone multiple remediation sprints and is suspected of containing LLM-assisted code patterns. The audit must apply heightened skepticism: code that looks polished may be only partially wired, dependency-unsound, or only correct on the happy path.

**Primary Goal:** Produce a complete, signal-optimized QA report with every finding backed by exact file path and line number, at minimum MEDIUM confidence, covering 9 check groups across all auditable files.

**Secondary Goal:** Generate a prioritized remediation plan so developers can act on findings immediately.

---

## 2. User Scenarios

### Scenario 1: Developer Consuming the QA Report
**As a** developer on this project  
**I want to** read the QA report and immediately know what to fix, in what order, and why  
**So that** I can remediate issues without needing to re-investigate

**Given** the QA report is generated  
**When** I read the findings  
**Then** each finding has an exact file path and line number  
**And** each finding has a specific, actionable fix description  
**And** findings are sorted by severity so I can triage efficiently

### Scenario 2: Project Lead Assessing Codebase Health
**As a** project lead  
**I want to** see an executive summary and counts table  
**So that** I can assess overall codebase health and decide on remediation investment

**Given** the QA report is generated  
**When** I read the executive summary  
**Then** I see overall health assessment, dominant failure patterns, and estimated remediation scope  
**And** I see a counts table with findings broken down by severity and check group  
**And** I see the AI pattern distribution showing systemic LLM-assisted code issues

### Scenario 3: Security Reviewer Checking Trust Boundaries
**As a** security reviewer  
**I want to** see all security and supply chain findings isolated and highlighted  
**So that** I can verify no critical vulnerabilities remain

**Given** the QA report is generated  
**When** I read the security and supply chain sections  
**Then** all Group 2 (Security) and Group 9 (Supply Chain) findings are listed regardless of severity  
**And** unsupported or contradicted shipped claims are called out separately

---

## 3. Functional Requirements

### FR-001: Codebase Inventory and Scope Mapping
**MUST** Produce a complete file inventory with line counts, roles, trust boundaries, and public API surface before any analysis begins.

**Acceptance Criteria:**
- Every Python file in the repository is cataloged with line count and purpose
- All API routes are listed with method, path, handler function, and trust boundary classification
- All CLI arguments are enumerated
- All exported classes and functions per module are documented
- Trust boundaries (HTTP inputs, file I/O, env vars, subprocess calls, URL fetches) are mapped with file and line references

### FR-002: Check Group 1 — Broken, Missing, or Incomplete Code
**MUST** Audit every file for broken wiring, stubs, dead code, unreachable branches, and mismatched interfaces.

**Acceptance Criteria:**
- Every function body is verified to be wired (not a no-op or hardcoded return)
- Every declared API route/CLI command has a confirmed working handler
- All TODO/FIXME/HACK/PLACEHOLDER/STUB comments are evaluated and classified
- Dead branches (feature flags always resolving to one side) are identified
- Commented-out code blocks exceeding 5 lines are flagged
- Functions with parameters that no caller provides are identified
- Async functions called without await where not intentional are flagged
- Interfaces or abstract classes declared but never instantiated are identified

### FR-003: Check Group 2 — Security and Data Handling
**MUST** Systematically check every trust boundary for input validation gaps, injection vectors, path traversal, and data leakage.

**Acceptance Criteria:**
- Every HTTP input endpoint is checked for missing or insufficient validation
- Every file I/O path that uses user-controlled input is checked for path traversal
- Every URL fetch target is checked for SSRF / DNS rebinding
- Logging statements are checked for sensitive data leakage
- Unsafe deserialization patterns (eval, pickle, unsafe YAML) are verified absent
- Authentication/authorization gaps on privileged operations are flagged
- Race conditions on shared mutable state are identified

### FR-004: Check Group 3 — Cross-Platform and Environment Assumptions
**MUST** Identify all platform-specific assumptions that could cause failures on non-development platforms.

**Acceptance Criteria:**
- Hardcoded Unix paths (`/tmp`, `/dev/null`, `~/.config`, `/etc/`) are flagged
- Hardcoded path separators (`/` or `\\`) instead of `os.path.join` are flagged
- Shell commands using Unix-specific syntax are identified
- Environment variable assumptions (missing var = crash) are identified
- Case-sensitive file lookups that could fail on Windows/macOS are flagged

### FR-005: Check Group 4 — Stale Comments, Documentation Drift, and Claimed-vs-Shipped Mismatch
**MUST** Compare every claim in README, ARCHITECTURE.md, CONFIGURATION.md, INSTALL.md, USAGE.md, and REMEDIATION_REPORT.md against actual code behavior.

**Acceptance Criteria:**
- Every feature/endpoint/config key/environment variable mentioned in docs is verified to exist in code
- Every API endpoint documented in README and ARCHITECTURE.md is verified to be wired in api_server.py
- Every CLI argument documented in README is verified in main.py argparse
- Version numbers, dates, and "Last Updated" fields across docs are checked for consistency
- Docstrings that describe different behavior than the function performs are flagged
- Architecture diagrams that no longer match actual module structure are flagged
- Stealth changes (material behavior changes without matching doc updates) are identified

### FR-006: Check Group 5 — AI-Generated Code Smells
**MUST** Apply maximum scrutiny AI-specific detection patterns to every file, treating the codebase as potentially LLM-assisted.

**Acceptance Criteria:**
- Over-abstraction cascades (Factory → Builder → Provider → Adapter for one implementation) are identified
- Phantom interfaces (defined, one implementer, zero polymorphic usage) are identified
- Unnecessary async functions (never await, no I/O) are flagged
- Copy-paste duplication (same logic in 3+ files with only variable name changes) is identified
- Comments that merely restate the code are flagged
- Off-by-one errors in loops, slicing, pagination, and boundary math are verified
- Happy-path-only implementations (no handling for empty/null/error/retry) are flagged
- Boolean logic inversions (&& where || needed) are checked
- Stale API usage (deprecated or outdated library signatures) is verified against installed versions
- Context rot (code internally consistent but contradicting file conventions) is identified

### FR-007: Check Group 6 — Technical Debt and Architecture
**MUST** Identify architectural issues including circular dependencies, god functions, inconsistent patterns, and resource leaks.

**Acceptance Criteria:**
- Circular dependencies between modules are detected
- God functions exceeding 80 lines or classes exceeding 300 lines are identified
- Inconsistent patterns (two modules solving the same problem differently) are documented
- Hardcoded values that should be constants or config are flagged
- Missing retry logic or error boundaries on I/O operations are identified
- Memory leaks (uncleaned event listeners, unbounded caches/growing Maps) are identified
- Resources opened without guaranteed cleanup (no finally/using/defer) are flagged

### FR-008: Check Group 7 — Performance and Observability
**MUST** Identify excessive I/O in loops, blocking operations in async contexts, and missing caching opportunities.

**Acceptance Criteria:**
- Filesystem/database/network calls inside loops where batching is feasible are flagged
- Synchronous I/O in hot paths or async contexts is identified
- Missing caching where the same expensive computation runs with identical inputs is noted
- Type safety gaps (untyped parameters, missing generics, unvalidated casts) are identified
- Missing logging/tracing on error paths or high-value operations is flagged

### FR-009: Check Group 8 — Test Quality
**MUST** Evaluate all test files for assertion quality, edge case coverage, and mutation resilience.

**Acceptance Criteria:**
- Tests asserting only `toBeDefined`/`toBeTruthy`/`not.toBeNull` without behavioral checks are flagged
- Tests with zero assertions are flagged
- Tests that mock every dependency so thoroughly they only test mock setup are flagged
- Missing edge case coverage (empty, null, max value, error path, concurrent calls) is identified
- Tests relying on external state (live network, real filesystem) without isolation are flagged
- Wrong framework imports or runner misuse are flagged
- For critical-path tests: mutation resilience is evaluated (would trivial code changes be caught?)

### FR-010: Check Group 9 — Dependency and Supply Chain Integrity
**MUST** Verify every package in dependency manifests is a real, published package with correct pinned versions.

**Acceptance Criteria:**
- Every package in requirements.txt is verified as existing in PyPI
- Packages matching AI hallucination naming patterns are flagged
- Packages where the pinned version does not exist are flagged
- Imports referencing packages not in requirements.txt are flagged
- Dependencies mentioned in docs/examples/install commands but absent from manifests are flagged

### FR-011: Cross-Boundary Verification
**MUST** Verify consistency across module boundaries after scope-specific analysis is complete.

**Acceptance Criteria:**
- Contract changes (function signatures, type exports) are verified consistent with all consumers
- Shared state mutations are checked for concurrent access safety
- Import chains are traced for circular dependencies and orphaned re-exports
- Integration seams (API ↔ RAG engine, DB ↔ business logic, GUI ↔ engine) have verified consistent contracts

### FR-012: Self-Critique and False Positive Rejection
**MUST** Run a structured self-critique pass on all findings to reject false positives before final report generation.

**Acceptance Criteria:**
- Every CRITICAL finding is individually verified by a critic agent
- Every HIGH finding is individually verified by a critic agent
- False positive cost model is applied: findings below 70% true positive probability are rejected
- Coverage gap challenge: if a pattern was found in one file, sibling files are checked
- Severity calibration is validated against actual impact

### FR-013: Final Report Generation
**MUST** Write a complete QA report to `qa-report.md` with all findings, counts tables, claim ledger, and remediation order.

**Acceptance Criteria:**
- Report contains executive summary (2-3 sentences)
- Counts table with findings per group and severity is included
- AI pattern distribution is included
- Claim ledger summary (supported/partially_supported/unsupported/contradicted/stealth_change) is included
- All CRITICAL findings are listed with full detail
- All HIGH findings are listed with full detail
- All MEDIUM and LOW findings are listed with full detail
- Supply chain findings are given special prominence
- Unsupported claims and stealth changes are listed separately
- Coverage notes identify areas not fully reviewed
- Recommended remediation order is provided
- Every finding has exact file path and line number

### FR-014: Orphan File Cleanup
**MUST** Flag files that are duplicated, misplaced, or have no consumers.

**Acceptance Criteria:**
- Root-level test files duplicated in `tests/` are identified (test_gguf_path_wiring_final.py, test_main_gguf_path.py, test_phase1_adversarial.py, test_phase1_fixes.py)
- Source files with zero imports from any other module are identified
- Dead code (unreachable functions, unused imports) is cataloged

---

## 4. Success Criteria

| ID | Criterion | Measurement |
|----|-----------|-------------|
| SC-001 | File Coverage | Every Python file in the repo (excluding __pycache__, dist/, build/, .swarm/) is read and analyzed |
| SC-002 | Finding Evidence | Every finding cites an exact file path and line number or line range |
| SC-003 | Finding Confidence | Every finding has at least MEDIUM confidence; LOW confidence findings are rejected |
| SC-004 | False Positive Rate | Self-critique pass rejects findings below 70% true positive probability |
| SC-005 | Check Group Coverage | All 9 check groups are applied to every file in scope |
| SC-006 | Claim Verification | Every feature/endpoint/config claim in README.md, ARCHITECTURE.md, CONFIGURATION.md, INSTALL.md, and USAGE.md is verified against code |
| SC-007 | Supply Chain Completeness | Every package in requirements.txt is verified as real and existing in PyPI |
| SC-008 | Report Completeness | qa-report.md contains all required sections per FR-013 |
| SC-009 | Remediability | Every finding includes a specific, actionable fix description |
| SC-010 | Signal-to-Noise | Report contains confirmed findings only; no unverified speculation |

---

## 5. Key Entities

- **Source Modules**: api_server.py, app_gui.py, rag_engine.py, llm_interface.py, vector_store.py, document_processor.py, engine_factory.py, app_paths.py, main.py, query_transformer.py, reranking.py, seed_loader.py, utils.py
- **Build Scripts**: build.py, scripts/build.py, scripts/build_installer.py, scripts/bundle_embedding_model.py, scripts/export_seed_chunks.py
- **Test Files**: 6 unit test files, 6 regression test files, conftest.py, 4 orphan root-level test files
- **Documentation**: README.md, ARCHITECTURE.md, CONFIGURATION.md, INSTALL.md, USAGE.md, REMEDIATION_REPORT.md
- **Configuration**: requirements.txt, build_exe.bat, pytest.ini
- **Dependency Manifest**: requirements.txt (28 lines, 16 packages)
- **Trust Boundaries**: 4 HTTP input endpoints, 15+ environment variables, file I/O paths in document_processor/vector_store/seed_loader, URL fetches in llm_interface

---

## 6. Edge Cases and Known Failure Modes

### EC-001: Root-Level Orphan Test Files
Four test files exist both in the repository root and in `tests/`. The QA audit should determine which is canonical and flag the duplicates for removal.

### EC-002: Pre-Existing Test Failure
`test_phase1_adversarial.py::test_validate_url_rejects_non_standard_port_9999` is known to fail due to a regex mismatch in the test's `match=` string. The audit should verify this is accurately documented and not a sign of a broader issue.

### EC-003: BM25 O(N) Rebuild
`BM25Index.add_document()` rebuilds the full BM25Okapi index on every add call. This is documented as a known limitation but the audit should assess whether the documentation adequately warns users of the performance impact at scale.

### EC-004: .pkl Compatibility Shim
`vector_store.py` has a `.pkl` → `.json` path translation shim in BM25Index.save()/load(). This should be flagged for cleanup once all call sites are migrated.

### EC-005: Architecture Doc Staleness
ARCHITECTURE.md was last updated 2026-02-28 while README.md shows 2026-03-01. The audit should check whether the architecture description still matches the actual codebase after multiple remediation sprints.

### EC-006: CONFIGURATION.md Settings Path Mismatch
CONFIGURATION.md references `AppData/DocumentQA/app_settings.json` while the actual codebase uses `app_paths.py` which resolves to `%LOCALAPPDATA%/AFOMIS Help and Support/settings.json`. This is a potential claimed-vs-shipped mismatch.

### EC-007: OpenVINO Backend Priority Conflict
README.md lists backend priority as GGUF → OpenVINO → OpenAI → Ollama, but CONFIGURATION.md lists it as GGUF → OpenVINO → Ollama → OpenAI. The audit must verify the actual code-level priority order.

---

## 7. Constraints and Non-Goals

**In Scope:**
- All Python source files (13 core modules)
- All build scripts (5 files)
- All test files (17 files including 4 orphans)
- All documentation files (6 .md files)
- All configuration files (requirements.txt, build_exe.bat, pytest.ini)
- Trust boundary analysis
- Supply chain verification
- AI code smell detection
- Test quality assessment
- Documentation claim verification

**Out of Scope:**
- Binary files, executables, compiled artifacts (dist/, build/)
- SQLite database contents (doc_qa_db/chroma.sqlite3)
- External package source code (node_modules, vendor directories)
- Running the application or executing tests for behavioral verification
- Writing fixes or modifying any source files
- Performance profiling or benchmarking
- Accessibility review

---

## 8. Notes

### Audit Methodology
The audit follows a serial-batched approach:
1. **Phase 0**: Orchestrator reads codebase directly for mental map
2. **Phase 1**: Serial-batched explorer subagents analyze files in small scopes (≤20 files per pass)
3. **Phase 2**: All 9 check groups applied to every file in scope
4. **Phase 3**: Findings returned in structured format with exact file+line evidence
5. **Phase 4**: Synthesis with deduplication, cross-reference, AI pattern clustering, and severity elevation
6. **Phase 5**: Self-critique pass validates findings in small batches (CRITICAL first, then HIGH, MEDIUM, LOW)
7. **Phase 6**: Final report written to qa-report.md

### Signal-to-Noise Directive
A report with 30 confirmed findings is worth more than one with 100 findings where 40 are false positives. Every finding that survives to the final report must justify its presence with concrete evidence and at least MEDIUM confidence.

### Threat Model
Assume the code may be heavily LLM-assisted. Apply heightened skepticism to:
- Code that looks polished but may be only partially wired
- Comments, docs, examples, release notes, and test names (treated as claims, not proof)
- Dependencies that follow AI naming patterns
- Functions that appear correct on inspection but produce wrong results at boundary conditions

### Finding Format
All findings use structured format:
```
FINDING
  id: [scope]-[sequence]
  group: [1-9]
  severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
  confidence: HIGH | MEDIUM
  file: <exact/path.ext>
  line: <line or range>
  title: <specific problem name>
  problem: <what is wrong — factual, 2-3 sentences>
  fix: <actionable and specific>
  evidence: <optional — claim/source checked>
  claim_status: SUPPORTED | PARTIALLY_SUPPORTED | UNSUPPORTED | CONTRADICTED | STEALTH_CHANGE
  ai_pattern: <optional — AI failure mode name>
  size: S | M | L
END
```

---

## 9. Clarification Log

*No open clarifications. All requirements derived from the provided QA audit plan.*
