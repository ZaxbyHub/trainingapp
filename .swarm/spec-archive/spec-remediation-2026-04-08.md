# Specification: Document Q&A Assistant Remediation v2.0

**Version**: 2.0.0  
**Date**: March 30, 2026  
**Project**: Document Q&A Assistant - Remediation & Feature Completion  
**Based on**: QA Audit Report v1.0 (106 issues identified)  
**Authorization**: User explicitly requested implementation after QA audit completion  

---

## 1. Feature Description

### 1.1 WHAT

Fix all 106 issues identified in the comprehensive QA audit and implement all promised features to 100% functionality. This is a **remediation project** following the completion of a read-only QA audit.

### 1.2 WHY

The QA audit identified critical bugs, security vulnerabilities, and three completely unimplemented features that are documented but non-functional. This remediation ensures:
- Core functionality works as designed
- Security vulnerabilities are patched
- All documented features are fully implemented
- Code quality meets production standards

### 1.3 SCOPE

**In Scope**:
- Fix 2 CRITICAL issues (broken hybrid search, O(N²) BM25 performance)
- Fix 7 HIGH severity issues (security, architecture)
- Implement 3 unimplemented features (query transformation, window expansion, reranking)
- Fix 45 MEDIUM priority issues (code smells, performance)
- Address 52 LOW priority issues (documentation, style)
- Add comprehensive tests for all new functionality
- Update documentation to match implementation

**Out of Scope**:
- New features not already documented
- Major architectural rewrites
- Changing programming languages or frameworks
- External dependencies not in requirements.txt

### 1.4 Authorization Note

This specification **supersedes** the QA Audit v1.0 stop condition ("DO NOT begin any fixes") per explicit user authorization. The QA audit phase is complete; this is a new remediation phase.

---

## 2. User Scenarios

### Scenario 1: User Enables Query Transformation
**As a** user configuring the application  
**I want** to enable query transformation in settings  
**So that** my specific questions are generalized for better retrieval  

**Acceptance Criteria**:
- [SC-001] Query transformation toggle exists in Settings dialog
- [SC-002] When enabled, step-back queries are generated before retrieval
- [SC-003] When disabled, original queries are used unchanged
- [SC-004] If transformation fails, original query is used (graceful fallback)

### Scenario 2: User Uses Window Expansion
**As a** user asking questions about documents  
**I want** window expansion to retrieve adjacent chunks  
**So that** I get more context around relevant sections  

**Acceptance Criteria**:
- [SC-005] Window expansion setting persists between sessions
- [SC-006] When window > 0, adjacent chunks are included in context
- [SC-007] Window expansion works with both vector and hybrid search
- [SC-008] Duplicate chunks from overlapping windows are deduplicated

### Scenario 3: User Enables Reranking
**As a** user needing precise search results  
**I want** to enable cross-encoder reranking  
**So that** results are reordered by semantic relevance  

**Acceptance Criteria**:
- [SC-009] Reranking toggle exists in Settings dialog
- [SC-010] When enabled, initial results are reranked before display
- [SC-011] Reranking model loads lazily (on first use)
- [SC-012] If reranking fails, initial results are used (graceful fallback)

### Scenario 4: Hybrid Search Returns Relevant Results
**As a** user querying with hybrid search enabled  
**I want** only results above the similarity threshold  
**So that** I don't see irrelevant matches  

**Acceptance Criteria**:
- [SC-013] Hybrid search applies min_similarity filter
- [SC-014] Results below threshold are excluded
- [SC-015] At least n_results are returned (if available above threshold)

---

## 3. Functional Requirements

### FR-001: Hybrid Search Similarity Filtering
**MUST** apply min_similarity filter to hybrid search results before returning.

### FR-002: BM25 Performance Optimization
**MUST** implement O(N) amortized BM25 updates using lazy rebuilding with batching.

### FR-003: Query Transformation Implementation
**MUST** wire existing QueryTransformer into RAGEngine.query() pipeline when enabled.

### FR-004: Window Expansion Implementation
**MUST** implement window expansion in VectorStore to retrieve adjacent chunks around matches.

### FR-005: Cross-Encoder Reranking Implementation
**MUST** wire existing CrossEncoderReranker into RAGEngine.query() pipeline when enabled.

### FR-006: GUI Factory Integration
**MUST** refactor GUI to use engine_factory.create_engine_from_settings() instead of manual construction.

### FR-007: API Environment Variable Support
**MUST** update API server to read all RAG_* environment variables for advanced settings.

### FR-008: Version Standardization
**MUST** standardize version to 2.0.0 across all files and documentation.

### FR-009: Comprehensive Testing
**MUST** add tests for all new functionality with >85% coverage.

### FR-010: Documentation Updates
**MUST** update all documentation to match implementation.

---

## 4. Success Criteria

| ID | Criterion | Measurement |
|----|-----------|-------------|
| SC-001 | All CRITICAL issues fixed | 0 open CRITICAL issues |
| SC-002 | All HIGH issues fixed | 0 open HIGH issues |
| SC-003 | All promised features implemented | 3/3 features functional |
| SC-004 | Test coverage | >85% for new code |
| SC-005 | All tests pass | 100% test pass rate |
| SC-006 | No new security issues | Security scan clean |
| SC-007 | Performance benchmarks met | BM25 rebuild <1s for 10K chunks |
| SC-008 | Documentation accurate | All docs match implementation |
| SC-009 | Version consistent | 2.0.0 across all files |
| SC-010 | Backward compatibility | Existing configs work unchanged |

---

## 5. Key Entities

- **RAGEngine**: Main orchestrator (to be fixed and extended)
- **VectorStore**: ChromaDB + BM25 hybrid search (critical fixes needed)
- **QueryTransformer**: Step-back query generation (needs wiring)
- **CrossEncoderReranker**: Result reranking (needs wiring)
- **SettingsDialog**: GUI configuration (needs new toggles)
- **RAGConfig**: Configuration dataclass (already has flags, needs usage)

---

## 6. Edge Cases and Failure Modes

### Edge Case 1: Query Transformation Failure
**Risk**: LLM fails to generate step-back query  
**Mitigation**: Use original query as fallback (implemented in error handler)

### Edge Case 2: Window Expansion Out of Bounds
**Risk**: Window extends beyond available chunks  
**Mitigation**: Clamp to valid range (0 to len(chunks)-1)

### Edge Case 3: Reranking Model Load Failure
**Risk**: CrossEncoder model fails to load  
**Mitigation**: Disable reranking, use initial results, log warning

### Edge Case 4: BM25 Rebuild During Query
**Risk**: Query arrives while index is rebuilding  
**Mitigation**: Use old index until rebuild completes (dirty flag pattern)

### Edge Case 5: All Results Below Similarity Threshold
**Risk**: min_similarity filter excludes all results  
**Mitigation**: Return empty list (correct behavior), UI shows "no relevant results"

---

## 7. Stop Condition

**This remediation project is complete when:**
1. All 106 issues from QA audit are addressed
2. All 3 promised features are fully implemented and tested
3. All success criteria (SC-001 through SC-010) are met
4. Final validation checklist is complete
5. Version 2.0.0 is tagged and released

**DO NOT**:
- Add new features beyond the 3 promised features
- Change frameworks or languages
- Remove existing functionality
- Skip test coverage requirements

---

## 8. References

- QA Audit Report v1.0: `qa-report-final-validated.md`
- Original Implementation Plan: `IMPLEMENTATION_PLAN.md`
- Codebase: Document Q&A Assistant (doc_qa_app)
- Previous Spec (Audit Phase): `.swarm/spec.md` (superseded for remediation)

---

**Specification Status**: APPROVED  
**Next Step**: Proceed with revised implementation plan  
