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
> Gemma 4 E2B-it GGUF (browser LLM, wllama) lands in Phase 2 and is documented below as
> the target procedure.

---

## 1. Prerequisites

```bash
cd web_ui
npm install            # provides ONNX Runtime WASM under node_modules
```

You also need the real embedding weights at the repo root. Issue #37 R9
swapped the embedder to snowflake-arctic-embed-m-v1.5 (768-dim, q8 ONNX).
Stage the q8 ONNX via optimum:

```bash
pip install optimum[onnxruntime]
optimum-cli export onnx --model Snowflake/snowflake-arctic-embed-m-v1.5 \
  --quantize q8 models/snowflake-arctic-embed-m-v1.5/onnx/
# → writes models/snowflake-arctic-embed-m-v1.5/onnx/model_quantized.onnx (~110 MB)
```

Copy the tokenizer/config alongside it (`tokenizer.json`, `config.json`,
`tokenizer_config.json` from the HF repo). `prepare-models` fails fast if the
q8 ONNX is missing or is an LFS stub. For CI / embeddings-only / server-mode
builds that deliberately omit the embedder, pass `--no-embedder`.

## 2. Assemble offline assets

```bash
cd web_ui
npm run prepare-models
```

This copies into `public/models/`:

- `embeddings/snowflake-arctic-embed-m-v1.5/` — config, tokenizer, and
  `onnx/model_quantized.onnx` (q8, ~110MB). 768-dim (Issue #37 R9 swapped from
  bge-small 384-dim).
- `ort/ort-wasm-simd-threaded.jsep.wasm` + `ort-wasm-simd-threaded.jsep.mjs` —
  the exact ORT JSEP build + ESM loader Transformers.js v3 fetches, so it never
  reaches for jsdelivr
- `reranker/ettin-reranker-32m-v1/` — **required** cross-encoder reranker
  (Issue #37 R9 swapped from ms-marco-MiniLM-L-6-v2 to ettin-reranker-32m-v1,
  a ModernBERT model: +7 nDCG@10 on MTEB-eng-v2). `prepare-models` **fails**
  if the source weights are absent. The reranker loads with `dtype:'q8'`, which
  in transformers.js v3.x resolves to the filename `onnx/model_quantized.onnx`
  (the `DATA_TYPES.q8 → '_quantized'` suffix) — you MUST stage the q8-quantized
  ONNX under that exact name, NOT `model.onnx`.
  Produce it via the optimum CLI:

  ```bash
  pip install optimum[onnxruntime]
  optimum-cli export onnx --model cross-encoder/ettin-reranker-32m-v1 \
    --quantize q8 models/ettin-reranker-32m-v1/onnx/
  # → writes models/ettin-reranker-32m-v1/onnx/model_quantized.onnx (~33-36 MB)
  ```

  Copy the tokenizer/config alongside it, then place the directory at
  `models/ettin-reranker-32m-v1/` before running `prepare-models`.

  For CI / embeddings-only / server-mode builds that deliberately omit the
  reranker, pass `--no-reranker` (mirrors `--no-llm`); the orchestrator then
  degrades to fused results at runtime.

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
   cannot drift. Pass `--no-llm` to skip the browser-LLM runtime + Gemma 4 E2B-it
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

## 5. Browser LLM — wllama + Gemma 4 E2B-it (multimodal)

Browser inference uses **wllama** (llama.cpp in WASM, CPU/SIMD, **no WebGPU**)
running **Google Gemma 4 E2B-it GGUF + mmproj**. Two pieces are packaged:

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
# (a) obtain Gemma 4 E2B-it QAT weights + mmproj from unsloth/gemma-4-E2B-it-qat-GGUF on HuggingFace:
#       gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf  (~2.44 GB) → rename to model.gguf
#       mmproj-F16.gguf                       (~940 MB) → rename to mmproj.gguf
#     then place them at the repo root as:
#       models/gemma-4-e2b-it/model.gguf
#       models/gemma-4-e2b-it/mmproj.gguf
# (b) npm run prepare-models   # copies them to public/models/llm/gemma-4-e2b-it/
```

Gemma 4 E2B-it QAT UD-Q4_K_XL is ~2.44 GB (down from ~2.9 GB for the prior
post-training Q4_K_M — quantization-aware training preserves more accuracy per
bit, so the smaller file is the recommended baseline). This exceeds the
historical ~2 GB/file WASM `ArrayBuffer` ceiling, but wllama v3+ streams via
HTTP range requests (not a single ArrayBuffer), so the practical limit is
browser RAM, not the 2 GB ceiling. Validate on target hardware before packaging.
~2.3B effective parameters (~5.1B total with Per-Layer Embeddings), 128K context
window (capped at 8192 by default for RAM headroom on 8 GB target boxes).

The QAT repo also ships an `mtp-gemma-4-E2B-it.gguf` Multi-Token Prediction
drafter (~56 MB). **Do not stage it** — wllama 3.5.1 does not expose the
`--spec-type draft-mtp` path (only the classic `--model-draft` path, which
fails on Gemma 4 E2B/E4B per llama.cpp#22337). MTP is server-mode-only until
wllama adds the API surface. See the QAT investigation notes in the PR that
introduced this swap.

**Chat-template override (important):** The `gemma-4-e2b-it` GGUF embeds an
~18 KB Jinja chat template that uses macros (`format_parameters`,
`format_argument`, etc.) wllama 3.5.1's Jinja subset cannot evaluate — the
macros render to empty strings, producing a blank prompt and **empty assistant
responses** (model emits `<eos>` immediately). The embedded template is
byte-identical between the QAT and post-training repos (MD5
`d451e60cbddd44f7a929b8eee8b209c6`), so the override applies to both. The app
works around this by injecting a macro-free Gemma 4 template override at load
time via `LoadModelParams.chat_template` + `jinja: true` (see
`web_ui/src/lib/llm/wllama-service.ts` → `GEMMA4_CHAT_TEMPLATE`). This makes
the app robust to any Gemma 4 GGUF regardless of its embedded template, so
operators staging a different quant (e.g. UD-Q2_K_XL, or a non-QAT Q5_K_M /
Q8_0 from `unsloth/gemma-4-E2B-it-GGUF`) do not need to verify the template
field themselves. The override can be removed once wllama ships a Jinja runtime
with macro support.

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

The **browser** engine (wllama + Gemma 4 E2B-it mmproj) already provides
verified offline multimodal (image) Q&A. A **server-side** VLM path
(image → `llama-cpp-python` with the mmproj) is intentionally **not yet wired**:
it requires constructing a model-specific multimodal chat handler with
`llama-cpp-python >= 0.3.0` and must be validated against the actual Gemma 4 E2B-it
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
