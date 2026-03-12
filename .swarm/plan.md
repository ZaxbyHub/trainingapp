<!-- PLAN_HASH: n2qwhb5lhkp4 -->
# AFOMIS End-to-End Functionality Restoration
Swarm: paid
Phase: 14 [PENDING] | Updated: 2026-03-12T00:43:19.794Z

---
## Phase 14: Phase 14: Establish Reproducible Baseline [PENDING]
- [x] 14.1: Create baseline test matrix covering GUI mode, CLI mode, and API mode with GGUF path variations and upload paths [MEDIUM]
- [x] 14.2: Execute baseline tests and capture failing code paths for each confirmed defect [MEDIUM]
- [ ] 14.3: Create regression test stubs for each confirmed defect that will verify fixes [SMALL] ← CURRENT

---
## Phase 15: Phase 15: Repair GGUF Backend Detection [PENDING]
- [x] 15.1: Fix GUI initialization in app_gui.py to pass gguf_path parameter instead of model_path to RAGEngine [SMALL]
- [x] 15.2: Fix API server lifespan in api_server.py to read RAG_GGUF_PATH environment variable and pass to RAGEngine [SMALL]
- [x] 15.3: Audit repository for remaining semantic misuse of model_path versus gguf_path including migration code and tests [MEDIUM]
- [x] 15.4: Create unified engine construction helper if needed to ensure all modes use shared path [MEDIUM]

---
## Phase 16: Phase 16: Repair Local Endpoint Handling [PENDING]
- [x] 16.1: Update validate_url() in api_server.py to allow localhost, 127.0.0.1, ::1 for explicitly local backends [SMALL]
- [x] 16.2: Add DNS rebinding protection by resolving hostname and validating IP against whitelist [SMALL]
- [x] 16.3: Update validate_model_path() to allow absolute Windows paths while preventing traversal [SMALL]
- [x] 16.4: Update validate_directory() with same path handling improvements [SMALL]
- [x] 16.5: Add port whitelist validation for non-standard ports with explicit opt-in requirement [SMALL]

---
## Phase 17: Phase 17: Rebuild Upload Ingestion [PENDING]
- [x] 17.1: Add source_name/display_name parameter through ingest pipeline from /ingest/file endpoint to DocumentProcessor [MEDIUM]
- [x] 17.2: Implement filename sanitization function to prevent path traversal while preserving display name [SMALL]
- [x] 17.3: Update DocumentProcessor.process_file() to use source_name parameter for metadata [SMALL]
- [x] 17.4: Verify duplicate handling, deletion, document listing, and citations use stable source metadata [MEDIUM]

---
## Phase 18: Phase 18: Align GUI, API, CLI, and Documentation [PENDING]
- [ ] 18.1: Audit README and documentation for drift between documented and actual behavior [MEDIUM]
- [x] 18.2: Verify GUI upload capabilities match API surface or document intentional differences [SMALL]
- [x] 18.3: Update settings labels and backend naming to match actual code behavior [SMALL]
- [ ] 18.4: Document actual backend precedence and configuration knobs accurately [SMALL]

---
## Phase 19: Phase 19: Packaging and Distribution Validation [PENDING]
- [x] 19.1: Audit AFOMIS.spec against current repository layout and update entry point and bundled paths [MEDIUM]
- [ ] 19.2: Update build_exe.bat to validate prerequisites against correct paths [SMALL]
- [x] 19.3: Perform clean package build and document any issues encountered [MEDIUM]
- [x] 19.4: Execute packaged application smoke test: launch, load GGUF, ingest document, answer question [MEDIUM]

---
## Phase 20: Phase 20: Regression Test Suite and Bug Ledger [PENDING]
- [ ] 20.1: Complete regression tests for all confirmed defects with PASS status [MEDIUM]
- [x] 20.2: Document final bug ledger with root cause, fix, and test for each defect [SMALL]
- [x] 20.3: Write postmortem analysis describing why regressions escaped and prevention measures [SMALL]
