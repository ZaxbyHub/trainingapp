# Changelog

## [1.1.2] - 2026-04-12

### Summary
Fixed all failing regression and unit tests; improved RAG pipeline quality.

### Test Fixes
- **test_defect_001_gui_gguf_wiring**: Fixed sys.modules mock pollution — use rag_engine.RAGEngine direct replacement instead of patch() decorator
- **test_defect_002_api_gguf_env**: Fixed validate_model_path mock side_effect (was returning lambda instead of calling it)
- **test_defect_003_adversarial**: Added control char detection, fixed userinfo regex, updated error messages, added loopback keyword to match pattern
- **test_api.py**: Fixed StatsResponse documents field, mocked DNS resolution, fixed error messages
- **test_llm_interface.py**: Fixed OLLAMA connection error mock with side_effect
- **test_phase1_adversarial.py**: Updated error message matches for URL validation changes
- **test_phase1_fixes.py**: Added socket.getaddrinfo mock for DNS resolution

### RAG Pipeline Quality
- Added CrossEncoder reranking with TinyBERT (ms-marco-TinyBERT-L-2, ~85MB) — enabled by default
- Sentence-boundary truncation (no more mid-sentence cuts)
- 3-pattern follow-up query detection (anaphora, short non-WH, continuation keywords)
- Expanded conversation history (2 turns, 4 messages)
- Strengthened system prompt (5 rules)

### Security Hardening
- Control character detection in validate_url (\x00-\x08, \x0a-\x0d, \x0e-\x1f)
- Userinfo detection regex (urlparse only catches non-empty usernames)
- Proper ValueError on unresolvable hostnames (not silent return)
- Centralized security.py module with validate_device()

### API Improvements
- StatsResponse now returns documents field
- validate_device() for device string command injection protection
- Centralized config.py with Pydantic validation

## [1.1.1] - 2026-04-12

### Summary
Pipeline optimization: wired three dead features, fixed page citation, improved answer quality.

### Phase 1 — Dead Feature Activation

#### Reranker Wiring
- **Wired CrossEncoderReranker** into `RAGEngine.query()` — was fully implemented but never connected
- **Switched to TinyBERT** (`ms-marco-TinyBERT-L-2`, ~85MB) from MiniLM (~500MB) — safe for 8GB RAM minimum spec
- Reranking now **enabled by default** (`reranking_enabled=True`)
- Lazy initialization — model loads on first query, not at startup

#### Retrieval Window
- **Wired `retrieval_window`** from config through to `vector_store.get_context()`
- Neighbor expansion (`_expand_chunks_with_neighbors`) was already implemented — was never called
- Default window of 1 now works: retrieved chunks are expanded ±1 neighbor from the same source document

#### Query Transformation
- Kept disabled (step-back LLM call adds 2-5s latency on CPU — unacceptable for minimum spec)
- Keyword-only extraction available when enabled

### Phase 2 — Ingestion Quality

#### Page Number Assignment
- **`_find_page()` helper** added to `chunk_text()` — maps chunk text to PDF page via longest-prefix matching against `para_page_map`
- All three `DocumentChunk` creation sites now set `page=_find_page(chunk_text)`
- PDF pages now carry through to metadata — enables page-level citations
- Fixed `_split_sentences()` Python 3.13 compatibility: replaced invalid `r'\1\x00'` replacement string with callback function

### Phase 3 — QA Output Quality

#### Sentence-Boundary Truncation
- **`_truncate_at_sentence()`** helper replaces raw char-level truncation
- Scans backward from cutoff for last complete sentence (`.` `!` `?` followed by space/newline)
- Fallback to word boundary — no more mid-sentence cuts sent to the LLM

#### System Prompt
- Strengthened with 5 rules: no speculation, full context inclusion, conflict handling (all perspectives), inline citations `[filename.pdf]`, bullet points for multi-step answers

#### Follow-Up Detection
- Replaced brittle keyword+length check with 3-pattern detection:
  - Pronoun/anaphora (`it`, `this`, `that`, `these`, `those`)
  - Short non-WH questions (≤4 words not starting with what/who/when/where/which/how/why)
  - Continuation keywords (`more`, `elaborate`, `compare`, `vs`, etc.)

#### Conversation History
- Expanded from 1 turn to 2 turns (last 2 user + 2 assistant messages)
- Increased char limit to 250 (display at 100 chars per line)

### Documentation Updates
- ARCHITECTURE.md: Updated reranking defaults (True / TinyBERT), added retrieval_window, fixed reranking code example
- CONFIGURATION.md: Updated `RAG_RERANKING_ENABLED` default to `True`, `RAG_RERANKER_MODEL` to TinyBERT
- README.md: Updated reranker description (TinyBERT, default ON), clarified step-back is not wired
- USAGE.md: Updated reranking default to ON

## [1.1.0] - 2026-04-09

### Summary
Comprehensive QA remediation addressing 79 findings (6 CRITICAL, 32 HIGH, 33 MEDIUM, 8 LOW) across security, reliability, test quality, documentation, and code quality.

### P0 Critical Fixes — Security & Reliability

#### Security
- **Consolidated SSRF protection** — Created shared `security.py` module with context-aware `validate_url(allow_local=False/True)`
- **Added API authentication** — Implemented FastAPI OAuth2PasswordBearer with JWT + API-Key fallback, controlled by `ENABLE_AUTH` env var (default: False)
- **Removed hardcoded credentials** — Cleaned up placeholder values in build scripts

#### Reliability
- **Fixed Python 3.10/3.11 compatibility** — Replaced `Path.walk()` with `os.walk()` in bundle_embedding_model.py
- **Added chunk_overlap validation** — Prevent infinite loops with chunk_overlap=0
- **Fixed document processor validation** — Added proper error handling for invalid inputs

### P1 High Priority — Configuration & Infrastructure

#### Configuration Management
- **Created centralized config system** — Implemented Pydantic BaseSettings in `config.py` with strict validation
- **Added environment variable validation** — RAG_MIN_SIMILARITY, RAG_CHUNK_SIZE, RAG_MAX_TOKENS, etc.
- **Fixed version bump script** — Added path validation and regex fixes

#### Build & CI/CD
- **Fixed model name consistency** — Standardized on Qwen3-1.7B across all documentation
- **Updated GitHub Actions** — Removed deprecated versions (v3→v4), fixed Windows-specific paths
- **Fixed subprocess handling** — Added capture_output and check parameters

### P2 Medium Priority — API Contract & Documentation

#### API Improvements
- **Fixed /search endpoint documentation** — Aligned USAGE.md with actual response format
- **Added CORS configuration** — Restricted to localhost in development
- **Fixed /stats information leakage** — Removed internal path exposure
- **Consolidated URL validation** — Single source of truth in security.py

#### Documentation
- **Fixed PyInstaller support claim** — Updated docstrings to reflect actual implementation
- **Fixed OpenVINO references** — Updated to GGUF terminology
- **Added explicit CHANGE_ME placeholders** — Inno Setup script now shows required customization points
- **Qualified performance claims** — Added measurement conditions to token/sec specifications
- **Made context_truncation configurable** — Added RAG_CONTEXT_TRUNCATION environment variable

### P2 Medium Priority — Validation & Ranges

#### GUI Improvements
- **Added shared constants** — MIN_CHUNK_SIZE, MAX_CHUNK_SIZE, DEFAULT_CHUNK_SIZE in config.py
- **Added max_tokens constants** — MIN_MAX_TOKENS, MAX_MAX_TOKENS, DEFAULT_MAX_TOKENS
- **Fixed AFOMIS branding** — Updated to Document Q&A Assistant consistently
- **Synchronized version numbers** — All files now show 1.1.0

### P2 Medium Priority — Code Quality

#### Code Cleanup
- **Fixed unbound variable documentation** — Documented false positive in verify_remediation.py
- **Fixed duplicate thread start** — Removed duplicate `after()` call in app_gui.py
- **Added path validation** — version_bump.py now checks file existence
- **Fixed subprocess.run** — Added capture_output and check parameters
- **Fixed path comparison** — Using Path.is_relative_to() instead of substring matching
- **Consolidated lazy imports** — Created cached helper function in engine_factory.py
- **Added LOCALAPPDATA caching** — Module-level cache for user data directory
- **Fixed log level** — Changed WARN to WARNING (standard Python logging)
- **Documented magic numbers** — Added inline comments for token/temperature values
- **Improved RRF docstring** — Added formula explanation and example
- **Fixed file encoding** — Added explicit encoding='utf-8' to write_text
- **Made STOP_WORDS constant** — Module-level constant instead of inline recreation
- **Added error recovery** — User-friendly messages for RAGEngine initialization failures
- **Added file size limits** — RAG_MAX_FILE_SIZE env var (default 100MB) for directory ingestion

### P2 Low Priority — Cleanup

#### Final Polish
- **Removed dead imports** — Cleaned up unused create_engine import
- **Fixed BM25 deletion** — Using exact match instead of startswith
- **Fixed exception logging** — Added exception details to all logger.error() calls
- **Cleaned up GitHub workflows** — Removed redundant token passing, fixed cross-platform issues
- **Fixed docstring escaping** — Escaped percent signs in app_paths.py

### Test Improvements

#### Test Quality
- **Created integration tests** — Real RAG pipeline tests in tests/integration/
- **Added GGUF wiring tests** — Verify path propagation from env to engine
- **Fixed mocked tests** — Proper assertions instead of dummy True assertions
- **Added adversarial tests** — SSRF, path traversal, and injection attempt coverage
- **Fixed Pydantic v2 compatibility** — Updated .dict() to .model_dump() where needed

### Migration Guide

#### Authentication (New in 1.1.0)
To enable API authentication:
1. Set `ENABLE_AUTH=true` in your environment
2. Configure `API_KEY` for simple authentication
3. Or use JWT tokens for programmatic access
4. See USAGE.md for detailed setup instructions

#### Environment Variables
New optional environment variables:
- `RAG_MAX_FILE_SIZE` — Maximum file size for directory ingestion (default: 100MB)
- `RAG_CONTEXT_TRUNCATION` — Max context length in characters (default: 6000)
- `ENABLE_AUTH` — Enable API authentication (default: false)
- `API_KEY` — API key for authentication when ENABLE_AUTH=true

### Statistics
- **Total Findings Addressed**: 79
- **Files Modified**: 40+
- **Tests Added**: 50+
- **Test Pass Rate**: 88% (658/745)

### Known Issues
- Integration tests require actual GGUF model files to pass
- Some edge case URL validation tests need refinement

---

## [1.0.0] - 2026-02-28

### Initial Release
- Document Q&A Assistant with RAG pipeline
- Support for GGUF, Ollama, and API LLM backends
- Web API and GUI interfaces
- Document ingestion and search
