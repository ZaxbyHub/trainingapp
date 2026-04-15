# Specification: Comprehensive Codebase QA Review — AI-Hardened Edition v5.1

**Version**: 5.1.0  
**Date**: 2026-04-08  
**Swarm**: paid  
**Project**: Codebase QA Audit Framework  

---

## 1. Feature Description

### 1.1 WHAT

Implement a comprehensive, AI-hardened codebase QA audit system that systematically identifies defects, security vulnerabilities, AI-generated code smells, documentation drift, and supply chain risks. This is a **quality assessment framework** designed for serial-batched subagent execution with rigorous validation gates.

The audit process uses a three-layer validation architecture:
- **Explorer Layer**: Breadth-first candidate finding generation (not final truth)
- **Reviewer Layer**: Precision validation and false-positive filtering for all severity tiers
- **Critic Layer**: Inline high-stakes challenge for CRITICAL and HIGH findings

### 1.2 WHY

LLM-assisted codebases require heightened skepticism. Code may appear polished but be only partially wired, dependency-unsound, or correct only on happy paths. This audit framework ensures:
- Signal-to-noise optimization (quality over quantity)
- Multi-layer validation before findings enter final reports
- Systematic coverage of 9 check groups across all codebase scopes
- Rigorous false-positive filtering through reviewer validation and critic challenge

### 1.3 SCOPE

**In Scope**:
- All source code files (language-agnostic, with Python as primary target)
- Configuration files (requirements.txt, package.json, etc.)
- CI/CD workflows (.github/workflows/)
- Documentation (README, ARCHITECTURE, USAGE, etc.)
- Test files and test quality analysis
- Build scripts and deployment configs
- Dependency manifests and lockfiles

**Out of Scope**:
- External dependency source code (only verify existence/versions)
- Generated build artifacts
- Cached data and temporary files
- Third-party libraries (only check integration)

---

## 2. User Scenarios

### Scenario 1: Architect Conducts Systematic Audit
**As an** audit architect  
**I want** a structured process to analyze a codebase in small, validated batches  
**So that** I can produce a high-quality QA report with minimal false positives  

**Acceptance Criteria**:
- [SC-001] Architect can dispatch explorer subagents in serial batches (1-2 at a time)
- [SC-002] Each explorer batch returns structured candidate findings with file paths and line numbers
- [SC-003] Reviewer validates all candidates before they become confirmed findings
- [SC-004] Critic challenges all CRITICAL and HIGH findings inline, per batch

### Scenario 2: Reviewer Validates Findings
**As a** reviewer agent  
**I want** clear candidate findings with exact locations and evidence  
**So that** I can efficiently validate or disprove each finding with confidence  

**Acceptance Criteria**:
- [SC-005] Every candidate has exact file path and line number
- [SC-006] Every CRITICAL/HIGH candidate has a disprove_attempt field
- [SC-007] Reviewer can mark findings as CONFIRMED, DISPROVED, UNVERIFIED, or PRE_EXISTING
- [SC-008] Reviewer performs inline finalization for MEDIUM and LOW findings

### Scenario 3: Critic Challenges High-Severity Findings
**As a** critic agent  
**I want** to challenge CRITICAL and HIGH findings immediately after reviewer validation  
**So that** high-stakes false positives are caught before entering the final report  

**Acceptance Criteria**:
- [SC-009] Critic receives only CRITICAL and HIGH confirmed findings
- [SC-010] Critic can UPHELD, DOWNGRADE, OVERTURN, or REFINE findings
- [SC-011] Critic checks for false positives, coverage gaps, and actionability
- [SC-012] Only UPHELD and REFINED findings enter the confirmed evidence set

### Scenario 4: Generate Final QA Report
**As a** development team  
**I want** a comprehensive qa-report.md with all validated findings  
**So that** I can prioritize remediation efforts based on severity and pattern  

**Acceptance Criteria**:
- [SC-013] Report includes counts by check group and severity
- [SC-014] Report includes validation statistics (confirmed, disproved, overturned)
- [SC-015] Report includes AI pattern distribution
- [SC-016] Report includes claim ledger summary
- [SC-017] Report includes recommended remediation order

---

## 3. Functional Requirements

### FR-001: Phase 0 — Codebase Inventory
**MUST** perform pre-dispatch inventory:
- Read root directory listing
- Read dependency manifests (package.json, requirements.txt, etc.)
- Read OPENCODE.md if present
- Skim top-level directory structure
- Read README/docs/release notes
- Produce mental map of: tech stack, directory layout, dependency inventory, claim inventory, public surface, trust boundaries, estimated file count

### FR-002: Phase 1 — Serial-Batched Candidate Generation
**MUST** implement explorer-based candidate generation:
- Dispatch explorers in batches of 1-2 subagents maximum
- Wait for each batch to complete before dispatching next
- Keep file scope at ≤20 files per pass (smaller for dense/risky files)
- Split by check family when helpful (claims, security, dependencies, behavior, tests, platform)
- Require exact file path + line number for every candidate
- Require disprove_attempt field for all CRITICAL and HIGH candidates
- Return structured candidate findings in defined format

### FR-003: Phase 1 Cross-Boundary Batch
**MUST** perform final explorer batch for cross-boundary issues:
- Contract changes across module boundaries
- Shared state mutations
- Import chain verification
- Integration seam checks
- Receive accumulated candidate findings to focus boundary analysis

### FR-004: Phase 2 — Candidate Validation with Severity Routing
**MUST** implement reviewer validation with inline routing:
- Reviewer validates all explorer candidates
- CRITICAL/HIGH confirmed findings → immediate inline Critic challenge
- MEDIUM/LOW confirmed findings → immediate inline Reviewer finalization
- Reviewer can mark: CONFIRMED, DISPROVED, UNVERIFIED, PRE_EXISTING
- Reviewer must provide disproof_reason for DISPROVED findings
- Reviewer must set inline_routing field for routing decisions

### FR-005: Phase 2C — Inline Critic Challenge
**MUST** implement critic challenge for CRITICAL/HIGH findings:
- Triggered immediately after each reviewer batch with CRITICAL/HIGH findings
- Critic performs false-positive challenge, coverage gap check, severity calibration, actionability check
- Critic returns: UPHELD, DOWNGRADED, OVERTURNED, REFINED
- Only UPHELD and REFINED findings enter confirmed evidence set
- OVERTURNED findings logged with rejection reason

### FR-006: Phase 2M — Inline Reviewer Finalization
**MUST** implement reviewer finalization for MEDIUM/LOW findings:
- Reviewer re-reads evidence one more time
- Verifies no mitigating control was missed
- Verifies severity calibration
- Downgrades overclaimed findings
- Records FINALIZED or DOWNGRADED status
- Only FINALIZED and DOWNGRADED findings enter confirmed evidence set

### FR-007: Phase 2A — Explorer Analysis Checklist
**MUST** apply 9 check groups to every file:
- Group 1: Broken, missing, or incomplete code (AI-PRIORITY items)
- Group 2: Security and data handling (AI-PRIORITY items)
- Group 3: Cross-platform and environment assumptions (AI-PRIORITY items)
- Group 4: Stale comments, documentation drift, claimed-vs-shipped (AI-PRIORITY items)
- Group 5: AI-generated code smells
- Group 6: Technical debt and architecture
- Group 7: Performance and observability (AI-PRIORITY items)
- Group 8: Test quality (AI-PRIORITY items)
- Group 9: Dependency and supply chain integrity

### FR-008: Phase 3 — Structured Output Formats
**MUST** implement three output formats:

#### Phase 3A: Explorer Candidate Format

```
CANDIDATE_FINDING
  id: [subagent-scope]-[sequence]
  group: [1-9]
  provisional_severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
  confidence: HIGH | MEDIUM
  file: <exact/relative/path.ext>
  line: <line number or range>
  title: <one line, specific>
  problem: <what appears wrong — factual, 2-3 sentences>
  fix: <what likely needs to be done>
  evidence: <what claim, caller, test, config, route, export, manifest, or boundary was checked>
  disprove_attempt: <CRITICAL/HIGH only — what condition was checked that could have falsified this finding, and what it showed. Required. Omitting this field on a CRITICAL or HIGH candidate is a process violation and the finding must be downgraded to MEDIUM.>
  claim_status: <optional — SUPPORTED | PARTIALLY_SUPPORTED | UNSUPPORTED | CONTRADICTED | STEALTH_CHANGE>
  ai_pattern: <optional — phantom-dependency | happy-path-only | off-by-one | context-rot | stale-api | confident-stub | copy-paste | wrong-framework | unsupported-claim | stealth-change | other>
  size: S | M | L
END
```

**Confidence gate**: If Explorer cannot reach at least MEDIUM confidence, it must not emit the candidate.

**CRITICAL/HIGH self-challenge gate**: Any CRITICAL or HIGH candidate missing a populated `disprove_attempt` field is automatically treated as MEDIUM by the architect and routed to Reviewer accordingly. An empty, vague, or placeholder `disprove_attempt` (e.g. "N/A", "none", "no disproof possible") fails the gate and triggers the same downgrade.

#### Phase 3B: Reviewer Validation Format

```
VALIDATED_FINDING
  candidate_id: [explorer-scope-sequence]
  status: CONFIRMED | DISPROVED | UNVERIFIED | PRE_EXISTING
  severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
  confidence: HIGH | MEDIUM
  file: <exact/relative/path.ext>
  line: <line number or range>
  title: <one line>
  problem: <final factual statement of the issue or the disproof>
  fix: <actionable remediation, or N/A if disproved>
  evidence: <what Reviewer checked to validate or disprove the candidate>
  disproof_reason: <required when status=DISPROVED>
  verification_mode: STATIC | STATIC_PLUS_RUNTIME
  runtime_validation: <command/flow used, or N/A>
  claim_status: <optional>
  ai_pattern: <optional>
  inline_routing: CRITIC_REQUIRED | REVIEWER_FINALIZED | REVIEWER_DOWNGRADED
  finalization_status: <FINALIZED | DOWNGRADED — required for MEDIUM and LOW findings>
  size: S | M | L
END
```

**Rules**:
- status=CONFIRMED requires exact file/line evidence
- status=DISPROVED requires an explicit disproof_reason
- status=UNVERIFIED means suspicious but not proven
- status=PRE_EXISTING means real but not introduced by the current target scope when that distinction matters
- inline_routing=CRITIC_REQUIRED must be set for every CONFIRMED CRITICAL or HIGH finding
- inline_routing=REVIEWER_FINALIZED must be set for MEDIUM and LOW findings that passed inline finalization
- inline_routing=REVIEWER_DOWNGRADED must be set for MEDIUM and LOW findings that were downgraded during inline finalization
- finalization_status is required for every MEDIUM and LOW finding

#### Phase 3C: Inline Critic Result Format

```
CRITIC_RESULT
  candidate_id: [validated-finding-id]
  verdict: UPHELD | DOWNGRADED | OVERTURNED | REFINED
  original_severity: CRITICAL | HIGH
  final_severity: <severity after verdict — same as original if UPHELD>
  file: <exact/relative/path.ext>
  line: <line number or range>
  title: <final one-line title>
  problem: <final factual statement — unchanged if UPHELD, reworded if REFINED>
  fix: <final actionable fix — unchanged if UPHELD, clarified if REFINED, N/A if OVERTURNED>
  verdict_reason: <required for DOWNGRADED, OVERTURNED, and REFINED — explain the challenge and decision>
  coverage_gap: <optional — sibling files or paths that should be checked for the same pattern>
END
```

**Rules**:
- UPHELD — finding enters confirmed evidence set at original severity
- REFINED — finding enters confirmed evidence set at original severity with updated text
- DOWNGRADED — finding enters confirmed evidence set at the new lower severity
- OVERTURNED — finding is dropped; rejection reason logged in Validation Notes
- Critic must not OVERTURN a finding without a specific, evidence-grounded reason
- Critic must not UPHOLD a finding that cannot withstand the false positive challenge

### FR-009: Phase 4 — Architect Synthesis
**MUST** implement evidence synthesis:
- Load all qa_candidate_findings, qa_validated_findings, qa_critic_results
- Deduplicate findings by file/line
- Drop DISPROVED and OVERTURNED findings
- Keep only CONFIRMED and PRE_EXISTING that passed inline routing
- Cluster by AI failure mode
- Build claim ledger summary
- Count findings by group, severity, validation status
- Count critic overturns and downgrades

### FR-010: Phase 5 — Final Report Generation
**MUST** generate qa-report.md with:
- Executive summary
- Findings count by group and severity
- Validation outcomes statistics
- Inline Critic outcomes
- Inline Reviewer finalization outcomes
- AI Pattern distribution
- Claim ledger summary
- CRITICAL and HIGH findings (full detail)
- MEDIUM findings (full detail)
- LOW and INFO findings (condensed)
- Pre-existing findings
- Unsupported/contradicted claims
- Stealth changes
- Coverage notes
- Recommended remediation order

---

## 4. Success Criteria

| ID | Criterion | Measurement |
|----|-----------|-------------|
| SC-001 | Serial batching enforced | No more than 2 explorer subagents dispatched simultaneously |
| SC-002 | Reviewer validation coverage | 100% of explorer candidates receive reviewer validation |
| SC-003 | Critic challenge coverage | 100% of CRITICAL/HIGH confirmed findings receive inline critic challenge |
| SC-004 | Reviewer finalization coverage | 100% of MEDIUM/LOW confirmed findings receive inline finalization |
| SC-005 | Location precision | 100% of findings have exact file path + line number |
| SC-006 | Disprove attempt gate | 100% of CRITICAL/HIGH candidates have populated disprove_attempt |
| SC-007 | Signal-to-noise ratio | False positive rate < 30% after validation |
| SC-008 | Report completeness | qa-report.md contains all required sections |
| SC-009 | Validation transparency | Report includes counts of confirmed, disproved, overturned |
| SC-010 | No premature completion | All planned scopes explored before report generation |

---

## 5. Key Entities

- **Finding**: Documented issue with severity, location, and fix recommendation
- **Candidate Finding**: Explorer-generated potential issue (not yet validated)
- **Validated Finding**: Reviewer-confirmed issue with validation status
- **Critic Result**: Challenge outcome for CRITICAL/HIGH findings
- **Check Group**: One of 9 analysis categories (1-9)
- **Severity**: CRITICAL, HIGH, MEDIUM, LOW, INFO
- **Confidence**: HIGH, MEDIUM
- **Claim**: User-facing statement about behavior (from docs, README, examples)
- **AI Pattern**: Specific failure mode common in LLM-generated code
- **Trust Boundary**: Point where untrusted input enters the system
- **Disprove Attempt**: Condition checked that could falsify a CRITICAL/HIGH finding

---

## 6. Edge Cases and Failure Modes

### Edge Case 1: Large File Count
**Risk**: Codebase has 200+ files, may exceed batch capacity  
**Mitigation**: Split into multiple explorer passes, prioritize by risk, never compress workflow

### Edge Case 2: Missing Dependencies
**Risk**: Some imports may not resolve (optional dependencies)  
**Mitigation**: Flag as INFO if clearly optional, CRITICAL if required for core function

### Edge Case 3: Dynamic Code
**Risk**: Code uses exec(), eval(), dynamic imports  
**Mitigation**: Flag for manual review, note in coverage

### Edge Case 4: Empty Disprove Attempt
**Risk**: Explorer emits CRITICAL/HIGH without valid disprove_attempt  
**Mitigation**: Architect auto-downgrades to MEDIUM before reviewer sees it

### Edge Case 5: Reviewer Cannot Validate
**Risk**: Missing context or unavailable runtime path prevents validation  
**Mitigation**: Mark UNVERIFIED rather than DISPROVED or CONFIRMED

### Edge Case 6: Critic Overturns All Findings
**Risk**: All CRITICAL/HIGH findings overturned in a batch  
**Mitigation**: Log rejection reasons, adjust explorer guidance for next batch

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
9. **Hardcoded Unix paths** — /tmp, /dev/null, ~/.config without platform guards
10. **Stale scaffold comments** — TODO/FIXME on implemented code
11. **Claimed-but-unimplemented features** — docs say it works, code says otherwise
12. **Off-by-one errors** — in loops, slicing, pagination, date arithmetic
13. **Happy-path-only** — no handling for empty/null/error/retry cases
14. **Tests asserting only structural properties** — non-behavioral checks
15. **Tests that only test mocks** — thorough mocking, no real behavior verification

---

## 8. Deliverables

1. **qa-report.md** — Complete findings report (primary deliverable)
2. **Evidence bundles** — Stored in .swarm/evidence/qa_findings/
3. **Validation receipts** — Stored in .swarm/evidence/qa_validated/
4. **Critic results** — Stored in .swarm/evidence/qa_critique/
5. **Claim ledger** — Documentation of supported/partially-supported/unsupported/contradicted claims

---

## 9. Stop Condition

**DO NOT begin any fixes. DO NOT modify any source files.**

The audit stops at report generation. Wait for explicit user instructions before any remediation work.

---

## 10. Process Rules

- Explorer generates breadth, not truth
- Reviewer validates candidates before they become findings — for all severity tiers
- Critic challenges CRITICAL and HIGH findings inline, immediately after each reviewer batch
- Reviewer finalizes MEDIUM and LOW findings inline, within the same validation batch
- Architect persists every stage as evidence
- No finding without exact file and line evidence
- No approval without positive evidence of what was checked
- If a candidate cannot be proven, mark UNVERIFIED rather than CONFIRMED
- If a finding is disproved, remove it from main report and record rejection reason
- If a finding is real but not introduced here, mark PRE_EXISTING
- If a CRITICAL or HIGH finding has not passed inline Critic challenge, it cannot enter final report
- If a MEDIUM or LOW finding has not passed inline Reviewer finalization, it cannot enter final report
- If a CRITICAL or HIGH candidate is missing populated disprove_attempt, architect downgrades to MEDIUM

---

## 11. References

- **Ingested Plan**: codebase-review-swarm-research-updated-v5.1.md
- **Plan Version**: 5.1 (AI-Hardened Edition)
- **Swarm**: paid
- **Previous Version Archived**: spec-v1.0.0-lowtier-2026-03-30.md, plan-v1.0.0-lowtier-2026-04-07.md
