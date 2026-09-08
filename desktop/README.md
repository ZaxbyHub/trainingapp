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
