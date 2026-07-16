# PACKAGING — Offline model bundling for the HTML5 web app

The web app is designed for **fully offline** operation: every model file is
packaged into the build and served same-origin. **By default** (wllama engine),
nothing is fetched from a CDN or the HuggingFace Hub at runtime. The optional
WebLLM fast-path fetches weights from mlc.ai when selected — it is not part of
the air-gapped / STIG-scannable archive configuration. All references to
"offline" in this document refer to the default wllama path.

Model **weight binaries are not committed to git** (they are large, mirroring the
desktop app's GGUF policy). They are assembled into `web_ui/public/models/` at
packaging time by `web_ui/scripts/prepare-models.mjs`.

> Status: **Phase 1** covers the embedding model + ONNX Runtime WASM. The
> LFM2-VL GGUF (browser LLM, wllama) lands in Phase 2 and is documented below as
> the target procedure.

---

## 1. Prerequisites

```bash
cd web_ui
npm install            # provides ONNX Runtime WASM under node_modules
```

You also need the real embedding weights at the repo root:
`models/bge-small-en-v1.5/onnx/model.onnx`. If that file is ~4 KB it is a Git LFS
pointer / stub — pull the real weights first (`git lfs pull`, or copy the model
folder from a machine that has it). `prepare-models` fails fast if it is a stub.

## 2. Assemble offline assets

```bash
cd web_ui
npm run prepare-models
```

This copies into `public/models/`:

- `embeddings/bge-small-en-v1.5/` — config, tokenizer, and `onnx/model.onnx`
- `ort/ort-wasm-simd-threaded.jsep.wasm` + `ort-wasm-simd-threaded.jsep.mjs` —
  the exact ORT JSEP build + ESM loader Transformers.js v3 fetches, so it never
  reaches for jsdelivr
- `reranker/ms-marco-MiniLM-L-6-v2/` — **optional** cross-encoder. If the source
  model isn't present at the repo root the step is skipped (a warning, not an
  error) and the app simply runs without reranking. To include it, place the
  model at `models/ms-marco-MiniLM-L-6-v2/` (ONNX + tokenizer) before running.

## 3. Build the offline archive

```bash
cd web_ui
npm run build:offline      # = prepare-models && tsc/vite build && validate-build
```

`build:offline` runs three steps:
1. `prepare-models` — stage all model assets into `public/models/`. This script
   **fails loudly (non-zero exit)** if a required weight file is a Git-LFS
   pointer stub (detected via the `version https://git-lfs.github.com/spec/v1`
   header) rather than the real binary — so a build that forgot `git lfs pull`
   cannot silently copy garbage into the archive. Run `git lfs pull` first to
   restore the embedding ONNX.
2. `vite build` — emit `web_ui/dist/`. The bundle uses a **relative base**
   (`base: './'`) for its own asset URLs, and model paths are resolved to an
   **absolute, deploy-aware** prefix (derived from `import.meta.env.BASE_URL`
   against `document.baseURI` in `model-manifest.ts`) so model fetches work
   whether the archive is served at the origin root OR a subpath
   (e.g. `https://host/training/`). Production builds drop sourcemaps
   (`sourcemap: command === 'serve'`); pass a dev override if you need them.
3. `validate-build` (`scripts/validate-build.mjs`) — **fails the build** if
   `dist/index.html`/`dist/models/` are missing or if any file required by
   `public/models/manifest.json` is absent from `dist/models/`. The manifest is
   the **single source of truth** shared with `src/lib/models/model-manifest.ts`
   (imported at runtime), so the TS readiness gate and the build validator
   cannot drift. Pass `--no-llm` to skip the browser-LLM runtime + LFM2-VL
   weights group (for an embeddings-only / server-mode archive where the
   multi-GB LLM weights are deliberately absent). (It does not grep bundled JS
   for CDN hostnames — vendored ML libs embed default-CDN constants that survive
   minification but are never called at runtime; the offline guarantee is
   enforced by `offline-env.ts` and verified by the no-network preview test in §4.)

Output is `web_ui/dist/`, a static directory containing the app **and** its
models. Serve it from any static host that sets cross-origin isolation headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`vite preview` sets these for local validation, and the bundled FastAPI server
sets them for every response (see §6). Model assets are loaded from a
same-origin path under the deploy root (`/models/...` at the origin root,
`/training/models/...` under a subpath), so the archive works served from any
path; `file://` cannot provide the cross-origin isolation that threaded WASM
requires.

> **Host requirement:** threaded WASM inference needs `SharedArrayBuffer`, which
> requires the **cross-origin isolation** headers above. A static host that does
> not send them will fall back to single-threaded WASM (slower) or fail to load
> the threaded ORT build. When the desktop app's FastAPI server hosts the archive
> (Phase 6) it must send these headers; document the same for any third-party host.

## 4. Validate (no network)

1. Disconnect from the network (or block egress).
2. `npm run preview` and open the app.
3. Settings → model readiness should report **all packaged models ready**.
4. Confirm in DevTools → Network that **no** request goes to `huggingface.co`,
   `jsdelivr`, `mlc.ai`, or any third-party host.

The runtime gate behind this is `src/lib/models/model-manifest.ts`
(`checkPackagedModels()`), which probes each required file via the hardened
`src/lib/models/probe.ts` helper and drives the "ready vs missing — see
PACKAGING.md" UI state. The probe treats a HEAD response as "present" only when
it is OK **and not** `Content-Type: text/html` — because Vite dev/preview (and
SPA static hosts) serve `index.html` with HTTP 200 for any unmatched path, which
would otherwise make a build with zero model files falsely report "ready".

---

## 5. Browser LLM — wllama + LFM2-VL (multimodal)

Browser inference uses **wllama** (llama.cpp in WASM, CPU/SIMD, **no WebGPU**)
running **LiquidAI LFM2.5-VL-450M GGUF + mmproj**. Two pieces are packaged:

1. **wllama runtime** — `npm run prepare-models` copies, from node_modules:
   - `@wllama/wllama` → `public/models/wllama/wasm/wllama.wasm` (the modern build)
   - `@wllama/wllama-compat` → `public/models/wllama/compat/{wllama.wasm,wllama.js}`
     — the **offline compat fallback** used when the browser lacks JSPI/Memory64
     (common on target hardware). Without it locally, wllama would fetch its
     runtime from jsdelivr and break offline. No action needed beyond `npm install`
     (both packages are dependencies).
2. **Model weights** — the GGUF + projector, placed at the repo root so
   `prepare-models` stages them (this step is **optional**; absence only disables
   browser generation, server mode is unaffected):

```bash
# (a) obtain LFM2.5-VL GGUF + mmproj from LiquidAI/LFM2.5-VL-450M-GGUF on HuggingFace:
#       LFM2.5-VL-450M-Q4_K_M.gguf     (~229 MB) → rename to model.gguf
#       mmproj-LFM2.5-VL-450m-Q8_0.gguf (~99 MB)  → rename to mmproj.gguf
#     then place them at the repo root as:
#       models/lfm2.5-vl-450m/model.gguf
#       models/lfm2.5-vl-450m/mmproj.gguf
# (b) npm run prepare-models   # copies them to public/models/llm/lfm2.5-vl-450m/
```

LFM2.5-VL-450M Q4_K_M is ~229 MB, well under wllama's 2 GB/file `ArrayBuffer`
limit, so a single `model.gguf` works.

The desktop app already runs the same GGUF family via `llama-cpp-python`, so
server mode gains VLM support from the same weights.

The user picks the engine in Settings (**wllama** default, or **WebLLM** when
WebGPU is usable); the choice persists and the RAG pipeline routes accordingly.

---

## 6. Desktop bundle integration

The desktop app can serve the self-contained archive locally:

1. Build the archive first: `cd web_ui && npm run build:offline`.
2. `build.py` and `DocumentQAApp.spec` bundle `web_ui/dist/` into the PyInstaller
   output as `web_ui_dist` (only if it exists).
3. At runtime, `api_server.py` locates the archive via
   `_resolve_web_archive_dir()` (env `WEB_UI_DIST` → `sys._MEIPASS/web_ui_dist`
   → repo `web_ui/dist`) and mounts it at `/` **after** the API routes, so
   `/ask`, `/auth`, etc. still take precedence.
4. A COOP/COEP middleware sets `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` on every response, enabling
   wllama's threaded WASM (`SharedArrayBuffer`).

To run the server serving the archive: `python api_server.py` (or
`WEB_UI_DIST=/path/to/dist python api_server.py`), then open the server root.

## 7. Server-side VLM (multimodal) — deferred extension

The **browser** engine (wllama + LFM2-VL mmproj, Phase 4) already provides
verified offline multimodal (image) Q&A. A **server-side** VLM path
(image → `llama-cpp-python` with the mmproj) is intentionally **not yet wired**:
it requires constructing a model-specific multimodal chat handler with
`llama-cpp-python >= 0.3.0` and must be validated against the actual LFM2-VL
GGUF on real hardware. To add it: build `GGUFBackend` with a clip/mmproj chat
handler, accept an optional `image_base64` on the `/ask` request, and route
multimodal turns through `create_chat_completion` with `image_url` content.
Until that is verified end-to-end, server mode answers text-only and multimodal
runs in the browser.

## 8. Server authentication (opt-in)

The API server (`api_server.py`) authentication is **off by default** — the
`ENABLE_AUTH` environment variable defaults to `false`, in which case
`require_auth()` allows all requests. The web UI runs unauthenticated in this
default configuration: the chat streaming path passes an `Authorization: Bearer
<token>` header **only** when a token is present in `sessionStorage` under the
key `doc_qa_access_token`, and no token is stored unless a login flow sets one.

To enable authentication:
1. On the server: set `ENABLE_AUTH=true` and `API_KEY=<your-key>` (also consider
   `JWT_SECRET` and `JWT_EXPIRATION_HOURS` — see `auth.py`).
2. On the client: a token must be stored in `sessionStorage['doc_qa_access_token']`.
   A first-party login UI (calling `login(apiKey)` in `web_ui/src/lib/api/auth.ts`)
   is intentionally deferred; until it ships, an operator scripting a pre-authed
   client can set that `sessionStorage` key directly.

The `ApiClient` (non-streaming requests) and the SSE streaming path both honor
the stored token, so server mode works uniformly in either auth configuration.
