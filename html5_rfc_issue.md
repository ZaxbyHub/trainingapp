## Summary

This RFC proposes releasing the Document Q&A Assistant as an HTML5 single-page application with **dual-mode inference**: API-based server inference (existing FastAPI backend) and **browser-side inference** using WebLLM, Transformers.js, and in-browser vector search.

**Core goal**: Users can run the app entirely in-browser (no server required after initial load) or route inference through the existing FastAPI server.

---

## Background

The current application is a **monolithic desktop app** built with:
- **CustomTkinter** GUI → completely replaced for HTML5
- **FastAPI** REST API → reused as optional backend for API mode
- **llama-cpp-python** for GGUF LLM inference → replaced by WebLLM in browser mode
- **sentence-transformers + ChromaDB** → replaced by Transformers.js + in-browser vector store
- **PyInstaller** packaging → replaced by Vite/React SPA

The existing FastAPI server already abstracts all ML operations behind REST endpoints. The browser becomes a thin client. **No existing functionality is lost** — API mode stays, browser mode is added.

---

## Technology Stack Analysis

### ✅ Browser-Viable Components

| Component | Current (Desktop) | Browser Replacement | Library | Feasibility |
|---|---|---|---|---|
| LLM Generation | llama-cpp-python (GGUF) | WebLLM (MLC format) | `webllm` npm | ✅ Viable |
| Embeddings | sentence-transformers | Transformers.js ONNX | `@huggingface/transformers` | ✅ Viable |
| Cross-Encoder Reranking | Python cross-encoder | Transformers.js CrossEncoder | `@huggingface/transformers` | ✅ Viable |
| Vector Store | ChromaDB (SQLite+Parquet) | In-browser HNSW | `EdgeVec` / `RuvCore` (WASM) | ✅ Viable |
| PDF Parsing | pdfplumber/pypdf | PDF.js | `pdfjs-dist` | ✅ Viable |
| DOCX Parsing | python-docx | mammoth.js | `mammoth` | ✅ Viable |
| XLSX Parsing | openpyxl | SheetJS | `xlsx` | ✅ Viable |
| Keyword Search | rank_bm25 | FlexSearch | `flexsearch` | ✅ Viable |
| RRF Fusion | `utils.rrf_fuse` (Python) | Pure TypeScript | — | ✅ Trivial port |
| Theme System | `theme.py` (ColorTokens, TypeScale) | CSS Custom Properties | — | ✅ Direct translation |
| Keyboard Shortcuts | `bind()` handlers | `onKeyDown` | — | ✅ Direct translation |

### ⚠️ Components Requiring Medium Effort

| Component | Current | Browser Replacement | Effort |
|---|---|---|---|
| **LLM Format Conversion** | GGUF (llama-cpp) | MLC (WebLLM) | ~1 day build tooling |
| **Model Hosting** | Local filesystem | CDN / Origin + OPFS cache | ~1 day |
| **Document Processing Pipeline** | Python chunker | TypeScript port + PDF.js/mammoth/xlsx | ~1 week |
| **ChromaDB → EdgeVec** | PersistentClient | WASM HNSW + IndexedDB | ~1 week |
| **Streaming SSE Endpoint** | Not wired (API returns complete response) | Add SSE streaming to `/ask` | ~1 day |

### 🔴 Components Requiring Complete Rewrite

| Component | Current | Browser Replacement | Effort |
|---|---|---|---|
| **GUI** | app_gui.py (2528 lines CustomTkinter) | React/Vue SPA | ~3-4 weeks |
| **Path Management** | `app_paths.py` (%LOCALAPPDATA%, _MEIPASS) | URL-based + IndexedDB | ~1 week |

---

## Browser Inference Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              HTML5 Frontend (React SPA)                       │
├──────────────────────────────────────────────────────────────┤
│  Inference Mode Toggle:  [ ] Use browser inference          │
│                         (off = FastAPI server, on = WebLLM) │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐  │
│  │ WebLLM       │    │ Transformers.js                    │  │
│  │ LLM Generation│    │ ├─ Embeddings (bge-small-en-v1.5)│  │
│  │ MLC format    │    │ ├─ Cross-Encoder (MiniLM-L-6)    │  │
│  │ WebGPU/WASM  │    │ └─ Text processing               │  │
│  └──────────────┘    └──────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ EdgeVec / RuvCore — In-browser vector store (HNSW)  │  │
│  │ ├─ Embeddings indexed in-browser (IndexedDB)           │  │
│  │ └─ Full similarity search without server roundtrip       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Document Processor (TypeScript port)                  │  │
│  │ ├─ PDF.js (Mozilla)                                │  │
│  │ ├─ mammoth.js (DOCX)                               │  │
│  │ ├─ jszip (PPTX)                                    │  │
│  │ └─ xlsx (SheetJS, XLSX)                          │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                              │
              ┌──────────────┴──────────────┐
              ▼                              ▼
    ┌─────────────────┐            ┌─────────────────┐
    │ FastAPI Server  │            │ FastAPI Server   │
    │ (API Mode)     │            │ (WebLLM proxy)  │
    │ Existing code   │            │ future: SSE stream│
    └─────────────────┘            └─────────────────┘
```

---

## Model Selection for Browser

The current bundled model is **Gemma 4 E2B Q5_K_M (~3.1GB GGUF)**. This is tight but feasible for modern laptops (16GB RAM, 4GB+ GPU).

| Model | Quantization | Browser RAM | Quality | Recommendation |
|---|---|---|---|---|
| **Gemma 4 E2B** | Q4_K_M | ~3.1 GB | HIGH (60% MMLU Pro) | ✅ Recommended |
| **SmolLM3-3B** | Q4_K_M | ~1.9 GB | MEDIUM | ✅ Good fallback |
| **Qwen3-0.6B** | Q4_K_M | ~0.4 GB | LOW | ⚠️ Fallback only |
| **Llama 3.2-1B** | Q2_K | ~0.6 GB | MEDIUM | ⚠️ Low-RAM devices |

**Note**: WebLLM requires **MLC format** models (converted from GGUF). A conversion pipeline must be added to the build process.

**Memory constraints by browser**:
- Chrome/Edge desktop: Most permissive, ~4GB+ models viable
- Safari: Strict per-buffer limits (256MB–993MB) — may OOM on Gemma 4 E2B
- Firefox: Moderate limits, ~2-3GB models viable

**Recommendation**: Target Chrome/Edge first (majority of users). Provide a smaller model (SmolLM3-3B) as fallback for Safari/low-RAM devices.

---

## Recommended Implementation Phases

### Phase 1: API Foundation (~2-3 days)

**Goal**: Make the FastAPI server the definitive backend with streaming support.

- [ ] Add SSE streaming endpoint `GET /ask/stream` wiring `stream_callback` through to SSE tokens
- [ ] Update CORS configuration for planned deployment domain(s)
- [ ] Add batch-file upload endpoint for multi-file drag-drop
- [ ] Add settings persistence API (`GET/PUT /settings`)
- [ ] Extend `/ingest/file` to support multiple files per request

**Files touched**: `api_server.py`, `config.py`

---

### Phase 2: Web UI Shell (~3-5 days)

**Goal**: React SPA scaffold with navigation, theme, and layout.

- [ ] Set up Vite + React + TypeScript project
- [ ] Implement navigation rail (4 pages: Chat, Documents, Settings, Help)
- [ ] Export `theme.py` tokens → CSS custom properties (direct translation)
- [ ] Implement dark/light mode via `prefers-color-scheme`
- [ ] Add keyboard shortcut handlers (`Ctrl+Enter`, `Ctrl+L`, `Ctrl+,`, `Escape`)
- [ ] Add toast notification system (replaces `messagebox.showerror`)

**Theme translation**:

| Python (`theme.py`) | CSS Equivalent |
|---|---|
| `ColorTokens.primary()` | `--color-primary: #1a73e8` |
| `ColorTokens.primary_hover()` | `--color-primary-hover: #1557b0` |
| `TypeScale.h2()`, `.body()` | `--font-size-heading: 1.5rem` |
| `Spacing.LG` | `--spacing-lg: 16px` |
| Dark mode via `ctk.get_appearance_mode()` | `prefers-color-scheme: dark` |

**Files touched**: New `web_ui/` directory

---

### Phase 3: Chat Page (~3-5 days)

**Goal**: Functional chat interface with streaming token display.

- [ ] Message list with user/assistant bubbles (flexbox, `overflow-y: auto`)
- [ ] Wire SSE streaming for token-by-token display
- [ ] Source pills with expandable snippets
- [ ] Typing indicator (CSS animation)
- [ ] Two-click confirm for clear (React state + `setTimeout`)
- [ ] Copy-to-clipboard (`navigator.clipboard.writeText`)
- [ ] Cancellation via `AbortController`

**Files touched**: `web_ui/src/pages/Chat.tsx`

---

### Phase 4: Document Processing Pipeline (~5-7 days)

**Goal**: Port document ingestion to TypeScript + browser-native libraries.

- [ ] Port `DocumentProcessor` chunking logic to TypeScript (~100 lines, trivial)
- [ ] Integrate `pdfjs-dist` for PDF extraction
- [ ] Integrate `mammoth.js` for DOCX extraction
- [ ] Integrate `xlsx` (SheetJS) for XLSX extraction
- [ ] Add PPTX extraction via `jszip` + XML parsing
- [ ] Implement chunk overlap algorithm in TypeScript

**Files touched**: `web_ui/src/lib/documentProcessor.ts`

---

### Phase 5: In-Browser Vector Store (~5-7 days)

**Goal**: Replace ChromaDB with in-browser HNSW vector search.

- [ ] Integrate `EdgeVec` or `RuvCore` for HNSW vector search
- [ ] Integrate `@huggingface/transformers` for embedding generation (`bge-small-en-v1.5` ONNX)
- [ ] Integrate `@huggingface/transformers` CrossEncoder for reranking (`ms-marco-MiniLM-L-6-v2`)
- [ ] Persist vector index to IndexedDB / OPFS
- [ ] Implement BM25 keyword search via `FlexSearch`
- [ ] Port RRF fusion to TypeScript

**Files touched**: `web_ui/src/lib/vectorStore.ts`, `web_ui/src/lib/embedder.ts`, `web_ui/src/lib/reranker.ts`

---

### Phase 6: WebLLM Integration (~3-5 days)

**Goal**: Add browser-side LLM inference via WebLLM.

- [ ] Set up MLC model conversion pipeline (GGUF → MLC format)
- [ ] Integrate `@mlc-ai/webllm` npm package
- [ ] Implement model loading + caching via OPFS
- [ ] Add inference mode toggle (API Mode / Browser Mode)
- [ ] Wire streaming token output to chat UI
- [ ] Handle GPU adapter detection + WASM fallback

**Model serving options**:
1. **Same origin**: Serve MLC files from web app origin (large initial download, then cached)
2. **CDN**: Cloudflare R2 + CDN edge caching (fast, cached across users)
3. **HuggingFace Hub**: WebLLM can load directly from HF URLs (requires internet on first load)

**Files touched**: `web_ui/src/lib/inference.ts`, build pipeline

---

### Phase 7: Documents Page (~2-3 days)

**Goal**: Document management interface with drag-drop.

- [ ] File upload via `<input type="file" multiple>`
- [ ] Drag-and-drop zone with `DataTransferItem.webkitGetAsEntry()` (Chrome/Edge)
- [ ] Folder ingestion via `webkitdirectory` attribute (Chrome/Edge only) with graceful degradation to ZIP upload
- [ ] Document list with delete buttons
- [ ] Per-file progress tracking (`XMLHttpRequest.upload.onprogress`)
- [ ] IndexedDB persistence for document metadata

**Files touched**: `web_ui/src/pages/Documents.tsx`

---

### Phase 8: Settings + Auth (~2-3 days)

**Goal**: Settings page and authentication.

- [ ] Settings form (relevant fields only — GGUF path becomes server model selection)
- [ ] JWT login flow via `/auth/token`
- [ ] API key configuration
- [ ] Inference mode toggle (Browser / API)
- [ ] Presets (Fast / Balanced / Quality)
- [ ] Settings persistence API (`GET/PUT /settings`) or IndexedDB for browser-only mode

**Note**: Several current settings are irrelevant for browser mode:
- `GGUF Model Path` → server-side model selection
- `GGUF Threads (n_threads)` → server-controlled
- `Database Path` → server-controlled

**Files touched**: `web_ui/src/pages/Settings.tsx`, `web_ui/src/lib/auth.ts`

---

### Phase 9: Integration + Polish (~3-5 days)

**Goal**: Production-ready release.

- [ ] Error handling with toast notifications throughout
- [ ] Loading skeletons and empty states
- [ ] Accessibility audit (WCAG 2.1 AA)
- [ ] Responsive design for tablet
- [ ] PWA manifest + service worker for offline capability
- [ ] Browser compatibility matrix validation (Chrome, Edge, Firefox, Safari)

---

## Total Estimated Effort

| Phase | Effort | Notes |
|---|---|---|
| 1. API Foundation | 2-3 days | Backend SSE + batch upload |
| 2. Web UI Shell | 3-5 days | React scaffold + theme |
| 3. Chat Page | 3-5 days | Core UX |
| 4. Document Pipeline | 5-7 days | JS parsing libraries |
| 5. Vector Store | 5-7 days | EdgeVec + Transformers.js |
| 6. WebLLM Integration | 3-5 days | MLC conversion + inference |
| 7. Documents Page | 2-3 days | Upload UI |
| 8. Settings + Auth | 2-3 days | Auth flow |
| 9. Polish | 3-5 days | A11y + responsiveness |
| **Total** | **~28-43 days** | ~6-9 weeks for one developer |

---

## Key Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Safari memory limits cause OOM on Gemma 4 E2B | MEDIUM | MEDIUM | Provide SmolLM3-3B fallback for Safari/low-RAM |
| GGUF → MLC conversion pipeline complexity | LOW | MEDIUM | MLC provides CLI tools; ~1 day tooling |
| Model download size (3-4GB) for browser mode | MEDIUM | LOW | OPFS caching after first load; CDN edge caching |
| Scope creep on web UI rewrite | HIGH | HIGH | Strict phase gates; defer non-essential features |
| PPTX extraction quality in browser | MEDIUM | LOW | Degrade to text-only or skip PPTX in v1 |
| WebGPU shader compilation cold-start (3-10s) | HIGH | LOW | Show loading UI; pipeline caching helps |

---

## Non-Goals (v1)

- Browser-side model fine-tuning
- Real-time collaborative editing
- Mobile-optimized UI (tablet is acceptable, phone is out of scope)
- Offline-first PWA as default (API mode should be the default until browser ML is stable)

---

## Open Questions

1. **Model quality**: SmolLM3-3B or Qwen3-0.6B as browser default — acceptable for a document Q&A use case where retrieval context is the primary signal?
2. **PPT(X) extraction**: python-pptx has no mature browser equivalent. Accept text-only PPTX extraction, or defer?
3. **API mode as default**: Should API mode (FastAPI backend) be the default with browser mode opt-in, or vice versa?
4. **Model hosting**: CDN vs. self-hosted for MLC model files?

---

## References

- WebLLM: https://webllm.mlc.ai | https://github.com/mlc-ai/web-llm
- Transformers.js: https://huggingface.co/docs/transformers.js
- EdgeVec (HNSW in browser): https://github.com/matteo1782/edgevec
- RuvCore WASM vector store: https://lib.rs/crates/ruvector-wasm
- LlamaWeb research paper: arXiv:2605.20706v1
- MLC model conversion: https://github.com/mlc-ai/mlc-llm
- Gemma 4 GGUF: https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF
- Browser memory limits (2026): https://tianpan.co/blog/2026-04-17-browser-native-llm-inference-webgpu
