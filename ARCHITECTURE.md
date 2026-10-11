# Architecture

**This document describes the shipped v3 system.** Last Updated: 2026-09-29.

Scope: how the Windows desktop application (Electron shell + Node backend),
the plain-browser web surface, the frozen API/store/pack contracts, and the
packtool build tooling fit together. Every claim below is verifiable against
the file cited next to it. Companion guides: [docs/electron-mode.md](docs/electron-mode.md)
(renderer/backend mode selection), [docs/training-player.md](docs/training-player.md)
(embedded Storyline player), [docs/updates.md](docs/updates.md) (update runbook),
[desktop/README.md](desktop/README.md) (shell layout and scripts),
[docs/pack-authoring-guide.md](docs/pack-authoring-guide.md) (authoring knowledge packs
with packtool), and [docs/training-pack-refresh-runbook.md](docs/training-pack-refresh-runbook.md)
(refreshing an installed training pack).

## System overview

```text
+--------------------------- Windows desktop app (desktop/) ---------------------------+
|                                                                                       |
|  Electron renderer (web_ui build)          Electron main process                     |
|  +--------------------------------+        +--------------------------------------+  |
|  | app://index.html                |  IPC   | desktop/main/index.ts                 |  |
|  | React pages (web_ui/src/pages)  |<------>|  single-instance lock, navigation     |  |
|  | desktopApi bridge (preload)     |        |  lockdown, integrity gate, first-run  |  |
|  +--------+-----------------------+        |  wizard, signed update checker        |  |
|           |                                 +------------------+-------------------+  |
|           | HTTP 127.0.0.1:<random port>                       | owns                 |
|           | X-Desktop-Token (per-launch, 256-bit)              v                     |
|           v                                                                             |
|  +----------------------------------------------------------------------------------+ |
|  | Node backend host (desktop/main/backend/index.ts)                                  | |
|  | 18 contract routes (desktop/main/backend/server.ts) behind the B2 loopback guard   | |
|  | LlamaEngine - ingest pipeline - hybrid retrieval - pack manager - learn assembler  | |
|  | memory governor (scheduler + pressure monitor + idle unload)                       | |
|  +------------------------------------+---------------------------------------------+ |
|                                       v                                               |
|        <userData>/profiles/default/store.sqlite                                       |
|        better-sqlite3 + sqlite-vec vec0 KNN + FTS5 (contracts/store.schema.sql)       |
+---------------------------------------------------------------------------------------+

  Plain browser (web_ui/, no Electron): wllama WASM LLM + ONNX embeddings +
  IndexedDB/EdgeVec/FlexSearch in-page; knowledge packs in OPFS, courses on an
  isolated player origin (ADR-0012).
```

One web_ui build runs Electron-hosted (this document's main subject) or as a
pure-browser local app (the former browser "remote Python server" mode was
removed by settings-wiring-honesty); mode selection,
boot discovery, and their deliberate limitations are documented in
[docs/electron-mode.md](docs/electron-mode.md).

## Process & transport architecture

**Main-process bootstrap** — [desktop/main/index.ts](desktop/main/index.ts)
claims the single-instance lock (a second launch focuses the existing
window), creates the one window with `contextIsolation`/`sandbox` on and
`nodeIntegration`/`webviewTag` off, denies all renderer-initiated
`window.open`, and restricts `will-navigate` to `app://` targets plus the
dev-server origin. `will-quit` holds the quit until the backend host's
`stop()` completes. IPC surfaces: `desktop:get-token`,
`desktop:get-backend`, `desktop:store-backup`, `desktop:updates:*` (status /
opt-in / check-now / apply / allowlisted external open), and
`desktop:first-run:*`; pushes are `ingest:progress`, `memory:event`,
`updates:available`, and `first-run:required`.

**Preload bridge** — [desktop/preload/index.ts](desktop/preload/index.ts)
exposes exactly two contextBridge namespaces: `trainingapp` (compatibility
shell object) and `desktopApi`, the only channel the per-launch token and
backend address take to the renderer (never web storage, never a URL).

**app:// protocol** — [desktop/main/protocol.ts](desktop/main/protocol.ts)
registers the `app` scheme (`standard`/`secure`/`supportFetchAPI`/`stream`
privileges) and serves the packaged renderer from `<resourcesPath>/web_ui`
with MIME mapping, segment validation, containment, and a realpath re-check
(a symlink inside root cannot serve content outside it). Every response
carries the B2 header posture: strict CSP
([desktop/main/security/csp.ts](desktop/main/security/csp.ts)), `COOP:
same-origin`, `COEP: require-corp`, `CORP`. The reserved
`app://training/<packId>/<rest>` namespace maps onto
`<packsRoot>/<packId>/assets/player/<rest>` (the packtool build-storyline
layout, with a versioned-layout fallback for manager-installed copies), uses
the training CSP profile, sets `CORP: cross-origin` plus
`access-control-allow-origin: *` so the player frame is embeddable, and
answers HTTP Range requests (206/416) for pack media.

**Loopback guard (B2)** — [desktop/main/security/loopback-guard.ts](desktop/main/security/loopback-guard.ts)
is a pure request gate mounted in front of every route (including `/health`
and CORS preflights): R2 origin (allowlist `app://*`; present-but-empty
origin fails closed), R3 literal loopback host only (`127.0.0.1`/`::1`; the
name `localhost` is refused — DNS-rebinding hardening), R1 token equality
(CORS preflights exempt; every real request requires it), R4 pass, R5 the
guard never touches the network. The token ([desktop/main/security/token.ts](desktop/main/security/token.ts))
is 256 bits of CSPRNG per launch, held in main-process memory only. Header
name and dev-origin additions resolve from [desktop/main/security/config.ts](desktop/main/security/config.ts):
`X-Desktop-Token` by default, `TRAININGAPP_DESKTOP_DEV_ORIGINS` honored only
in unpackaged builds.

**Backend listener** — [desktop/main/backend/server.ts](desktop/main/backend/server.ts)
binds `127.0.0.1` on an OS-assigned random port and routes the frozen
contract table `CONTRACT_ROUTES` — 18 paths: `/health`, `/auth/status`,
`/auth/token`, `/ask`, `/ask/stream` (SSE, frame `data: {json}\r\n\r\n`,
exactly one terminal `done` or `error` event; client disconnect produces the
cancelled `done`), `/ingest`, `/ingest/file`, `/ingest/batch`, `/documents`,
`/search`, `/settings`, `/stats`, `/telemetry/memory`, `/status/models`,
`/packs`, `/packs/install`, `/packs/rollback`, `/packs/remove`. Body caps:
1 MiB JSON, 60 MiB multipart with the pack-zip upload capped at the contract
50 MiB. Unknown paths 404; known paths with a wrong method 405; a missing
model answers the contract 503, never a crash. The table mirrors
[contracts/api.openapi.yaml](contracts/api.openapi.yaml) (OpenAPI 3.1,
version 2.6.0), authoritative for both backends; conformance is verified by
[contracts/tests/run_conformance.py](contracts/tests/run_conformance.py).

**Host selection** — [desktop/main/backend/index.ts](desktop/main/backend/index.ts)
`createBackendHost()` returns one of two `BackendHost` implementations,
selected by `backend.mode`: `NodeBackendHost` (the shipped default —
`DEFAULT_BACKEND_MODE` in [desktop/main/backend/types.ts](desktop/main/backend/types.ts),
ADR-0003) and `SidecarBackendHost`, a guarded listener fronting a spawned
backend child via
[desktop/main/backend/sidecar-manager.ts](desktop/main/backend/sidecar-manager.ts).
The sidecar path is dormant: implemented and unit-tested, not selected by
the shipped configuration. The same host runs headless under plain Node for
CI conformance via
[desktop/main/backend/dev-server.ts](desktop/main/backend/dev-server.ts)
(`--port-file`/`--mode`/`--token` CLI).

`NodeBackendHost.start()` composes the backend: the memory governor
(scheduler, telemetry, pressure monitor, idle-unload controller), the
per-profile settings sidecar ([desktop/main/backend/settings-store.ts](desktop/main/backend/settings-store.ts),
atomic `settings.json` beside the store), the store open/recovery path, the
embedder (worker-proxied when a reranker worker exists — one ONNX runtime
owner per process), the ingest document surface, the hybrid retrieval
surface, the learn assembler, and the pack manager. Attached surfaces
degrade independently: a missing model or a closed store logs a named reason
and the rest of the host keeps serving; the pack lifecycle exposes its
degradation reason to the first-run wizard.

## Data & store

[contracts/store.schema.sql](contracts/store.schema.sql) is the authoritative
schema (version 3): `docs` (content-sha256 identity), `chunks`
(content-derived chunk ids, `UNIQUE(doc_id, chunk_index)`), `embeddings`
(sqlite-vec `vec0` virtual table, `__EMBEDDING_DIMS__` substituted at apply
time), `chunks_fts` (FTS5 mirror of chunk text), `packs` (one row per
installed pack version, PK `(id, version)`, `active`/`install_path`
lifecycle), `links` (doc-chunk to training-slide links), and `meta`
(`schema_version`, `embedding_model_id`, `embedding_dims`). sqlite-vec is
pinned at 0.1.9 exactly on both the Node and Python sides (ADR-0005).

- **Open/apply** — [desktop/main/backend/store/sqlite-store.ts](desktop/main/backend/store/sqlite-store.ts):
  better-sqlite3 connection, sqlite-vec extension load (with an app.asar
  unpacked-twin path rewrite for packaged layouts), schema applied from the
  contracts file on disk (never copied), `meta.schema_version` verified.
- **Migrations** — [desktop/main/backend/store/migrate.ts](desktop/main/backend/store/migrate.ts):
  ladder v1 -> v2 (links finalization) -> v3 (per-version packs table);
  `CURRENT_SCHEMA_VERSION = 3`.
- **Profile layout** — [desktop/main/backend/store/profiles.ts](desktop/main/backend/store/profiles.ts)
  (ADR-0006): `<userData>/profiles/default/store.sqlite` by default; named
  profiles via `TRAININGAPP_PROFILE_MODE=named` +
  `TRAININGAPP_PROFILE_NAME`; legacy layouts migrate by atomic rename.
- **Backup/recovery** — [desktop/main/backend/store/backup.ts](desktop/main/backend/store/backup.ts)
  WAL-truncates then snapshots to `<backupsDir>/<UTC-timestamp>/`;
  [desktop/main/backend/store/recovery.ts](desktop/main/backend/store/recovery.ts)
  runs `PRAGMA integrity_check` at startup and drives restore-or-fresh
  (a modal choice in Electron, automatic in headless runs) before anything
  is served from a corrupt store.
- **Ingestion** — [desktop/main/backend/ingest/pipeline.ts](desktop/main/backend/ingest/pipeline.ts):
  extract -> chunk -> embed -> write, with content-derived identity
  (`doc id = sha256(bytes)`, `chunk id =
  sha256(docsha:index:normalized)`, byte-matched with the Python interop
  normalization), sha dedupe first, delete-before-reingest for revised
  files, one writer queue, links recomputed in the chunks' transaction.
  [desktop/main/backend/ingest/text-chunker.ts](desktop/main/backend/ingest/text-chunker.ts)
  ports the browser semantic chunker (256-word / 100-overlap defaults, CJK
  fallback) so both surfaces chunk identically.
  [desktop/main/backend/ingest/config.ts](desktop/main/backend/ingest/config.ts)
  defaults: `maxConcurrentFiles 2`, `chunkWordCount 256`,
  `chunkOverlapWords 100`; caps 60 MiB per file, 512 MiB decompressed zip,
  8 M extracted characters.
- **Embeddings** — [desktop/main/backend/ingest/embedder.ts](desktop/main/backend/ingest/embedder.ts):
  production embedder is the staged `bge-small-en-v1.5` ONNX weights (384
  dims, fp32, `cls` pooling, normalized), loaded lazily; `HashEmbedder` is
  the explicit dev/CI fixture (`TRAININGAPP_DESKTOP_EMBEDDER=hash`), never
  a production default.
- **Engine-facing surfaces** —
  [desktop/main/backend/store/document-surface.ts](desktop/main/backend/store/document-surface.ts)
  bridges the engine's document methods onto the store (including Clear
  Cache: close, delete, re-initialize at the same path).

## LLM inference & profiles

[desktop/main/backend/inference/llama-engine.ts](desktop/main/backend/inference/llama-engine.ts)
fills the engine slot with real llama.cpp inference through node-llama-cpp
(imported dynamically so constructing the engine never loads native code).
One model is resident per effective profile, loaded lazily and reused; a
profile switch disposes and reconstructs once, deferred past in-flight
generations; client disconnects bridge to the library abort signal via a
20 ms poll. A missing model throws `ModelNotConfiguredError`, which the
transport maps to the contract 503.

| Knob | Value | Source |
|---|---|---|
| Quality model | `gemma-4-e2b-it/model.gguf` (Q4_K_M per ADR-0002) | `QUALITY_MODEL_SUBPATH` |
| Fast model | `lfm2.5-vl-450m/model.gguf` (Q4_K_M per ADR-0002) | `FAST_MODEL_SUBPATH` |
| Context size | 8192 | `CONTEXT_SIZE` |
| Threads | `min(cores, 8)` | [desktop/main/backend/inference/profile-select.ts](desktop/main/backend/inference/profile-select.ts) |
| Profile gate | `auto` selects quality at >= 6 GiB free RAM | `DEFAULT_PROFILE_THRESHOLD_GB` |
| Generation (quality / fast) | 1024 tokens @ temp 0.2 / 384 @ 0.3 | `PROFILE_GENERATION` |
| Sampler | top-p 0.9, repeat penalty 1.1, lookback window 8192 (generated tokens only) | [desktop/main/backend/inference/penalties.ts](desktop/main/backend/inference/penalties.ts) (`PENALTY_FULL_CONTEXT_TOKENS`) |
| History | at most 12 turns carried into the prompt | `MAX_HISTORY_TURNS` |

The compute backend is decided by an out-of-process probe (issue #155): a working
Vulkan device is used when one is found and CPU inference is the fallback;
`inference.vulkan` can pin either choice. The memory governor can force the
runtime profile to `fast` (below); the wizard's RAM gate uses the same estimate
family (file size + 1 GiB KV-cache + 1 GiB overhead,
[desktop/main/first-run/ram-gate.ts](desktop/main/first-run/ram-gate.ts)).

## Retrieval pipeline

[desktop/main/backend/retrieval/hybrid.ts](desktop/main/backend/retrieval/hybrid.ts):
query embedding -> `vec0` KNN leg **union** FTS5 leg (user syntax sanitized
to quoted terms by `sanitizeFtsQuery`) -> Reciprocal Rank Fusion
(`score += 1/(rrfK + rank + 1)`, dedup by chunk id) -> C4 pack stage
(inactive-pack exclusion, cross-pack chunk dedup with
publishedAt/semver/id precedence, linear recency multiplier per
[desktop/main/backend/retrieval/recency.ts](desktop/main/backend/retrieval/recency.ts))
-> optional cross-encoder rerank in a dedicated worker thread
([desktop/main/backend/retrieval/reranker.ts](desktop/main/backend/retrieval/reranker.ts),
model `ettin-reranker-32m-v1`; reranker scores replace the fused ones and the
calibrated floor applies to reranker scores only — a no-reranker path is
floor-free and resolves `grounding: "general"`) -> topK slice. The surface's
`floorActive` flag is what the C5 `grounding` enum derives from.

Shipped defaults ([desktop/main/backend/retrieval/config.ts](desktop/main/backend/retrieval/config.ts);
every key has a `TRAININGAPP_RETRIEVAL_*` / `TRAININGAPP_PACKS_RECENCY_*` env
override, invalid values fall back to the default):

| Key | Default | Notes |
|---|---|---|
| `topK` | 10 | final slice; per-leg fetch is topK x multiplier |
| `candidateMultiplier` | 3 | over-retrieval and rerank window factor |
| `rerank` | true | worker cross-encoder on |
| `rrfK` | 60 | same constant as the browser and Python fusion |
| `relevanceFloor` | 0.569387 | calibrated per [docs/adr/0007-relevance-floor-calibration.md](docs/adr/0007-relevance-floor-calibration.md) |
| `packsRecencyFloor` | 0.85 | multiplier floor |
| `packsRecencyFloorMonths` | 18 | age (30.44-day months) reaching the floor |
| `packsRecencyHalfLifeMonths` | 9 | reserved exponential variant, not wired |

## Knowledge packs & packtool

A knowledge pack is a zip with a root manifest validated against
[contracts/pack.schema.json](contracts/pack.schema.json): id/version
(semver), `published_at`, `source_class` (bundled / training / user),
`supersedes` (`id@version` strings), embedding/chunking stamps, and a
`docs[]` list with per-file sha256.

- **Lifecycle** — [desktop/main/backend/store/pack-manager.ts](desktop/main/backend/store/pack-manager.ts):
  install / supersede / rollback / remove / list. Identity is
  content-derived (same scheme as ingest, cross-backend parity with the
  Python manager). Superseded versions stay installed-but-inactive so
  rollback reactivates them without re-obtaining the pack. Prebuilt-index
  packs (packtool output) install through a read-only `index.sqlite` path.
- **Install hardening (C8)** — [desktop/main/backend/packs/pack-extract.ts](desktop/main/backend/packs/pack-extract.ts)
  (re-exported at [desktop/main/backend/packs/zip-install.ts](desktop/main/backend/packs/zip-install.ts)):
  2 GiB total-uncompressed cap, 5000-entry cap, 100:1 declared
  compression-ratio cap, resolved-path containment per entry
  (drive-relative escapes refused), symlink entries refused, a ZIP32
  central-directory pre-filter that runs before decompression, a
  written-bytes backstop, the embedding-model pin (`bge-small-en-v1.5`),
  and the opt-in Ed25519 detached-signature gate.
- **Build tooling** — [packtool/cli.ts](packtool/cli.ts) verbs: `storyline
  extract`, `build-storyline`, `build-docs`, `verify`, `diff`, `links`.
  `storyline extract` ([packtool/storyline/extract.ts](packtool/storyline/extract.ts))
  turns an Articulate Storyline 360 HTML5 publish into per-slide documents
  plus an outline; [packtool/storyline/transcribe.py](packtool/storyline/transcribe.py)
  is the build-machine-only narration transcriber (faster-whisper
  `distil-large-v3` int8, content-hash keyed cache; nothing in web_ui/ or
  the Electron runtime imports it — see
  [docs/training-transcription.md](docs/training-transcription.md)). The
  composer lives under `packtool/build/`; link computation under
  `packtool/links/`.
- **In-app surface** — the Knowledge Packs panel
  ([web_ui/src/components/PacksPanel.tsx](web_ui/src/components/PacksPanel.tsx))
  mounts only in Electron mode on the Documents page and drives
  `POST /packs/install` (zip upload), rollback, and remove through the
  loopback API.

## Training / Learn surface

The TRAINING tab ([web_ui/src/pages/TrainingPage.tsx](web_ui/src/pages/TrainingPage.tsx))
plays installed `training` source-class packs in the embedded Storyline
player ([web_ui/src/components/TrainingPlayer.tsx](web_ui/src/components/TrainingPlayer.tsx)),
served from `app://training/<packId>/`. The player frame is a distinct
origin, so all communication goes through the postMessage protocol in
[web_ui/src/components/training-player-bridge.ts](web_ui/src/components/training-player-bridge.ts);
the player itself polls state at 1 s — `POLL_INTERVAL_MS` in
[web_ui/src/components/TrainingPlayer.tsx](web_ui/src/components/TrainingPlayer.tsx) —
and jumps are verified against the player's own reported slide). The pinned-slide banner
([web_ui/src/components/PinnedSlideContext.tsx](web_ui/src/components/PinnedSlideContext.tsx))
carries "currently viewing" context into chat and marks stale pins.

Ask-time learning: [desktop/main/backend/learn.ts](desktop/main/backend/learn.ts)
joins the retrieval-cited chunks against the `links` and `docs` tables to
build the `learn[]` payload (direct slide hits plus linked slides, deduped,
capped at 5, empty when `grounding` is `"general"`), rendered by
[web_ui/src/components/LearnPanel.tsx](web_ui/src/components/LearnPanel.tsx)
with deep-links back into the player.

## First-run & packaging

**Startup integrity gate (E1)** — [desktop/main/integrity-check.ts](desktop/main/integrity-check.ts)
verifies the staged `resources/manifest.json` before the backend host
starts. Decision table: packaged + failures (or packaged + no manifest) ->
block start with named path/expected/actual; packaged + clean -> pass and
arm the packaged-to-runtime bridge (verified model dirs override env seams);
dev + no manifest -> skip; dev + manifest -> verify and report, never fatal.

**First-run wizard (E2)** — a six-step modal stepper
([web_ui/src/components/FirstRunWizard.tsx](web_ui/src/components/FirstRunWizard.tsx)
over the state machine in [desktop/main/first-run/wizard.ts](desktop/main/first-run/wizard.ts)):
`detect-hardware` -> `select-profile` -> `verify-manifest` -> `activate-packs`
-> `licensing-notices` -> `complete`. Completion requires an explicit
profile choice, license acknowledgment, a passed (or explicitly absent)
manifest verification, and every manifest-required pack active. Manifest
loading and sha256 verification live in
[desktop/main/first-run/manifest-verifier.ts](desktop/main/first-run/manifest-verifier.ts);
persisted state (atomic `first-run.json` beside the store) in
[desktop/main/first-run/first-run-store.ts](desktop/main/first-run/first-run-store.ts);
bundled-pack satisfaction (installed + active at the manifest version or
newer) in [desktop/main/first-run/bundled-packs.ts](desktop/main/first-run/bundled-packs.ts),
also enforced at every boot.

**Packaging** — [desktop/electron-builder.yml](desktop/electron-builder.yml):
unsigned NSIS x64 installer; `extraResources` stage the renderer
(`<resources>/web_ui`), models, packs, `docs/licenses.md`, and
`manifest.json` at the resources root; native/wasm dependencies
(transformers, onnxruntime, pdfjs-dist, sqlite-vec, better-sqlite3) are
asar-unpacked. [desktop/scripts/stage-installer-resources.mjs](desktop/scripts/stage-installer-resources.mjs)
assembles the staged tree from explicit allow-lists (a missing required
file fails the build by name), supports `--fixture-models` for CI, and
enforces the double-ship guard (no model id may exist in both the renderer
dist and the staged weights). Measured installed footprint: ~6.4 GB
(6,378,451,601 bytes) against the 7 GiB budget — devstation row in
[bench/RESULTS.md](bench/RESULTS.md).

## Update channels (E5, ADR-0010)

[desktop/main/update-checker.ts](desktop/main/update-checker.ts) implements
opt-in signed updates, default OFF — until the user opts in, the app makes
zero update-related network calls. The feed document is validated against
[contracts/pack-feed.schema.json](contracts/pack-feed.schema.json) and every
version entry must carry an Ed25519 signature over the artifact's sha256,
verifiable with the build-time-baked public key; there is no unsigned
fallback. Pack updates download, re-verify, and install through the same
loopback `POST /packs/install` route as a drag-dropped zip, so all C8
guards and supersede/rollback semantics apply unchanged. App-binary updates
are detect-and-notify only: the notice opens the download through an
allowlisted external-open handler and the user runs the installer. Operator
runbook: [docs/updates.md](docs/updates.md).

## External model endpoints (ADR-0011)

Generation can be sent to a user-configured OpenAI- or Anthropic-compatible
endpoint (a local server, a LAN server, or a cloud provider) instead of the
local model. The feature is off by default and opt-in; it is the only
generation path that leaves the machine, and retrieval always stays local
(grounded by default; an ungrounded Direct chat is a separate opt-in toggle).
Rationale and rejected alternatives: [docs/adr/0011-external-model-endpoints.md](docs/adr/0011-external-model-endpoints.md).

- **Shared URL policy.** One policy, implemented twice and pinned by shared
  vectors: [web_ui/src/lib/llm/endpoint-policy.ts](web_ui/src/lib/llm/endpoint-policy.ts),
  [desktop/main/security/endpoint-policy.ts](desktop/main/security/endpoint-policy.ts),
  [contracts/endpoint-policy-vectors.json](contracts/endpoint-policy-vectors.json) and
  [contracts/endpoint-policy-vectors.supplemental.json](contracts/endpoint-policy-vectors.supplemental.json).
  Loopback and private-network hosts may use http or https, every other host
  requires https, and metadata, link-local and unspecified addresses are always
  refused. Airgap builds refuse public hosts.
- **Browser.** The generators
  [web_ui/src/lib/llm/openai-provider.ts](web_ui/src/lib/llm/openai-provider.ts) and
  [web_ui/src/lib/llm/anthropic-provider.ts](web_ui/src/lib/llm/anthropic-provider.ts),
  built by the factory in [web_ui/src/lib/llm/external-provider.ts](web_ui/src/lib/llm/external-provider.ts)
  (which also holds the stored configuration and the connection probe), plug into
  `RAGOrchestrator` as its LLM service in place of the in-browser model. The browser calls the
  endpoint directly with `fetch` (the endpoint must allow CORS from the app's
  origin), never follows redirects, and omits credentials.
- **Desktop.** The renderer never calls the endpoint and never holds the key.
  [desktop/main/backend/inference/external-generator.ts](desktop/main/backend/inference/external-generator.ts)
  fills the engine's generation slot; every request goes through
  [desktop/main/backend/net/guarded-request.ts](desktop/main/backend/net/guarded-request.ts)
  (`node:https` / `node:http`; resolves the host, validates every address,
  pins the connection to the validated address, follows no redirects). The key
  is held by [desktop/main/security/secret-store.ts](desktop/main/security/secret-store.ts)
  (Electron `safeStorage`, bound to the endpoint origin it was saved for).
  With the external model on, no local GGUF model is required and
  `GET /status/models` reports engine `external`.
- **Unchanged.** The Python `api_server.py` has no external backend, and the
  renderer's content-security policy is not widened.

## Browser surface & browser packs

In plain-browser mode the web_ui runs its own stack: the wllama (llama.cpp
WASM) LLM engine ([web_ui/src/lib/llm/wllama-service.ts](web_ui/src/lib/llm/wllama-service.ts),
context 8192, weights served same-origin under `/models/`), and the
`snowflake-arctic-embed-m-v1.5` embedder (768-dim,
[web_ui/src/lib/models/model-manifest.ts](web_ui/src/lib/models/model-manifest.ts))
over IndexedDB/EdgeVec/FlexSearch storage. Session/mode discovery and the
`window.desktopApi` typing live in
[web_ui/src/lib/desktop-session.tsx](web_ui/src/lib/desktop-session.tsx).

Knowledge packs and training courses work in the browser app with the same
Packs panel and Training page as desktop (ADR-0012, superseding the ADR-0009
capability gate). Both apps go through one client interface,
[web_ui/src/lib/packs/pack-client.ts](web_ui/src/lib/packs/pack-client.ts):
desktop calls the loopback pack API; the browser uses
[web_ui/src/lib/packs/browser-pack-manager.ts](web_ui/src/lib/packs/browser-pack-manager.ts),
which runs the archive guards, manifest gates and signature policy as twins of
the desktop code ([web_ui/src/lib/packs/pack-archive-rules.ts](web_ui/src/lib/packs/pack-archive-rules.ts)
is byte-identical to
[desktop/main/backend/packs/pack-archive-rules.ts](desktop/main/backend/packs/pack-archive-rules.ts);
shared vectors in [contracts/pack-signature-vectors.json](contracts/pack-signature-vectors.json)
and [contracts/training-path-vectors.json](contracts/training-path-vectors.json)),
stores pack files in the app origin's OPFS with an IndexedDB version registry,
and ingests slide documents into the browser keyword/vector indexes with
`packId` on every chunk. The prebuilt `index.sqlite` is not mounted in the
browser (no SQLite; different embedding space).

Course content is untrusted JavaScript, so it never runs on the app origin. It
runs on a dedicated player origin (by default the loopback alias:
`localhost` <-> `127.0.0.1`, one listener bound to 127.0.0.1), resolved by
[web_ui/src/lib/packs/player-origin.ts](web_ui/src/lib/packs/player-origin.ts).
A player-origin service worker
([web_ui/public/training/sw.js](web_ui/public/training/sw.js)) serves
`/training/<packId>/<rest>` from bytes the app page relays over an
app-created `MessageChannel`
([web_ui/src/lib/packs/training-relay.ts](web_ui/src/lib/packs/training-relay.ts)),
scoped to the open pack's active version with desktop path containment. The
pack update channel (ADR-0010) is available in the browser app through
[web_ui/src/lib/packs/pack-update-controller.ts](web_ui/src/lib/packs/pack-update-controller.ts)
(opt-in, the feed host must allow CORS, refused in air-gapped builds).

## Memory & concurrency budget (B8)

[desktop/main/backend/memory/budget.ts](desktop/main/backend/memory/budget.ts)
resolves the runtime budget (defaults: telemetry interval 5000 ms,
accounting ceiling 16 GiB, pressure threshold 6 GiB — imported from the
profile gate so the knobs cannot drift, pressure sustained 10 s, recovery
sustained 60 s, idle unload 300 s) and implements the pressure monitor as a
state machine. Sustained low free RAM latches a downgrade to `fast`; the
only upgrade path clears the override between generations after sustained
recovery. [desktop/main/backend/memory/scheduler.ts](desktop/main/backend/memory/scheduler.ts)
serializes generations behind a FIFO mutex (default
`maxConcurrentGenerations 1`; excess requests queue, never 503) and exposes
the ingestion-pause seam. [desktop/main/backend/memory/idle-unload.ts](desktop/main/backend/memory/idle-unload.ts)
owns the idle window: after 300 s idle the reranker worker's ONNX sessions
unload; the next score or embed transparently rebuilds them. Telemetry
(`GET /telemetry/memory`) attributes RSS per component (chromium / llm /
rerankerSession / embeddingSession / sqlite); downgrade/recovery events
reach the renderer as `memory:event` pushes. Decision record:
[docs/adr/0008-memory-budget.md](docs/adr/0008-memory-budget.md).

## CI & conformance

This repository carries nine GitHub workflows on disk:
`build.yml` and `release.yml` (Python artifacts), `nightly.yml`,
`security.yml` (bandit/safety scans), and the four below; the ninth,
`doc-accuracy.yml`, is part of this documentation refresh: a deliberately
unscoped, always-run guardrail that checks documented paths and claims
against the tree (path filters would let a docs-drifting PR skip its own
check).

- [`.github/workflows/test.yml`](.github/workflows/test.yml) and
  [`.github/workflows/conformance.yml`](.github/workflows/conformance.yml) —
  the issue #87 (E4) pattern: triggers stay unfiltered (a workflow-level
  `paths:` filter leaves required checks Pending forever on filtered PRs);
  scoping lives in a `changes` job classifying the diff into buckets via
  [scripts/ci_paths.py](scripts/ci_paths.py), fail-open so a broken
  classifier can only run more CI, never silently less. The conformance
  jobs run [contracts/tests/run_conformance.py](contracts/tests/run_conformance.py)
  against the reference app and the Node backend.
- [`.github/workflows/desktop-build.yml`](.github/workflows/desktop-build.yml) —
  builds the Electron shell (NSIS x64); its path-scoped trigger covers the
  desktop, web_ui, contracts, and packtool trees plus the workflow file
  itself.
- [`.github/workflows/web-ui.yml`](.github/workflows/web-ui.yml) — web_ui
  typecheck, build, test, and packaging validation.

Quality measurement is backend-agnostic: the tier-0 eval harness
([eval/README.md](eval/README.md), `eval/runner.py`) scores recall@k, MRR,
abstain accuracy, and latency against any implementation of the frozen
contract; measured performance numbers are recorded machine-tagged in
[bench/RESULTS.md](bench/RESULTS.md).

## ADR index

| ADR | Decision (one line) |
|---|---|
| [0001](docs/adr/0001-embedding-reranker.md) | Embedding/reranker model targets for all surfaces (Qwen3-Embedding-0.6B 1024-dim + ettin-reranker-32m-v1); per-surface re-pin follow-ups open. |
| [0002](docs/adr/0002-llm-profiles.md) | Distributable LLM profiles: Quality gemma-4-e2b-it / Fast lfm2.5-vl-450m, 6 GiB free-RAM gate. |
| [0003](docs/adr/0003-desktop-backend.md) | Desktop backend is a Node main-process server; the Python sidecar loses as default (seam retained). |
| [0004](docs/adr/0004-knowledge-packs.md) | Knowledge Pack specification and format freeze (content-hash identity, semver, supersedes). |
| [0005](docs/adr/0005-sqlite-vec-interop.md) | SQLite store schema freeze; sqlite-vec Node/Python interop (0.1.9 exact pin). |
| [0006](docs/adr/0006-profile-model.md) | Profile model, ingest configuration, store backup/recovery. |
| [0007](docs/adr/0007-relevance-floor-calibration.md) | Calibrated reranker relevance floor 0.569387 for desktop hybrid retrieval. |
| [0008](docs/adr/0008-memory-budget.md) | Runtime memory budget, concurrency governance, idle-session unloading. |
| [0009](docs/adr/0009-browser-packs.md) | Superseded by ADR-0012. Browser surface got an explicit pack capability gate, not a browser adapter. |
| [0010](docs/adr/0010-update-channels.md) | Opt-in Ed25519-signed update channels for packs (installable) and the app binary (notify-only). |
| [0011](docs/adr/0011-external-model-endpoints.md) | Opt-in, grounded external model endpoints (OpenAI- and Anthropic-compatible); reverses the 2.0.0 no-network posture for this feature only; desktop backend owns the outbound call with pinned-address `node:https`. |
| [0012](docs/adr/0012-browser-training-packs.md) | Browser app installs Knowledge Packs (OPFS, desktop-twin guards and signature checks) and plays courses on an isolated player origin fed by an app-side byte relay; supersedes ADR-0009. |

## Known limits & pending work

- **Reference-laptop matrix (E3, issue #86) is pending.** All measured rows
  in [bench/RESULTS.md](bench/RESULTS.md) are devstation-tagged; the
  reference-i5 rows (physical 16 GB soak, installer size/latency) remain
  PENDING until the operator runs them.
- **Embedding re-pin is open follow-up work.** The shipped surfaces stage
  `bge-small-en-v1.5` (desktop, 384-dim) and `snowflake-arctic-embed-m-v1.5`
  (browser, 768-dim); the ADR-0001 target model and the reranker
  export/floor re-derivation are recorded as downstream issues in
  [docs/adr/0001-embedding-reranker.md](docs/adr/0001-embedding-reranker.md).
- **The sidecar backend path is dormant.** `SidecarBackendHost` is
  implemented and tested but never selected by the shipped configuration
  (ADR-0003 chose Node).
- **Narration transcription is build-machine-only.** faster-whisper runs in
  [packtool/storyline/transcribe.py](packtool/storyline/transcribe.py) at
  pack-build time; it is not a runtime dependency of any shipped surface.
- **The doc-accuracy guardrail is intentionally unscoped.** `doc-accuracy.yml`
  runs on every PR precisely so documentation-accuracy failures cannot be
  skipped by path filters.
- **The Windows installer is unsigned** (see Packaging; feed and pack
  artifacts are Ed25519-signed, the binary is not), and per-document delete
  does not exist on the frozen contract — only `DELETE /documents` (clear
  all) — so Electron mode hides the per-document button
  ([docs/electron-mode.md](docs/electron-mode.md)).
