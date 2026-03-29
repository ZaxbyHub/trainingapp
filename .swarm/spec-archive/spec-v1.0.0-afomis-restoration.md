# AFOMIS Help and Support — End-to-End Functionality Restoration

**Version:** 1.0.0  
**Status:** Ready for Implementation  
**Last Updated:** 2026-03-11

---

## 1. Feature Description

Restore full end-to-end functionality for offline chat and document ingestion in the AFOMIS Help and Support RAG application. The application currently has architectural drift between the live codebase (top-level `app_gui.py`, `main.py`, `api_server.py`) and the build specification (which references obsolete `ui/app.py` paths). Additionally, there are confirmed integration defects preventing proper GGUF backend initialization, local endpoint access, and upload source identity preservation.

**Primary Goal:** Return the application to a known-good state with unified behavior across GUI, CLI, and API modes, while establishing a regression test suite to prevent recurrence.

**Secondary Goal:** Align packaging and documentation with the actual runtime code structure.

---

## 2. User Scenarios

### Scenario 1: GUI User with Bundled GGUF Model
**As a** desktop application user  
**I want to** launch the GUI and have it automatically use the bundled GGUF model  
**So that** I can start chatting without manual configuration  

**Given** a valid GGUF file exists in the bundled models directory  
**When** I launch the GUI application  
**Then** the settings dialog shows the bundled model path  
**And** the chat interface initializes with the GGUF backend  
**And** I can ask questions and receive responses

### Scenario 2: API Mode with Environment-Based GGUF
**As a** system administrator deploying the API server  
**I want to** configure the GGUF model path via environment variable  
**So that** the API uses the correct backend without code changes  

**Given** the `RAG_GGUF_PATH` environment variable is set to a valid GGUF file  
**When** I start the API server  
**Then** the server initializes using the specified GGUF model  
**And** the `/query` endpoint responds using the GGUF backend

### Scenario 3: Local Ollama Integration
**As a** developer testing with local Ollama  
**I want to** configure `http://localhost:11434` as my LLM endpoint  
**So that** I can use my local Ollama instance  

**Given** Ollama is running on localhost:11434  
**When** I configure the API URL to `http://localhost:11434`  
**Then** the application accepts the configuration  
**And** queries are sent to the local Ollama instance

### Scenario 4: Single-File Upload with Source Preservation
**As a** user uploading a document  
**I want to** upload `report.pdf` and see it listed as "report.pdf"  
**So that** I can identify and manage my documents correctly  

**Given** I upload a file named `report.pdf` via the API  
**When** the file is processed and indexed  
**Then** the document appears in the library as "report.pdf"  
**And** citations reference "report.pdf"  
**And** delete operations target the correct document

### Scenario 5: Packaged Application Smoke Test
**As a** release engineer  
**I want to** build and run the packaged application  
**So that** I can verify the installer works correctly  

**Given** the PyInstaller build completes successfully  
**When** I run the packaged executable  
**Then** the GUI launches without errors  
**And** I can load a GGUF model  
**And** I can ingest a document  
**And** I can query and receive a response

---

## 3. Functional Requirements

### FR-001: Unified GGUF Backend Initialization
**MUST** Provide a single shared engine construction path used by GUI, CLI, and API modes that correctly passes `gguf_path` to the `RAGEngine` constructor.

**Acceptance Criteria:**
- GUI initialization passes `gguf_path` from settings (not `model_path`)
- API lifespan startup reads `RAG_GGUF_PATH` and passes it to `RAGEngine`
- CLI mode continues to work with direct parameter passing
- All three modes produce identical engine configuration given the same inputs

### FR-002: Local Endpoint URL Validation
**MUST** Allow localhost, 127.0.0.1, ::1, and private LAN addresses (RFC1918) for explicitly local backends while maintaining security against malicious URLs.

**Acceptance Criteria:**
- URLs to `http://localhost:11434` are accepted when explicitly configured as local
- URLs to `http://127.0.0.1` and `http://[::1]` are accepted for local backends
- Private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x) are accepted when local mode is enabled
- Malformed URLs and URLs with userinfo (user:pass@host) are rejected
- Resolved IP addresses are validated against the whitelist (DNS rebinding protection)
- Non-standard ports outside the allowed set require explicit opt-in

### FR-003: Path Validation for Local Files
**MUST** Allow legitimate local file paths (including absolute Windows paths outside the repo directory) while preventing directory traversal attacks.

**Acceptance Criteria:**
- Absolute paths like `C:\Models\model.gguf` validate successfully
- Paths with parent directory references (`../`) are rejected
- Path traversal attempts using encoded sequences are rejected
- Windows reserved device names (CON, NUL, AUX, COM1-9, LPT1-9) are rejected
- Symbolic links in path resolution are handled safely

### FR-004: Upload Filename Preservation
**MUST** Preserve the original uploaded filename through the entire ingest pipeline while sanitizing for safe filesystem storage.

**Acceptance Criteria:**
- Original filename is extracted and sanitized (path traversal characters removed)
- Sanitized filename is stored in document metadata as `source_name` or `display_name`
- Document listing displays the original (sanitized) filename
- Citations reference the original filename
- Delete-by-document operations use the stable source identifier
- Duplicate uploads of the same filename behave deterministically

### FR-005: Consistent GUI and API Upload Behavior
**SHOULD** Align GUI and API upload capabilities to match documented behavior.

**Acceptance Criteria:**
- API `/ingest/file` endpoint supports single-file upload (existing)
- GUI provides explicit single-file upload option if not already present
- GUI folder-based ingestion continues to work as documented
- Documentation accurately describes available upload methods per mode

### FR-006: Build Specification Alignment
**MUST** Update build scripts and PyInstaller spec to match the current repository layout.

**Acceptance Criteria:**
- `AFOMIS.spec` entry point references the correct application file (top-level, not `ui/app.py`)
- Bundled paths in spec match the actual directory structure
- `build_exe.bat` validates prerequisites against the correct paths
- Packaged application launches and functions correctly

---

## 4. Success Criteria

| ID | Criterion | Measurement |
|----|-----------|-------------|
| SC-001 | GUI GGUF Auto-Detection | GUI startup with valid GGUF initializes SmartLLM on GGUF backend within 10 seconds |
| SC-002 | API GGUF Environment Variable | API server with `RAG_GGUF_PATH` set initializes GGUF backend on first request |
| SC-003 | Local Ollama Endpoint | API startup succeeds with `http://localhost:11434` configured as local endpoint |
| SC-004 | Private LAN Endpoint | API accepts connections to `http://192.168.x.x:11434` when local mode is enabled |
| SC-005 | Malicious URL Rejection | URLs with path traversal, userinfo, or non-whitelisted remote hosts are rejected with clear error messages |
| SC-006 | Upload Source Identity | Uploading `report.pdf` results in "report.pdf" displayed everywhere (library, citations, deletion) |
| SC-007 | Duplicate Upload Handling | Repeated uploads of identical files produce deterministic, non-conflicting behavior |
| SC-008 | Packaged Application Startup | Clean PyInstaller build launches GUI without import errors or path issues |
| SC-009 | End-to-End Packaged Functionality | Packaged app can load GGUF, ingest documents, and answer questions |
| SC-010 | Regression Test Coverage | Each confirmed defect has a corresponding regression test that would catch recurrence |

---

## 5. Key Entities

- **RAGEngine**: Core orchestration class for RAG operations
- **SmartLLM**: Backend selector that prefers GGUF when `gguf_path` is populated
- **DocumentProcessor**: Handles text extraction and metadata assignment
- **VectorStore**: ChromaDB wrapper for document storage and retrieval
- **Settings/Configuration**: User preferences including `gguf_path`, `ollama_url`, etc.
- **Bug Ledger**: Document tracking confirmed defects, root causes, fixes, and test status

---

## 6. Edge Cases and Failure Modes

### EC-001: Conflicting Configuration Sources
**Scenario:** User sets `RAG_GGUF_PATH` environment variable AND provides `--model-path` CLI argument  
**Expected Behavior:** Explicit CLI parameter takes precedence over environment variable; precedence order is documented

### EC-002: Empty or Malformed GGUF Path
**Scenario:** Settings contain empty string or invalid path for `gguf_path`  
**Expected Behavior:** Application gracefully falls back to next available backend (OpenVINO, Ollama, API) with clear logging

### EC-003: Filename with Special Characters
**Scenario:** User uploads file named `report [v2] (final).pdf` or `document\name.pdf`  
**Expected Behavior:** Special characters are sanitized; original intent is preserved in display name; filesystem storage uses safe name

### EC-004: Upload with Path Traversal Attempt
**Scenario:** Malicious upload with filename `../../../etc/passwd`  
**Expected Behavior:** Traversal attempt is detected and sanitized; file is stored with safe name only

### EC-005: Concurrent Uploads of Same File
**Scenario:** Multiple users upload `report.pdf` simultaneously  
**Expected Behavior:** Each upload is processed independently; duplicate detection handles race conditions gracefully

### EC-006: Packaged App Path Resolution
**Scenario:** PyInstaller bundle runs from directory with spaces or non-ASCII characters  
**Expected Behavior:** Path resolution uses `sys._MEIPASS` correctly; all bundled resources are accessible

### EC-007: DNS Rebinding Attack
**Scenario:** Attacker configures DNS to resolve `localhost.attacker.com` to `127.0.0.1`  
**Expected Behavior:** URL validation resolves hostname and validates the IP address, not just the string

---

## 7. Constraints and Non-Goals

**In Scope:**
- GGUF backend initialization across all modes
- URL validation for local/offline endpoints
- Path validation for local files
- Upload filename preservation
- Build specification alignment
- Regression test suite

**Out of Scope:**
- New LLM backends or model formats
- Changes to chunking or embedding logic
- UI redesign or new features
- Database schema changes
- Network security beyond input validation
- Cloud deployment configurations

---

## 8. Notes

### Bug Ledger Structure
Each confirmed defect must be documented with:
- **Defect ID**: Unique identifier (e.g., BUG-001)
- **Description**: What is broken
- **Root Cause**: Why it broke
- **Affected Files**: Where the bug lives
- **Repro Steps**: How to trigger it
- **Fix Status**: Pending / In Progress / Complete
- **Regression Test**: Test file that prevents recurrence

### Architecture Drift Context
The repository currently has:
- **Live code**: `app_gui.py`, `main.py`, `api_server.py` at repository root
- **Legacy code**: `ui/app.py` (may be obsolete or superseded)
- **Build spec**: `AFOMIS.spec` references `ui/app.py` as entry point

This drift must be resolved by determining which entry point is canonical and updating all references accordingly.

### Test Requirements
- Each FR must have at least one integration test
- Each confirmed defect must have a regression test
- Tests must cover GUI, CLI, and API modes where applicable
- Packaged application requires smoke test (manual or automated)

---

## 9. Clarification Log

*No open clarifications. All requirements derived from confirmed defects and execution plan provided.*

