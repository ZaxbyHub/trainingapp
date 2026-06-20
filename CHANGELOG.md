# Changelog

## [Unreleased]

### Added

- **End-to-end integration wiring (Phase 8)**: Connected `ChatPage.tsx` to `RAGOrchestrator` for browser-local mode and SSE streaming (`SSEStreamConsumer`) for API mode
- **DocumentsPage search wiring (Phase 8)**: Connected `DocumentsPage.tsx` to search indexes (vector-index, keyword-index) for document retrieval
- **Service initialization infrastructure (Phase 8)**: New `useServiceInitialization.ts` hook with sequential service init, cleanup on unmount, and loading overlay in `App.tsx`
- **edgevec WASM production fix (Phase 8)**: Added Vite plugin stub for edgevec WASM snippet in production builds

### Fixed

- **EdgeVec API contract (Phase 8)**: Fixed `search()` method signature in `vector-index.ts` to return `Promise<SearchResult[]>` instead of incorrect type
- **pdfjs import paths (Phase 8)**: Fixed `GlobalWorkerOptions.workerSrc` initialization in `pdf-extractor.ts` for production build compatibility
- **PasswordException handling (Phase 8)**: Added `PasswordException` catch in `pdf-extractor.ts` with user-friendly error and PDF password removal guidance
- **SSE abort controller (Phase 8)**: Fixed `AbortController` not being called on error in `SSEStreamConsumer` during API mode streaming
- **WebLLMService disposal (Phase 8)**: Added proper `_engine = null` disposal in `WebLLMService.terminate()` to prevent memory leaks
- **TokenStreamManager dead code (Phase 8)**: Removed unused stub code from `TokenStreamManager.ts`
- **Unused variable cleanup (Phase 8)**: Fixed unused `prefetchStatus` variable in `SettingsPage.tsx`

### Changed

- **Dual-mode streaming architecture (Phase 8)**: `ChatPage` now routes to `RAGOrchestrator` (browser-local) or `SSEStreamConsumer` (API) based on inference mode

### Added

- **Settings page (Phase 7)**: Full-featured settings UI with 6 sections:
  - `SettingsPage.tsx`: Inference mode toggle (browser-local/API), server configuration with connection test, model selection with cache status and download progress, appearance/theme selector (light/dark/system), storage management with memory budget/pressure display and two-click cache clear, and about section with version info
  - IndexedDB persistence via `openSettingsDatabase()` / `loadSettings()` / `saveSettings()` for theme, preferredModel, and serverUrl preferences
  - Connection test button with 5s timeout, success/error status badges, and real-time serverUrl sync

- **InferenceModeProvider at root (Phase 7)**: Moved `InferenceModeProvider` from `ChatPage.tsx` to `App.tsx` root level, enabling shared inference mode state across Chat, Documents, and Settings pages

- **Cross-browser compatibility detection (Phase 7)**: `browser-compat.ts` provides:
  - `detectBrowser()`: User-agent parsing for Chrome, Edge, Firefox, Safari
  - `checkFeatures()`: WebGPU, OPFS, IndexedDB, SharedArrayBuffer, WASM, Worker detection
  - `getCompatMessage()`: Compatibility guidance with level (full/degraded/unsupported) and upgrade recommendations
  - `detectBrowserInfo()`: Combined browser and feature detection with support determination
  - Chrome/Edge 113+ = full support; Firefox = degraded (experimental WebGPU); Safari = degraded (partial WebGPU)

- **Reusable UI components (Phase 7)**:
  - `ErrorBoundary.tsx`: Class-based error boundary with `getDerivedStateFromError`, componentDidCatch logging, retry functionality, and accessible fallback UI with danger icon
  - `LoadingSkeleton.tsx`: Shimmer-animated skeleton placeholders with variants (text, card, avatar, button), configurable width/height/count, ARIA status attributes
  - `EmptyState.tsx`: Contextual empty state display with 4 variants (no-documents, no-results, no-chat-history, generic), inline SVG icons, and optional action button

- **Browser-side LLM inference via WebLLM (Phase 6)**: Complete WebGPU-based LLM inference in the browser using `@mlc-ai/web-llm`:
  - `web-llm-service.ts`: Singleton service using CreateMLCEngine API for SmolLM3-3B-Q4_K_M (~1.9GB) with streaming support, progress callbacks, and OPFS caching; WebGPU-only backend with fast-fail to server API mode
  - `model-download.ts`: Model download manager with progress tracking, speed/ETA calculation, cancellation support, and storage quota error handling
  - `ModelDownloadProgress.tsx`: Accessible progress bar component with ARIA attributes, speed display, ETA countdown, error banner for quota exceeded, and cancel button
  - `model-readiness.ts`: Pre-flight readiness gate with WebGPU availability check, memory sufficiency check (2GB minimum for SmolLM3-3B-Q4_K_M), and OPFS cache status check; returns detailed failures and recommendations
  - `rag-orchestrator.ts`: Full RAG pipeline orchestrator connecting embedding→vector search→keyword search→RRF fusion→optional reranking→LLM generation; yields typed RAGEvent stream for UI progress tracking
  - `webgpu-watchdog.ts`: WebGPU context loss detection and recovery watchdog monitoring GPUDevice.lost promise and event; includes createRecoveryHandler for automatic service re-initialization after context loss
  - `llm.ts`: Simplified `LLMInferenceMode` type now exclusively `'webgpu'` (WASM backend removed — web-llm has no WASM support)
  - Dependencies: `@mlc-ai/web-llm` ^0.2.83

- **Web UI search infrastructure (Phase 5)**: Complete browser-side search pipeline with hybrid retrieval:
  - `embedding-service.ts`: Transformers.js embedding service using `bge-small-en-v1.5` ONNX model with OPFS caching
  - `memory-aware.ts`: Memory-aware model selection with device memory detection and tier-based configuration (low/medium/high memory tiers)
  - `vector-index.ts`: HNSW vector index using EdgeVec (Rust/WASM) with native IndexedDB persistence
  - `keyword-index.ts`: FlexSearch keyword index with resolution-based scoring for BM25-style matching
  - `rrf-fusion.ts`: Reciprocal Rank Fusion algorithm for hybrid semantic + keyword retrieval
  - `reranker.ts`: Cross-encoder reranker using `ms-marco-MiniLM-L-6-v2` with memory-aware conditional activation
  - `embedding.ts`: TypeScript types for `EmbeddingDocument`, `EmbeddingResult`
  - `search.ts`: TypeScript types for `SearchResult`, `HybridSearchResult`
  - Dependencies: `@huggingface/transformers` ^3.0.0, `edgevec` ^0.6.0, `flexsearch` ^0.8.0
  - Vite config: Added `optimizeDeps` for WASM modules, COOP/COEP headers for SharedArrayBuffer

- **Browser-side document extraction (Phase 4)**: Full document processing pipeline in the browser with no server uploads:
  - `pdf-extractor.ts`: PDF text extraction using pdfjs-dist ^4.4.168
  - `docx-extractor.ts`: DOCX text extraction using mammoth ^1.8.0
  - `xlsx-extractor.ts`: XLSX text extraction using xlsx ^0.18.5
  - `pptx-extractor.ts`: PPTX text extraction using jszip ^3.10.1 for ZIP/xml parsing
  - `txt-extractor.ts`: TXT/MD text extraction via native text processing
  - `extractor-factory.ts`: MIME-type based extractor selection
  - `text-chunker.ts`: Semantic chunking with paragraph/sentence boundary awareness, configurable overlap, page mapping, and SHA256 content IDs (faithful Python port)

- **IndexedDB document storage (Phase 4)**: Browser-local persistence via `document-store.ts`:
  - `loadDocuments()`: Retrieve all stored documents with metadata
  - `saveDocument()`: Store document with extracted chunks
  - `deleteDocument()`: Remove document by ID
  - `DocumentChunk` interface with SHA256 IDs for deduplication

- **Documents page (Phase 4)**: Full-featured `/documents` page in web UI:
  - `DocumentsPage.tsx`: Main documents management page
  - `DropZone.tsx`: Drag-and-drop file upload with visual feedback and progress indication
  - `DocumentList.tsx`: Paginated document list with name, type, size, status, and date display
  - Complete file processing pipeline from upload to IndexedDB storage

- **SSE streaming endpoint** (`POST /ask/stream`): Real-time token streaming using `sse-starlette` with `asyncio.Queue` for thread-safe token delivery; callback-based architecture feeds tokens from background thread to async queue

- **Batch file upload** (`POST /ingest/batch`): Upload up to 20 files per request with per-file error isolation; each file validated individually (size, extension, filename sanitization) and processed sequentially with detailed per-file results

- **Settings persistence endpoints** (`GET/PUT /settings`): Full CRUD for RAG configuration including chunk_size, chunk_overlap, n_results, min_similarity, temperature, max_tokens, hybrid_search, reranking_enabled, context_truncation, retrieval_window, initial_retrieval_top_k, rerank_top_k; cross-field validation ensures `chunk_overlap < chunk_size`

- **TypeScript API client** (`web_ui/src/lib/api/`): Typed interfaces matching FastAPI request/response shapes (snake_case), `ApiClient` class with methods for all endpoints, `SSEStreamConsumer` for POST-based SSE using fetch+ReadableStream, auth interceptor with localStorage token storage and Safari private mode fallback

- **Browser ML feasibility spike** (`/ml-spike`): Diagnostic page validating Transformers.js (feature-extraction pipeline), EdgeVec (HNSW vector search), and FlexSearch (full-text indexing) on target hardware; shows pass/fail/skip status, duration, and memory delta per library

- **21 backend tests** (`test_api_endpoints.py`): Comprehensive unit tests for SSE streaming, batch upload, and settings endpoints with mock engine and auth bypass fixture

- **HTML5 Web UI (Phase 1)**: New `web_ui/` directory with Vite 6 + React 18 + TypeScript 5 project scaffold
  - Design token system translating Python theme.py (ColorTokens, TypeScale, Spacing) to CSS custom properties
  - React ThemeProvider with dark/light mode toggle, system preference detection, localStorage persistence
  - Application shell: navigation rail (Chat/Documents/Settings pages), responsive flexbox layout
  - Toast notification system with success/error/info variants and entrance/exit animations
  - Keyboard shortcuts hook (Ctrl+Enter, Ctrl+L, Ctrl+,) with input/textarea focus guard
  - vitest + @testing-library/react testing framework configured

- **Chat UI (Phase 3)**: Complete streaming chat interface with new components:
  - `ChatPage.tsx`: Primary chat page with `TokenStreamManager`-powered streaming, message state management, send/cancel/clear operations
  - `ChatMessageBubble.tsx`: Role-based bubbles (user/assistant/system) with relative timestamps, hover-to-copy, markdown rendering, source citations, and streaming cursor
  - `ChatMessageList.tsx`: Scrollable message container with auto-scroll on new messages
  - `ChatInput.tsx`: Multi-line input with Ctrl+Enter send, Escape cancel, disabled state during loading
  - `MarkdownRenderer.tsx`: Zero-dependency inline markdown parser (bold, italic, code, lists, links with URL validation); fenced code blocks rendered as `<pre>`
  - `SourceCitation.tsx`: Expandable citation pills with filename truncation, full-path reveal on click, copy-to-clipboard
  - `InferenceModeToggle.tsx`: Status dot (green/yellow/red) and mode button for browser-local vs API mode
  - `StreamingIndicator.tsx`: Bouncing dots animation (3 dots cycling at 200ms intervals)
  - `TokenStreamManager.ts`: RAF-batched token delivery with unified callbacks for SSE/WebLLM, cancellation support, memory-safe cleanup
  - `InferenceModeContext.tsx`: Dual-mode React context with localStorage persistence (`inference-mode` key) and server connectivity checking against `/auth/status`
  - `chat.ts`: Shared `ChatMessage`, `MessageRole`, `ChatState` TypeScript types
  - `@keyframes blink` in `tokens.css`: Streaming cursor animation (step-end, 1s period)
  - Model loading overlay: Blocking modal with progress bar when browser-local model is initializing

- **Thread-safe RAG engine**: Lazy LLM initialization with cancellation support, asyncio.to_thread wrapping for all LLM calls, and thread-safe query transformer singleton with retry suppression via _query_transformer_failed sentinel (Phase 5)

- **Streaming message persistence**: stream_end handler now calls `_add_message` before destroying frame; `_streaming_finalized` guard prevents double-finalization; `_finalize_streaming_message()` helper extracted (Task 1.1)
- **Chat history bounded to 50 messages**: Oldest messages pruned when limit exceeded; configurable via `CHAT_HISTORY_MAX_MESSAGES` and `CHAT_HISTORY_PRUNE_COUNT` constants (Task 3.1)
- **Message queue validation**: Malformed messages logged and skipped before processing; prevents crashes from invalid queue entries (Task 4.1)
- **Exception logging**: Previously silent except blocks now log via `logging.getLogger("app_gui")` for debugging (Task 4.2)
- **Shutdown flag**: `_message_processor_shutdown` flag stops message processor loop on window close for clean shutdown (Task 5.1)

### Changed
- **Clear chat resets streaming refs**: `_streaming_message_ref`, `_streaming_message_frame`, and `_streaming_finalized` all reset in `_do_clear_chat` and `_confirm_clear_chat` (Task 2.1)
- **BM25 incremental updates**: Batch-only incremental ChromaDB updates on document changes instead of full rebuilds
- **Hybrid search with RRF**: Combined BM25 and vector search using Reciprocal Rank Fusion for improved retrieval quality
- **BM25 tokenizer normalization**: Normalized tokenization for consistent BM25 scoring across document and query processing
- **Vector store neighbor expansion**: Configurable neighbor expansion (default k=5) to capture near-duplicate relevant chunks
- **Embedding normalization**: Unit-normalized embeddings for consistent cosine similarity scores
- **Gemma 4 support**: Added Gemma 4 E2B model detection for <|think|> stop token suppression

- **Dynamic text wrapping**: Chat messages automatically reflow based on window width — resize the window and text wraps accordingly (Task 3.1)
- **Empty state guide**: Friendly placeholder with document icon, heading, descriptive text, and sample question buttons shown when no documents are loaded (Task 3.2)
- **Operation cancellation**: Cancel button and Escape key support for interrupting long-running operations including engine initialization, document ingestion, and question querying (Task 3.3)
- **Sample question buttons**: Quick-start questions in empty state to help users get started immediately
- **Interactive source pills**: Document sources displayed as clickable badge frames with document icons and truncated filenames (Task 4.2)
- **Inline snippet cards**: Clicking a source pill expands an inline card showing the relevant text snippet from the document (Task 4.2)
- **CTkTooltip class**: Non-blocking hover tooltips using CTkToplevel with 500ms delay (Task 4.3)
- **Settings field hints**: Descriptive tooltip text for all RAG configuration fields including chunk_size, n_results, max_tokens, temperature, hybrid_search, reranking, retrieval_window, initial_top_k, rerank_top_k, context_truncation, chunk_overlap, min_similarity, and db_path (Task 4.3)
- **Database settings section**: New section in Settings dialog with database path entry and Browse button (Task 4.1)
- **Additional RAG configuration fields**: 
  - `rag_embedding_model`: Read-only display of current embedding model
  - `rag_reranker_model`: Read-only display of current reranker model
  - `rag_chunk_overlap`: Configurable chunk overlap (0-512 words)
  - `rag_min_similarity`: Minimum similarity threshold (0.0-1.0)
  - `rag_context_truncation`: Maximum context length (256-32768 characters)
  - `rag_db_path`: Configurable vector database path (Task 4.1)
- **Settings placeholder hints**: Model path, chunk_size, n_results, max_tokens, temperature, retrieval_window, initial_top_k, and rerank_top_k entries now show placeholder text to guide users (Task 5.2)

### Changed
- **Cancel button behavior**: Now appears during all background operations (engine init, ingestion, querying) and disappears when operation completes or is cancelled
- **Escape key handler**: Delegates to `_cancel_operation()` when an operation is active, providing consistent cancellation behavior
- **Button border width**: All buttons created via `_make_button()` now consistently use `border_width=1` (standardized from Task 5.1)

### Fixed
- **Non-streaming chat_complete return**: Fixed missing `return cleaned` in GGUFBackend.chat_complete() non-streaming branch that caused LLM responses to be discarded
- **QueryTransformer race condition**: Added `_query_transformer_failed` check inside `_init_lock` double-check to prevent retry storms after failure
- **Duplicate reranking block**: Removed accidental duplicate `if reranked is not None` block from merge artifact in RAGEngine.query()
- **QueryCancelled exception**: Introduced dedicated `QueryCancelled` exception class replacing fragile `"cancelled" in str(e)` string matching
- **Security CI false positives**: Created `.safety-policy.yml` and tightened dependency minimum versions to resolve safety scan range-based false positives
- **Text overflow**: Long chat messages no longer overflow the chat area due to dynamic wraplength calculation
- **Empty chat confusion**: Users now see clear guidance and sample questions when no documents are loaded

## [2.0.0] - 2026-04-14

### Changed
- **Model upgrade**: Replaced phi3-mini-int4 with Gemma 4 E2B (Q5_K_M GGUF, 3.13 GB)
- **Single backend**: Removed OpenVINO, Ollama, and OpenAI-compatible API backends; GGUF (llama-cpp-python) is now the only backend
- **Offline hardened**: Eliminated all network access — no HuggingFace downloads, no API calls, no telemetry
- **Security**: Added non-HTTP scheme rejection, 0.0.0.0 binding rejection, null-byte injection prevention, path traversal protection
- **UI/UX**: Segoe UI font, 36px button height, accessibility labels, keyboard shortcuts (Ctrl+O, Ctrl+Enter, Escape), progress animation
- **Error handling**: Structured logging (replaced print()), TimeoutError classification, SettingsProxy AttributeError wrapping
- **Resilience**: Lazy loading for embedding model, BM25, and SentenceTransformer; try/except wrappers on all I/O
- **Build system**: Updated PyInstaller spec, removed Ollama env vars from build scripts
- **Dead code cleanup**: Removed unused validate_numeric(), validate_device(), legacy model fallbacks, deprecated import aliases

### Added
- **Keyboard shortcuts**: Enter to submit questions, Escape to clear input/cancel operations, Ctrl+L for clear chat, Ctrl+, for settings
- **Inline typing indicator**: "Thinking..." animation in chat area during processing (replaces status bar overwrite)
- **Clear chat confirmation**: Two-click confirm pattern with 3-second timeout to prevent accidental deletion
- **Settings switch labels**: CTkSwitch widgets with descriptive text ("Enable Hybrid Search", "Enable Reranking")

### Removed
- OpenVINOLLM backend and OpenVINO dependencies
- OllamaLLM backend and Ollama configuration
- OpenAICompatibleLLM backend and API configuration
- Dead CLI arguments (--model-path, --ollama-url, --api-url, etc.)
- Legacy model filename fallbacks (phi3-mini-int4.gguf, phi3.5-mini-instruct-int4-cw-ov)

## [1.2.1] - 2026-04-12

### Changes

#### SettingsDialog Simplification (Task 3.2)
- **app_gui.py**: Removed backend priority label showing "GGUF → Ollama → OpenAI-Compatible" order
- **app_gui.py**: Removed all Ollama-related widgets (URL entry, Model entry, Test button)
- **app_gui.py**: Removed all API-related widgets (URL entry, Model entry, Test button)
- **app_gui.py**: Removed `_test_ollama()` method
- **app_gui.py**: Removed `_test_api()` method
- **app_gui.py**: Updated `_populate_fields()` to remove ollama_url, ollama_model, api_url field insertions
- **app_gui.py**: Updated `_save()` to remove ollama_url, ollama_model, api_url from saved settings
- **app_gui.py**: Updated `_load_settings()` to remove ollama_url, ollama_model, api_url from default settings
- **app_gui.py**: Replaced bundled_models list (with 3 legacy models) with single Gemma 4 model

### Migration Notes
Settings dialog now only supports:
- GGUF Model Path (with Browse button)
- RAG Settings (chunk_size, n_results, max_tokens, temperature)
- Advanced RAG Settings (hybrid_search, retrieval_window, reranking)

Users who previously used Ollama or OpenAI-compatible API backends must:
1. Obtain a GGUF model file (.gguf format)
2. Configure the GGUF Model Path in Settings

For environment variable configuration (advanced users):
- Ollama: Set `RAG_OLLAMA_URL` and `RAG_OLLAMA_MODEL` in environment
- API: Set `RAG_API_URL` and `RAG_API_MODEL` in environment

## [1.2.0] - 2026-04-12

### Summary
UX Phase 1-5: Fixed critical backend fallback bug, improved API types, error messages, and Settings UI.

### Phase 1 — Chat Fallback Fix (D1)
- **llm_interface.py**: `answer_question()` now iterates all backends explicitly (GGUF tries chat_complete then generate; non-GGUF uses generate). Previously only tried backends[0].

### Phase 2 — API Typed Models (A1-A5)
- **api_server.py**: Added `LoginRequest` Pydantic model for `/auth/token`
- **api_server.py**: Added `DocumentsResponse`/`DocumentInfo` using `engine.get_all_documents()` for `/documents`
- **api_server.py**: Root `GET /` now returns `version`, `docs`, `auth_status`
- **api_server.py**: Auth-disabled at `/auth/token` now returns HTTP 503 (was 400)

### Phase 3 — API Exception Handlers (A6-A7)
- **api_server.py**: Added `RequestValidationError` custom handler returning structured `{"detail", "errors"}`
- **api_server.py**: Added global catch-all `Exception` handler with correlation ID

### Phase 4 — Error UX (B1-B2)
- **app_gui.py**: Added `_classify_error()` helper — connection/timeout/token-limit errors now show actionable messages instead of raw exceptions
- **llm_interface.py**: OpenAI-compatible URLError now appends "Is the server running?"

### Phase 5 — Settings UI (C1-C3)
- **app_gui.py**: Added backend priority hint label ("GGUF → Ollama → OpenAI-Compatible")
- **app_gui.py**: Added "Test" buttons for Ollama URL and API URL
- **app_gui.py**: Status bar now shows `Ready (Backend / model-name)` instead of just backend name

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
