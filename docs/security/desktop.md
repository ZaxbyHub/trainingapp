# Desktop Security: Threat Model and Transport Contract (issue #60)

Scope: the Electron desktop shell under `desktop/` — the `app://` renderer
surface and the loopback API transport. Python-side server hardening is
covered by `docs/security_hardening_guide.md`; renderer feature work is B9
(#67); the backend host itself is B3 (#61).

## Architecture invariants

1. **The renderer is untrusted input to the main process.** It runs
   third-party-influenced bundles (model runtimes, app code) inside
   `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
   `webviewTag: false` (pinned by `desktop/src/__tests__/secure-defaults.test.ts`).
   Everything below assumes a compromised or malicious renderer must not be
   able to reach the backend, navigate the shell, or escalate out of its
   sandbox.
2. **Every transport seam threads the security barrel.** All security
   primitives live in `desktop/main/security/` (`config`, `token`,
   `loopback-guard`, `csp`) and are consumed via the barrel
   (`desktop/main/security/index.ts`). New seams must reuse them, not roll
   their own policy. Enforced by the frozen B2 regression family
   (`desktop/src/__tests__/b2-*.test.ts` + `desktop/repro/check-b2.sh`).
3. **Loopback-only transport.** The backend that B3 hosts binds
   `127.0.0.1` on a random free port. The Python server's own default is
   loopback with explicit `API_HOST=0.0.0.0` opt-in (`api_server.py`),
   but its auth is off by default (`auth.py` `ENABLE_AUTH=false`) — which is
   exactly why the desktop transport carries its own token gate: **a loopback
   port is reachable by every local process**, so origin+token enforcement
   must not depend on the backend's own auth settings. This guard sits in
   front of the B3 backend regardless of which side of ADR-0003 (#57) wins
   (Node main or Electron-hosted Python sidecar).

## Threats and mitigations

### Token theft
- **Threat:** any renderer script (or anything that can read renderer
  storage/history) learns the transport token.
- **Mitigations:**
  - The token is `crypto.randomBytes(32)` hex, minted once per launch in the
    main process (`desktop/main/security/token.ts`), held in main-process
    memory only. It is never written to disk (fs-write spies in
    `b2-token-lifecycle.test.ts`) and never logged (console spies, and
    rejection bodies are static strings that never echo it).
  - The renderer receives it ONLY through
    `contextBridge.exposeInMainWorld('desktopApi', { getAuthToken })` ->
    `ipcRenderer.invoke('desktop:get-token')`. It never touches
    localStorage/sessionStorage and never travels in a URL (structurally
    enforced by the `token-bridge` greps in `desktop/repro/check-b2.sh`).
  - Rejection responses are static; no reflection of request material.

### Malicious renderer content
- **Threat:** injected markup/script in the packaged web_ui bundle escalates
  beyond the renderer (phishing navigation, exfiltration, arbitrary JS).
- **Mitigations:**
  - Strict CSP on every `app://` response (success AND errors, `protocol.ts`):
    `script-src 'self' app: 'wasm-unsafe-eval' 'sha256-<pin>'` — arbitrary
    inline scripts and eval are blocked; the single legitimate inline script
    (theme bootstrap in `web_ui/index.html`) is hash-pinned, and the pin is
    CI-verified against the tracked file (`b2-csp-pin.test.ts`). Relaxations
    and their consumers are documented inline in `desktop/main/security/csp.ts`.
  - Navigation lockdown (`main/index.ts`): `will-navigate` denies everything
    except `app://` (plus the dev-server origin in dev mode);
    `setWindowOpenHandler` denies every `window.open` (C3 spec).
  - COOP/COEP/CORP on every response (same discipline as `start.ps1`), which
    also enables cross-origin isolation for multithreaded WASM.

### LAN exposure
- **Threat:** the backend (or the transport) is reachable from other machines.
- **Mitigations:** the backend binds literal loopback only (B3 contract);
  the guard's Host gate accepts only `127.0.0.1` / `[::1]` literals — the
  name `localhost` and LAN/private IPs are rejected even with a valid token
  (DNS-rebinding hardening, R3 in `loopback-guard.ts`). Wrong origin
  (`Origin` outside `security.allowedOrigins`, default `["app://*"]`,
  including `Origin: null` and subdomain tricks) is rejected 403 BEFORE the
  token is checked.

### Token replay across restarts
- **Threat:** a token captured in session N is replayed in session N+1.
- **Mitigations:** the token dies with the process — every launch mints a
  fresh one (uniqueness pinned by `b2-token-lifecycle.test.ts`), nothing
  persists it, so a replayed stale token fails the equality check (401).

## B3 integration contract (binding, not advisory)

When the backend host lands (#61, per ADR-0003), it MUST:

1. Bind `127.0.0.1` on a **random free port** (ask the OS, do not hard-code).
2. Mount `getLoopbackGuard()` (constructed at bootstrap and surfaced by
   `desktop/main/security/index.ts`) in front of EVERY request route, before
   any backend logic: `const verdict = guard(req); if (verdict) return verdict;`
3. **Adapt the request shape correctly.** The guard requires:
   - `url` as an ABSOLUTE URL — a Node `http.IncomingMessage.url` is a bare
     path and fails closed (403); build it explicitly, e.g.
     `url: \`http://127.0.0.1:${port}${req.url}\``.
   - Case-insensitive header lookup. Real `fetch`/`Headers` fold case; a
     hand-rolled adapter must too (or lowercase names before lookup) — the
     guard folds names itself as defense-in-depth, but do not rely on that.
   - `method` (optional, reserved for #61): a CORS-preflight `OPTIONS` may be
     answered by the adapter, but ONLY after the guard's origin/host gates
     pass — never exempt preflight requests before the guard.
4. Read the token header name from `resolveSecurityConfig().tokenHeaderName`
   (default `X-Desktop-Token`) — do not hard-code it, and do not switch the
   desktop transport to `Authorization: Bearer` (the web_ui ApiClient reserves
   that header for its server-mode JWT flow; B9 renders the desktop token via
   the `desktopApi.getAuthToken()` bridge instead of `auth.ts` storage).
5. Never log the token, the raw `Authorization`-equivalent header, or full
   request URLs at info level.

The bootstrap fails fast (`app.quit()`) if the guard was not constructed, so
a regression that drops the initialization cannot ship silently.

## B3 backend host (issue #61, implemented)

The backend host lives in `desktop/main/backend/` (single import seam:
`desktop/main/backend/index.ts`; B4-B9 import ONLY that module). It satisfies
the contract above as follows:

- **Binding.** The host binds `127.0.0.1` on a **random free port** — the port
  is requested from the OS (`listen(0)`), never hard-coded. The headless
  entry `desktop/main/backend/dev-server.ts` (compiled to
  `desktop/dist/main/backend/dev-server.js`) writes the bound port to a
  `--port-file` for harness synchronization, stops the host when stdin closes
  or on SIGINT/SIGTERM, and stops the host before exiting if the port file
  cannot be written. In sidecar mode the child's port is reserved first
  (`listen(0)` then close); the brief bind-close window before the child
  binds it is an accepted race — this sentence is its authoritative note.
- **Guard mounting.** `createBackendServer` has ONE guard call site before any
  routing; every request — including `/health`, `/auth/*`, and CORS-preflight
  OPTIONS (answered only AFTER the origin/host gates) — traverses the B2
  guard instance constructed at bootstrap (`initializeTransportSecurity()`).
  The request adapter builds the ABSOLUTE URL the guard
  requires (`http://<Host header><path>`) and folds header case through the
  fetch `Headers` implementation. A vitest guard-spy spec pins that every
  request crosses the gate exactly once before any handler.
- **Mode selection.** `backend.mode` (`"node" | "sidecar"`, env
  `TRAININGAPP_DESKTOP_BACKEND_MODE`, default `"node"` while ADR-0003 #57 is
  open) selects between two implementations of the ONE `BackendHost`
  interface: the node host (guarded listener + local stub engine) or the
  sidecar host (the SAME guarded listener fronting a loopback proxy to the
  spawned backend child). Flipping the ADR decision is a one-line default
  change.
- **Sidecar spawn contract.** `SidecarManager` spawns the configured backend
  executable with a loopback bind configuration — env `API_HOST=127.0.0.1`
  and `API_PORT=<reserved free port>` for `api_server`-style launchers;
  `--host 127.0.0.1 --port <port>` style args for uvicorn-style launchers —
  with a configurable **working directory** (`sidecar.cwd`), bounded
  readiness polling of `GET /health` with retry/backoff, bounded-retry
  restart on unexpected exit (exponential backoff, loud give-up; the budget
  is a ROLLING window — `restartWindowMs`, default 60 s — not a lifetime
  cap), and a graceful-then-kill shutdown (`SIGTERM`, grace window,
  `SIGKILL`; on Windows both signals map to TerminateProcess — the sequence
  is POSIX-meaningful and Windows-harmless). All lifecycle timers are cleared
  on stop, so an app quit leaves no orphan child; a FAILED start() also stops
  everything (no scheduled respawn behind a thrown start), and bootstrap
  holds `will-quit` until the stop completes. Bind enforcement is by launch
  CONTRACT: the host passes the loopback configuration but does not verify
  the child's actual bind address — a compliant sidecar MUST bind 127.0.0.1
  (health probing proves function, not bind address; real sidecar lands B4).
  When the restart budget is exhausted the host keeps answering with
  contract-safe 502s and bootstrap surfaces the give-up via
  `config.onGiveUp` (fail-loud dialog + console in the Electron entry).
- **Proxy hygiene (sidecar mode).** The guarded proxy STRIPS the transport
  token header before forwarding (the sidecar never sees it) and FORWARDS the
  reserved `X-Profile-Id` header unchanged (the B6 profile slot must survive
  end-to-end). Upstream errors mid-response tear the client socket down after
  a best-effort terminal write — no half-open hangs.
- **Conformance testing.** CI job `backend-conformance` (in
  `.github/workflows/desktop-build.yml`) runs
  `desktop/scripts/run-conformance-host.mjs`: it boots the compiled headless
  host with a random run token, starts a HARNESS-ONLY loopback proxy that
  injects the token into every forwarded request (so the frozen conformance
  suite traverses the REAL guarded listener — the guard is never bypassed,
  weakened, or shipped in any production path), measures cold start to the
  first 200 `GET /health` against a 15 s bound, and runs
  `contracts/tests/run_conformance.py --base-url <proxy> --destructive`.
  The harness runs the suite via an ASYNC spawn: a synchronous spawn would
  block the harness event loop and stall the in-process proxy. The harness
  passes the run token to the headless host via `--token` ARGV (visible in
  local process listings) — dev/CI-only: the production path mints the token
  in-process and never places it on a command line.
- **Reserved profile slot.** `X-Profile-Id`
  (`RESERVED_PROFILE_HEADER_NAME`, `desktop/main/backend/types.ts`) is
  accepted on every route and ignored until B6 (#64) gives it meaning, so
  profile-scoped storage cannot change the wire contract later. B6 also owns
  validating its size/charset when it becomes meaningful.
- **Renderer discovery.** The backend address reaches the renderer ONLY via
  `ipcMain.handle('desktop:get-backend')` →
  `desktopApi.getBackendInfo()` (B9 consumes it) — never web storage, never a
  URL. The token still travels via `desktopApi.getAuthToken()` and is sent
  under the configured token header, not `Authorization: Bearer`.

## Known limits (explicit, not silent)

- Rate limiting beyond origin+token and TLS are out of scope for B2 per the
  issue (loopback-only traffic never leaves the machine).
- The manual verification transcript for this issue was produced against a
  local launch of the real guard (see the PR body); the packaged-app run on
  the reference laptop is an E3 (#86) validation-matrix item.
