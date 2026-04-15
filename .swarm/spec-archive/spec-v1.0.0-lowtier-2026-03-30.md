# Specification: Comprehensive Codebase QA Review — AI-Hardened Edition

**Version**: 1.0.0  
**Date**: 2026-03-30  
**Swarm**: lowtier  
**Project**: Document Q&A Assistant (doc_qa_app)  

---

## 1. Feature Description

### 1.1 WHAT

Conduct a comprehensive QA audit of the Document Q&A Assistant codebase to identify all defects, security vulnerabilities, AI-generated code smells, documentation drift, and supply chain risks. This is **not feature development** — it is a systematic quality assessment.

### 1.2 WHY

The codebase is heavily LLM-assisted and requires heightened skepticism. Code may appear polished but be only partially wired, dependency-unsound, or correct only on happy paths. The audit ensures production readiness and identifies systemic patterns that could cause failures.

### 1.3 SCOPE

**In Scope**:
- All Python source files (`*.py`)
- Configuration files (`requirements.txt`, `.pre-commit-config.yaml`)
- CI/CD workflows (`.github/workflows/`)
- Documentation (`README.md`, `ARCHITECTURE.md`, `USAGE.md`, `CONFIGURATION.md`)
- Test files (`tests/`)
- Build scripts (`build.py`, `scripts/`)

**Out of Scope**:
- External dependencies (only verify they exist, don't audit their code)
- Generated build artifacts (`build/`, `dist/`)
- Cached data (`.pytest_cache/`, `.ruff_cache/`)

---

## 2. User Scenarios

### Scenario 1: Development Team Needs Quality Baseline
**As a** development team  
**I want** a comprehensive QA report  
**So that** I understand the current state of code quality and can prioritize fixes  

**Acceptance Criteria**:
- [SC-001] Report identifies all CRITICAL and HIGH severity issues
- [SC-002] Report includes file paths and line numbers for every finding
- [SC-003] Report categorizes findings by type (security, broken code, AI smells, etc.)

### Scenario 2: Security Review Before Production
**As a** security reviewer  
**I want** identification of all trust boundary violations and injection vectors  
**So that** I can ensure the application is safe for production deployment  

**Acceptance Criteria**:
- [SC-004] All input validation gaps at trust boundaries are documented
- [SC-005] All SQL/command injection risks are flagged
- [SC-006] All hardcoded secrets or credentials are identified

### Scenario 3: Documentation Accuracy Verification
**As a** technical writer  
**I want** verification that documentation matches actual implementation  
**So that** users receive accurate setup and usage instructions  

**Acceptance Criteria**:
- [SC-007] All claims in README are cross-referenced with code
- [SC-008] All API examples are verified to work as documented
- [SC-009] All configuration options are documented accurately

---

## 3. Functional Requirements

### FR-001: Codebase Inventory
**MUST** create a complete inventory of:
- Tech stack (languages, frameworks, runtimes)
- Directory layout and module structure
- Dependency inventory with verification
- Public surface (routes, commands, exports, APIs)
- Trust boundaries (HTTP, CLI, env vars, files, subprocesses)

### FR-002: Serial-Batched Code Analysis
**MUST** analyze codebase in small batches (max 20 files per pass) covering:
- Check Group 1: Broken, missing, or incomplete code
- Check Group 2: Security and data handling
- Check Group 3: Cross-platform and environment assumptions
- Check Group 4: Stale comments and documentation drift
- Check Group 5: AI-generated code smells
- Check Group 6: Technical debt and architecture
- Check Group 7: Performance and observability
- Check Group 8: Test quality
- Check Group 9: Dependency and supply chain integrity

### FR-003: Cross-Boundary Verification
**MUST** perform a final pass specifically for:
- Contract changes across module boundaries
- Shared state mutations and thread safety
- Import chain verification (circular deps, version conflicts)
- Integration seam consistency

### FR-004: Finding Documentation
**MUST** document each finding with:
- Unique ID (scope-sequence format)
- Check group number (1-9)
- Severity (CRITICAL/HIGH/MEDIUM/LOW/INFO)
- Confidence (HIGH/MEDIUM)
- Exact file path and line number
- Title (specific problem name)
- Problem description (2-3 sentences, cite code)
- Fix recommendation (actionable)
- Evidence (what was checked)
- Claim status (if applicable)
- AI pattern name (if applicable)

### FR-005: Self-Critique and Validation
**MUST** validate findings through critic review:
- CRITICAL findings first (small batches)
- HIGH findings next (small batches)
- Check for false positives
- Verify coverage gaps
- Calibrate severity
- Confirm actionability

### FR-006: Synthesis and Reporting
**MUST** produce:
- Finding counts by group and severity
- AI pattern distribution
- Claim ledger summary
- Coverage notes
- Recommended remediation order

### FR-007: Final QA Report
**MUST** generate `qa-report.md` containing:
- Executive summary
- Findings count table
- Claim ledger summary
- All CRITICAL findings (full detail)
- All HIGH findings (full detail)
- All MEDIUM findings (full detail)
- All LOW findings (full detail)
- All INFO findings (full detail)
- Supply chain findings (special section)
- Unsupported/contradicted claims
- Stealth changes
- Coverage notes
- Recommended remediation order

---

## 4. Success Criteria

| ID | Criterion | Measurement |
|----|-----------|-------------|
| SC-001 | All CRITICAL issues identified | Zero undiscovered CRITICAL issues in final report |
| SC-002 | All HIGH issues identified | Zero undiscovered HIGH issues in final report |
| SC-003 | Every finding has location | 100% of findings have exact file path + line number |
| SC-004 | Signal-to-noise optimized | False positive rate < 30% after critique |
| SC-005 | Coverage documented | All files analyzed or explicitly noted as skipped |
| SC-006 | Report delivered | `qa-report.md` exists in project root |
| SC-007 | Remediation guidance | Report includes prioritized fix order |
| SC-008 | Claim verification | All user-facing claims checked against implementation |

---

## 5. Key Entities

- **Finding**: A documented issue with severity, location, and fix recommendation
- **Check Group**: One of 9 analysis categories (broken code, security, etc.)
- **Claim**: A user-facing statement about behavior (from docs, README, examples)
- **AI Pattern**: A specific failure mode common in LLM-generated code
- **Trust Boundary**: Any point where untrusted input enters the system

---

## 6. Edge Cases and Failure Modes

### Edge Case 1: Large File Count
**Risk**: Codebase has 200+ files, may exceed batch capacity  
**Mitigation**: Split into multiple explorer passes, prioritize by risk

### Edge Case 2: Missing Dependencies
**Risk**: Some imports may not resolve (optional dependencies)  
**Mitigation**: Flag as INFO if clearly optional, CRITICAL if required for core function

### Edge Case 3: Dynamic Code
**Risk**: Code uses `exec()`, `eval()`, dynamic imports  
**Mitigation**: Flag for manual review, note in coverage

### Edge Case 4: Test Files with Mocks
**Risk**: Tests may mock so thoroughly they only test mocks  
**Mitigation**: Apply mutation resilience check

### Edge Case 5: Cross-Platform Code
**Risk**: Windows-specific code may not be auditable on Linux  
**Mitigation**: Flag platform assumptions, note in findings

---

## 7. AI-Priority Checks (Statistically Common LLM Failures)

The following checks **MUST** be applied with maximum scrutiny:

1. **"Plausible but wrong" logic** — functions that look correct but fail at boundaries
2. **"Confident stub" pattern** — full signature with no-op or hardcoded body
3. **Data model mismatches** — code accessing non-existent properties
4. **Requirement-conflicting behavior** — implementation doesn't match caller/test/docs
5. **Phantom dependencies** — packages that don't exist or have suspicious names
6. **Missing input validation** at all trust boundaries
7. **Path traversal** — user input in file paths without sanitization
8. **SQL/command injection** — string interpolation instead of parameters
9. **Hardcoded Unix paths** — `/tmp`, `/dev/null`, `~/.config` without platform guards
10. **Stale scaffold comments** — TODO/FIXME on implemented code
11. **Claimed-but-unimplemented features** — docs say it works, code says otherwise
12. **Off-by-one errors** — in loops, slicing, pagination, date arithmetic
13. **Happy-path-only** — no handling for empty/null/error/retry cases
14. **Tests asserting only `toBeDefined`** — non-behavioral checks
15. **Tests that only test mocks** — thorough mocking, no real behavior verification

---

## 8. Deliverables

1. **qa-report.md** — Complete findings report (primary deliverable)
2. **Evidence bundles** — Stored in `.swarm/evidence/qa_findings/`
3. **Critique results** — Stored in `.swarm/evidence/qa_critique/`

---

## 9. Stop Condition

**DO NOT begin any fixes. DO NOT modify any source files.**

The audit stops at report generation. Wait for explicit user instructions before any remediation work.

---

## 10. References

- **Ingested Plan**: `codebase-review-swarm-research-updated-v3.md`
- **Codebase**: Document Q&A Assistant (Python, RAG-based)
- **Tech Stack**: Python 3.10+, ChromaDB, FastAPI, CustomTkinter, llama-cpp-python
