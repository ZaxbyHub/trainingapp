# Web UI (HTML5 App) Deep Audit — Offline RAG for EHR Tier-0 Support

**Scope:** `web_ui/` — the offline HTML5 SPA (React 18 + Vite + TypeScript; transformers.js embeddings, edgevec WASM HNSW + FlexSearch hybrid retrieval, RRF fusion, optional cross-encoder reranker, wllama/WebLLM browser LLM engines, legacy server-API mode).
**Goal assessed against:** a first-class, fully offline (air-gap-capable) RAG application answering tier-0 (how-to / navigation / troubleshooting) questions for EHR users.
**Method:** multi-agent dimension audit (UI/visual auditor completed with 21 findings) + line-by-line manual trace of the chat, settings, storage, retrieval, and packaging paths. Every finding below cites the exact source location. User complaints audited: (a) "UI is messed up", (b) "chat sometimes doesn't work", (c) "settings page is almost entirely useless".

---

## Executive summary

The app's architecture is genuinely sound — the offline-hardening of transformers.js, the wllama packaging, per-request abort plumbing, and the design-token system are all above average. But the integration layer between the well-built modules was never finished, and that produces three product-killing defect clusters:

1. **Chat cannot work in browser-local mode.** No code path ever calls `initialize()` on the wllama (default) engine; both engines' `generate()` throw if uninitialized. Every send in the flagship offline mode errors immediately. (P0-1)
2. **The knowledge base evaporates every browser session.** All three IndexedDB stores are namespaced by a random `sessionStorage` UUID, so a restart or even a second tab starts from an empty corpus while orphaned data accumulates on disk. (P0-3)
3. **Answers are not grounded even when everything else works.** Vector-retrieved chunks lose their text before reaching the LLM and are replaced by literal placeholder strings — disqualifying for clinical-adjacent QA. (P0-2)

The settings page is "useless" because its controls are largely dead ends: a one-option model dropdown that feeds nothing, WebLLM-semantics cache status shown to wllama users, a Clear Cache button that deletes a database name that doesn't exist, duplicate conflicting theme stores, and a crash-on-download progress component with no error boundary anywhere in the tree.

Below: 5 critical, 9 high, 15 medium, 12 low/info findings, then the enhancement roadmap.

---

## Complaint → root-cause map

| Complaint | Root causes (finding #) |
|---|---|
| "Chat sometimes doesn't work" | P0-1 (LLM never initialized — always fails in browser mode), P0-3 (corpus gone next session → "No relevant context"), P0-5 (docs uploaded before first chat are never embedded), P1-6 (engine disposed + conversation wiped on any page switch), P1-9 (permanent "wait for download" overlay that can never resolve offline), P2-24 (readiness race on engine switch) |
| "UI is messed up" | P1-11 (no CSS reset → double scrollbars + gutter), P1-12 (undefined color tokens → invisible progress bars/status colors), P0-4 (hooks crash → blank white app), P2-18..23 (forced autoscroll, invisible assistant bubbles, double "Copied!", theme flash, scrollbar/theme desync, broken drag highlight) |
| "Settings page is almost entirely useless" | P1-13 (dead controls cluster), P1-10 (green "Models Ready" while chat LLM missing), P0-4 (download crash), P2-28 (one-shot "periodic" memory display), theme double-fire + dual stores |

---

## P0 — Critical

### P0-1. Browser LLM is never initialized; browser-local chat fails on every send
- **Where:** `web_ui/src/pages/ChatPage.tsx:164`, `web_ui/src/lib/rag/rag-orchestrator.ts:282`, `web_ui/src/lib/llm/wllama-service.ts:207-208`, `web_ui/src/lib/llm/web-llm-service.ts:252-253`
- **Evidence:** `RAGOrchestrator.query()` calls `this.llmService.generate(...)` directly. Both `WllamaService.generate` and `WebLLMService.generate` throw `"... not initialized. Call initialize() first."` when not ready. Repo-wide search shows the only production callers of an LLM `initialize()` are `model-download.ts:117` (Settings "Download Model" → WebLLM only) and `webgpu-watchdog.ts:251` — and the watchdog is never instantiated anywhere (dead code). Nothing initializes wllama, ever; nothing re-initializes WebLLM on a fresh page load even when its weights are cached in OPFS.
- **Impact:** In the default configuration (browser-local + wllama), the readiness gate unblocks the input (packaged files HEAD-probe OK), the user sends a message, and the assistant bubble immediately shows `[Error: WllamaService not initialized. Call initialize() first.]`. 100% reproducible. WebLLM works only in the same page-session as a completed download. Only API-server mode reliably works — hence "sometimes."
- **Fix:** In `runGeneration` (or a readiness effect), `await llmService.initialize(modelId, onProgress)` before `orchestrator.query()`, routing progress into `setModelLoadingProgress` so the existing overlay/progress UI finally has a real data source. Make `initialize()` idempotent-fast when ready (it already is). Add one integration test with the real service class (mock only the wllama internals) asserting a send works from cold state.

### P0-2. Vector-retrieved passages lose their text; the LLM is grounded on placeholders
- **Where:** `web_ui/src/lib/rag/rag-orchestrator.ts:330` (fallback `chunk.text ?? 'Document chunk from <docId>'`), `web_ui/src/lib/search/rrf-fusion.ts:24-37` (first-occurrence-wins text), `rag-orchestrator.ts:213` (vector list passed first), `web_ui/src/lib/search/vector-index.ts:272-279` (search results carry no text), `web_ui/src/pages/DocumentsPage.tsx:114-119` (vector entries store no text)
- **Impact:** Chunks found by semantic search enter the prompt as the literal string `Document chunk from <docId>`. With reranking on, `reranker.ts:183-196` scores `[query, '']` pairs and demotes exactly the semantic hits. Answers are then generated from degraded/empty context while citing `[1], [2]` — a hallucination engine. For EHR tier-0 this is a patient-safety-grade defect.
- **Fix:** Store chunk text in the vector index `idMapping` (and its persisted form), or hydrate text after fusion from the keyword index by `docId:chunkIndex` key. Make `rrfFuse` prefer a defined `text` across lists as defense-in-depth. Log/assert when a context chunk has no text.

### P0-3. Per-session random storage namespace destroys persistence and isolates tabs
- **Where:** `web_ui/src/lib/storage/document-store.ts:13-29`, `web_ui/src/lib/search/keyword-index.ts:18-34`, `web_ui/src/lib/search/vector-index.ts:16-33`
- **Evidence:** All three stores build their IndexedDB names from `getUserPrefix()`, a UUID stored in `sessionStorage` (`doc-qa-user-id`). sessionStorage is per-tab and cleared when the browser session ends.
- **Impact:** Every new browser session — and every additional tab — sees an **empty corpus**: documents, keyword text, and vectors are unreachable under the new prefix (data remains on disk, orphaned, unbounded growth). The Documents page looks wiped; chat answers "No relevant context found." Settings' Clear Cache (`SettingsPage.tsx:662`) deletes `doc-qa-documents` — an **unprefixed name that never exists** — so it cannot even clean up. The intent (shared-workstation user isolation, per FR-007 tests) is legitimate, but a tab-lifetime UUID is not a user identity.
- **Fix:** Replace the sessionStorage UUID with a stable profile identity: a named local profile (localStorage + explicit profile switcher), or the authenticated username when server auth is present. Add a migration that adopts the newest orphaned DB set on first run, and a storage-manager that enumerates and deletes stale prefixes. Point Clear Cache at the real (prefixed) names, including the edgevec-db store.

### P0-4. Hooks-order crash in ModelDownloadProgress + no mounted ErrorBoundary = blank app
- **Where:** `web_ui/src/components/ModelDownloadProgress.tsx:86-88` (early `return null` before `React.useState` at `:161`), mounted by `SettingsPage.tsx:904-910`; `web_ui/src/App.tsx:118-128` (ErrorBoundary exists in `components/ErrorBoundary.tsx` but is imported nowhere)
- **Impact:** Click "Download Model": the component mounts with `progress=null` (zero hooks rendered), the first progress event re-renders it with one hook → React error #310 → with no error boundary the **entire app unmounts to a white page**. Also fires on the transition back to idle.
- **Fix:** Move the `useState` above the early return; mount `ErrorBoundary` around `AppContent` and around each page in `renderPage()`; enable `eslint-plugin-react-hooks` in CI (would also have caught `NavigationRail.tsx:62`'s hook-in-map).

### P0-5. Documents uploaded before the first chat query are never vector-indexed
- **Where:** `web_ui/src/pages/DocumentsPage.tsx:110` (`if (embeddingService.isReady() && vectorIndex.isReady())` silently skips), `web_ui/src/hooks/useServiceInitialization.ts:117-119` (embedding model deferred to first query)
- **Impact:** On a fresh boot the embedding service initializes only when the first chat question is asked. Any document uploaded before that is chunked and keyword-indexed but **silently never embedded** — no error, no toast, no backfill. Those documents are permanently invisible to semantic retrieval. Order-of-operations data loss in the primary ingestion flow.
- **Fix:** `await ensureEmbeddingServiceReady()` at the top of `processFile` (with progress UI), or queue an embedding backfill job keyed by `docId` whenever the service becomes ready. Surface indexing failures via the existing (unused) toast system, and record per-document index state (embedded: yes/no) in the document store so gaps are visible and repairable.

---

## P1 — High

### P1-6. Page navigation disposes the LLM engine (even mid-generation) and wipes the conversation
- **Where:** `web_ui/src/pages/ChatPage.tsx:77-83` (effect cleanup calls `disposeBrowserEngine(browserEngine)` on unmount), `web_ui/src/App.tsx:98-109` (switch-based routing unmounts pages), `ChatPage.tsx:49` (messages in page-local state)
- **Impact:** Visiting Documents or Settings frees the multi-hundred-MB wllama heap — the next question pays a full GGUF reload (tens of seconds on target i5 hardware); if a generation is streaming, it is killed. The entire conversation is also lost on every navigation. Users experience this as random chat breakage/slowness.
- **Fix:** Lift chat messages into a context/store that survives navigation; keep pages mounted (CSS visibility switch) or dispose the engine only on actual engine-switch and memory pressure, not on unmount. Block navigation-triggered dispose while a stream is in flight.

### P1-7. WebLLM path breaks the air-gap guarantee and is actively recommended
- **Where:** `web_ui/src/lib/llm/web-llm-service.ts:186-196` (prebuilt MLC appConfig → mlc.ai/HuggingFace CDN, ~1.9 GB), `web_ui/src/lib/llm/engine-capability.ts:99-104` (recommends webllm whenever WebGPU exists), `web_ui/src/lib/rag/rag-orchestrator.ts:107` (defaults to WebLLM when no service injected), `PACKAGING.md:5-8` (admits WebLLM is outside the air-gapped archive)
- **Impact:** On air-gapped EHR workstations with WebGPU the app steers users to an engine that cannot work; on partially connected networks it silently pulls weights from third-party hosts (STIG/data-governance violation).
- **Fix:** Build-time flag for air-gapped archives that hides WebLLM and pins recommendations to wllama; change the orchestrator default to `getLLMService()` (wllama); optionally package MLC weights same-origin via a custom `appConfig` for connected deployments.

### P1-8. BGE embeddings use mean pooling; the model requires CLS pooling
- **Where:** `web_ui/src/lib/embeddings/embedding-service.ts:118-121, 179-182, 245-248` (`pooling: 'mean'`); the packaged model's own `models/bge-small-en-v1.5/1_Pooling/config.json` declares CLS pooling
- **Impact:** Embeddings don't match the model's training objective — silent, across-the-board retrieval degradation. Retrieval quality is the #1 safety bottleneck in medical RAG.
- **Fix:** `pooling: 'cls'` in all three call sites; bump an index schema version and force re-index (existing vectors are incompatible).

### P1-9. Model-blocked overlay promises a download that can never happen and offers no recovery
- **Where:** `web_ui/src/pages/ChatPage.tsx:405-472` ("Model not loaded. Please wait for the model to download and initialize."), `web_ui/src/lib/llm/readiness-gate.ts:91-129`
- **Impact:** When packaged weights are missing (or the gate check errors), wllama-mode users get a permanent dark overlay with a lying message and a progress bar wired to `modelLoadingProgress`, which nothing updates (see P0-1). No link to Settings, no diagnostics, no retry.
- **Fix:** Engine-aware messaging: wllama + missing files → "This build is missing the packaged model (see Packaging guide / contact your administrator)" with the failing paths (`readinessResult.failures/recommendations` already exist — render them); retry button; deep-link to Settings' packaged-models panel.

### P1-10. "Packaged Models: ✓ Ready" shows green while the chat LLM is absent
- **Where:** `web_ui/src/lib/models/model-manifest.ts:164-181` (wllama runtime + GGUF/mmproj all `required: false`), consumed at `SettingsPage.tsx:1123-1145` (`allReady` drives the green badge)
- **Impact:** `allReady` only counts required files (embeddings + ORT). A build without any browser LLM shows "Ready" in Settings while ChatPage simultaneously blocks with "model not loaded" — contradictory signals that make both pages look broken.
- **Fix:** Report readiness per-kind (embeddings / reranker / browser LLM / wllama runtime) with the engine in scope; the aggregate badge should reflect the currently selected engine's needs.

### P1-11. No CSS reset: 8px body margin + `100vw/100dvh` layout → permanent double scrollbars and gutter
- **Where:** `web_ui/src/layouts/AppLayout.tsx:12-18`; neither `theme.css` nor `tokens.css` resets body margin
- **Impact:** Every page overflows the viewport by 16px in both axes: background gutter on top/left, horizontal + vertical document scrollbars, diagonal shift when scrolled. The most literal "UI is messed up."
- **Fix:** `html, body { margin:0; height:100%; } #root { height:100%; }` and `width:'100%'` instead of `100vw`.

### P1-12. Undefined design tokens make core feedback invisible
- **Where:** `web_ui/src/components/DocumentList.tsx:32-45,176,198` (`--color-info/-warning/-success` undefined → progress-bar fill transparent, status labels uncolored); `web_ui/src/components/DropZone.tsx:102-104,142` (`--color-primary-rgb`, `--color-text-primary` undefined → drag highlight never renders); `web_ui/src/App.tsx:20-73` (LoadingOverlay uses ~12 phantom tokens → always near-black even in light theme)
- **Impact:** Upload/processing progress is a stuck empty bar; drag-over feedback missing; light-theme users get white flash → black boot screen → light app. Two half-migrated token vocabularies exist (see P3-36).
- **Fix:** Define the semantic palette (success/warning/info + rgb triplets + dark variants) in `tokens.css`; restyle LoadingOverlay with real tokens; add a CI check that every `var(--x)` used in `src/` is defined.

### P1-13. Settings page dead-controls cluster
- **Where/Evidence:**
  - Model dropdown has exactly one option (`SettingsPage.tsx:136-143`) and its persisted value is read by nothing that matters: readiness uses `modelIdForEngine()` which hardcodes `LLM_MODEL_DIR` (wllama) or `'SmolLM3-3B-Q4_K_M'` (webllm — a third, inconsistent ID) at `readiness-gate.ts:23-25`; the WebLLM default elsewhere is `Llama-3.2-3B-Instruct-q4f16_1-MLC`.
  - Cache status + Download button use WebLLM semantics in wllama mode: `SettingsPage.tsx:482` calls `checkModelCached(preferredModel)` with default `engine='webllm'` (`model-readiness.ts:202`), so the default-engine user sees "Not cached" and a button that downloads a 1.9 GB CDN model wllama never uses (also violates offline).
  - Theme radios double-fire (`SettingsPage.tsx:1087-1104` lack the `stopPropagation` the other radio groups have at `:991/:1049`) — clicking the radio circle toggles theme twice, so the app doesn't change while the selection does.
  - Two competing theme stores: Settings persists to IndexedDB `user-preferences.theme` and calls relative `toggleTheme()` (`:443-455, 529-549`) while `ThemeContext` persists `localStorage['theme-preference']` — when they disagree, merely opening Settings flips the app theme.
  - "Update memory pressure periodically" runs once — no interval (`SettingsPage.tsx:502-513`).
  - Clear Cache deletes a nonexistent DB name and misses all real stores (see P0-3) and OPFS wllama cache.
- **Impact:** Nearly every control is a no-op, misleading, or destructive-but-ineffective — the user's assessment ("almost entirely useless") is accurate.
- **Fix:** Rebuild settings around things that exist: engine selector (works today), RAG preset (works today), a real model panel per engine (packaged LFM2-VL status for wllama; download/cache management for WebLLM when online), single theme source of truth (extend ThemeContext with `setTheme(mode)`), real storage panel (per-store usage via `navigator.storage.estimate()`, working clear-data per store), diagnostics (capability + packaged files with paths). Delete the dead model dropdown until >1 model genuinely wired.

### P1-14. Root-absolute `/models` paths break any subpath deployment
- **Where:** `web_ui/src/lib/models/model-manifest.ts:23` (`MODELS_BASE = '/models'`) vs `vite.config.ts:64` (`base: './'` chosen explicitly so the archive works "from any path")
- **Impact:** Served from `https://host/training/` (common IIS/static-host reality in hospitals), the app shell loads but every model probe/fetch 404s at the origin root → readiness gate reports missing, wllama fails, and the packaged-models panel shows all-missing. The two config decisions contradict each other.
- **Fix:** Derive model paths from `import.meta.env.BASE_URL` (or `new URL('models/…', document.baseURI)`).

---

## P2 — Medium

- **P2-15. Missing BGE query-instruction prefix** — queries should be embedded with `"Represent this sentence for searching relevant passages: "` prepended (query side only). Orchestrator embeds the raw question (`rag-orchestrator.ts:159`). Short tier-0 questions vs long passages is exactly the case this exists for. No re-index needed.
- **P2-16. No token budgeting; quality preset overflows the context window** — `buildContext` (`rag-orchestrator.ts:320-339`) concatenates all topK chunks; `wllama-service.ts:37` sets `n_ctx=4096`; quality preset topK=16 routinely exceeds it → silent truncation that can drop the user's question. Budget context with headroom for system + question + generation; surface "context trimmed".
- **P2-17. No relevance floor / abstention path** — `fusedResults.slice(0, topK)` (`rag-orchestrator.ts:244,255,258`) always fills context regardless of score; abstention exists only as a sentence in the system prompt (`:83`). Add a score floor and an explicit "insufficient evidence" UI state; log misses for content-gap analysis. (Python engine has `min_similarity=0.3`; browser has no equivalent.)
- **P2-18. Citation numbers don't resolve to sources** — the prompt instructs `[1], [2]` citations over chunk-numbered context, but `sources` is a de-duplicated `docId` list (`rag-orchestrator.ts:261-268`), so `[3]` in an answer has no stable mapping to the pills rendered under the message — and `docId` is a random timestamp-based string (`DocumentsPage.tsx:16-18`), not a filename. Tier-0 users cannot verify provenance. Fix: pass structured chunk metadata (fileName, chunkIndex, snippet) through `complete.data`, render numbered citations that open the exact chunk text.
- **P2-19. Chat autoscroll force-scrolls on every token** (`ChatMessageList.tsx:32-57` force flag bypasses the near-bottom check; `ChatPage.tsx:477`) — impossible to scroll up during slow CPU generation. Use the near-bottom heuristic during streaming; force only on send.
- **P2-20. Assistant bubbles are invisible** — `--color-bubble-assistant` is simultaneously the page/header/input background (`theme.css:12`, `ChatPage.tsx:328/337`, `ChatMessageBubble.tsx:218`) in both themes, so answers render as bare text and the hover Copy button overlaps content. Introduce a distinct surface/elevation token.
- **P2-21. Two overlapping "Copied!" indicators** on assistant messages (`ChatMessageBubble.tsx:223` span + `:224-231` button label swap at identical absolute positions).
- **P2-22. `color-scheme: light dark` follows the OS, not `data-theme`** (`theme.css:7-9`) — mismatched scrollbars/form controls when app theme ≠ OS theme. Use `[data-theme="dark"] { color-scheme: dark; }`.
- **P2-23. Theme flash on startup** — `data-theme` set post-paint in an effect (`ThemeContext.tsx:41-43`), no inline bootstrap in `index.html`.
- **P2-24. Readiness-gate promise race on engine switch** — `readiness-gate.ts:63-73`: first call has `lastReadinessEngine=null` so concurrent same-engine calls clobber `readinessGateInitPromise`; rapid wllama↔webllm switches interleave two checks and the **last event wins `isModelReady`, possibly for the wrong engine** (events carry `engine` but the listener at `useServiceInitialization.ts:181-207` ignores it). Tag events with engine and drop stale ones.
- **P2-25. The polished feedback system is dead code; failures are silent** — `useToast` has zero consumers; `EmptyState`/`LoadingSkeleton` render only in tests; DocumentsPage catch-blocks log to console only (`DocumentsPage.tsx:33,53,121,132,219,231,237`). IndexedDB quota/private-mode failures (locked-down hospital browsers) are invisible. Wire toasts into every catch; use the empty/skeleton components.
- **P2-26. Hand-rolled edgevec persistence stub in the build config** — `vite.config.ts:10-57` replaces edgevec's internal `./snippets/` backend with a custom `IndexedDbBackend` writing to an unversioned, unprefixed `edgevec-db`. Any drift from the real backend's semantics silently corrupts vector persistence, and it bypasses the user-prefix scheme. Verify against the packaged edgevec snippet, or upstream a proper resolve fix.
- **P2-27. Reranker scores `[query, '']` for vector-only hits** (`reranker.ts:183-196`) — downstream of P0-2; quality mode can rank worse than fast mode until fixed.
- **P2-28. wllama memory gate uses a 2 GB fallback requirement** (`model-readiness.ts:67-77`: table only contains the MLC Llama ID; `LLM_MODEL_DIR` falls back to 2 GB) — on 4 GB machines `getMemoryBudget()` can fail the **hard** memory check for a ~1 GB LFM2-VL model, permanently blocking chat on exactly the low-end hardware wllama exists for. Add real per-model requirements.
- **P2-29. Ctrl+, / shortcut double-registration** — both `AppContent` (`App.tsx:84-86`) and `ChatPage` (`ChatPage.tsx:315-320`, with a no-op `onOpenSettings`) mount `useKeyboardShortcuts`; depending on listener order the page-level no-op can swallow or duplicate handling (and Ctrl+L clear-chat is registered only inside ChatPage while the hint text lives in README). Consolidate into one registrar.

---

## P3 — Low / informational

- **P3-30.** `NavigationRail.tsx:62` calls `useState` inside `navItems.map` — Rules-of-Hooks violation, latent crash for any dynamic nav; blocks enabling the lint that would've caught P0-4.
- **P3-31.** SourceCitation expanded popover: `nowrap`, no max-width, page-colored background (`SourceCitation.tsx:132-151`) — long EHR document paths paint an edge-clipped strip; also the pill shows `docId`, see P2-18.
- **P3-32.** Toast palette: info = white-on-#8a8a8a (~3.3:1, fails WCAG AA); success renders primary-blue because no success token exists (`ToastProvider.tsx:89-98`).
- **P3-33.** Markdown renderer lacks headings/blockquotes/tables/`*` bullets (`MarkdownRenderer.tsx:162-231`) — local instruct models emit `###`/`|` routinely; users see raw markup. (Renderer is XSS-safe: React elements only, protocol-filtered links — but `isValidUrl`'s base-URL trick admits relative URLs.)
- **P3-34.** Relative timestamps computed once, never refreshed ("just now" forever; `ChatMessageBubble.tsx:11-29`, memoized).
- **P3-35.** Enter-to-send ignores IME composition (`ChatInput.tsx:114-122`) — splits CJK/Vietnamese input mid-composition.
- **P3-36.** Token debt: 7 defined-but-unused tokens; a whole phantom family (`--color-background/-border/-accent/-error`, `--font-sans`, `--spacing-2/3/4`…) referenced but never defined — two divergent design systems (`tokens.css` vs App.tsx/DropZone vocabulary).
- **P3-37.** `index.html` ships no favicon (404 noise in the air-gapped bundle), no `color-scheme`/`theme-color` meta, no `<noscript>`; zero responsive breakpoints anywhere (header overflows below ~500px).
- **P3-38.** Lexical layer is FlexSearch resolution scoring with `suggest:true` fuzz (`keyword-index.ts:108-114,216-226`), not the BM25 the root docs describe (that's the Python engine). Align docs; consider disabling `suggest` for precision.
- **P3-39.** Production build ships sourcemaps (`vite.config.ts:100`) — archive bloat/source exposure for a STIG-scanned artifact.
- **P3-40.** `public/models/manifest.json` has drifted from `model-manifest.ts` (no wllama runtime/LLM entries; nothing reads the JSON) — delete it or generate it from the TS source of truth.
- **P3-41.** `getRAGOrchestrator()` (`rag-orchestrator.ts:382-384`) returns a WebLLM-defaulted orchestrator — a footgun for any future caller (compounds P1-7).
- **Also noted:** TokenStreamManager RAF-flush stalls in background tabs (tokens buffer until visible); `MAX_BUFFER_SIZE` overflow drops tokens silently mid-answer.

---

## What is genuinely good (keep and build on)

- `configureOfflineEnv()` (`offline-env.ts`) correctly forces transformers.js fully local (no Hub, local ORT WASM) with a well-documented shared-global guard.
- `WllamaService` is careful: HEAD-probe fail-fast with actionable message, offline compat build pinned same-origin, single-flight init, abort forwarding, teardown promise.
- Abort/cancel plumbing (ChatPage → orchestrator generator → engine `abortSignal`) is correct end-to-end.
- Design-token discipline in most components; fixing `tokens.css` fixes the app globally.
- Accessibility groundwork: aria-labels, `role=progressbar/alert`, visually-hidden legends, `aria-current` nav, keyboard handlers on custom radios and DropZone.
- Dependency-free windowed virtualization in DocumentList; timer hygiene (refs + unmount cleanup) is consistent; ThemeContext handles private-mode storage failures.
- The packaged-model manifest + readiness-report pattern (`model-manifest.ts`) is the right idea — it just needs engine-aware aggregation (P1-10).

---

## Roadmap to first-class offline EHR tier-0 RAG

### Phase A — Make it work (the P0s, ~days)
1. Wire `llmService.initialize()` into the chat path with progress → existing overlay (P0-1).
2. Stable storage identity + migration + orphan cleanup + honest Clear Data (P0-3).
3. Hydrate chunk text into context; assert non-empty (P0-2).
4. Fix ModelDownloadProgress hooks; mount ErrorBoundary; enable react-hooks lint (P0-4, P3-30).
5. Ensure embedding service before indexing + backfill queue + failure toasts (P0-5, P2-25).

### Phase B — Make it right (~1-2 weeks)
6. Persist chat + keep engine alive across navigation; dispose only on engine switch/memory pressure (P1-6).
7. Settings overhaul per P1-13; engine-aware packaged-models badge (P1-10); honest model-blocked overlay (P1-9).
8. Retrieval quality: CLS pooling + re-index versioning (P1-8), query instruction (P2-15), token budgeting (P2-16), relevance floor + abstention UX (P2-17), fix citation mapping with click-through chunk viewer (P2-18).
9. Offline integrity: air-gap build flag hiding WebLLM + wllama-default orchestrator (P1-7, P3-41), BASE_URL-relative model paths (P1-14), drop prod sourcemaps (P3-39).
10. UI polish pass: CSS reset (P1-11), token consolidation (P1-12, P3-36), autoscroll (P2-19), bubble surface (P2-20), theme unification incl. color-scheme + boot script (P2-21..23), markdown headings/tables (P3-33).

### Phase C — Make it first-class for EHR tier-0 (~weeks, product decisions)
11. **Ship the knowledge base, don't crowdsource it:** package a curated, versioned tier-0 corpus (EHR how-to guides) with a **pre-built index** in the archive (index at packaging time with the same models); user uploads become a supplement, not the foundation. This eliminates the per-user indexing fragility class entirely.
12. **Verifiable answers:** numbered citations → exact source passage viewer; answer header showing corpus version; explicit "not in the knowledge base — contact the help desk" abstention card with an escalation link.
13. **Safety rails:** system-prompt + retrieval-scope guardrails that route clinical/dosing/diagnosis questions to an "out of scope for tier-0" response; visible "not clinical advice" disclaimer; configurable blocked-topic list.
14. **Governance:** local append-only Q&A audit log with export (what was asked, what was retrieved, what was answered, corpus version) — required for hospital sign-off; unanswered-question log to drive content updates.
15. **Shared-workstation posture:** profile picker or SSO-derived identity, inactivity auto-clear of conversation, optional at-rest encryption of IndexedDB payloads (WebCrypto, key from profile secret).
16. **Offline resilience:** service worker (also solves COOP/COEP via coi-serviceworker pattern for static hosts) so the app shell loads with zero network; storage-quota monitoring with real numbers (`navigator.storage.estimate()`).
17. **Quality harness:** golden Q&A evaluation set for the corpus run at packaging time (retrieval hit-rate + citation accuracy gates); Playwright smoke of boot→upload→ask→citation in CI.
18. **A11y to WCAG 2.1 AA:** contrast fixes (P3-32 et al.), `aria-live` for streaming answers, focus management on page switch, reduced-motion.

---

## Verification status

- The 21 UI-dimension findings were produced by a dedicated auditor agent; P0-1/2/3/5, P1-6/7/9/10/13/14, P2-15..18/24/26/28 were manually traced end-to-end through source by the report author (file:line cited on every claim).
- Residual gaps to close when infrastructure allows: a live build/test/runtime probe (`npm ci && tsc && vitest && vite build` + Playwright smoke) and a dedicated WCAG contrast computation pass. The multi-agent adversarial verification workflow (per qa-sweep) is queued to re-run these plus independent refutation passes; its transcript will be appended when complete.
