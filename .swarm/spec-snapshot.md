# Specification: HTML5 Web Version — Browser-Side Inference + API Hybrid Architecture

## Goals

1. **Offline-first RAG**: The full document question-answering pipeline (upload, parse, embed, index, search, rerank, generate) MUST work entirely offline after initial page load on minimum hardware of a 12th-gen i5 with 16 GB RAM. No network connectivity is required for any operation once the application and models are cached.
2. **Zero-install access**: Users can run the Document Q&A Assistant entirely through a web browser, removing the requirement for local Python, CUDA, or manual dependency setup.
3. **Dual inference modes**: Browser-local mode is the primary path. Server API mode is an optional enhancement for users who have a FastAPI backend available and want higher-quality inference.
4. **Seamless RAG workflow**: Users upload documents, ask questions, and receive cited answers — all within a browser-based chat interface — in either inference mode.
5. **Accessibility**: The application works on modern browsers with responsive support for lower-end devices via automatic model fallback.

## Non-Goals

- Replacing or rewriting the existing FastAPI backend — server mode reuses the current API layer as an optional enhancement.
- Supporting mobile-native app stores or PWA installation beyond what the browser provides.
- Real-time collaborative document editing or multi-user document workspaces.
- Native desktop features that browsers cannot support (e.g., filesystem access beyond the File API, background processes).
- Video, audio, or image analysis — only document text content is within scope.
- Multi-language support for the UI itself (English only for v1).
- Accessibility conformance beyond WCAG 2.1 Level A (though Level AA is aspirational).

## User-Visible Behaviour

### US-01: Complete offline RAG workflow
**Given** the user has opened the application in a browser after the initial load (with models cached)
**And** the user has no network connectivity
**When** the user uploads a PDF document via drag-and-drop
**And** asks a question about the document's content
**Then** the answer appears in the chat as streaming tokens
**And** the answer includes citations linking to the relevant passages in the uploaded document
**And** no network requests are made

### US-02: Toggle inference mode mid-session
**Given** the user is in an active chat session in browser-local mode
**When** the user configures a server API endpoint and switches to server API mode
**Then** the application transitions without losing the current chat history
**And** subsequent queries execute via the configured backend server

### US-03: Memory pressure detection and model fallback
**Given** the user is on a device with 16 GB RAM running a 12th-gen i5
**When** browser-local mode is activated and the primary model cannot fit in available memory alongside the vector index and browser heap
**Then** the application automatically selects a smaller model that fits within the memory budget
**And** displays a clear indicator showing which model was selected and why

### US-04: Offline usage after initial load
**Given** the user has previously visited the application and all model artifacts are cached
**When** the user revisits the application with no network connectivity
**Then** the application loads fully from cached artifacts (HTML, JS, model files)
**And** the user can upload documents and ask questions without any network requests

### US-05: WebGPU unavailable
**Given** the user opens the application in a browser that does not support WebGPU
**When** the user attempts to use browser-local mode
**Then** the application detects the missing capability and displays a clear notification
**And** guides the user to either switch to server API mode or use a WebGPU-capable browser

### US-06: First-time model download
**Given** the user visits the application for the first time
**When** the model artifact download begins (served from the application origin)
**Then** a progress indicator shows bytes transferred vs. total, transfer speed, and estimated time remaining
**And** the download supports resumption if interrupted
**And** once complete, the model is cached for all subsequent visits without re-download

### US-07: Multi-file upload with partial failures
**Given** the user drags five supported-format files (PDF, DOCX, XLSX, PPTX, TXT) onto the upload area, one of which is corrupt
**When** the parsing completes
**Then** a per-file status shows four documents as successfully indexed
**And** one file shows a specific parse error without blocking the other documents from being queried

### US-08: Theme switching
**Given** the user is viewing the application in the default theme
**When** the user toggles to dark mode in settings
**Then** every UI element updates to the dark theme instantly without page reload
**And** the preference is remembered on the next visit

### US-09: Keyboard shortcuts
**Given** the user is on the chat page
**When** the user presses Ctrl+Enter (or the platform-appropriate shortcut)
**Then** the current message is sent without requiring a mouse click
**And** pressing Ctrl+L (or equivalent) clears the chat history
**And** pressing Ctrl+, (or equivalent) opens the settings panel

### US-10: Background tab context recovery (browser mode)
**Given** the user is in browser-local mode with a model loaded
**When** the browser tab is backgrounded and the system reclaims the GPU context
**Then** upon returning to the tab, the application detects the lost context
**And** reloads the model or displays a "context lost — click to reload" prompt

## Functional Requirements

### FR-001: Browser-based access without installation
The application MUST be fully functional through a standard web browser without requiring the user to install any desktop software, runtime environments, or command-line tools.

### FR-002: Dual inference mode support
The application MUST provide two distinct inference execution modes:
- **Browser-local mode** (default): all machine-learning operations (text embedding, document search, answer generation) execute entirely on the user's device within the browser sandbox.
- **Server API mode** (optional): all machine-learning operations execute on the backend server when a server endpoint is configured.

### FR-003: Offline-first architecture
The application MUST be fully operational offline after initial page load. In browser-local mode, all operations (document upload, parsing, embedding, indexing, search, reranking, and answer generation) MUST execute without any network connectivity. No external network requests MUST be made after initial load and model caching are complete.

### FR-004: Browser-local execution isolation
In browser-local mode, all ML operations MUST execute client-side without transmitting document content, queries, or intermediate results to any external server.

### FR-005: Server API execution path
In server API mode, all ML operations MUST execute via the existing backend service. The web application MUST authenticate with the backend using the existing authentication system when required. Server API mode MUST only be available when the user explicitly configures a server endpoint.

### FR-006: Runtime inference mode switching
The user MUST be able to switch between inference modes at any time without restarting the application or losing the current chat session.

### FR-007: Streaming token display
The chat interface MUST display assistant responses incrementally as tokens are generated, with each new token appearing in real-time without waiting for the full response to complete. This applies to both browser-local mode and server API mode.

### FR-008: Supported document formats
The application MUST accept and extract text content from the following document formats: PDF, DOCX, XLSX, PPTX, and TXT. PPTX extraction MUST provide at minimum text content from slides.

### FR-009: Drag-and-drop and batch upload
Document upload MUST support drag-and-drop interaction from the operating system file manager and MUST allow selecting and uploading multiple files simultaneously.

### FR-010: Source citation display
When answering a question, the application MUST display inline citations or footnotes that reference the specific source passages from which the answer was derived. Each citation MUST link to or reveal the source document passage.

### FR-011: Visual theme system
The application MUST provide at minimum two visual themes: a light theme and a dark theme. Switching between themes MUST apply instantly without a page reload.

### FR-012: Persistent user preferences
User preferences (inference mode selection, active theme, selected model, configured server endpoint, and any other configurable settings) MUST be persisted across browser sessions using client-side local storage.

### FR-013: Model artifact caching and offline persistence
Model artifacts MUST be served from the application origin (not external CDNs or third-party URLs) and MUST be cached using browser storage APIs (Cache API, IndexedDB, or OPFS). Subsequent sessions MUST reuse cached artifacts without re-download. Downloads MUST be resumable after interruption. The application MUST gate RAG functionality behind a "model ready" state — no inference, embedding, or search is available until required models are loaded.

### FR-014: Memory-aware model selection
The application MUST detect available device memory and automatically select a model that fits within the memory budget alongside the vector index and browser heap. On the target hardware (12th-gen i5, 16 GB RAM), the default model MUST leave sufficient headroom for the browser, OS, vector index, and embedding model. A memory-pressure indicator MUST be visible to the user.

### FR-015: Graceful WebGPU absence handling
The application MUST detect when the browser lacks WebGPU support. In that case, browser-local mode MUST either fall back to an alternative inference path (e.g., WASM-based) or display a clear message explaining the limitation and suggesting alternatives (server API mode or a different browser).

### FR-016: Server-Sent Events for streaming
When operating in server API mode, the backend MUST deliver streaming token responses via Server-Sent Events (SSE) protocol so the web client can render tokens incrementally.

### FR-017: Hybrid retrieval pipeline
The document question-answering pipeline MUST combine semantic similarity retrieval with keyword-based retrieval (hybrid search) and fuse results using a ranked fusion algorithm to maximize answer relevance. This applies in both browser-local mode and server API mode.

### FR-018: Per-file error reporting
When multiple documents are uploaded and some fail to parse, the application MUST report the failure for each affected file individually and MUST continue processing the remaining files.

### FR-019: Download progress indication
When browser-local mode requires downloading a model artifact, the application MUST display a progress indicator showing at minimum: bytes transferred vs. total bytes, transfer speed, and estimated time remaining or percentage complete.

### FR-020: Background context loss recovery (browser mode)
In browser-local mode, if the WebGPU context is lost (e.g., due to tab backgrounding or system resource pressure), the application MUST detect the loss and either automatically restore the context or prompt the user to reinitialize the inference engine.

## Acceptance Criteria

### SC-001: Full offline RAG workflow — browser mode
A user can upload a PDF document via drag-and-drop in browser-local mode with no network connectivity, ask a question about its content, and receive a streamed answer with source citations. The answer content is factually derived from the uploaded document. No network requests are observed after initial load.

### SC-002: Full RAG workflow — server API mode
A user can upload a PDF document in server API mode (with a running backend), ask a question, and receive a streamed answer with source citations, matching the current desktop API experience.

### SC-003: Streaming token latency
From the moment the local inference engine begins generating a response, the first token appears in the chat UI within 500 milliseconds. Subsequent tokens appear at a steady cadence without long pauses between tokens.

### SC-004: Cross-mode switching
A user can toggle from browser-local mode to server API mode (or vice versa) and immediately submit a new query without a page refresh, application restart, or loss of preceding chat messages.

### SC-005: Browser-local privacy isolation
With browser-local mode active and the browser's developer tools network tab open, no HTTP requests to external servers are observed after initial load and model caching are complete.

### SC-006: Minimum hardware compliance
The full offline RAG workflow (upload, parse, embed, index, query, stream answer) completes successfully on a 12th-gen i5 with 16 GB RAM using the default model selection. The application does not crash or become unresponsive due to memory pressure.

### SC-007: Chromium compatibility
The full application workflow completes successfully on the latest stable versions of Google Chrome and Microsoft Edge.

### SC-008: Firefox compatibility
The full application workflow completes successfully on the latest stable Mozilla Firefox, possibly with reduced performance but correct functional behaviour.

### SC-009: Safari degraded operation
On the latest stable Safari, the application loads and displays the interface correctly. Browser-local mode detects the WebGPU limitation and presents fallback guidance without crashing.

### SC-010: Dark/light theme instant switch
Toggling between dark and light themes updates all visible UI elements within 100 milliseconds without a page reload. The selected theme persists after closing and reopening the browser tab.

### SC-011: 50 MB document upload
A single PDF file of up to 50 MB in size is accepted, parsed, and indexed without error in browser-local mode on minimum-spec hardware (12th-gen i5, 16 GB RAM).

### SC-012: Multi-file batch upload
Dragging 10 documents onto the upload area in a single operation indexes all valid documents and reports per-file errors for any that fail parsing, without interrupting the processing of successful files.

### SC-013: Keyboard shortcut execution
Pressing each documented keyboard shortcut triggers its associated action (send message, clear chat, open settings) and produces the expected UI result.

### SC-014: Model caching across sessions
After downloading a model in browser-local mode, closing and reopening the application reuses the cached model without initiating a new download. The user is informed which model is active.

### SC-015: No-install verification
A user who has never installed Python, Node.js, or any desktop runtime can open the application URL in a supported browser and complete the entire offline RAG workflow after the initial page and model download.

## Out of Scope

- Mobile-native applications (iOS/Android app store builds) — v1 targets desktop browsers only.
- PWA install prompt or service-worker-based offline support — caching via standard browser storage APIs only.
- Audio/video/image document processing — only text-based document formats are supported.
- Real-time collaboration or document sharing between users.
- Multi-language UI localization — English only for v1.
- Accessibility beyond basic WCAG 2.1 Level A compliance.
- Browser extension or add-on development.
- Desktop build via Electron or similar wrappers — the application must work without any bundling into a native shell.
- Performance benchmarking or automated regression testing infrastructure.
- Custom theming beyond dark/light mode (e.g., custom accent colors).

## Resolved Questions

The following questions arose during spec drafting and have been resolved by the project team:

1. **Default inference mode**: Browser-local mode is the default on first visit. This application is offline-first — the full RAG pipeline MUST work without network after initial load. Server API mode is an optional enhancement, available only when the user explicitly configures a backend endpoint. Rationale: the primary use case is offline document Q&A on minimum-spec hardware (12th-gen i5, 16 GB RAM). API mode is a quality escape hatch, not the primary path.

2. **PPTX support scope**: v1 includes text-only PPTX extraction via slide XML parsing. Presentations are a common document type for offline Q&A use cases. The extraction cost is low and deferring would create an obvious gap. Caveat: only text content is extracted — complex layouts, charts, and speaker notes are not preserved.

3. **Model artifact sourcing**: Model artifacts MUST be served from the application origin (self-hosted) to support offline operation. External CDNs and HuggingFace Hub URLs are not used. This requires: chunked and resumable downloads, storage-quota management, a "model ready" gate before RAG functionality is available, and static hosting capable of serving multi-GB files with proper Cache-Control and range request support.