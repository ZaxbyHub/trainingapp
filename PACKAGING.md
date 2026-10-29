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

Bundled weights are distributed under their own licenses — the per-model review
(license type, required notices, restrictions) lives in
[docs/licenses.md](docs/licenses.md); keep it current when the packaged model set
changes.

> Status: **Phase 1** covered the embedding model + ONNX Runtime WASM. The browser
> LLM weights (originally a multimodal Gemma GGUF at Phase 2; swapped 2026-10-11 by
> #156 to the text-only LFM `lfm2-1.2b-rag`) are documented in §5 as the target
> procedure.

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
q8 ONNX is missing or is an LFS stub. For CI / embeddings-only builds
that deliberately omit the embedder, pass `--no-embedder`.

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

  For CI / embeddings-only builds that deliberately omit the
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
   (e.g. `https://host/docqa/`). Course playback is the exception: it needs the
   origin root (see the course player hosting note in §3). Production builds drop sourcemaps
   (`sourcemap: command === 'serve'`); pass a dev override if you need them.
3. `validate-build` (`scripts/validate-build.mjs`) — **fails the build** if
   `dist/index.html`/`dist/models/` are missing or if any file required by
   `public/models/manifest.json` is absent from `dist/models/`. The manifest is
   the **single source of truth** shared with `src/lib/models/model-manifest.ts`
   (imported at runtime), so the TS readiness gate and the build validator
   cannot drift. Pass `--no-llm` to skip the browser-LLM runtime + `lfm2-1.2b-rag`
   weights group (for an embeddings-only archive — e.g. CI — where the LLM weight is
   deliberately absent). (It does not grep bundled JS
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
`/docqa/models/...` under a subpath), so the app works served from any path;
`file://` cannot provide the cross-origin isolation that threaded WASM
requires. Course playback needs the archive at the **origin root**:
`/training-boot.html` is origin-absolute on the player origin, and every
`/training/*` path is reserved for the course worker (a host answers it 404).
A `/training/` subpath deploy therefore cannot work at all. An app served under
another subpath installs packs, but it plays courses only when
`player-origin.json` names a player host that serves the player files at its
root.

> **Host requirement:** threaded WASM inference needs `SharedArrayBuffer`, which
> requires the **cross-origin isolation** headers above. A static host that does
> not send them will fall back to single-threaded WASM (slower) or fail to load
> the threaded ORT build. When the desktop app's FastAPI server hosts the archive
> (Phase 6) it must send these headers; document the same for any third-party host.

> **Course player hosting (Knowledge Packs):** courses play on a separate player
> origin (ADR-0012, CONFIGURATION.md "Browser app: Knowledge Packs and course
> player"). A host that should play courses must also:
>
> - serve `/training-boot.html` and `/training-boot.js` with
>   `Cross-Origin-Resource-Policy: cross-origin` and `nosniff`, and serve
>   `/training/sw.js`;
> - answer every other `/training/*` path with 404 (no SPA fallback);
> - serve `/training-boot.html` with the restrictive header CSP
>   `default-src 'none'; script-src <player origin>/training-boot.js; worker-src
>   <player origin>/training/sw.js; connect-src 'none'; base-uri 'none';
>   form-action 'none'; object-src 'none'; frame-ancestors <app origin>` and no
>   `X-Frame-Options`;
> - send `Content-Security-Policy: frame-ancestors 'none'` and
>   `X-Frame-Options: DENY` on **every other** response, errors included, so
>   course content can never frame a same-origin page that runs under a
>   weaker policy than its own (final-critic FC6);
> - send no `frame-src` / `child-src` / restrictive `default-src` on the app
>   pages: the app installs its own runtime `frame-src <player origin>`
>   (ADR-0012 threat model item 6), and a host policy would intersect with it;
> - answer the player origin from a **static-only** host: course JS can
>   navigate its own frame or the app's boot frame to any same-origin path (a
>   GET request the course worker never sees), so no API routes, proxies or
>   authenticated endpoints there.
>
> `serve-offline.mjs` and `start.ps1` meet these. The FastAPI server does not
> host the player (see §6).

## 4. Validate (no network)

1. Disconnect from the network (or block egress).
2. `npm run preview` and open the app.
3. Settings → model readiness should report **all packaged models ready**.
4. Confirm in DevTools → Network that **no** request goes to `huggingface.co`,
   `jsdelivr`, `mlc.ai`, or any third-party host.

The runtime gate behind this is `src/lib/models/model-manifest.ts`
(`checkPackagedModels()`), which probes each required file via the hardened
`src/lib/models/probe.ts` helper and drives the "ready vs missing" UI state. The probe treats a HEAD response as "present" only when
it is OK **and not** `Content-Type: text/html` — because Vite dev/preview (and
SPA static hosts) serve `index.html` with HTTP 200 for any unmatched path, which
would otherwise make a build with zero model files falsely report "ready".

---

## 5. Browser LLM — wllama + lfm2-1.2b-rag (text-only)

Browser inference uses **wllama** (llama.cpp in WASM, CPU/SIMD, **no WebGPU**)
running the **LFM2-1.2B-RAG (`lfm2-1.2b-rag`) Q4_K_M GGUF** — text-only. The
multimodal projector artifact is gone from every shipped surface with the #156 LFM
swap (the historical image-input browser path was removed with it — see §7). Two
pieces are packaged:

1. **wllama runtime** — `npm run prepare-models` copies, from node_modules:
   - `@wllama/wllama` → `public/models/wllama/wasm/wllama.wasm` (the modern build)
   - `@wllama/wllama-compat` → `public/models/wllama/compat/{wllama.wasm,wllama.js}`
     — the **offline compat fallback** used when the browser lacks JSPI/Memory64
     (common on target hardware). Without it locally, wllama would fetch its
     runtime from jsdelivr and break offline. No action needed beyond `npm install`
     (both packages are dependencies).
2. **Model weights** — the single text-only GGUF, placed at the repo root so
   `prepare-models` stages it (this step is **optional**; absence only disables
   browser generation; the desktop app's backend and direct API clients of the Python
   server are unaffected):

```bash
# (a) obtain the LFM2-1.2B-RAG GGUF from LiquidAI/LFM2-1.2B-RAG-GGUF on HuggingFace:
#       LFM2-1.2B-RAG-Q4_K_M.gguf  (730,894,048 bytes, ~0.73 GB) → rename to model.gguf
#     then place it at the repo root as:
#       models/lfm2-1.2b-rag/model.gguf
# (b) npm run prepare-models   # copies it to public/models/llm/lfm2-1.2b-rag/
```

LFM2-1.2B-RAG Q4_K_M is ~0.73 GB (730,894,048 bytes). This is comfortably under the
historical ~2 GB/file WASM `ArrayBuffer` ceiling that once constrained browser
weights, and wllama v3+ streams via HTTP range requests regardless, so the practical
limit is browser RAM. Validate on target hardware before packaging.

**Chat-template note:** the retired model's macro-heavy embedded template needed a
chat-template override at load time (`LoadModelParams.chat_template` +
`jinja: true`, see `web_ui/src/lib/llm/wllama-service.ts`); that override went away
with the #156 swap, and the LFM GGUF's embedded template is served as-is. The robust
property is unchanged, so operators staging a different quant (e.g. Q5_K_M, Q8_0) from
`LiquidAI/LFM2-1.2B-RAG-GGUF` only need to verify once on target hardware that the
template renders a non-empty prompt.

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
4. A middleware sets `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` on every response, enabling
   wllama's threaded WASM (`SharedArrayBuffer`), plus
   `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
   (the app is never frameable). It is not a course-player host: it answers
   `/training-boot.html`, `/training-boot.js`, `/training/sw.js` and every
   `/training/*` path with 404, because course JS on a player origin can send
   GET requests to any path of the server answering it (by navigation) and
   this server carries the unauthenticated API. The browser app served from here installs packs but
   reports course playback as unavailable on this host, unless
   `player-origin.json` names a separate static player host that sends the §3
   headers for this app origin. The bundled `serve-offline.mjs` / `start.ps1`
   cannot be that host: they only admit their own loopback alias as the app
   origin.

To run the server serving the archive: `python api_server.py` (or
`WEB_UI_DIST=/path/to/dist python api_server.py`), then open the server root.

## 7. Server-side VLM (multimodal) — retired with #156

The browser multimodal path (image input in chat via a vision projector alongside
the browser LLM) was removed by the #156 LFM swap: node-llama-cpp has no image
support, the browser LLM (`lfm2-1.2b-rag`) is text-only, and no projector artifact
ships on any surface. The previously deferred server-side VLM extension (image →
`llama-cpp-python` with a projector chat handler) is retired with it — a future
multimodal feature would be a new model-selection decision under ADR-0002's method
plus a fresh packaging review. Until then every surface answers text-only questions
(the Python `/ask` API answers text-only for its direct API clients; the browser app
has no server mode).

## 8. Server authentication (opt-in)

The API server (`api_server.py`) authentication is **off by default** — the
`ENABLE_AUTH` environment variable defaults to `false`, in which case
`require_auth()` allows all requests. Direct API clients run unauthenticated in this
default configuration. The web UI's `ApiClient` attaches an `Authorization: Bearer
<token>` header **only** when a token is present in `sessionStorage` under the
key `doc_qa_access_token`, and no token is stored unless a login flow sets one.

To enable authentication:
1. On the server: set `ENABLE_AUTH=true` and `API_KEY=<your-key>` (also consider
   `JWT_SECRET` and `JWT_EXPIRATION_HOURS` — see `auth.py`).
2. On the client: a token must be stored in `sessionStorage['doc_qa_access_token']`.
   A first-party login UI (calling `login(apiKey)` in `web_ui/src/lib/api/auth.ts`)
   is intentionally deferred; until it ships, an operator scripting a pre-authed
   client can set that `sessionStorage` key directly.

The stored-token path applies to direct API clients of the Python server (the
`ApiClient` honors the stored token). The browser app no longer has a server mode
(settings-wiring-honesty): its chat never streams from `api_server.py`, and the
desktop app authenticates to its own backend with the per-launch `X-Desktop-Token`.
