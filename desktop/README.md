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

- **Modes**: `backend.mode` selects `"node"` (default while ADR-0003 #57 is
  open; guarded listener + in-memory stub engine — real inference arrives with
  B4 #62, ingestion B6 #64, retrieval B7 #65) or `"sidecar"` (the same guarded
  listener fronting a loopback proxy to a spawned backend child managed by
  `SidecarManager`). Env override: `TRAININGAPP_DESKTOP_BACKEND_MODE`.
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
choice is recorded as an assumption pending ADR-0003 #57), with Quality/Fast
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

- `app://training/<packId>/` is RESERVED for Workstream D5 (#81, embedded
  Storyline player). The current handler maps every path under the renderer
  root; when D5 lands it must register its pack routes before the generic
  file mapping.

## ADR-0003 note (issue #57, still open)

No backend-host code exists in the main bootstrap, on purpose. When ADR-0003
decides Node-main vs Electron-hosted Python sidecar, #61 adds backend hosting
in its own module — this bootstrap does not need to change shape. If the ADR
adds a sidecar executable, re-verify `electron-builder.yml` `extraResources`
against it (per the issue's invalidation clause).

## B5 store (issue #63)

The Node host opens the per-profile SQLite store (`contracts/store.schema.sql`,
schema v1) on the `NodeBackendHost` start path when a store path is configured
(Electron bootstrap: `<userData>/store/store.db`; dev-server:
`--store-path` or `TRAININGAPP_DESKTOP_STORE_PATH`). Init is
failure-isolated — the store is not load-bearing until B6 (#64). Pinned
sqlite-vec 0.1.9 (`better-sqlite3` + `sqlite-vec` in `desktop/package.json`);
Node↔Python interop proof: `contracts/tests/store-interop/` (ADR-0005). The
Electron-packaged native-addon path remains #84/E1. Browser IndexedDB storage
(`web_ui`) is unchanged by B5.

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
