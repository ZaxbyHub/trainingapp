# Electron mode — how the renderer picks its backend (B9, issue #67)

The web UI build ships in ONE artifact that runs in three environments. Every
environment-specific decision funnels through two modules so pages stay small:

- `web_ui/src/lib/desktop-session.tsx` — `isElectron()`, boot discovery
  (`initDesktopSession`), the `DesktopSessionProvider`/`useDesktopSession`
  context, and `modelsAbsentForRealEngine` (the first-run gate predicate).
- `web_ui/src/types/desktop.d.ts` — the ambient `window.desktopApi` type
  (the bridge is exposed by `desktop/preload/index.ts`).

## The three modes

| Mode | When | Documents / ingest / settings | Chat |
|---|---|---|---|
| **Electron-hosted** | `window.desktopApi` present (packaged `app://` renderer OR the Electron dev window) | `ApiClient` against the Electron-hosted loopback backend (`GET/DELETE /documents`, `POST /ingest/file`), settings via `GET/PUT /settings` | `mode === 'api'` branch posting to `{backend}/ask/stream` |
| **Remote Python server** | plain browser, user picks API mode + server URL | browser-local (IndexedDB) | `mode === 'api'` branch to `{serverUrl}/ask/stream` |
| **Pure-browser (local)** | plain browser, browser-local mode | IndexedDB + WASM pipeline (wllama/ONNX/EdgeVec/FlexSearch) | `RAGOrchestrator` in-page |

## Transport contract inside Electron

1. **Discovery** — `desktopApi.getBackendInfo()` returns `{ mode, port, url }`
   (frozen address-only shape). The backend binds `127.0.0.1` on a NEW random
   port every launch, and the launch token rotates too, so the renderer MUST
   rediscover both at every boot (`DesktopBootGate` in `App.tsx`).
2. **Auth** — every request carries the per-launch token in the
   `X-Desktop-Token` header (RAW token value — no `Bearer` prefix; the
   desktop loopback guard compares it directly). The Python surface's
   `Authorization: Bearer` convention is untouched and remains the default
   for remote-server mode.
3. **CORS** — the guard's allowlist is `['app://*']`; the dev window
   (`ELECTRON_START_URL`, e.g. the `vite preview` origin used by the e2e
   suite) must be added via `TRAININGAPP_DESKTOP_DEV_ORIGINS`. Browser
   preflights (OPTIONS) are answered without the token by design; every real
   request still requires it. Responses carry
   `Cross-Origin-Resource-Policy: cross-origin` because the renderer page
   sets COEP `require-corp`.
4. **Inference mode** — Electron boots seed `localStorage['inference-mode']`
   with `mode: 'api'` and the fresh backend URL before the provider mounts.
   Browser-local engine boot (`useServiceInitialization`) is skipped.
5. **First-run model gate** — at boot the renderer reads
   `GET /status/models` (`{ engine, profile, models: { quality, fast } }`).
   Chat send is blocked with an informative overlay ONLY when a REAL engine
   (`engine !== 'stub'`) has NO model file for either profile; the CI/dev
   stub answers `/ask` without weights and is never gated.

## Deliberate limitations (documented, not bugs)

- **No per-document delete in Electron mode.** The frozen API contract only
  exposes `DELETE /documents` (clear all) — per-document delete does not
  exist on either backend. Electron mode hides the per-document button and
  offers "Clear all" behind an explicit two-step confirm.
- **No IndexedDB migration.** Documents created in the pure-browser build
  stay in IndexedDB; Electron mode lists the server store. Switching back to
  the pure-browser build shows them again.
- **`X-Profile-Id` stays unwired** — desktop profile scoping is by store
  path (ADR-0006); the status UI only DISPLAYS the profile name.

## Which files branch on Electron

- `App.tsx` — `DesktopBootGate` (discovery, model status, mode seeding) and
  the `skip` flag for `useServiceInitialization`.
- `DocumentsPage.tsx` — load/upload/delete handlers.
- `SettingsPage.tsx` — settings load/save via the backend, "Desktop backend"
  status section; server-URL + browser-model sections hidden.
- `ChatPage.tsx` — SSE URL/token/header from the session; model gate.
- `useDocumentCount.ts` — count from `GET /documents`; `recount()` exposed
  for same-tab refresh after upload/clear.
- `InferenceModeContext.tsx` — connectivity probe carries the session header.
