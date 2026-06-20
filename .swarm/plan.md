<!-- PLAN_HASH: hg6r0e1f0tnt -->
# HTML5 Web Version — Browser-Side Inference + API Hybrid Architecture
Swarm: modelrelay
Phase: 1 [COMPLETE] | Updated: 2026-05-28T15:38:30.078Z

---
## Phase 1: Project Scaffold and Theme Foundation [COMPLETE]
- [x] 1.1: Initialize Vite + React + TypeScript project in web_ui/ directory with production build configuration, dev server proxy to FastAPI backend, and project structure (src/pages, src/components, src/lib, src/styles, src/types) [MEDIUM]
- [x] 1.2: Implement the design token system by translating the existing theme.py ColorTokens, TypeScale, and Spacing classes into CSS custom properties and a typed theme context (React context provider with dark/light mode toggle via prefers-color-scheme) [MEDIUM] (depends: 1.1)
- [x] 1.3: Build the application shell with navigation rail (Chat, Documents, Settings pages), responsive layout, global keyboard shortcut handler (Ctrl+Enter, Ctrl+L, Ctrl+,), and toast notification system [MEDIUM] (depends: 1.2)
- [x] 1.4: Address Phase 1 council concerns: add vitest + @testing-library/react to devDependencies, fix NavigationRail hover effect (replace imperative DOM mutation with CSS approach), add input/textarea focus guard to keyboard shortcuts, fix 100vh to 100dvh in AppLayout, add aria-hidden to decorative SVGs [SMALL] (depends: 1.3)

---
## Phase 2: API Foundation and Browser ML Feasibility Spike [COMPLETE]
- [x] 2.1: Add SSE streaming endpoint to the FastAPI backend that wires the existing stream_callback from LLM interface through to Server-Sent Events, along with batch file upload endpoint accepting multiple files per request and settings persistence endpoints (GET/PUT /settings) [MEDIUM]
- [x] 2.2: Build the TypeScript API client layer with typed request/response interfaces for all FastAPI endpoints, SSE streaming consumer using EventSource, authentication interceptor using existing JWT system, and connection error handling with offline detection [MEDIUM]
- [x] 2.3: Add tests for the new FastAPI endpoints (SSE streaming, batch upload, settings CRUD) covering success cases, error cases (invalid files, auth failures), and streaming interruption scenarios [SMALL] (depends: 2.1)
- [x] 2.4: Browser ML feasibility spike: create a standalone test page that loads Transformers.js (bge-small-en-v1.5), EdgeVec (HNSW vector search), and FlexSearch (BM25 keyword search), validates each works on target hardware (12th-gen i5 / 16GB RAM), measures memory usage and query latency [MEDIUM]

---
## Phase 3: Chat Page and Inference Mode Architecture [COMPLETE]
- [x] 3.1: Implement the chat message list component with user/assistant bubble styling, markdown rendering for assistant responses, message input with send button, and AbortController-based generation cancellation [MEDIUM] (depends: 1.3, 2.2)
- [x] 3.2: Add source citation pills to chat responses with expandable snippet view, copy-to-clipboard for individual messages and source passages, two-click confirm for clear chat history (React state + setTimeout), and empty state guidance [MEDIUM] (depends: 3.1)
- [x] 3.3: Implement the inference mode architecture: React context for mode state (browser-local vs API), mode toggle in chat header, runtime switching without session loss, model readiness gate that blocks chat until model is loaded in browser mode, and server connectivity check for API mode [MEDIUM] (depends: 3.1)
- [x] 3.4: Implement the streaming token display layer: SSE token consumer that feeds tokens to chat message state, WebLLM token consumer wired to same message state, typing indicator CSS animation, and batched DOM updates to prevent jank during rapid token arrival [MEDIUM] (depends: 3.1)

---
## Phase 4: Document Processing Pipeline [COMPLETE]
- [x] 4.1: Implement PDF text extraction using pdfjs-dist: load PDF from File API, extract text content per page, track page numbers for chunk-to-page mapping, handle encrypted and malformed PDFs gracefully [MEDIUM]
- [x] 4.2: Implement DOCX extraction via mammoth.js (paragraphs + tables), XLSX extraction via SheetJS (sheet/row structure), and TXT/MD extraction with multiple encoding fallback [MEDIUM] (depends: 4.1)
- [x] 4.3: Implement PPTX text-only extraction via jszip + XML parsing: open PPTX as ZIP, parse slide XML files, extract text content preserving slide order [SMALL] (depends: 4.2)
- [x] 4.4: Port the semantic chunking algorithm from document_processor.py to TypeScript: paragraph/sentence boundary detection, configurable overlap, abbreviation protection, page mapping for PDFs, and document ID generation (SHA256) [MEDIUM] (depends: 4.2)
- [x] 4.5: Build the Documents page UI with drag-and-drop upload zone, file picker input, multi-file progress tracking, per-file status indicators, document list with delete capability, and IndexedDB persistence [MEDIUM] (depends: 4.4)

---
## Phase 5: In-Browser Embeddings and Vector Search [COMPLETE]
- [x] 5.1: Integrate Transformers.js for embedding generation using bge-small-en-v1.5 ONNX model: model loading with OPFS/IndexedDB caching, single and batch encode methods, memory-efficient processing [MEDIUM]
- [x] 5.2: Implement HNSW vector index using EdgeVec (Rust/WASM): index creation with configurable parameters, add/remove vectors, k-NN queries, index serialization to IndexedDB [LARGE] (depends: 5.1)
- [x] 5.3: Implement BM25 keyword search using FlexSearch: index creation with stop-word filtering, incremental document addition, query with relevance scoring [MEDIUM] (depends: 5.1)
- [x] 5.4: Port Reciprocal Rank Fusion from utils.py to TypeScript: merge ranked results from HNSW and BM25 with configurable k parameter [SMALL] (depends: 5.2, 5.3)
- [x] 5.5: Implement optional cross-encoder reranking via Transformers.js MiniLM-L-6 model with conditional activation based on document set size and memory [MEDIUM] (depends: 5.4)
- [x] 5.6: Add memory-aware model selection logic: detect available device memory, select appropriate model based on budget, surface memory-pressure indicator [MEDIUM]

---
## Phase 6: Browser-Side LLM Inference (WebLLM) [COMPLETE]
- [x] 6.1: Integrate @mlc-ai/web-llm for browser-side LLM inference: model loading with OPFS caching, GPU adapter detection with WASM fallback, basic prompt/completion API [MEDIUM] (depends: 3.3)
- [x] 6.2: Implement model download management: progress tracking, resumable downloads, OPFS cache write, storage quota error handling, model selection UI [MEDIUM] (depends: 6.1)
- [x] 6.3: Implement model readiness gate: block all RAG functionality until models loaded, show loading state, handle storage quota errors [MEDIUM] (depends: 5.1, 6.2)
- [x] 6.4: Build complete browser-local RAG orchestrator: query preprocessing, embedding, hybrid search, optional reranking, context assembly, LLM prompt construction, streaming generation [LARGE] (depends: 5.5, 6.3)
- [x] 6.5: Implement WebGPU context loss detection and recovery: contextlost events, auto model reload, recovery prompt, tab visibility handling [MEDIUM] (depends: 6.1)

---
## Phase 7: Settings, Cross-Browser Compatibility, and Polish [COMPLETE]
- [x] 7.1: Build the Settings page with inference mode configuration, server endpoint URL, model selection, theme toggle, and preferences persisted to IndexedDB [MEDIUM] (depends: 1.3, 6.3)
- [x] 7.2: Add cross-browser compatibility: Chrome/Edge full support, Firefox degradation, Safari WebGPU detection with fallback guidance [MEDIUM]
- [x] 7.3: Production polish: loading skeletons, empty states, error boundaries, responsive layout, accessibility basics, and SC-011/SC-006 verification [MEDIUM] (depends: 7.1, 7.2)

---
## Phase 8: End-to-End Integration Wiring [COMPLETE]
- [x] 8.1: Create service initialization infrastructure: a React hook or component that initializes EmbeddingService, VectorIndex, and KeywordIndex on app startup with a loading screen, runs early WebGPU availability check, wires model readiness state via InferenceModeContext.setModelReady() when model is cached, handles initialization errors gracefully, and adds service dispose() cleanup on app unmount [MEDIUM]
- [x] 8.2: Wire DocumentsPage to search indexes: after TextChunker creates chunks, compute embeddings via EmbeddingService.encodeBatch(), call vectorIndex.addBatch() with embedded vectors and docId mapping, call keywordIndex.addDocuments() with text chunks, show indexing progress in UI, save indexes after operations. On document deletion, call vectorIndex.removeByDocId() and keywordIndex.removeByDocId() to clean up search indexes [MEDIUM] (depends: 8.1)
- [x] 8.3: Wire ChatPage to RAGOrchestrator for browser-local inference mode: import RAGOrchestrator, replace MOCK_STREAMING_RESPONSE and mockProducer with RAGOrchestrator.query() AsyncGenerator iteration, feed token events to TokenStreamManager.pushToken(), wire complete event with sources to TokenStreamManager.complete(), wire error events to TokenStreamManager.error(), handle no-document/no-results case with user-friendly message, connect cancellation, remove all mock data (MOCK_STREAMING_RESPONSE, mockTimerRef, mockProducer) [LARGE] (depends: 8.1)
- [x] 8.4: Wire ChatPage to API server mode: when inference mode is 'api', use TokenStreamManager.startSSEStream() to connect to the backend /ask endpoint via SSE, wire serverUrl from InferenceModeContext into the API request, handle connection errors and server unreachable states, pass auth token if available [MEDIUM] (depends: 8.3)
- [x] 8.5: Remove TokenStreamManager.startWebLLMStream() stub: delete the unimplemented startWebLLMStream method that always errors, since ChatPage now iterates RAGOrchestrator.query() directly and the orchestrator handles WebLLM internally [SMALL] (depends: 8.3)
- [x] 8.6: Production cleanup: remove MlSpikePage.tsx diagnostic page, fix StreamingIndicator.tsx dotStyle function (move outside component), wire useKeyboardShortcuts onSendMessage and onClearChat callbacks, clean up lib/index.ts barrel exports, add service dispose() calls on app unmount for singleton cleanup [MEDIUM] (depends: 8.2, 8.4, 8.5)
- [x] 8.7: End-to-end build and integration verification: run production build (vite build), fix any TypeScript compilation errors, run full test suite, run placeholder scan to confirm zero remaining TODO/FIXME/HACK markers in production code, verify no dead imports or unused exports remain [SMALL] (depends: 8.6)
