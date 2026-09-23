# TrainingApp Desktop Shell (Electron)

Workstream B1 scaffold (issue #59): an Electron shell that opens the existing
`web_ui/dist` renderer from a custom `app://` protocol with secure defaults
locked down from commit one. Backend hosting, protocol/token hardening, and
renderer integration are later Workstream B slots — this shell only boots and
shows the current renderer.

## Package layout decision (required by issue #59)

**Multi-package: each app directory owns its own `package.json`; no root
workspace.** The repo today has exactly one npm package (`web_ui/`) and
deliberately no root `package.json`. Adding a root workspace would reshape
web_ui's CI install/cache assumptions for no benefit to a single new app, so
`desktop/` follows the established per-app-directory convention. Revisit only
if a third npm package appears (at which point a `nohoist`-free workspace with
per-package lockfiles is the honest migration, not a blanket hoist).

## Layout

```
desktop/
  main/index.ts          app bootstrap: single-instance lock, window, secure defaults,
                         transport-security wiring, navigation lockdown (B2)
  main/protocol.ts       app:// file protocol (traversal-refusing, MIME-mapped,
                         CSP + COOP/COEP/CORP on every response, B2)
  main/security/         B2 transport security: config, per-launch token,
                         backend-agnostic loopback guard, CSP policy (barrel: index.ts)
  preload/index.ts       contextBridge namespaces: `trainingapp` (shell) +
                         `desktopApi.getAuthToken` (B2 token bridge, IPC-only)
  src/__tests__/         frozen acceptance specs (vitest, stubbed electron)
  test/electron-stub.ts  in-memory electron for the specs
  repro/check.sh         acceptance-check driver for issue #59 (C1..C6)
  repro/check-b2.sh      acceptance-check driver for issue #60 (B2 specs)
  scripts/               preload format guard + runtime smoke (CI)
  electron-builder.yml   unsigned NSIS x64 packaging (appId com.zaxbyhub.trainingapp)
  renderer/              build-time staging of web_ui/dist (gitignored)
  desktop-release/       electron-builder output (gitignored)
```

## Scripts

| Script | What it does |
|---|---|
| `npm run compile` | tsc -> `dist/` (main as ESM/nodenext; preload as CommonJS, renamed .cjs) |
| `npm test` | all acceptance spec files (vitest; B1 + B2 suites) |
| `npm run dev` | compile + launch Electron with `--dev` (expects the vite dev server already running — use `desktop:dev` to start both) |
| `npm run desktop:dev` | vite dev (web_ui) + Electron with reload, via `concurrently` |
| `npm run desktop:build` | build web_ui, copy `web_ui/dist` -> `renderer/`, compile, run electron-builder (NSIS x64, unsigned) |
| `npm run test:secure-defaults` / `test:single-instance` / `test:app-protocol` | one spec file each |

Dev mode: Electron loads `http://localhost:5173` when `--dev` is in argv, or
whatever URL `ELECTRON_START_URL` points at. Production: `app://index.html`
served from `<resourcesPath>/web_ui`. Note the packaged binary does not start a
vite server — `--dev` on an installed app shows nothing; use `desktop:dev`.
In dev mode the `app://` protocol handler is intentionally not registered (the
vite server serves the renderer), so an `app://` navigation — allowed by the
navigation policy — fails to load; that combination is production-only.

## Security posture (baseline, per issue #59)

- Every window: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, `webviewTag: false` — asserted by a frozen,
  mutation-sensitive spec (`src/__tests__/secure-defaults.test.ts`) that runs
  in CI.
- Single instance: second launch focuses the existing window and exits
  (`app.requestSingleInstanceLock` + `second-instance` handler, spec-pinned).
- `app://` handler: parses the raw request URL, percent-decodes, rejects
  backslashes/NUL/traversal segments, contains resolved paths under the
  renderer root, re-checks containment through `realpath` (symlink escape),
  and returns 403/404 rather than reading anything outside the root
  (spec-pinned including Windows drive-letter and `%00` cases).
- Preload exposes two non-privileged namespaces (`window.trainingapp`,
  `window.desktopApi.getAuthToken`) and nothing else; the per-launch transport
  token reaches the renderer only through that bridge (never storage, never a
  URL).
- B2 transport security (issue #60): per-launch token
  (`crypto.randomBytes(32)` hex, main-process memory only), strict CSP +
  COOP/COEP/CORP on every app:// response (relaxations documented inline in
  `desktop/main/security/csp.ts`), navigation/`window.open` lockdown, and a
  backend-agnostic loopback guard (origin allow-list, literal-loopback-only
  Host gate, token check) that B3 (#61) MUST mount in front of its backend —
  see `docs/security/desktop.md` for the threat model and the binding B3
  integration contract.
- Invariant: every new transport-facing seam threads the security barrel
  (`desktop/main/security/index.ts`); the frozen B2 specs
  (`src/__tests__/b2-*.test.ts`) plus the B1 secure-defaults spec are the
  regression family that keeps the webPreferences, CSP, guard, and token
  contracts from eroding.
- The installer is unsigned at this stage; signing/updates are Workstream E5
  (#88).

## Backend host (B3, issue #61)

`desktop/main/backend/` hosts the guarded loopback backend that answers the
frozen API contract (`contracts/api.openapi.yaml`). B4-B9 import ONLY
`desktop/main/backend/index.ts` (`createBackendHost`, `resolveBackendMode`,
`resolveNodeEngine`).

- **Modes**: `backend.mode` selects `"node"` (default per ADR-0003; guarded
  listener + real native inference via B4 #62, ingestion B6 #64, retrieval
  B7 #65) or `"sidecar"` (the same guarded listener fronting a loopback proxy
  to a spawned backend child managed by `SidecarManager`). Env override:
  `TRAININGAPP_DESKTOP_BACKEND_MODE`.
- **Security**: binds `127.0.0.1` on a random free port; the B2 loopback guard
  sits in front of EVERY route (see `docs/security/desktop.md`, "B3
  integration contract"); the reserved `X-Profile-Id` header is accepted on
  all routes for B6.
- **Renderer discovery**: `ipcMain.handle('desktop:get-backend')` exposed to
  the renderer as `desktopApi.getBackendInfo()` -> `{mode, port, url}`.
- **Headless entry** (tests/CI): `desktop/dist/main/backend/dev-server.js
  --port-file <p> --mode node --token <t>` (compiles from
  `desktop/main/backend/dev-server.ts`; exits when stdin closes).

## Native inference (B4, issue #62)

The node-mode default engine is `LlamaEngine`
(`desktop/main/backend/inference/`): REAL llama.cpp inference via
`node-llama-cpp` (prebuilt binaries ship in the npm package; the library
choice is recorded as an assumption, confirmed by ADR-0003), with Quality/Fast
profile auto-selection.

- **Profiles**: `auto` (default) picks Quality when free RAM >=
  `inference.profileThresholdGb` (default 6 GiB, inclusive), else Fast.
  Quality model: `gemma-4-e2b-it/model.gguf`; Fast model:
  `lfm2.5-vl-450m/model.gguf` — both relative to the model dir (assumption A2
  pending ADR-0002 #56). Embeddings remain the stub until B5 (#63).
- **Threads**: `min(cores, 8)` by default — explicitly NOT the browser WASM
  4-cap (`web_ui/src/lib/llm/wllama-service.ts`). `inference.vulkan` is
  reserved, default `false` (llama.cpp #17389).
- **Model location**: `TRAININGAPP_INFERENCE_MODEL_DIR` env (or dev-server
  `--model-dir`) -> `<userData>/models` (Electron injects the path) ->
  `~/.trainingapp/models` headless fallback. A missing model makes `/ask` and
  `/ask/stream` answer the contract's 503 with a load diagnostic; the stream
  route preflights BEFORE any SSE byte.
- **Resident + cancel**: one model per effective profile, loaded lazily on the
  first query and reused (reload only on profile switch, deferred until any
  in-flight generation ends); a client disconnect stops emission via a 20ms
  cancellation poll + abort signal — well inside the 200ms budget.
- **Settings**: `inference.profile` | `inference.profileThresholdGb` |
  `inference.threads` (1..64) | `inference.vulkan` via PUT /settings; the
  rag_* keys still round-trip (owned by the composed stub until B5/B6).
  Headless env equivalents: `TRAININGAPP_DESKTOP_INFERENCE_PROFILE`
  (quality|fast|auto; invalid values fall back to auto) and
  `TRAININGAPP_DESKTOP_INFERENCE_THREADS` (same 1..64 integer gate as the
  settings key; invalid values fall back to the min(cores, 8) default).
- **Packaged installs**: the installer does NOT yet unpack node-llama-cpp's
  native addon from the asar archive — packaged inference lands with #84
  (E1). Dev runs and the headless dev-server are unaffected.
- **History**: contract-supplied history is capped to the last 12 turns
  before seeding the model, so an oversized array cannot overflow the 8192
  context (the browser client already caps at 6).
- **Stub fixture**: `TRAININGAPP_DESKTOP_ENGINE=stub` (or dev-server
  `--engine stub`) restores the B3 deterministic engine for dev/CI transport
  conformance without weights. The CI conformance job does exactly this;
  `TRAININGAPP_CONFORMANCE_ENGINE=llama` runs the SAME suite against REAL
  inference on a weights-staged machine.

Commands:

```bash
npm --prefix desktop run compile          # tsc -> dist (includes the backend)
npm --prefix desktop test                 # vitest incl. the six b3-* specs
node desktop/scripts/run-conformance-host.mjs   # conformance vs this host
#   (needs: pip install httpx; starts host + token-injecting harness proxy,
#    runs contracts/tests/run_conformance.py --base-url ... --destructive)
```

CI: the `backend-conformance` job in `.github/workflows/desktop-build.yml`
runs the conformance suite against the Electron-hosted backend on every
desktop change.

## Reserved namespaces

- `app://training/<packId>/` — the embedded Storyline player route
  (Workstream D5, #81), implemented in `desktop/main/protocol.ts`
  (`resolveTrainingRequest`): serves `<packsRoot>/<packId>/assets/player/`
  with the training CSP profile; see `docs/training-player.md`. The pack
  routes dispatch before the generic renderer file mapping.

## ADR-0003 note (issue #57, decided)

ADR-0003 (`docs/adr/0003-desktop-backend.md`) chose the Node main-process
backend on measured evidence; the `node` default in `backend.mode` is that
decision. The sidecar mode remains available behind `backend.mode` /
`SidecarManager` for a future packaged-Python capability (its PyInstaller +
frozen-llama blockers are recorded in the ADR).

## B5 store (issue #63)

The Node host opens the per-profile SQLite store (`contracts/store.schema.sql`,
schema v3 — per-version `packs` since C3/#70) on the `NodeBackendHost` start
path when a store path is configured
(Electron bootstrap: `<userData>/store/store.db`; dev-server:
`--store-path` or `TRAININGAPP_DESKTOP_STORE_PATH`). Init is
failure-isolated — the store is not load-bearing until B6 (#64). Pinned
sqlite-vec 0.1.9 (`better-sqlite3` + `sqlite-vec` in `desktop/package.json`);
Node↔Python interop proof: `contracts/tests/store-interop/` (ADR-0005). The
Electron-packaged native-addon path remains #84/E1. Browser IndexedDB storage
(`web_ui`) is unchanged by B5.

## Pack lifecycle (C3, issue #70)

The backend host start path constructs the Node `PackManager`
(`desktop/main/backend/store/pack-manager.ts`) over the opened store and the
shared embedder, and attaches it to the engine (`attachPackManager`; the
instance-field/attach shape keeps the b3 prototype pin intact). It implements
C2's `pack_manager.py` semantics on the shared schema — install / supersede /
rollback / remove / listInstalled with ADR-0004 content-hash chunk ids —
against the v3 per-version `packs` table (migration ladder handles older
stores). Lifecycle ops are serialized (C2 registry-lock parity) and rebind
across clear-cache store swaps. Cross-backend chunk-id parity with the Python
PackManager is proven in CI's store-interop job
(`contracts/tests/test_pack_parity.py`). The Documents-page UI consuming this
surface lands with C7/#74; hardening (symlinks, resource caps) is C8/#75.

## First-run wizard (E2, issue #85)

A fresh install walks a deterministic six-state sequence: `detect-hardware` →
`select-profile` → `verify-manifest` → `activate-packs` → `licensing-notices` →
`complete`. Key facts an operator or reviewer needs:

- **Profile gate** (`main/first-run/ram-gate.ts`): the default profile is
  `quality` iff the quality model fits in free RAM under A3's
  `file_size + kv_estimate(n_ctx) + GGUF_LOAD_OVERHEAD_BYTES` (1 GiB each,
  `n_ctx = CONTEXT_SIZE`); otherwise `fast` with a warning naming the numbers.
  An explicit operator choice always overrides. When a model is not staged,
  the manifest's declared `sizeBytes` drives the estimate.
- **Integrity verification** (`main/first-run/manifest-verifier.ts`): every
  manifest-required file's sha256 is checked at first run and at every launch
  after completion (drift re-run). Failures name the path + expected/actual.
  A packaged install without `resources/manifest.json` fails CLOSED (broken
  install); a dev/CI tree with none staged degrades explicitly.
- **State** (`main/first-run/first-run-store.ts`): `firstRun.completed`,
  `firstRun.selectedProfile`, `firstRun.completedAt`, license acknowledgment,
  and the per-file digest anchor persist atomically in
  `<profileDir>/first-run.json`. The engine settings API deliberately does NOT
  carry these (its key set is contract-frozen).
- **Completion guard** (`main/first-run/wizard.ts`): completion is impossible
  without an explicit profile choice, all manifest-required packs active, and
  the license acknowledgment. "Skip for now" only closes the window; the
  wizard re-opens on the next launch.
- **Re-run**: Settings → "First-run setup" → "Re-run setup" resets the state;
  mutating any manifest-covered file re-triggers the wizard automatically
  (`reason: "drift"`).
- **Dev/test seams**: `TRAININGAPP_DESKTOP_MANIFEST` (manifest path override),
  `TRAININGAPP_DESKTOP_FREE_RAM_BYTES` (free-RAM override),
  `TRAININGAPP_FIRST_RUN_FORCE=1` (opens the wizard on the CI stub engine,
  which is otherwise exempt like the B9 boot gate).
- `TRAININGAPP_DESKTOP_STORE_PATH` is honored by the Electron bootstrap (not
  just the headless dev-server), which is what gives the Playwright-under-
  Electron suite per-test store isolation.

## Installer resources + startup integrity gate (E1, issue #84)

The installer ships every model/pack the packaged app needs, enumerated and
verified. Key facts for operators and reviewers:

- **Staging** (`scripts/stage-installer-resources.mjs`, run by
  `desktop:build` before electron-builder): assembles
  `installer-resources/` as `models/{embedding,reranker,llm-quality,
  llm-fast}/<id>/…`, `packs/{bundled-docs,training}/<packId>-<version>/  and `docs/licenses.md` from EXPLICIT allow-lists. The staged models are
  exactly what the packaged desktop runtime loads today (bge-small-en-v1.5
  fp32 embedder, ettin-reranker-32m-v1 q8 reranker, the ADR-0002 GGUF
  pairs); swapping any of those is a model-selection decision (A5/A6),
  not a packaging one. A missing required source file fails the build BY
  NAME — electron-builder silently skips a missing extraResources `from:`,
  so staging must not. `--fixture-models` (CI) substitutes deterministic
  stand-ins; the mode is printed, embedded in the manifest description, and
  carried in the CI artifact name (`…-installer-fixture`).
- **Renderer copy anti-double-ship**: the same stager copies
  `web_ui/dist` → `renderer/` EXCLUDING weight files whose model-id dir
  is staged (keeping `models/ort`, `models/manifest.json`, wllama and
  the snowflake browser embedder for the packaged renderer), then asserts
  the (model-id, file) overlap between `renderer/models` and the staged
  weights is empty — a hard build failure otherwise. Without this, a local
  post-`prepare-models` build would ship the ~4 GB weights twice.
- **Manifest** (`scripts/build-installer-manifest.mjs`): whole-tree
  enumeration with streaming sha256 into `resources/manifest.json` (the
  E2-pinned schema; packs`[].dir` is packs-root-relative — the value
  `packEntryDir` joins under `<resourcesPath>/packs/`). `--verify` is
  a read-only completeness gate (exit 1 naming each unlisted staged file
  and each listed-but-missing one; the manifest at `--out` is exempt — a
  manifest cannot hash itself). CI runs it as a required step after
  `desktop:build`.
- **Startup gate** (`main/integrity-check.ts`, wired BEFORE engine
  construction in `main/index.ts`): verifies the shipped tree at the
  packaged resources root; any failure BLOCKS backend start with a dialog
  and logs naming path + expected/actual (packaged-without-manifest fails
  closed; dev-without-manifest skips by design; dev-with-manifest verifies
  and reports, never fatal). On pass it derives the runtime bridge from
  the VERIFIED manifest: per-profile engine model overrides (through the
  existing `resolveNodeEngine` `models` seam) and the embedder/reranker
  dirs (through their existing env seams — packaged manifest wins over a
  pre-set env value, logged when it overrides one).
- **Integrity layering** (stated honestly): startup verifies every
  `required` file (models + docs); pack files are verified at build by the
  `--verify` gate and at install by the #68 pack schema per-doc sha256.
  Note `verifiedCount`-style counts include the `installer-docs` entry.
- **Size budget**: measured component table in `bench/RESULTS.md`
  (E1 section); staged resources 4,108,286,464 bytes ≈ 3.83 GiB + shell vs
  the ≤7 GiB budget.

## Ingestion, profiles, backup and recovery (B6, issue #64)

Design decisions are frozen in ADR-0006 (`docs/adr/0006-profile-model.md`).

- **Profiles**: one OS-user-scoped profile by default at
  `<userData>/profiles/default/store.sqlite`. Named profiles are opt-in:
  `TRAININGAPP_PROFILE_MODE=named` + `TRAININGAPP_PROFILE_NAME` (required in
  named mode; allowlist `[a-z0-9-]{1,64}` — names become directory names, so
  traversal is structurally impossible). B5's interim `<userData>/store/store.db`
  migrates to the default profile (atomic same-volume rename) on first B6
  launch; rollback is the reverse rename.
- **Ingest env keys** (invalid values fall back per-key; an overlap >= words
  pair falls back to both defaults): `TRAININGAPP_INGEST_MAX_CONCURRENT_FILES`
  (default 2, coordinated with B8 #66), `TRAININGAPP_INGEST_CHUNK_WORD_COUNT`
  (256), `TRAININGAPP_INGEST_CHUNK_OVERLAP_WORDS` (100). Ingest identity is
  content-derived (doc id = sha256 of file bytes; chunk id = sha256 over
  doc + index + normalized text) — never path-derived.
- **Embeddings**: `bge-small-en-v1.5` (384-dim) via transformers.js +
  onnxruntime-node, pinned pending ADR-0001 (#55). Weights must be staged at
  `models/bge-small-en-v1.5/onnx/model.onnx` (repo, or `<userData>/models`);
  `TRAININGAPP_EMBEDDING_MODEL_DIR` overrides the location. Without weights,
  dev/CI selects the deterministic fixture via `TRAININGAPP_DESKTOP_EMBEDDER=hash`
  (never a production default). Embedding width is validated against the
  store's `meta.embedding_dims` on every write.
- **Backup/restore**: `desktop:store-backup` IPC handler and automatic
  recovery write snapshots to `<userData>/backups/<UTC-timestamp>/store.sqlite`
  (WAL checkpointed first). Restore validates `schema_version` and
  `embedding_dims` BEFORE replacing the active store.
- **Corruption recovery**: startup runs `PRAGMA integrity_check`; a store
  failing integrity cannot be served, so the Electron prompt (Restore from
  backup / Start fresh) intentionally BLOCKS host start. Headless hosts
  auto-recover (latest backup, else fresh). Clear Cache targets the ACTIVE
  profile's store only.
- **`ingest:progress`**: IPC channel emitting `{docId, phase, percent}`
  (phase: extract | chunk | embed | write | done) per document; the renderer
  consumer lands with B9 (#67).

## Hybrid retrieval (B7, issue #65)

`POST /search` and the retrieval step inside `/ask` + `/ask/stream` run the
hybrid pipeline in `main/backend/retrieval/`: sqlite-vec top-K UNION FTS5
top-K -> Reciprocal Rank Fusion (1/(rrfK + rank + 1), dedup by chunk id) ->
`recencyWeight()` hook (inert until C4/#71) -> the ettin-reranker-32m-v1
cross-encoder over the fused window IN A DEDICATED WORKER THREAD (never the
main/event-loop thread) -> the calibrated relevance floor (ADR-0007) -> topK.

- **Config keys** (env-resolved, mirroring the browser `balanced` preset;
  invalid or out-of-range values fall back per key):
  `TRAININGAPP_RETRIEVAL_TOPK` (10, max 1000),
  `TRAININGAPP_RETRIEVAL_CANDIDATE_MULTIPLIER`
  (3, max 100), `TRAININGAPP_RETRIEVAL_RERANK` (true; 'true'/'1'/'false'/'0'),
  `TRAININGAPP_RETRIEVAL_RRF_K` (60, max 10000),
  `TRAININGAPP_RETRIEVAL_RELEVANCE_FLOOR`
  (the calibrated ADR-0007 value; finite float in [0, 1)).
- **Reranker weights**: staged at `models/ettin-reranker-32m-v1/onnx/`
  (repo, or `<userData>/models`); `TRAININGAPP_RERANKER_MODEL_DIR` overrides.
  Without weights the pipeline degrades to RRF-only ordering and the
  relevance floor is NOT applied (it gates reranker-scale sigmoid scores
  only). A reranker worker failure degrades that single query to the same
  fused ordering (logged once) — `/search` never fails because of the
  reranker.
- **Query embedding** reuses the ingest embedder instance (single model load
  per process): `bge-small-en-v1.5` (ADR-0006 pin, pending ADR-0001), or the
  deterministic `TRAININGAPP_DESKTOP_EMBEDDER=hash` fixture in dev/CI.
  Queries are embedded WITHOUT a model-card instruction prefix to stay in the
  same vector space as the recorded parity baseline
  (eval/samples/report-devstation-weighted.json); see ADR-0007 for the
  re-baseline condition if that changes.
- **Reranker stub fixture** (C5, issue #72): on hash-embedder dev/CI hosts
  there is no ONNX reranker model, so `TRAININGAPP_DESKTOP_RERANKER_STUB=1`
  attaches a constant-high stub reranker, keeping the pipeline on the
  calibrated-floor path (evidence is floor-qualified and the C5 `grounding`
  provenance value is meaningful). Dev/CI-only — never set in production;
  with neither a real reranker nor the stub the surface runs fused (no floor)
  and grounding resolves `"general"` (see `RetrievalSurface.floorActive`).
- **Detached mode**: with no store configured (or no embedder resolvable) the
  host attaches no retrieval surface and engines keep the B3 deterministic
  behavior; attaching/detaching is the `attachRetrievalSurface` seam,
  mirroring B6's document surface.

## Runtime memory and concurrency budget (B8, issue #66)

Design decisions are frozen in ADR-0008 (`docs/adr/0008-memory-budget.md`).

- **Telemetry**: the host samples per-component memory every
  `memory.telemetryIntervalMs` and serves `GET /telemetry/memory`
  (`{snapshot, downgrade}`; `contracts/api.openapi.yaml` v2.4.0) —
  token-guarded like every route (it reveals process memory). Component
  attribution semantics (main-process RSS, baseline-relative LLM delta,
  worker thread counters, better-sqlite3 heap) are documented in the ADR.
  Unwired hosts answer 503 — the path is known, never 404.
- **Memory env keys** (invalid values fall back per-key):
  `TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS` (5000),
  `TRAININGAPP_MEMORY_MAX_TOTAL_GB` (16 — the v3 floor from
  `.swarm/spec-snapshot.md`), `TRAININGAPP_MEMORY_PRESSURE_THRESHOLD_GB`
  (6 — the SAME constant as `inference.profileThresholdGb`, imported not
  restated), `TRAININGAPP_MEMORY_PRESSURE_SUSTAINED_MS` (10000),
  `TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS` (60000),
  `TRAININGAPP_MEMORY_IDLE_UNLOAD_MS` (300000).
- **Downgrade (AC2/AC3)**: free RAM strictly below the threshold for the
  sustained window latches the effective profile to Fast (the user's
  `inference.profile` setting is never mutated), logs the observed free-RAM
  value, and emits `memory:event {type:'downgrade', effectiveProfile,
  freeMemMb}`. There is NO silent auto-upgrade: after a sustained recovery
  window the host clears the override only between generations (scheduler
  fully drained), emitting `recovery-eligible` first. Renderer consumption
  of `memory:event` lands with B9 (#67).
- **Serialization (AC4)**: `/ask` + `/ask/stream` run under a FIFO generation
  mutex (`concurrency.maxConcurrentGenerations`, default 1; excess requests
  queue, never 503). The B6 embed phase pauses while a generation runs
  (`coordination.waitForGenerationEnd()`). The stream preflight stays
  outside the mutex so a missing model still answers 503 immediately.
- **Worker pools (S4)**: `TRAININGAPP_EMBEDDING_WORKER_POOL_SIZE` /
  `TRAININGAPP_RERANKER_WORKER_POOL_SIZE` (default 1, never
  `os.cpus()`-derived). Values >1 are reported by the parser but rejected at
  the host — logged + `memory:event`, and the host CONTINUES with 1 (no
  startup failure): B7's single-thread ORT ownership means a second ONNX
  instance on another thread aborts the process.
- **Idle unload (AC5)**: the retrieval worker is terminated after
  `memory.idleUnloadMs` idle and transparently rebuilt on the next
  score/embed; the measured reload latency is recorded. The resident LLM is
  deliberately not unloaded (B4's resident-model contract).
- **Soak harness**: `desktop/test/soak/memory-soak.mjs` (+ README) — the
  AC1 reference-laptop procedure lives in `desktop/test/soak/README.md`.
