# Document Q&A Assistant

A fully offline RAG-based document question answering system optimized for Windows PCs. Features semantic search, hybrid retrieval, and CPU-based LLM inference with GGUF models.

Two first-class delivery options share the same offline RAG capabilities:
1. **Desktop app** — Python + PyInstaller + llama.cpp/GGUF (CustomTkinter GUI / FastAPI).
2. **HTML5 web app** (`web_ui/`) — a fully self-contained, STIG-scannable archive that
   runs entirely in the browser with **no runtime downloads**.

## 🌐 Offline HTML5 Web App (overhauled)

The browser app is a complete, offline RAG client. See `PACKAGING.md` for the build/bundle steps.

- **Fully offline, packaged models** — embeddings (bge-small ONNX), ONNX Runtime WASM, and the
  browser LLM are served same-origin from `public/models/`; nothing is fetched from a CDN or the
  HuggingFace Hub at runtime. A readiness gate reports "models ready vs missing".
- **Two user-selectable browser engines** — **wllama** (llama.cpp WASM, CPU/SIMD, **no WebGPU**,
  the default and most robust on i5/Iris Xe) and **WebLLM** (WebGPU, faster when available). A
  hardware-capability panel detects WebGPU/threads/memory and recommends an engine.
- **Multimodal** — attach a screenshot in chat and ask about it (wllama + Gemma 4 E2B-it mmproj), offline.
- **Chat UX** — streaming with interactive source citations, regenerate, conversation export
  (Markdown/JSON), and Fast/Balanced/Quality RAG presets.
- **Self-contained archive** — `npm run build:offline` produces a validated `web_ui/dist/` the
  desktop FastAPI server (or any root static host) serves with the COOP/COEP headers wllama needs.

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
- **Hybrid Retrieval**: BM25 + Vector search with Reciprocal Rank Fusion (RRF)
- **Window Expansion**: Automatically fetches adjacent context chunks
- **Smart Chunking**: Paragraph and sentence boundary aware
- **Cross-Encoder Reranking**: Optional MS MARCO MiniLM for precise ranking

### LLM Backend (GGUF-Only)
The application uses GGUF models via llama-cpp-python for fully offline inference:

- **Default Model**: Gemma 4 E2B (Q5_K_M GGUF, ~3.1GB) — bundled
- Set via: `RAG_GGUF_PATH` environment variable or `--gguf-path` CLI option
- No GPU required
- No network access required
- ~5-10 tokens/second on standard CPU

### Hardware Requirements
#### Minimum (Intel 11th Gen i5, 16GB RAM)
- Windows 11 (64-bit)
- Intel Core i5 11th generation or newer (or equivalent AMD Ryzen 5000+)
- Intel integrated graphics (present on all 11th gen+ Intel CPUs) — no discrete GPU required
- 16GB RAM
- ~4GB free storage for model + app
- **Performance**: ~5-7 tokens/second

#### Recommended (Intel 12th Gen i7, 32GB RAM)
- Intel Core i7 12th generation or newer (or equivalent AMD Ryzen 7000+)
- Intel Iris Xe integrated graphics or discrete GPU
- 32GB RAM
- SSD for vector database
- **Performance**: ~10-15 tokens/second

#### High-Performance (Intel 13th Gen i9, 64GB RAM)
- High-end CPU (Intel Core i9 or AMD Ryzen 9)
- 64GB RAM
- **Performance**: ~15-20 tokens/second (CPU-only with GGUF)

## 🆕 New Features (Version 2.0.0)

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
- **Transformers.js Embeddings**: Browser-side embedding generation using `bge-small-en-v1.5` ONNX model with OPFS caching for offline use
- **HNSW Vector Index**: `EdgeVec` Rust/WASM-based HNSW index with native IndexedDB persistence for semantic search
- **FlexSearch Keyword Index**: Full-text keyword search with resolution-based scoring for BM25-style matching
- **Reciprocal Rank Fusion**: Ported RRF algorithm for hybrid retrieval combining semantic and keyword results
- **Cross-Encoder Reranking**: `ms-marco-MiniLM-L-6-v2` reranker with memory-aware conditional activation (skipped on low-memory devices)
- **Memory-Aware Model Selection**: Device memory detection with tier-based configuration (low/medium/high memory tiers)

### Browser LLM Inference (Phase 6)
- **WebLLM Service**: Browser-side LLM inference using `@mlc-ai/web-llm` with `CreateMLCEngine` API for SmolLM3-3B-Q4_K_M (~1.9GB), OPFS caching, and streaming token generation
- **Model Download Manager**: Progress tracking with speed/ETA calculation, cancellation support, and storage quota error handling
- **ModelDownloadProgress UI**: Accessible progress bar with ARIA attributes, download speed, ETA countdown, and cancel button
- **Model Readiness Gate**: Pre-flight checks for WebGPU availability, memory sufficiency (2GB minimum), and OPFS cache status; guides users to server API mode when requirements aren't met
- **RAG Orchestrator**: Full retrieval pipeline connecting embedding→vector search→keyword search→RRF fusion→reranking→LLM generation; emits typed `RAGEvent` stream for UI progress
- **WebGPU Watchdog**: Context loss detection via `GPUDevice.lost` promise/event monitoring; `createRecoveryHandler` automatically re-initializes the service after loss

### Chat Improvements (Phase 7)
- **Thinking Indicator**: Animated "Thinking..." with dots while LLM generates responses
- **Smart Regeneration**: "Regenerate" button replaces the last assistant message instead of creating duplicates
- **Feedback System**: Working thumbs up/down buttons that persist to database
- **Conversation Context Menu**: Right-click options to delete or rename conversations
- **Time Display**: Relative timestamps in sidebar (e.g., "2 min ago", "Yesterday")

### Settings Page & Cross-Browser Support (Phase 7)
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

### Method 1: Standard Python Installation

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

3. **Download required models**

   **GGUF Model (Required for LLM inference)**
   ```powershell
   # Default model: Gemma 4 E2B (Q5_K_M) is bundled
   # To use a custom model, download any GGUF format model
   # From Hugging Face: https://huggingface.co/models?search=gguf
   ```

   **Embedding Model (Required for search)**
   ```powershell
   # BAAI/bge-small-en-v1.5 is automatically downloaded on first use
   # Can be manually downloaded if needed for offline installation
   ```

4. **Run the application**

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

### Method 2: Offline Bundle Installation (Recommended for Enterprises)

1. **Download the offline installer bundle**
   - Includes Python embeddable, wheels, and model files

2. **Extract the bundle**
   - Unzip to a directory on your machine

3. **Install**
   - Run the provided installer or execute `main.py`

4. **No internet required** after installation

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RAG_DB_PATH` | Vector database location | `./doc_qa_db` |
| `RAG_GGUF_PATH` | Path to GGUF model file | - |
| `RAG_CHUNK_SIZE` | Document chunk size (words) | `512` |
| `RAG_N_RESULTS` | Context chunks to retrieve | `3` |
| `RAG_MAX_TOKENS` | Max response tokens | `1024` |
| `RAG_TEMPERATURE` | LLM temperature | `0.3` |
| `API_PORT` | API server port | `8080` |

## 🔐 API Authentication (Production Required)

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

**Backend Selection:**
The application uses GGUF models only via llama-cpp-python.
If `RAG_GGUF_PATH` is set, that model is used. Otherwise, defaults to bundled Gemma 4.

## 📖 Usage

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
MS MARCO TinyBERT reranker (enabled by default):
- Ranks retrieved chunks by relevance after initial retrieval
- Higher accuracy than pure hybrid search
- Lightweight (~85MB) — optimized for minimum-spec hardware
- Can be disabled via Settings dialog

#### Step-back Query Transform
Keyword-based query expansion (disabled by default):
- Extracts key terms from questions to improve retrieval
- Note: The LLM-based step-back transformation is not wired (latency cost too high for minimum-spec hardware)

## ⚙️ Configuration

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

```
┌─────────────────────────────────────────────────────────────┐
│                     Document Q&A App                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Document     │    │ Vector Store │    │ LLM Interface│  │
│  │ Processor    │───▶│ (ChromaDB+   │    │ (GGUF-only)  │  │
│  │              │    │  BM25+RRF)   │◀───│             │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                   │                    │          │
│         └───────────────────┴────────────────────┘          │
│                           │                                 │
│                    ┌──────▼──────┐                          │
│                    │ RAG Engine  │                          │
│                    │ (Query      │                          │
│                    │  Processing)│                          │
│                    └──────┬──────┘                          │
│                           │                                 │
│                    ┌──────▼──────┐                          │
│                    │ GUI / API   │                          │
│                    └─────────────┘                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Components

**Document Processor**
- Extracts text from PDF, DOCX, PPTX, TXT, MD
- Semantic chunking with paragraph/sentence boundaries
- Chunk overlap for context continuity

**Vector Store**
- ChromaDB for semantic vector storage
- BM25Index for keyword-based search
- Reciprocal Rank Fusion (RRF) for hybrid results
- Window expansion for context fetching

**LLM Interface**
- GGUF via llama-cpp-python (CPU-only, fully offline)

**RAG Engine**
- Query processing and routing
- Hybrid search orchestration
- Context assembly and answer generation
- Source citation tracking

## 🔧 Troubleshooting

### "No LLM backend available"

**Solution 1: GGUF Model Not Found**
```powershell
# Check if model file exists (default bundled model)
dir gemma-4-E2B-it-Q5_K-M.gguf

# If not, download from:
# https://huggingface.co/google/gemma-4-2b-it-gguf
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

- Embedding model (~80MB) downloads on first use
- Subsequent runs use cached model
- BM25 index is built on first ingestion

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
| `/` | GET | Health check |
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

### Example: Ask a Question

```python
import requests
import json

# Configure the engine
os.environ["RAG_GGUF_PATH"] = "path/to/gemma-4-E2B-it-Q5_K-M.gguf"

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

## 📦 Building Standalone Executable

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

A new browser-based interface is being developed alongside the existing desktop GUI.

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
| Embedding Service | `src/lib/embeddings/embedding-service.ts` | Transformers.js pipeline with bge-small-en-v1.5 ONNX model, OPFS caching |
| Memory-Aware Selection | `src/lib/embeddings/memory-aware.ts` | Device memory detection, tier-based model configuration |
| Vector Index | `src/lib/search/vector-index.ts` | EdgeVec HNSW index with IndexedDB persistence |
| Keyword Index | `src/lib/search/keyword-index.ts` | FlexSearch with resolution-based scoring |
| RRF Fusion | `src/lib/search/rrf-fusion.ts` | Reciprocal Rank Fusion for hybrid results |
| Reranker | `src/lib/search/reranker.ts` | Cross-encoder reranker (ms-marco-MiniLM-L-6-v2) |
| Types | `src/types/embedding.ts` | `EmbeddingDocument`, `EmbeddingResult` interfaces |
| Types | `src/types/search.ts` | `SearchResult`, `HybridSearchResult` interfaces |

**Dependencies added**: `@huggingface/transformers` ^3.0.0, `edgevec` ^0.6.0, `flexsearch` ^0.8.0

## 📋 Project Structure

```
doc_qa_app/
├── main.py                 # Main entry point
├── app_gui.py              # GUI application (customtkinter)
├── api_server.py           # FastAPI REST server
├── rag_engine.py           # RAG orchestration
├── document_processor.py   # Document extraction & semantic chunking
├── vector_store.py         # Vector search (ChromaDB + BM25 + RRF)
├── llm_interface.py        # LLM interface (GGUF-only)
├── reranking.py            # Cross-encoder reranking
├── query_transformer.py    # Query transformation
├── utils.py                # Utility functions (RRF fusion)
├── requirements.txt        # Python dependencies
├── build.py                # PyInstaller build script
├── scripts/
│   └── build_installer.py  # Inno Setup preparation
├── web_ui/                 # HTML5 Web UI (Phase 3+)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── ChatPage.tsx          # Chat UI page (Phase 3)
│   │   │   ├── DocumentsPage.tsx    # Document upload & management (Phase 4)
│   │   │   └── SettingsPage.tsx     # Settings page with 6 sections (Phase 7)
│   │   ├── components/
│   │   │   ├── ChatMessageBubble.tsx # Role-based message bubbles (Phase 3)
│   │   │   ├── ChatMessageList.tsx   # Scrollable message container (Phase 3)
│   │   │   ├── ChatInput.tsx         # Input with send/cancel (Phase 3)
│   │   │   ├── MarkdownRenderer.tsx  # react-markdown + remark-gfm (Phase 3)
│   │   │   ├── SourceCitation.tsx    # Expandable citation pills (Phase 3)
│   │   │   ├── InferenceModeToggle.tsx # Mode status toggle (Phase 3)
│   │   │   ├── StreamingIndicator.tsx  # Bouncing dots animation (Phase 3)
│   │   │   ├── DropZone.tsx          # Drag-and-drop file upload (Phase 4)
│   │   │   ├── DocumentList.tsx      # Document list with status (Phase 4)
│   │   │   ├── ModelDownloadProgress.tsx # Download progress UI (Phase 6)
│   │   │   ├── ErrorBoundary.tsx     # Error boundary with retry (Phase 7)
│   │   │   ├── LoadingSkeleton.tsx   # Skeleton loading placeholders (Phase 7)
│   │   │   ├── EmptyState.tsx        # Empty state messages (Phase 7)
│   │   │   ├── Sidebar.tsx           # Responsive 260px sidebar (Phase 3)
│   │   │   └── SidebarConversationItem.tsx # Context menu conversations (Phase 3)
│   │   ├── db/
│   │   │   ├── index.ts              # DocQADatabase class (Phase 3)
│   │   │   └── conversations.ts       # Conversation CRUD + pagination (Phase 3)
│   │   ├── hooks/
│   │   │   ├── useSidebarState.ts    # Sidebar collapsed state (Phase 3)
│   │   │   └── useConversations.ts   # Conversation list management (Phase 3)
│   │   ├── layouts/
│   │   │   └── AppLayout.tsx        # Layout with sidebar + header (Phase 3)
│   │   ├── utils/
│   │   │   └── relativeTime.ts       # Relative timestamp formatting (Phase 3)
│   │   ├── lib/
│   │   │   ├── streaming/
│   │   │   │   └── TokenStreamManager.ts # RAF-batched token delivery (Phase 3)
│   │   │   ├── inference/
│   │   │   │   └── InferenceModeContext.tsx # Browser-local/API mode context (Phase 3)
│   │   │   ├── browser/
│   │   │   │   └── browser-compat.ts    # Cross-browser WebGPU detection (Phase 7)
│   │   │   ├── embeddings/
│   │   │   │   ├── embedding-service.ts # Transformers.js embedding (Phase 5)
│   │   │   │   └── memory-aware.ts      # Memory-aware model selection (Phase 5)
│   │   │   ├── llm/
│   │   │   │   ├── web-llm-service.ts  # WebLLM browser inference (Phase 6)
│   │   │   │   ├── model-download.ts   # Download manager with ETA (Phase 6)
│   │   │   │   ├── model-readiness.ts  # WebGPU/memory readiness gate (Phase 6)
│   │   │   │   └── webgpu-watchdog.ts  # Context loss recovery (Phase 6)
│   │   │   ├── rag/
│   │   │   │   └── rag-orchestrator.ts # RAG pipeline orchestrator (Phase 6)
│   │   │   ├── search/
│   │   │   │   ├── vector-index.ts     # EdgeVec HNSW index (Phase 5)
│   │   │   │   ├── keyword-index.ts    # FlexSearch keyword index (Phase 5)
│   │   │   │   ├── rrf-fusion.ts       # Reciprocal Rank Fusion (Phase 5)
│   │   │   │   └── reranker.ts         # Cross-encoder reranker (Phase 5)
│   │   │   ├── processing/
│   │   │   │   ├── pdf-extractor.ts     # PDF text extraction (Phase 4)
│   │   │   │   ├── docx-extractor.ts    # DOCX text extraction (Phase 4)
│   │   │   │   ├── xlsx-extractor.ts    # XLSX text extraction (Phase 4)
│   │   │   │   ├── pptx-extractor.ts   # PPTX text extraction (Phase 4)
│   │   │   │   ├── txt-extractor.ts     # TXT/MD text extraction (Phase 4)
│   │   │   │   ├── extractor-factory.ts # MIME-type based extractor selection (Phase 4)
│   │   │   │   └── text-chunker.ts      # Semantic chunking with overlap (Phase 4)
│   │   │   └── storage/
│   │   │       └── document-store.ts   # IndexedDB document storage (Phase 4)
│   │   ├── types/
│   │   │   ├── chat.ts               # Shared chat types (Phase 3)
│   │   │   ├── document.ts           # Document types (Phase 4)
│   │   │   ├── embedding.ts          # Embedding types (Phase 5)
│   │   │   ├── search.ts             # Search result types (Phase 5)
│   │   │   └── llm.ts                # LLM types, WebGPU-only inference mode (Phase 6)
│   │   └── styles/
│   │       └── tokens.css           # Design tokens + @keyframes blink (Phase 3)
│   ├── package.json
│   └── ...
└── README.md               # This file
```

## 🛡️ Security & Privacy

- **Offline-Only**: No data leaves your machine
- **No Cloud Services**: All processing is local
- **Model Bundling**: Models are stored locally
- **Portable**: Can be run from USB drive

## 📄 License

MIT License - See LICENSE for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 🙏 Acknowledgments

- [ChromaDB](https://www.trychroma.com/) - Vector database
- [Sentence Transformers](https://www.sbert.net/) - Embedding models
- [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) - GGUF inference
- [PyMuPDF](https://pymupdf.readthedocs.io/) - PDF processing
- [CustomTkinter](https://customtkinter.tomschimansky.com/) - Modern GUI toolkit
- [pdfjs-dist](https://mozilla.github.io/pdf.js/) - PDF processing (Apache-2.0)
- [@huggingface/transformers](https://github.com/huggingface/transformers.js) - In-browser ML models (Apache-2.0)
- [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) - In-browser LLM inference (Apache-2.0)
- [edgevec](https://github.com/matte1782/edgevec) - In-browser vector database (MIT OR Apache-2.0)
- [flexsearch](https://github.com/nextapps-de/flexsearch/) - Full-text search (Apache-2.0)
- [mammoth](https://github.com/mwilliamson/mammoth.js) - DOCX processing (BSD-2-Clause)
- [xlsx](https://sheetjs.com/) - XLSX processing (Apache-2.0)
- [jszip](https://github.com/Stuk/jszip) - ZIP handling (MIT OR GPL-3.0-or-later)

---
**Version**: 2.3.0
**Last Updated**: 2026-06-20 (Phase 9 → v2.3.0 web overhaul)
**Hardware**: CPU-only optimized for Intel 11th gen i5 and above (16GB RAM minimum)
