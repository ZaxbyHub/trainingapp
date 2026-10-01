# Document Q&A Assistant

A fully offline RAG-based document question answering system optimized for Windows PCs. Features semantic search, hybrid retrieval, and CPU-based LLM inference with GGUF models. Nothing leaves the machine unless you turn on the external model or update checks (both off by default).

The shipped delivery options share the same offline RAG capabilities:
1. **Desktop app (primary)** — an Electron installer with a first-run wizard, a Node
   main-process backend ([ADR-0003](docs/adr/0003-desktop-backend.md)), bundled models
   (Quality/Fast profiles per [ADR-0002](docs/adr/0002-llm-profiles.md)), and knowledge
   packs — fully offline after install.
2. **HTML5 web app** (`web_ui/`) — a fully self-contained, STIG-scannable archive that
   runs entirely in the browser with **no runtime downloads** (the same build is the
   desktop app's renderer).

A legacy Python harness (`api_server.py`, `pip install`) survives only as the CI
contract-conformance surface — see the scope notes at the top of USAGE.md, INSTALL.md,
and CONFIGURATION.md.

## 🖥️ What's in the v3 desktop app

- **Knowledge packs** — installable document/training packs built and verified with
  `packtool`, managed in-app (install / supersede / rollback / remove); see the
  [pack authoring guide](docs/pack-authoring-guide.md) and the
  [training-pack refresh runbook](docs/training-pack-refresh-runbook.md).
- **Learn panel with Open-in-training deep links** — answers cite the training slides
  that teach them, and jump straight into the embedded Storyline player.
- **First-run wizard** — hardware detection, profile selection, sha256 integrity
  verification of the bundled tree, pack activation, and license notices.
- **Signed, opt-in update channel** — Ed25519-signed pack updates and detect-and-notify
  app updates, off until you switch them on
  ([ADR-0010](docs/adr/0010-update-channels.md), [docs/updates.md](docs/updates.md)).
- **Quality/Fast inference profiles** — `gemma-4-e2b-it` Q4_K_M vs `lfm2.5-vl-450m`
  Q4_K_M with a free-RAM auto gate ([ADR-0002](docs/adr/0002-llm-profiles.md)).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system map.

## 🌐 Offline HTML5 Web App (overhauled)

The browser app is a complete, offline RAG client. See `PACKAGING.md` for the build/bundle steps.

- **Fully offline, packaged models** — embeddings (arctic-embed-m ONNX), ONNX Runtime WASM, and the
  browser LLM are served same-origin from `public/models/`; nothing is fetched from a CDN or the
  HuggingFace Hub at runtime. A readiness gate reports "models ready vs missing".
- **Browser LLM engine: wllama** — llama.cpp WASM, CPU/SIMD, **no WebGPU**, the default
  and most robust on i5/Iris Xe. A hardware-capability panel detects WebGPU/threads/memory.
  The WebLLM (WebGPU) engine remains selectable code but ships no weights in the offline
  manifest, so it is not part of the air-gapped configuration.
- **Multimodal** — attach a screenshot in chat and ask about it (wllama + Gemma 4 E2B-it mmproj), offline.
- **Chat UX** — streaming with interactive source citations, regenerate, conversation export
  (Markdown/JSON), and Fast/Balanced/Quality RAG presets.
- **Self-contained archive** — `npm run build:offline` produces a validated `web_ui/dist/` the
  Electron desktop app (or any root static host) serves with the COOP/COEP headers wllama needs.
- **Optional external model (both apps, off by default)** — Settings → External model connects to
  any OpenAI- or Anthropic-compatible server on this computer, on your network, or in the cloud
  (with an API key). Retrieval stays local; see the "External model" section of
  [CONFIGURATION.md](CONFIGURATION.md) and
  [ADR-0011](docs/adr/0011-external-model-endpoints.md).

### HTML5 Web UI (Phase 1 — Complete)
- **Application Shell**: Navigation rail with Chat, Documents, Settings pages and responsive flexbox layout
- **Theme System**: Dark/light mode toggle with system preference detection and localStorage persistence
- **Design Token Foundation (Phase 1)**: Comprehensive CSS custom property system on 8px grid with Inter font, status color tokens (info/warning/success), and radius tokens (sm/md/lg)
- **Toast Notifications**: Non-blocking toast system with success/error/info variants and entrance animations
- **Keyboard Shortcuts**: Ctrl+Enter (send), Ctrl+L (clear chat), Ctrl+, (open settings) with input/textarea focus guard
- **Testing Framework**: vitest configured with @testing-library/react and jsdom environment

### Chat Experience (Phase 2)
- **Centered Transcript Layout**: Message list now centered with 768px max-width for comfortable reading
- **Rich Empty State**: Hero heading "How can I help with your documents?" with 3 clickable suggested prompt cards
- **Suggested Prompts**: Click any prompt card to immediately send that question to the chat
- **Assistant Message Styling**: Full-width prose layout (no bubble background/radius) for improved readability
- **User Message Styling**: 75% width bubbles aligned right, maintaining visual distinction
- **Action Row Copy Button**: Copy button relocated below message content in a dedicated action row
- **Composer Redesign**: Raised card input with 20px radius (`--radius-lg`), enhanced focus feedback (border color + shadow), elevation shadow, and 12px radius buttons (`--radius-md`)

### Core Capabilities
- **Offline-First Design**: No internet required after initial setup
- **Multi-format Support**: PDF, DOCX, PPTX, TXT, MD documents
- **Hybrid Retrieval**: keyword (FTS5/BM25) + vector search fused with Reciprocal Rank Fusion (RRF, k=60 on every surface)
- **Window Expansion**: Automatically fetches adjacent context chunks
- **Smart Chunking**: Paragraph and sentence boundary aware
- **Cross-Encoder Reranking**: ettin-reranker (ModernBERT) for precise ranking

### LLM Backend (GGUF-Only)
The desktop app runs GGUF models via node-llama-cpp (Node main-process backend, ADR-0003); the browser app uses the same GGUF weights through wllama (llama.cpp WASM) — fully offline on both:

- **Quality profile (default)**: Gemma 4 E2B-it (Q4_K_M GGUF per [ADR-0002](docs/adr/0002-llm-profiles.md); ~2.9 GB nominal per PACKAGING.md; 2,620,370,976 bytes measured per bench/RESULTS.md) — bundled
- **Fast profile**: lfm2.5-vl-450m (Q4_K_M GGUF per ADR-0002) — bundled
- Profile selection: automatic free-RAM gate or in-app choice; `TRAININGAPP_DESKTOP_INFERENCE_PROFILE` (`quality` / `fast` / `auto`) is the desktop env override. (`RAG_GGUF_PATH` / `--gguf-path` select a custom GGUF on the legacy Python harness only.)
- No GPU required
- No network access required (unless you turn on the external model or update checks)
- Measured decode throughput and first-token latency per model/profile: see [bench/RESULTS.md](bench/RESULTS.md) (issue #52 benchmark harness)

### Hardware Requirements
#### Minimum (Intel 11th Gen i5, 16GB RAM)
- Windows 11 (64-bit)
- Intel Core i5 11th generation or newer (or equivalent AMD Ryzen 5000+)
- Intel integrated graphics (present on all 11th gen+ Intel CPUs) — no discrete GPU required
- 16GB RAM
- ~6.4 GB free storage for models + app (measured installed footprint 6,378,451,601 bytes; staged model resources 4,111,872,009 bytes; see bench/RESULTS.md)
- **Performance**: measured numbers per model and quantization are recorded in [bench/RESULTS.md](bench/RESULTS.md)

#### Recommended (Intel 12th Gen i7, 32GB RAM)
- Intel Core i7 12th generation or newer (or equivalent AMD Ryzen 7000+)
- Intel Iris Xe integrated graphics or discrete GPU
- 32GB RAM
- SSD for vector database
- **Performance**: measured numbers per model and quantization are recorded in [bench/RESULTS.md](bench/RESULTS.md)

#### High-Performance (Intel 13th Gen i9, 64GB RAM)
- High-end CPU (Intel Core i9 or AMD Ryzen 9)
- 64GB RAM
- **Performance**: measured CPU-only GGUF numbers are recorded in [bench/RESULTS.md](bench/RESULTS.md)

> **Pending**: the offline/low-RAM reference-laptop validation matrix (issue #86) —
> reference-i5 rows are not yet measured; no reference-hardware numbers are claimed here.

## Web UI overhaul (Version 2.0.0 era — historical)

> The phases below describe the 2026 `web_ui` overhaul and are preserved for history;
> the current feature set is described above and in [ARCHITECTURE.md](ARCHITECTURE.md).

### Chat UI (Phase 3)
- **Streaming Chat Interface**: Full-featured chat page (`ChatPage.tsx`) with real-time token streaming display using RAF-batched updates via `TokenStreamManager`
- **Role-Based Message Bubbles**: Distinct styling for user, assistant, and system messages with relative timestamps ("2m ago", "just now")
- **Inline Markdown Renderer**: react-markdown + remark-gfm based renderer supporting CommonMark + GFM (tables, strikethrough, task lists, autolinks, nested emphasis), fenced code blocks with language chips and per-block copy, and a URL allowlist (allows http/https/mailto/tel; rejects javascript:, data:, and scheme-less/relative URLs)
- **Source Citation Pills**: Expandable/collapsible source pills with filename truncation, full path reveal on click, and one-click copy-to-clipboard
- **Inference Mode Toggle**: Status indicator (green/yellow/red) for browser-local vs API mode with server connectivity check against `/auth/status` endpoint
- **Streaming Cursor Animation**: Blinking cursor (`@keyframes blink`) appended to assistant messages during streaming for visual feedback
- **Copy Message**: Hover-to-reveal copy button on user and assistant bubbles with 1.5s "Copied!" feedback
- **Streaming Indicator**: Bouncing dots animation (setInterval-based, 3 dots cycling at 200ms) shown below messages during generation
- **Operation Cancellation**: Cancel button stops `TokenStreamManager`, clears pending mock timers, and marks streaming messages complete

### Inference Mode Architecture (Phase 3)
> Historical (Phase 3): the browser API-server mode and its server URL described here were removed by settings-wiring-honesty, and with them the browser-side "Server not connected" header warning; `api` mode now exists only in the desktop app (where that warning still reports the desktop backend). See CONFIGURATION.md, App Settings.

- **Dual-Mode Context**: `InferenceModeContext` (`InferenceModeContext.tsx`) manages `browser-local` vs `api` mode via React context
- **localStorage Persistence**: Mode preference and server URL stored under `inference-mode` key; survives page refresh
- **Server Connectivity Check**: `checkServerConnectivity()` pings `/auth/status` with 5s timeout, handles abort for rapid toggles, updates `isServerConnected` and `modeError` state
- **Model Loading Progress**: `modelLoadingProgress` (0–100) displayed in blocking overlay when browser-local model is initializing
- **API Mode Warning**: "Server not connected" warning shown in header when API mode is active but server is unreachable

### Conversation Persistence and Navigation (Phase 3)
- **Dexie.js Integration**: IndexedDB-based conversation persistence via `DocQADatabase` class (`db/index.ts`) and CRUD operations (`db/conversations.ts`) with pagination support
- **Sidebar Navigation**: Responsive 260px sidebar (`Sidebar.tsx`) with collapsible state, showing conversation history
- **Conversation Context Menu**: Right-click to delete or rename conversations (`SidebarConversationItem.tsx`)
- **Controlled ChatPage**: Refactored with `messages`, `onMessagesChange`, and `onSaveConversation` props for explicit state management
- **App Wiring**: `useConversations` hook connects AppLayout and ChatPage for automatic conversation loading and saving
- **Simplified Header**: Compact padding, right-aligned controls, removed title text
- **Elevation Tokens**: New shadow hierarchy (`--shadow-sm/md/lg`) and surface colors (`--color-bg/surface/raised`) for consistent depth
- **Relative Timestamps**: `relativeTime.ts` utility formats conversation timestamps as "2m ago", "Yesterday", etc.

### Interactive Source Pills (Phase 4)
- **Expandable Citations**: Click to expand source pills showing full filename, page number, and content preview
- **One-Click Copy**: Copy button on each pill copies citation text to clipboard
- **Hover Preview**: Hover shows truncated source preview with tooltip for full content
- **Phase Attribution**: Pills labeled with "Phase 3" or "Phase 4" indicating extraction source

### Settings Tooltips (Phase 4)
- **CTkTooltip Class**: Non-blocking hover tooltips with 500ms delay for all settings fields
- **Contextual Help**: Each RAG configuration field has descriptive hint text explaining its purpose
- **Dark Theme Tooltips**: Tooltips use dark background (#3a3a4e) with white text for consistent visibility

### Document Upload & Processing (Phase 4)
- **Browser-Side Extraction**: All document processing happens locally in the browser with no server uploads
- **Multi-Format Support**: PDF, DOCX, XLSX, PPTX, TXT, and MD files via dedicated extractors
- **Extractor Factory**: `ExtractorFactory` selects the appropriate extractor based on MIME type
- **Semantic Chunking**: Faithful Python port with paragraph/sentence boundary awareness, configurable overlap, page mapping, and SHA256 content IDs
- **IndexedDB Storage**: Documents, chunks, and metadata persisted locally via `document-store.ts`
- **Documents Page**: Full-featured `/documents` page with drag-and-drop upload, file processing pipeline, and document list with status tracking
- **DropZone Component**: Drag-and-drop or click-to-browse file input with visual feedback and progress indication
- **DocumentList Component**: Paginated document list showing name, type, size, status, and date with delete functionality

#### Supported Formats
| Format | Extractor | Library |
|--------|-----------|---------|
| PDF | `pdf-extractor.ts` | pdfjs-dist |
| DOCX | `docx-extractor.ts` | mammoth |
| XLSX | `xlsx-extractor.ts` | xlsx |
| PPTX | `pptx-extractor.ts` | jszip + xml parsing |
| TXT/MD | `txt-extractor.ts` | Native text processing |

#### Dependencies Added
- `pdfjs-dist` ^4.4.168
- `mammoth` ^1.8.0
- `xlsx` ^0.18.5
- `jszip` ^3.10.1

### Settings (Phase 6)
- **Real-time UI Updates**: Font size slider now applies to all widgets immediately when saved
- **Debug Mode**: Toggle debug-level logging for troubleshooting
- **Log File Persistence**: Customizable log file path with automatic persistence
- **Auto-Reconfiguration**: RAG settings (chunk size, n_results, etc.) trigger engine reinitialization when changed

### Performance & Thread Safety (Phase 5)
- **Thread-Safe RAG Engine**: Full serialization via `asyncio.to_thread()` wrapping for blocking endpoints
- **ChromaDB Locking**: `RLock` for vector store operations preventing concurrent access corruption
- **BM25 Index Threadsafety**: Incremental add operations protected by RLock for safe concurrent document ingestion
- **Lazy LLM Initialization**: On-demand LLM loading reduces memory footprint for CLI/API modes
- **Cancellation Propagation**: `cancellation_event` passed through query processing for responsive long-operation termination
- **Memory Budget Checks**: Pre-ingestion memory validation prevents OOM errors on large document sets
- **QueryTransformer Singleton**: Shared transformer instance across requests with thread-safe initialization
- **Cross-Encoder threadsafety**: `__new__` pattern ensures single instance with RLock for concurrent reranking
- **Neighborhood Expansion**: Increased k from 3 to 5 chunks for better context coverage in streaming mode
- **Embedding Batch Normalization**: Consistent batch sizes for predictable memory usage during ingestion

### Web UI Search Infrastructure (Phase 5)
- **Transformers.js Embeddings**: Browser-side embedding generation using snowflake-arctic-embed-m-v1.5 ONNX model for offline use
- **HNSW Vector Index**: `EdgeVec` Rust/WASM-based HNSW index with native IndexedDB persistence for semantic search
- **FlexSearch Keyword Index**: Full-text keyword search with resolution-based scoring for BM25-style matching
- **Reciprocal Rank Fusion**: Ported RRF algorithm for hybrid retrieval combining semantic and keyword results
- **Cross-Encoder Reranking**: ettin-reranker-32m-v1 (ModernBERT) reranker with conditional activation (skipped on low-memory devices)
- **Memory-Aware Model Selection**: Device memory detection with tier-based configuration (low/medium/high memory tiers)

### Browser LLM Inference (Phase 6)
- **Browser LLM engines**: **wllama** (llama.cpp WASM, CPU/SIMD, the default) drives the
  bundled Gemma 4 E2B-it GGUF + mmproj weights — `web_ui/public/models/manifest.json` ships
  the wllama runtime and the Gemma files, nothing is fetched at runtime. The Phase-6 WebLLM
  (WebGPU) engine (`@mlc-ai/web-llm`, retired model era) remains selectable code but ships no
  weights in the offline manifest, so it is not part of the air-gapped configuration
  (see PACKAGING.md)
- **Model Download Manager**: Progress tracking with speed/ETA calculation, cancellation support, and storage quota error handling
- **ModelDownloadProgress UI**: Accessible progress bar with ARIA attributes, download speed, ETA countdown, and cancel button
- **Model Readiness Gate**: Pre-flight checks for WebGPU availability, memory sufficiency (2GB minimum), and OPFS cache status; guides users to the wllama engine or an external model server (Settings → External model) when requirements aren't met
- **RAG Orchestrator**: Full retrieval pipeline connecting embedding→vector search→keyword search→RRF fusion→reranking→LLM generation; emits typed `RAGEvent` stream for UI progress
- **WebGPU Watchdog**: Context loss detection via `GPUDevice.lost` promise/event monitoring; `createRecoveryHandler` automatically re-initializes the service after loss

### Chat Improvements (Phase 7)
- **Thinking Indicator**: Animated "Thinking..." with dots while LLM generates responses
- **Smart Regeneration**: "Regenerate" button replaces the last assistant message instead of creating duplicates
- **Feedback System**: Working thumbs up/down buttons that persist to database
- **Conversation Context Menu**: Right-click options to delete or rename conversations
- **Time Display**: Relative timestamps in sidebar (e.g., "2 min ago", "Yesterday")

### Settings Page & Cross-Browser Support (Phase 7)
> Historical (Phase 7): the Server Configuration / Server URL controls and the Model Selection dropdown listed here no longer exist; the current Settings page is described in CONFIGURATION.md, App Settings.

- **Dedicated Settings Page** (`SettingsPage.tsx`): Full-featured settings UI with 6 sections:
  - **Inference Mode**: Toggle between browser-local (WebGPU) and API server modes with real-time state sync
  - **Server Configuration**: Server URL input with connection test button and status indicators
  - **Model Selection**: Dropdown for AI model choice with cache status, download progress, and cancel support
  - **Appearance**: Theme selector (light/dark/system) with immediate UI application
  - **Storage**: Memory budget display, memory pressure status, and two-click cache clear with confirmation
  - **About**: Version info and app description
- **IndexedDB Persistence**: User preferences (theme, preferredModel, serverUrl) stored in IndexedDB with automatic load/save
- **InferenceModeProvider at Root**: Provider moved to `App.tsx` root level for shared state across all pages (Chat, Documents, Settings)
- **Cross-Browser Compatibility** (`browser-compat.ts`): Detection for Chrome/Edge 113+ (full WebGPU), Firefox (degraded/experimental), Safari (degraded/partial); provides compatibility guidance with upgrade recommendations
- **Reusable UI Components**:
  - `ErrorBoundary.tsx`: Class-based error boundary catching render errors with retry functionality
  - `LoadingSkeleton.tsx`: Shimmer-animated skeleton placeholders (text, card, avatar, button variants)
  - `EmptyState.tsx`: Contextual empty states (no-documents, no-results, no-chat-history, generic) with optional action buttons

### End-to-End Integration (Phase 8)
- **Dual-Mode Streaming**: `ChatPage` now connects to `RAGOrchestrator` for browser-local inference (WebGPU) and `SSEStreamConsumer` for API server streaming, with seamless mode switching
- **DocumentsPage Search Wiring**: Document search now uses the full search pipeline (vector-index + keyword-index + RRF fusion)
- **Service Initialization Hook** (`useServiceInitialization.ts`): Sequential service initialization with proper cleanup on unmount; manages embedding service, vector index, and keyword index lifecycle
- **Loading Overlay**: Service initialization state surfaced via blocking overlay in `App.tsx` during startup
- **Production Build Fixes**: edgevec WASM snippet stub plugin for Vite; pdfjs worker initialization fix for production

### Keyboard Shortcuts & UX (Phase 2)
- **Enter Key Submission**: Press Enter to submit questions (no need to click "Ask" button)
- **Escape Key**: Clears input field or cancels active operations
- **Ctrl+Enter**: Alternative shortcut for submitting questions
- **Ctrl+L**: Quick clear chat shortcut
- **Ctrl+,**: Open settings dialog shortcut
- **Inline Typing Indicator**: "Thinking..." indicator appears in chat area while processing (replaces status bar overwrite)
- **Clear Chat Confirmation**: Clear button requires a second click within 3 seconds to prevent accidental deletion
- **Settings Switch Labels**: CTkSwitch widgets now display descriptive text labels ("Enable Hybrid Search", "Enable Reranking")

### Web UI Component Inventory
| Component | File | Description |
|-----------|------|-------------|
| `ChatPage.tsx` | `src/pages/` | Primary chat page with streaming, message state, send/cancel/clear |
| `ChatMessageList.tsx` | `src/components/` | Centered transcript (768px max-width), rich empty state with suggested prompts (Phase 2) |
| `ChatMessageBubble.tsx` | `src/components/` | Role-based messages: assistant full-width prose, user 75% bubbles, action-row copy (Phase 2) |
| `ChatInput.tsx` | `src/components/` | Raised card composer with focus feedback, elevation shadow, 20px radius (Phase 2) |
| `MarkdownRenderer.tsx` | `src/components/` | react-markdown + remark-gfm renderer (CommonMark + GFM, URL allowlist) |
| `SourceCitation.tsx` | `src/components/` | Expandable citation pills with copy-to-clipboard |
| `InferenceModeToggle.tsx` | `src/components/` | Status dot (green/yellow/red) for browser-local vs API mode |
| `StreamingIndicator.tsx` | `src/components/` | Bouncing dots animation during generation |
| `DropZone.tsx` | `src/components/` | Drag-and-drop file upload with progress indication |
| `DocumentList.tsx` | `src/components/` | Paginated document list with status tracking |
| `ModelDownloadProgress.tsx` | `src/components/` | Accessible progress bar for model download |
| `ErrorBoundary.tsx` | `src/components/` | Error boundary with retry functionality |
| `LoadingSkeleton.tsx` | `src/components/` | Shimmer-animated skeleton placeholders |
| `EmptyState.tsx` | `src/components/` | Contextual empty states with optional action buttons |
| `Sidebar.tsx` | `src/components/` | Responsive 260px sidebar with conversation history (Phase 3) |
| `SidebarConversationItem.tsx` | `src/components/` | Conversation list item with context menu (Phase 3) |

## 📦 Installation

### Desktop app (recommended)

1. **Download the installer** — unsigned NSIS x64 build (see the repo Releases; the
   measured installed footprint is ~6.4 GB, staged model resources 4,111,872,009 bytes —
   [bench/RESULTS.md](bench/RESULTS.md)). Models, knowledge packs, and license docs are
   bundled; nothing downloads at runtime.
2. **Run the installer** and launch the app.
3. **Complete the first-run wizard**: hardware detection → profile selection
   (Quality/Fast, with an automatic free-RAM recommendation) → sha256 integrity
   verification of the bundled tree → knowledge-pack activation → license notices →
   complete. Every gate names its failure reason; setup can be re-run from Settings.

No Python, no GPU, and no network access are required (unless you turn on the external model or update checks).

### Building the desktop app from source

```powershell
cd desktop
npm install
npm run desktop:build   # builds the web_ui renderer, stages models/packs, compiles,
                        # generates the sha256 manifest, runs electron-builder (NSIS x64)
npm run desktop:dev     # vite dev server + Electron, for development
npm test                # desktop test suites
```

Model weights must be staged first — see [PACKAGING.md](PACKAGING.md) and
[desktop/README.md](desktop/README.md) for the staging and packaging details.

### Browser web app (`web_ui/`, development flow)

```powershell
cd web_ui
npm install
npm run dev        # Development server
npm run build:offline  # Self-contained offline archive (see PACKAGING.md)
npm run typecheck  # TypeScript validation
npm test           # Run tests with vitest
```

### Legacy Python harness (CI conformance)

The Python stack below is **not the shipped product** — it survives as the CI
contract-conformance surface for the frozen API (`contracts/tests/run_conformance.py`).
It is retained here for maintainers running that suite.

#### Prerequisites
- Windows 10 or later
- Python 3.10+
- pip package manager

#### Installation Steps

1. **Clone or download the repository**
   ```powershell
   cd doc_qa_app
   ```

2. **Install dependencies**
   ```powershell
   pip install -r requirements.txt
   ```

3. **Models**

   **GGUF Model (Required for LLM inference)**
   ```powershell
   # The harness uses a local GGUF via RAG_GGUF_PATH (e.g. the ADR-0002
   # gemma-4-e2b-it Q4_K_M model.gguf); any GGUF format model works
   # From Hugging Face: https://huggingface.co/models?search=gguf
   ```

   **Embedding Model (Required for search)**
   ```powershell
   # Snowflake/snowflake-arctic-embed-m-v1.5 is packaged for offline use
   # Can be manually downloaded if needed for offline installation
   ```

4. **Run the harness**

   **GUI Mode** (default):
   ```powershell
   python main.py
   ```

   **CLI Mode**:
   ```powershell
   python main.py --cli
   ```

   **API Server**:
   ```powershell
   python main.py --api --port 8080
   ```

#### Offline Bundle (historical enterprise path, retired)

1. **Download the offline installer bundle**
   - Includes Python embeddable, wheels, and model files

2. **Extract the bundle**
   - Unzip to a directory on your machine

3. **Install**
   - Run the provided installer or execute `main.py`

4. **No internet required** after installation

### Environment Variables

**Desktop app** (main override seams; more are documented in
[docs/electron-mode.md](docs/electron-mode.md)):

| Variable | Description | Default |
|----------|-------------|---------|
| `TRAININGAPP_DESKTOP_INFERENCE_PROFILE` | Force the inference profile (`quality` / `fast` / `auto`) | auto (free-RAM gate) |
| `TRAININGAPP_DESKTOP_BACKEND_MODE` | Backend host selection (`node` / `sidecar`) | `node` (ADR-0003) |
| `TRAININGAPP_DESKTOP_DEV_ORIGINS` | Extra dev origins allowed by the loopback guard (unpackaged builds only) | - |
| `TRAININGAPP_DESKTOP_FREE_RAM_BYTES` | Override free RAM for the wizard's RAM gate (dev/test seam) | real reading |

**Legacy Python harness only** (`api_server.py` / `main.py`):

| Variable | Description | Default |
|----------|-------------|---------|
| `RAG_DB_PATH` | Vector database location | `./doc_qa_db` |
| `RAG_GGUF_PATH` | Path to GGUF model file | - |
| `RAG_CHUNK_SIZE` | Document chunk size (words) | `512` |
| `RAG_N_RESULTS` | Context chunks to retrieve | `3` |
| `RAG_MAX_TOKENS` | Max response tokens | `1024` |
| `RAG_TEMPERATURE` | LLM temperature | `0.3` |
| `API_PORT` | API server port | `8080` |

## 🔐 API Authentication (Legacy Python harness)

> **The shipped desktop app has no user-facing auth**: its backend binds loopback only,
> on an OS-assigned random port, and every request carries a per-launch 256-bit
> `X-Desktop-Token` — see [docs/security/desktop.md](docs/security/desktop.md) and
> [docs/electron-mode.md](docs/electron-mode.md). The `ENABLE_AUTH` / `API_KEY` material
> below applies to the legacy Python harness only.

⚠️ **Warning**: Authentication is **disabled by default** for development convenience. **MUST be enabled** for any production or shared environment.

### Enabling Authentication

Set both environment variables to enable authentication:

| Variable | Description | Example |
|----------|-------------|---------|
| `ENABLE_AUTH` | Enable authentication (any value enables) | `true` |
| `API_KEY` | Secret API key for authentication | `your-secure-api-key` |

#### Linux/macOS
```bash
export ENABLE_AUTH=true
export API_KEY="your-secure-api-key"
python main.py --api --port 8080
```

#### Windows PowerShell
```powershell
$env:ENABLE_AUTH=$true
$env:API_KEY="your-secure-api-key"
python main.py --api --port 8080
```

### Using Authentication

All API requests require authentication headers:

- **API Key**: `X-API-Key: <your-api-key>`
- **JWT Bearer Token**: `Authorization: Bearer <jwt-token>`

### Python Example

```python
import requests
import os

# Configure authentication
os.environ["ENABLE_AUTH"] = "true"
os.environ["API_KEY"] = "your-secure-api-key"

# Make authenticated request
headers = {
    "X-API-Key": os.environ["API_KEY"]
}

response = requests.post("http://localhost:8080/ask", json={
    "question": "What are the main findings?",
    "n_results": 3
}, headers=headers)

print(response.json())
```

### Security Notes

- Always use HTTPS in production
- Rotate API keys regularly
- Store API keys in environment variables, never in code
- See [USAGE.md](USAGE.md) for complete authentication documentation

**Backend Selection (legacy Python harness):**
The harness uses GGUF models only via llama-cpp-python.
If `RAG_GGUF_PATH` is set, that model is used. Otherwise, it defaults to the bundled Gemma 4
artifact. The desktop app instead loads its bundled ADR-0002 profile models through
node-llama-cpp (see the LLM Backend section above).

## 📖 Usage

> The GUI/CLI/API flows below are the **legacy Python harness**. The shipped desktop app
> exposes ingestion, chat, knowledge packs, and training through its UI; its API is the
> same frozen contract, served on a per-launch loopback address.

### Ingest Documents

**GUI Mode**:
1. Click "Ingest" button
2. Select document folder (folder-based ingestion)
3. Wait for processing to complete

*Note: GUI supports folder-based batch ingestion. For single-file upload, use API or CLI mode.*

**CLI Mode**:
```powershell
# Ingest all documents in a directory
python main.py --ingest "C:\Documents\reports"

# Ingest a single file
python main.py --ingest "C:\Documents\report.pdf"
```

**API Mode**:
```python
import requests

# Ingest entire directory
response = requests.post("http://localhost:8080/ingest", json={
    "directory": "C:/Documents/reports"
})
print(response.json())

# Upload and ingest single file
with open("C:/Documents/report.pdf", "rb") as f:
    response = requests.post(
        "http://localhost:8080/ingest/file",
        files={"file": ("report.pdf", f, "application/pdf")}
    )
print(response.json())
```

### Ask Questions

**GUI Mode**:
1. Type your question in the input field
2. Press Enter or click "Ask"
3. View the answer with source citations

**CLI Mode**:
```powershell
# Single question
python main.py --query "What are the main findings?"

# Interactive mode
python main.py --cli
```

**API Mode**:
```python
import requests

response = requests.post("http://localhost:8080/ask", json={
    "question": "What are the main findings?",
    "n_results": 3
})
print(response.json())
```

### Advanced Features

#### Hybrid Search (Default: Enabled)
Combines BM25 keyword search with vector semantic search using RRF fusion:
- BM25: Fast keyword matching
- Vector: Semantic understanding
- RRF Fusion: Combines both for optimal results

#### Window Expansion
Automatically fetches adjacent chunks around retrieved results:
- Configurable window size (default: 1 chunk)
- Ensures context continuity
- Improves answer quality for multi-part questions

#### Cross-Encoder Reranking
ettin-reranker-32m-v1 (ModernBERT, enabled by default on the desktop backend):
- Ranks retrieved chunks by relevance after initial retrieval
- Higher accuracy than pure hybrid search
- Lightweight — ~40 MB staged total (39,611,408 bytes: q8 ONNX + root tokenizers, per [bench/RESULTS.md](bench/RESULTS.md)) — optimized for minimum-spec hardware
- Can be tuned via `TRAININGAPP_RETRIEVAL_RERANK` (desktop) / the Settings dialog (legacy harness)

#### Step-back Query Transform
Keyword-based query expansion (disabled by default):
- Extracts key terms from questions to improve retrieval
- Note: The LLM-based step-back transformation is not wired (latency cost too high for minimum-spec hardware)

## ⚙️ Configuration

> GUI settings dialog and CLI options below are the **legacy Python harness**; the desktop
> app is configured in-app (Settings) plus the `TRAININGAPP_*` seams listed under
> Installation. Harness env vars are documented in [CONFIGURATION.md](CONFIGURATION.md).

### GUI Settings Dialog

**LLM Settings**:
- GGUF Model Path: Path to `.gguf` model file

**RAG Settings**:
- Chunk Size: Number of words per chunk
- Results to Retrieve: Number of chunks for context
- Max Tokens: Maximum response length
- Temperature: Response creativity (0.0-1.0)

**Advanced Settings**:
- Hybrid Search: Enable/disable BM25+Vector search
- Window Expansion: Number of adjacent chunks to fetch
- Cross-Encoder Reranking: Enable/disable reranking

### Command-Line Options

```powershell
python main.py [OPTIONS]

Options:
  --api                         Run API server
  --cli                         Run in interactive CLI mode
  --ingest PATH                 Ingest documents from directory
  --query QUESTION              Ask a question
  --db-path PATH                Path to vector database (default: ./doc_qa_db)
  --model-path PATH             Path to GGUF model file (legacy alias for --gguf-path)
  --gguf-path PATH              GGUF model path
  --port PORT                   API server port (default: 8080)
  --chunk-size SIZE             Chunk size in words (default: 512)
  --chunk-overlap N             Chunk overlap in words (default: 50)
```

## 🏗️ Architecture

### Overview

Mirrors [ARCHITECTURE.md](ARCHITECTURE.md) (the authoritative map):

```text
+--------------------------- Windows desktop app (desktop/) ---------------------------+
|                                                                                       |
|  Electron renderer (web_ui build)          Electron main process                     |
|  +--------------------------------+        +--------------------------------------+  |
|  | app://index.html                |  IPC   | desktop/main/index.ts                 |  |
|  | React pages (web_ui/src/pages)  |<------>|  lockdown, integrity gate, first-run  |  |
|  | desktopApi bridge (preload)     |        |  wizard, signed update checker        |  |
|  +--------+-----------------------+        +------------------+-------------------+  |
|           | HTTP 127.0.0.1:<random port> + X-Desktop-Token (per-launch)               |
|           v                                                                             |
|  +----------------------------------------------------------------------------------+ |
|  | Node backend host (desktop/main/backend) — ADR-0003                                | |
|  | LlamaEngine (node-llama-cpp, Quality/Fast profiles) - ingest pipeline              | |
|  | hybrid retrieval (vec0 KNN + FTS5 + RRF k=60 + ettin rerank) - pack manager        | |
|  | learn assembler - memory governor                                                 | |
|  +------------------------------------+---------------------------------------------+ |
|                                       v                                               |
|        <userData>/profiles/default/store.sqlite                                       |
|        better-sqlite3 + sqlite-vec vec0 KNN + FTS5 (contracts/store.schema.sql)       |
+---------------------------------------------------------------------------------------+

  Plain browser (web_ui/, no Electron): wllama WASM LLM + ONNX embeddings +
  IndexedDB/EdgeVec/FlexSearch in-page; knowledge packs gated (ADR-0009).
```

### Components

**Renderer (Electron)**
- The web_ui React build served from the `app://` protocol with a strict CSP
- Chat / Documents (knowledge packs) / Training (embedded Storyline player) / Settings pages

**Node backend (Electron main process)**
- 18 contract routes behind the loopback guard (random port + per-launch `X-Desktop-Token`)
- GGUF inference via node-llama-cpp with Quality/Fast profiles (ADR-0002)
- Pack lifecycle: install / supersede / rollback / remove (packtool-built packs)

**Vector Store**
- SQLite + sqlite-vec `vec0` KNN and an FTS5 mirror (contracts/store.schema.sql, ADR-0005)
- Reciprocal Rank Fusion (RRF, k=60) for hybrid results — same constant on every surface
- Cross-encoder rerank (ettin-reranker-32m-v1) with a calibrated relevance floor

**LLM Interface**
- GGUF via node-llama-cpp (desktop, CPU-only, fully offline)
- GGUF via wllama WASM (browser, CPU/SIMD, fully offline)

**RAG Engine**
- Query processing and routing
- Hybrid search orchestration
- Context assembly and answer generation with `grounding` provenance
- Source citation and Learn-panel deep-link tracking

## 🔧 Troubleshooting

> The pip-based entries below diagnose the **legacy Python harness**. Desktop-app issues
> surface through the first-run wizard's named gates and the startup integrity check
> (failures block backend start and name path/expected/actual — reinstall if the bundled
> tree fails verification).

### "No LLM backend available"

**Solution 1: GGUF Model Not Found**
```powershell
# Desktop: both profile models are bundled and integrity-checked at startup:
#   <resources>/models/llm-quality/gemma-4-e2b-it/model.gguf   (Q4_K_M, ADR-0002)
#   <resources>/models/llm-fast/lfm2.5-vl-450m/model.gguf      (Q4_K_M, ADR-0002)
# A missing model means a broken install — re-run the installer.

# Legacy harness: point RAG_GGUF_PATH at a local GGUF file; custom GGUF models
# can be downloaded from https://huggingface.co/models?search=gguf
```

**Solution 2: Wrong Model Path**
- Check Settings dialog for correct path
- Use "Browse" button to select model file

### "chromadb not installed"

```powershell
pip install chromadb --break-system-packages
```

### "sentence-transformers not installed"

```powershell
pip install sentence-transformers
```

### "llama-cpp-python not installed"

```powershell
# CPU-only build (recommended)
pip install llama-cpp-python

# With CUDA support (if you have NVIDIA GPU)
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121
```

### Slow First Run

- Nothing downloads: the embedding model (bge-small-en-v1.5 on desktop, snowflake-arctic-embed-m in the browser), the reranker, and both LLM profiles are bundled
- Desktop first run verifies the sha256 integrity manifest over the staged model tree (2,377 ms measured, streaming; [bench/RESULTS.md](bench/RESULTS.md))
- Legacy harness only: BM25 index is built on first ingestion

### Memory Errors with Large Documents

**Solution 1: Reduce chunk size**
```powershell
python main.py --chunk-size 128
```

**Solution 2: Increase chunk overlap**
```powershell
python main.py --chunk-size 256 --chunk-overlap 100
```

**Solution 3: Reduce number of results**
```powershell
$env:RAG_N_RESULTS=2
```

### Hybrid Search Not Working

**Check BM25 is enabled**:
```python
# In API, check config
from rag_engine import create_engine_from_env
engine = create_engine_from_env()
print(engine.config.hybrid_search)  # Should be True
```

**Verify both backends loaded**:
```python
# Check vector store stats
stats = engine.vector_store.get_stats()
print(f"Embedding model: {stats['embedding_model']}")
print(f"BM25 index: {'Ready' if engine.vector_store.bm25_index else 'Not built'}")
```

## 📚 API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (liveness probe) |
| `/stats` | GET | Engine statistics |
| `/ask` | POST | Ask a question (non-streaming) |
| `/ask/stream` | POST | Ask a question with SSE streaming |
| `/search` | POST | Search documents |
| `/ingest` | POST | Ingest directory |
| `/ingest/file` | POST | Upload and ingest single file |
| `/ingest/batch` | POST | Batch upload and ingest (up to 20 files) |
| `/documents` | GET | List documents |
| `/documents` | DELETE | Clear all documents |
| `/settings` | GET | Get current RAG settings |
| `/settings` | PUT | Update RAG settings |
| `/auth/status` | GET | Authentication status |
| `/auth/token` | POST | Obtain JWT token |
| `/telemetry/memory` | GET | Memory telemetry snapshot and downgrade state |
| `/status/models` | GET | Per-profile inference model presence (first-run gate) |

### Example: Ask a Question

```python
import requests
import json

# Configure the engine (legacy Python harness)
os.environ["RAG_GGUF_PATH"] = "path/to/gemma-4-e2b-it/model.gguf"  # Q4_K_M, ADR-0002

# Start API server in another terminal
# python main.py --api --port 8080

# Ask a question
response = requests.post("http://localhost:8080/ask", json={
    "question": "What are the main findings?",
    "n_results": 3
})

result = response.json()
print(f"Answer: {result['answer']}")
print(f"Sources: {result['sources']}")
print(f"Grounding: {result['grounding']}")  # "grounded" or "general" (C5, issue #72)
print(f"Inference time: {result['inference_time']:.2f}s")
```

### Example: SSE Streaming

```python
import requests

# Ask with streaming response
with requests.post(
    "http://localhost:8080/ask/stream",
    json={"question": "What are the main findings?", "n_results": 3},
    headers={"Authorization": "Bearer <token>"},
    stream=True
) as response:
    for line in response.iter_lines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if "token" in data:
                print(data["token"], end="", flush=True)
            elif data.get("done"):
                print(f"\n\nSources: {data['sources']}")
                print(f"Inference time: {data['inference_time']:.2f}s")
```

### Example: Batch File Upload

```python
import requests

# Upload multiple files at once (up to 20)
files = [
    ("files", ("report1.pdf", open("report1.pdf", "rb"), "application/pdf")),
    ("files", ("report2.docx", open("report2.docx", "rb"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
    ("files", ("notes.txt", open("notes.txt", "rb"), "text/plain")),
]

response = requests.post(
    "http://localhost:8080/ingest/batch",
    files=files,
    headers={"Authorization": "Bearer <token>"}
)

result = response.json()
print(f"Total: {result['total_files']}, Succeeded: {result['successful']}, Failed: {result['failed']}")
for r in result["results"]:
    status = "✓" if r["success"] else "✗"
    print(f"  {status} {r['filename']}: {r.get('error', r.get('chunks_added', 0))} chunks")
```

### Example: Settings CRUD

```python
import requests

# Get current settings
response = requests.get(
    "http://localhost:8080/settings",
    headers={"Authorization": "Bearer <token>"}
)
settings = response.json()
print(f"Chunk size: {settings['chunk_size']}, Overlap: {settings['chunk_overlap']}")

# Update settings (partial update supported)
response = requests.put(
    "http://localhost:8080/settings",
    json={"rag_temperature": 0.7, "rag_chunk_size": 768},
    headers={"Authorization": "Bearer <token>"}
)
updated = response.json()
print(f"New temperature: {updated['temperature']}, chunk size: {updated['chunk_size']}")
```

## 📦 Building Standalone Executable (legacy Python harness — retired product path)

> The shipped desktop binary is the Electron NSIS installer (see "Building the desktop
> app from source" above). The PyInstaller/Inno Setup flow below built the retired
> Python desktop product and is retained for history.

### Prerequisites

```powershell
pip install pyinstaller
```

### Build

```powershell
python build.py
```

The executable will be created in `dist/DocumentQA.exe`.

### Including Models (Offline Bundle)

To create an offline installer:

```powershell
# Prepare installer files
python scripts/build_installer.py

# Manually download:
# 1. GGUF model to build_installer/models/
# 2. Embedding model to build_installer/embeddings/
# 3. Python embeddable to python_embeddable/

# Run Inno Setup
iscc build_installer/setup.iss
```

This creates an offline installer with all dependencies and models included.

## 🌐 HTML5 Web UI (Phase 1)

The browser-based interface (`web_ui/`) is one of the two shipped surfaces — it is also
the desktop app's renderer. This section documents its development flow.

### Tech Stack
- **Vite 6** + **React 18** + **TypeScript 5**
- Pure CSS design token system (no Tailwind)
- vitest + @testing-library/react for testing

### Design Token System (Phase 1 — Updated)
Translates Python theme.py (ColorTokens, TypeScale, Spacing) to CSS custom properties:

| Token Category | Examples |
|---------------|----------|
| Colors | `--color-primary`, `--color-info`, `--color-warning`, `--color-success`, `--color-bubble-user`, `--color-text-muted`, `--color-text-primary` |
| Typography | `--font-family` (Inter first), `--font-size-display` (32px), `--font-size-h1` (24px), `--font-size-h2` (20px), `--font-size-h3` (17px), `--font-size-body` (15px), `--font-size-caption` (13px), `--font-size-small` (11px) |
| Line Height | `--line-height-body` (1.6), `--line-height-heading` (1.3), `--line-height-tight` (1.2) |
| Spacing | `--spacing-xs` (4px) through `--spacing-xxxl` (64px) on 8px grid |
| Radius | `--radius-sm` (6px), `--radius-md` (12px), `--radius-lg` (20px) |

**Font**: Inter (self-hosted via @fontsource/inter, weights 400/500/600/700)

Dark mode overrides via `[data-theme="dark"]` attribute on `<html>`.

### Running the Web UI
```powershell
cd web_ui
npm install
npm run dev      # Development server
npm run build    # Production build
npm run typecheck # TypeScript validation
npm test         # Run tests with vitest
```

### TypeScript API Client

The web UI includes a typed API client (`src/lib/api/`) for all backend endpoints:

| File | Description |
|------|-------------|
| `client.ts` | `ApiClient` class with methods for all endpoints |
| `streaming.ts` | `SSEStreamConsumer` for POST-based SSE streaming |
| `auth.ts` | Token storage with Safari private mode fallback |
| `types.ts` | TypeScript interfaces matching FastAPI models |
| `index.ts` | Barrel export and default client instance |

### Document Processing (Phase 4)

The web UI includes browser-side document processing with no server uploads:

```typescript
import { ExtractorFactory } from './lib/processing/extractor-factory';
import { TextChunker } from './lib/processing/text-chunker';
import { DocumentStore } from './lib/storage/document-store';

// Extract text from uploaded file
const extractor = ExtractorFactory.getExtractor(file);
const extraction = await extractor.extract(file);

// Chunk with semantic boundaries
const chunker = new TextChunker({ chunkSize: 512, overlap: 50 });
const chunks = chunker.chunk(extraction.text, extraction.metadata);

// Store in IndexedDB
const store = new DocumentStore();
await store.saveDocument({
  id: crypto.randomUUID(),
  name: file.name,
  type: file.type,
  size: file.size,
  chunks,
  createdAt: new Date()
});

// List all documents
const docs = await store.loadDocuments();
console.log(`Loaded ${docs.length} documents`);
```

### Chat Infrastructure

| File | Description |
|------|-------------|
| `src/types/chat.ts` | Shared `ChatMessage`, `MessageRole`, and `ChatState` types |
| `src/lib/streaming/TokenStreamManager.ts` | RAF-batched token delivery, unified callbacks for SSE/WebLLM, cancellation support |
| `src/lib/inference/InferenceModeContext.tsx` | React context for `browser-local`/`api` mode with localStorage persistence |

**Usage:**
```typescript
import { apiClient, SSEStreamConsumer, login } from './lib/api';

// Ask a question
const answer = await apiClient.ask("What are the main findings?");

// Stream tokens with SSE
const stream = new SSEStreamConsumer('/ask/stream', { question: "Tell me more" });
stream.onToken(token => appendToAnswer(token));
stream.onDone(data => showSources(data.sources));
stream.start();

// Batch upload
const batch = await apiClient.uploadBatch([file1, file2, file3]);
console.log(`Uploaded ${batch.successful}/${batch.total_files} files`);

// Settings
const settings = await apiClient.getSettings();
await apiClient.updateSettings({ rag_temperature: 0.8 });
```

### Browser ML Spike

The ML spike page validates Transformers.js, EdgeVec, and FlexSearch on target hardware.

**Test Categories:**
- **Transformers.js**: Hugging Face transformers running in browser (feature-extraction pipeline)
- **EdgeVec**: HNSW-based vector similarity search (edgevec npm package)
- **FlexSearch**: Full-text search indexing (flexsearch npm package)

Results show pass/fail/skip status, duration, and memory delta for each library.

### Web UI Search Architecture (Phase 5)

The web UI implements a complete browser-side search pipeline:

```
Query → Embeddings (Transformers.js) → HNSW (EdgeVec) → RRF Fusion → Reranker (optional)
         ↓
Keyword Index (FlexSearch) ──────────────────────────────→
```

| Component | File | Description |
|-----------|------|-------------|
| Embedding Service | `src/lib/embeddings/embedding-service.ts` | Transformers.js pipeline with snowflake-arctic-embed-m-v1.5 ONNX (768-dim, q8) |
| Memory-Aware Selection | `src/lib/embeddings/memory-aware.ts` | Device memory detection, tier-based model configuration |
| Vector Index | `src/lib/search/vector-index.ts` | EdgeVec HNSW index with IndexedDB persistence |
| Keyword Index | `src/lib/search/keyword-index.ts` | FlexSearch with resolution-based scoring |
| RRF Fusion | `src/lib/search/rrf-fusion.ts` | Reciprocal Rank Fusion for hybrid results |
| Reranker | `src/lib/search/reranker.ts` | Cross-encoder reranker (ettin-reranker-32m-v1, ModernBERT) |
| Types | `src/types/embedding.ts` | `EmbeddingDocument`, `EmbeddingResult` interfaces |
| Types | `src/types/search.ts` | `SearchResult`, `HybridSearchResult` interfaces |

**Dependencies added**: `@huggingface/transformers` ^3.0.0, `edgevec` ^0.6.0, `flexsearch` ^0.8.0

## 📋 Project Structure

```
trainingapp/
├── desktop/                # Electron desktop app (the shipped product)
│   ├── main/               # main process: backend host, security/, first-run/,
│   │                       # update-checker.ts, app:// protocol
│   ├── preload/            # contextBridge: desktopApi token bridge
│   ├── renderer/           # build-time staging of web_ui/dist (gitignored)
│   ├── scripts/            # resource stager, sha256 manifest generator,
│   │                       # pack builders, packaged smoke test
│   └── src/__tests__/      # desktop vitest suites (frozen acceptance specs)
├── web_ui/                 # HTML5 web app — browser surface AND desktop renderer
│   ├── src/                # React app: pages/, components/, lib/ (api, llm, rag, ...)
│   ├── public/models/      # manifest.json + packaged model weights (gitignored)
│   └── scripts/            # prepare-models.mjs, validate-build.mjs
├── packtool/               # Knowledge Pack build/verify CLI (Node): build/, storyline/, links/
├── contracts/              # frozen contracts + conformance suite + fixtures
│   ├── api.openapi.yaml        # the frozen HTTP API (both backends)
│   ├── store.schema.sql        # SQLite store schema (v3)
│   ├── pack.schema.json        # Knowledge Pack manifest schema
│   └── pack-feed.schema.json   # signed update-feed schema (ADR-0010)
├── docs/                   # adr/ (ADR-0001..0010), security/, pack/training/update
│   └── archive/pre-v3/     # retired pre-v3 planning/audit/release docs (indexed)
├── eval/                   # tier-0 eval harness (questions.jsonl, corpus, runner)
├── bench/                  # measured performance results (RESULTS.md)
├── scripts/                # repo scripts (CI path classifier, export_seed_chunks.py)
├── tests/                  # Python (legacy harness) test suites
├── .github/workflows/      # CI: test, conformance, desktop-build, web-ui, ...
├── api_server.py           # legacy Python harness entry (CI conformance surface),
│                           # with config.py / rag_engine.py / vector_store.py / ...
└── README.md               # This file
```

## 🛡️ Security & Privacy

- **Offline-Only**: No data leaves your machine
- **No Cloud Services**: All processing is local
- **Model Bundling**: Models are stored locally
- **Opt-in Updates Only**: zero update-related network calls until you enable the signed channel ([ADR-0010](docs/adr/0010-update-channels.md))

## 📄 License

MIT License - See LICENSE for details.

Bundled model weights carry their own licenses (LLM, embedding, reranker) —
see [docs/licenses.md](docs/licenses.md) for the per-model review.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 🙏 Acknowledgments

Desktop stack (v3):

- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) - GGUF inference (node bindings)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - SQLite store
- [sqlite-vec](https://github.com/asg017/sqlite-vec) - sqlite vector search extension
- [pdfjs-dist](https://mozilla.github.io/pdf.js/) - PDF processing (Apache-2.0)
- [@huggingface/transformers](https://github.com/huggingface/transformers.js) - In-browser ML models (Apache-2.0)
- [edgevec](https://github.com/matte1782/edgevec) - In-browser vector database (MIT OR Apache-2.0)
- [flexsearch](https://github.com/nextapps-de/flexsearch/) - Full-text search (Apache-2.0)
- [mammoth](https://github.com/mwilliamson/mammoth.js) - DOCX processing (BSD-2-Clause)
- [xlsx](https://sheetjs.com/) - XLSX processing (Apache-2.0)
- [jszip](https://github.com/Stuk/jszip) - ZIP handling (MIT OR GPL-3.0-or-later)

Legacy Python harness only (CI conformance surface):

- [ChromaDB](https://www.trychroma.com/) - Vector database
- [Sentence Transformers](https://www.sbert.net/) - Embedding models
- [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) - GGUF inference
- [PyMuPDF](https://pymupdf.readthedocs.io/) - PDF processing
- [CustomTkinter](https://customtkinter.tomschimansky.com/) - GUI toolkit of the retired desktop product
- [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) - Optional WebGPU browser engine (weights not bundled)

---
**Version**: 2.3.0
**Last Updated**: 2026-09-29 (v3 documentation refresh, issue #89)
**Hardware**: CPU-only optimized for Intel 11th gen i5 and above (16GB RAM minimum)
