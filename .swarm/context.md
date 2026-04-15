# Context
Swarm: paid
Project: Comprehensive Codebase QA Review — AI-Hardened Edition v5.1 — **ARCHIVED**

## Status
- **Phase**: ALL PHASES COMPLETE — **PROJECT ARCHIVED**
- **Completion Date**: 2026-04-09
- **Final Deliverable**: qa-report.md (79 findings)
- **Plan Version**: 5.1.0 (archived)
- **Previous Work**: Archived (v1.0.0 lowtier)

## Archive Log
### Current Audit (v5.1.0)
- `.swarm/spec-archive/spec-v5.1.0-qa-audit-2026-04-08.md` — QA audit v5.1.0 specification
- `.swarm/plan-archive/plan-v5.1.0-qa-audit-2026-04-08.md` — QA audit v5.1.0 implementation plan
- `.swarm/evidence/retro-2/evidence.json` — Phase 2 retrospective

### Previous Audits
- `.swarm/plan-archive/plan-v1.0.0-lowtier-2026-04-07.md` — Previous QA audit plan
- `.swarm/spec-archive/spec-v1.0.0-lowtier-2026-03-30.md` — Previous QA audit spec
- `.swarm/spec-archive/spec-audit-v1.0.0-2026-03-27.md` — Earlier audit spec
- `.swarm/spec-archive/spec-v1.0.0-afomis-restoration.md` — Afomis restoration spec

## Completion Summary

### Phase 1: Codebase Inventory ✅
- 48 files catalogued
- Mental map created
- Tech stack documented

### Phase 2: Explorer Generation (7 batches) ✅
- 106 candidates generated
- 79 unique findings validated
- 15 disproved/overturned
- 6 duplicates merged

### Phase 3: Evidence Persistence ✅
- 21 evidence files preserved
- All batches documented

### Phase 4: Architect Synthesis ✅
- 9 clusters identified
- Top 10 critical findings ranked

### Phase 5: Report Generation ✅
- qa-report.md delivered
- 79 findings with file paths, line numbers
- 20 prioritized recommendations

### Phase 6: Delivery & Sign-off ✅
- Retrospective written
- Plans archived
- Repo cleaned

## Final Metrics

| Metric | Value |
|--------|-------|
| Total Findings | 79 |
| CRITICAL | 6 |
| HIGH | 32 |
| MEDIUM | 33 |
| LOW | 8 |
| Tool Calls | 866 |
| Batches | 7 |
| Validation Layers | 3 (Explorer→Reviewer→Critic) |

## Key Lessons Learned
1. **3-layer validation essential**: 66% overturn rate on initial HIGH findings shows value of inline Critic challenge
2. **Serial batching prevents degradation**: 7 batches completed without quality loss
3. **Disprove_attempt gate effective**: 15 false positives caught before entering report
4. **Documentation-code drift dominant**: 4 of 9 clusters involve configuration/API mismatches
5. **Test false-confidence critical**: 19 findings (4 CRITICAL) show limited real assurance

## Evidence Preserved
- `.swarm/evidence/qa_findings/` — 7 batch candidate files
- `.swarm/evidence/qa_validated/` — 7 reviewer validation files
- `.swarm/evidence/qa_critique/` — 7 critic challenge files
- `.swarm/evidence/retro-2/` — Retrospective evidence

## Repo Status
- **Active spec.md**: Removed (archived)
- **Active plan.md**: Removed (archived)
- **Context.md**: Preserved for historical reference
- **qa-report.md**: Available in repo root
- **Status**: Ready for new work

---
*Project archived 2026-04-09. Future swarms should start fresh with no active plans.*

---

# NEW PROJECT: QA Findings Remediation — Document Q&A Assistant

## Status
- **Phase**: Planning Complete — Critic Review Received, SME Consulted
- **Start Date**: 2026-04-09
- **Total Findings to Remediate**: 79 (6 CRITICAL, 32 HIGH, 33 MEDIUM, 8 LOW)
- **Plan**: 10 phases, 77 tasks (awaiting revision based on feedback)

## SME Guidance — Security Architecture

### 1. API Authentication (Task 1.5)
**RECOMMENDED**: FastAPI OAuth2PasswordBearer with JWT + API-Key fallback
- Use JWT for programmatic access
- Use simple API-Key for tkinter GUI
- Add `ENABLE_AUTH` env flag (default False for dev)
- Provide admin endpoint for key rotation

**Implementation**:
- Add `python-jose[cryptography]` dependency
- Create auth middleware in api_server.py
- Support both header types: `Authorization: Bearer <jwt>` and `X-API-Key: <key>`

**Risks**:
- Default ENABLE_AUTH=False prevents breaking existing scripts
- Must document migration path for users

### 2. SSRF Policy Consolidation (Task 1.3)
**RECOMMENDED**: Context-aware validator (Option C)
- Keep strict api_server policy as default
- Add `allow_local` flag for RAG engine when using local LLM
- Document flag usage clearly

**Implementation**:
- Create shared `validate_url()` in new `security.py` module
- api_server uses strict mode (allow_local=False)
- llm_interface uses permissive mode when RAG_USE_LOCAL_LLM=true

**Risks**:
- allow_local=True opens SSRF if misused
- Restrict flag to internal config paths only

### 3. Test Strategy (Tasks 2.1-2.4)
**RECOMMENDED**: Hybrid approach (Option C)
- Keep fast unit tests with mocking
- Add integration tests with `@pytest.mark.integration`
- Use `httpx.MockTransport` for mock LLM server
- Skip integration tests in CI unless `RUN_INTEGRATION=true`

**Implementation**:
- Create `tests/integration/` directory
- Mark existing mocked tests as `@pytest.mark.unit`
- Add conftest.py fixture for mock LLM transport

### 4. Environment Variable Security (batch2-F010)
**RECOMMENDED**: Pydantic Settings with strict validation
- Use `BaseSettings` for all config
- Declare strict types, validators for int conversion
- Fail fast on bad values (ValidationError)
- Never log raw env values

**Implementation**:
- Create `config.py` with Pydantic BaseSettings
- Replace manual os.getenv() calls
- Add validators for RAG_MIN_SIMILARITY, RAG_TOP_K, etc.

**Dependencies**:
- `pydantic[email]` for settings validation
- `python-dotenv` for dev .env support

## Critic Review Feedback — Issues to Address

### Major Issues:
1. **False Positives** (Tasks 1.1, 1.4, 8.1) — Need to verify against current code
2. **Task 1.3 underspecified** — Need to specify which SSRF policy wins  
3. **Task 1.5 underspecified** — Need auth mechanism details
4. **No incremental testing** — Add verification at end of each phase
5. **Task 6.1 scope unclear** — Clarify PyInstaller implementation vs docstring fix

### Plan Revisions Needed:
- Add authentication mechanism specification to Task 1.5
- Specify SSRF policy consolidation approach in Task 1.3
- Add phase-end verification tasks
- Clarify or remove false positive tasks after verification

## Key Decisions

### Authentication Strategy
- Mechanism: OAuth2PasswordBearer (JWT) + API-Key fallback
- Configurable: ENABLE_AUTH env var (default False)
- Breaking change: Documented in CHANGELOG with migration guide

### SSRF Policy Strategy
- Default: Strict (api_server.py policy)
- Local LLM exception: allow_local flag controlled by RAG_USE_LOCAL_LLM
- Implementation: Shared security module with context parameter

### Testing Strategy
- Unit tests: Keep mocked, mark with @pytest.mark.unit
- Integration tests: New directory, mock LLM transport, @pytest.mark.integration
- CI: Run unit tests always, integration tests conditionally

## Plan Status
**APPROVED** by critic with HIGH confidence (2026-04-09)

### Critic Verdict
- **Feasibility**: PASS — All file/line references verified
- **Completeness**: PASS — 77 tasks with clear actions and acceptance criteria  
- **Dependency Ordering**: PASS — Phase ordering provides implicit sequencing
- **Scope Containment**: PASS — Tightly scoped to 79 QA findings
- **Risk Assessment**: PASS — VERIFY tasks gate false positives, high-risk tasks specified

### All Major Issues Resolved
1. ✓ Added verification tasks for potential false positives (1.1, 1.4, 8.1)
2. ✓ Specified SSRF consolidation approach with context-aware validator (Task 1.3)
3. ✓ Specified authentication mechanism (OAuth2PasswordBearer + API-Key fallback) (Task 1.5)
4. ✓ Added Pydantic BaseSettings approach for configuration (Tasks 1.7, 3.3)
5. ✓ Specified hybrid test strategy with integration tests (Tasks 2.1-2.4)

## Ready for Execution
The plan is ready for implementation. Recommended approach:
1. **Subagent-Driven Development** — Fresh subagent per task with review between tasks
2. **Phase-by-phase execution** — Complete Phase 1 (P0 Critical) before moving to Phase 2
3. **Verification gates** — Run tests after each phase, full verification in Phase 10

## To Begin Execution
Say: "Execute Phase 1" or "Start remediation" and I'll begin with Task 1.1 (verification of inverted logic finding)

## Agent Activity

| Tool | Calls | Success | Failed | Avg Duration |
|------|-------|---------|--------|--------------|
| read | 7607 | 7560 | 47 | 171ms |
| bash | 3446 | 3418 | 28 | 4964ms |
| edit | 2331 | 2321 | 10 | 954ms |
| grep | 2151 | 2128 | 23 | 295ms |
| task | 1222 | 1216 | 6 | 134682ms |
| glob | 1002 | 1000 | 2 | 34ms |
| test_runner | 745 | 742 | 3 | 141ms |
| update_task_status | 434 | 434 | 0 | 16ms |
| write | 391 | 382 | 9 | 7096ms |
| todowrite | 298 | 294 | 4 | 4ms |
| pre_check_batch | 236 | 231 | 5 | 1302ms |
| invalid | 174 | 174 | 0 | 1ms |
| search | 145 | 145 | 0 | 14714ms |
| save_plan | 131 | 131 | 0 | 5ms |
| declare_scope | 119 | 119 | 0 | 2ms |
| phase_complete | 90 | 90 | 0 | 3840ms |
| syntax_check | 79 | 79 | 0 | 22ms |
| lint | 71 | 71 | 0 | 2000ms |
| diff | 56 | 56 | 0 | 19ms |
| check_gate_status | 53 | 53 | 0 | 1ms |
| retrieve_summary | 51 | 51 | 0 | 3ms |
| write_retro | 44 | 44 | 0 | 4ms |
| todo_extract | 31 | 31 | 0 | 3ms |
| imports | 26 | 26 | 0 | 24ms |
| knowledgeAdd | 25 | 25 | 0 | 10ms |
| write_drift_evidence | 21 | 21 | 0 | 4ms |
| placeholder_scan | 21 | 21 | 0 | 16ms |
| skill | 16 | 16 | 0 | 59ms |
| symbols | 14 | 14 | 0 | 2ms |
| mystatus | 12 | 12 | 0 | 1809ms |
| secretscan | 11 | 11 | 0 | 552ms |
| batch_symbols | 10 | 10 | 0 | 5ms |
| curator_analyze | 8 | 8 | 0 | 46251ms |
| completion_verify | 8 | 8 | 0 | 2ms |
| webfetch | 7 | 7 | 0 | 2344ms |
| apply_patch | 6 | 6 | 0 | 182ms |
| evidence_check | 4 | 4 | 0 | 51ms |
| build_check | 4 | 4 | 0 | 473ms |
| checkpoint | 3 | 3 | 0 | 11ms |
| knowledgeRecall | 2 | 2 | 0 | 3ms |
| sast_scan | 2 | 2 | 0 | 16ms |
| todoread | 1 | 1 | 0 | 6ms |
| detect_domains | 1 | 1 | 0 | 2ms |
| pkg_audit | 1 | 1 | 0 | 5ms |
| complexity_hotspots | 1 | 1 | 0 | 50ms |
