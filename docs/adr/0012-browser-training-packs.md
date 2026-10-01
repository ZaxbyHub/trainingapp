# ADR-0012: Knowledge Packs and training courses in the browser app — isolated player origin

- **Status:** Accepted (2026-10-01, trace `browser-training-parity`)
- **Supersedes:** [ADR-0009](0009-browser-packs.md) (browser pack capability gate). ADR-0009
  required that a revisit supersede it rather than edit it; its Status now reads Superseded and
  points here. Nothing in ADR-0004 (pack format), ADR-0005 (store schema) or ADR-0010 (signed
  update channels) changes.
- **Context:** ADR-0009 gave the browser app an explicit capability gate: a dropped pack zip
  showed "Knowledge Packs require the desktop app" and was never imported, and the Training page
  told browser users that courses are available in the desktop app. The product decision since
  then (user, 2026-09-30) is that the standalone browser app and the desktop app have parity:
  the same Packs panel, the same install refusals, the same training player, and the same pack
  update channel. Two things kept packs desktop-only. First, the install path (`pack-extract.ts`,
  JSZip + Node `fs`, Node `crypto` Ed25519) and the course route (`app://training/<packId>/...`
  in `desktop/main/protocol.ts`) exist only in Electron. Second, course content is untrusted
  third-party JavaScript (an Articulate Storyline publish). On desktop it runs on its own
  `app://training` host, a different origin from the renderer (`app://index.html`), so it cannot
  read app storage. A browser app has one origin unless we create a second one; course JS on the
  app origin could read IndexedDB, localStorage and OPFS (documents, settings, the external-model
  API key from ADR-0011).

## Options

### Option A — pure-browser runtime with a dedicated player origin (selected)

Pack bytes live in the app origin's private storage (OPFS). Courses run on a separate player
origin (by default the loopback alias of the app's own server: `localhost` and `127.0.0.1` are
different origins served by one listener). A service worker on the player origin answers course
requests with bytes the app page relays to it over a `MessageChannel`. Archive guards and
signature checks run in the browser as twins of the desktop code, pinned by shared vectors.

- **For:** no server-side pack storage; true origin isolation (the browser's same-origin policy,
  not a sandbox flag, keeps course JS away from app data); the Packs/Training UI is shared with
  desktop through one client interface.
- **Against:** the largest option; every web-app host must serve two small files with the right
  headers and answer other `/training/*` paths with 404; hosting on a non-loopback name needs a
  second hostname for the player.

### Option B — server-assisted playback from the Python `api_server` (rejected)

`api_server.py` would serve `/training/<id>/...` from its own PackManager. Rejected: browser
parity would depend on the Python server, which is not part of the standalone browser app
(settings-wiring-honesty removed the browser's server mode), and its 50 MiB upload cap is far
below the real 292 MB OpMed publish.

### Option C — keep the gate, improve the message (rejected)

Contradicts the parity decision.

### Same-origin variants (rejected)

A sandboxed iframe without `allow-same-origin`, a `credentialless` iframe, or a CSP `sandbox` on
same-origin course documents. Measured in the plan's critic round 1 (Chromium 153): a
sandboxed opaque-origin frame cannot be controlled by a service worker, and the variants that
could be served were not isolated from app storage.

## Decision

### Two origins, one static server

- The app runs at `http://localhost:<port>`; the player origin is `http://127.0.0.1:<port>`
  (swapped when the app is opened on `127.0.0.1`). Desktop is unchanged (`app://training`).
- **Binding.** Both names must reach one listener, and the listener must not reach the LAN:
  every local server binds `127.0.0.1` explicitly (vite dev and preview in
  `web_ui/vite.config.ts`, `web_ui/scripts/serve-offline.mjs`, the HttpListener prefix in
  `web_ui/scripts/start.ps1`). Never `0.0.0.0` or `::`.
- **Player-origin resolution** (`web_ui/src/lib/packs/player-origin.ts`), once at app start and
  cached, in order: (1) runtime `player-origin.json` next to `index.html`
  (`{"playerOrigin": "https://player.example"}`, fetched same-origin with a 2 s bound; an HTML
  answer, such as a static host's SPA fallback, is ignored); (2) the build-time variable
  `VITE_TRAININGAPP_PLAYER_ORIGIN`; (3) the loopback alias when the app origin is loopback. A
  configured value must be a bare origin (no credentials, path, query or fragment), must differ
  from the app origin, and must be `https:` unless its host is loopback; anything else is
  ignored. If nothing resolves, course playback is disabled with an explanation. There is no
  same-origin fallback.
- **Remote hosting** (the app served from a non-loopback name, for example behind
  `api_server.py`) needs a second hostname that serves the same files, configured through
  `player-origin.json` or the build variable.

### Player-origin components (stateless)

- `/training-boot.html` + `/training-boot.js` (`web_ui/public/`): a hidden frame the app page
  embeds on the player origin. It registers the course service worker and passes the relay port
  the app transfers to it; it accepts the handshake only from `window.parent` at the exact
  expected parent origin. It stores nothing.
- `/training/sw.js` (scope `/training/`): serves only `/training/<packId>/<rest>`; every other
  request from a player client (other paths, other origins, the app shell, app APIs) is refused
  with 404; methods other than GET/HEAD get 405. It holds no cache and writes no storage; every
  response is built from relay bytes. It waits up to 10 s for a relay port, then answers 503.
  `skipWaiting` is deferred while a course page is open.

### The byte relay (all enforcement is app-side)

`web_ui/src/lib/packs/training-relay.ts`, driven by `training-player-host.ts`:

- On every course open the app page recreates the boot frame and transfers a fresh
  `MessageChannel` port to it with `targetOrigin` set to the player origin. Relay requests are
  accepted only on that port. The one window message the app accepts from the boot frame (exact
  source window and origin) is a data-free "relay needed" signal, sent when the worker lost its
  port while idle; the app answers it by repeating the handshake with the current boot frame,
  coalesced (one re-handshake in flight, at least 1 s apart) because course JS can send it too.
- The relay answers reads only for the pack currently open in the Training page (app state, not
  request data), mapped to that pack's active version in the app-origin registry. Path
  containment uses the same rules as desktop `resolveTrainingRequest` (`..`, encoded traversal,
  backslash, NUL, bad pack ids), pinned by `contracts/training-path-vectors.json` on both
  runtimes. Reads are bounded (16 MiB per message, 64 open handles, 2000 requests per 10 s
  window). Range requests get 206/416 with desktop parsing.
- Responses carry the desktop MIME table, `Cross-Origin-Resource-Policy: cross-origin`,
  `nosniff`, `no-cache`, and the training CSP: the desktop `buildTrainingCspPolicy()` without the
  private `app:` sources plus `frame-ancestors 'self' <app origin>` (pinned by
  `desktop/src/__tests__/browser-training-serving-drift.test.ts`). Course documents also carry
  `Cross-Origin-Embedder-Policy: require-corp`, without which the app's COEP blocks the frame.

### Threat model — nothing on the player origin is trusted

1. Course JS can read the boot frame's DOM (same origin), take any port the boot frame holds,
   open its own `/training-boot.html`, and send the worker its own handshake. It then holds a
   relay port and gains only what item 2 allows. Recreating the boot frame and port on every
   course open raises the bar against stale instances but does not stop a live malicious course.
2. A relay port can read only files of the open pack's active version, inside its player asset
   directory, with bounded sizes and rates.
3. The worker and boot page never read or write player-origin Cache Storage, IndexedDB, OPFS or
   localStorage, so nothing a course writes is served to another pack.
4. **Shared untrusted player origin.** All packs share one player origin, as all packs share
   `app://training` on desktop. A live malicious pack cannot reach app data, but within a session
   it can interfere with the player origin, for example spoof what another pack's frame
   displays. Only one course is open at a time and the relay serves only the open pack, which
   limits this, but it is not prevented. This is parity with desktop.
5. Isolation from the app is by origin: app IndexedDB, localStorage, OPFS, Cache Storage and DOM
   are unreachable from course JS. Course JS reaches the app only through the slide bridge
   (exact origins, below) and the scoped relay.

### Slide bridge

`web_ui/src/components/training-player-bridge.ts` posts every request to the frame's exact origin
with a one-shot `MessagePort` and accepts the reply only on that port; it posts nothing when the
frame origin is unknown. The pack-side `story_content/trainingapp-bridge.js` (fixture) accepts
requests only from `window.parent` at the exact parent origin and replies on the transferred
port. No first-party `postMessage` uses the `'*'` target (source guardrail in
`web_ui/src/lib/packs/__tests__/browser-isolation-guards.test.ts`). No bridge is injected into
packs by packtool (that would change pack hashes and signatures; a separate decision): real packs
without a bridge play in both apps but report no slide state and accept no deep-link jumps,
exactly as on desktop.

### Install path parity

- **Archive guards:** `pack-archive-rules.ts` is one rules module kept byte-identical in
  `desktop/main/backend/packs/` and `web_ui/src/lib/packs/` (drift test), consumed by desktop
  `pack-extract.ts` and the browser `pack-extract-browser.ts` (central directory first, read
  through `Blob.slice`, entries inflated by `DecompressionStream('deflate-raw')`). Same limits,
  entry-name rules, ZIP64/encrypted/compression-method refusals and messages as desktop.
- **Manifest gates and signature:** `pack-manifest.ts` and `pack-verify.ts` mirror desktop
  (docs path/sha256, index schema version, sqlite-vec pin, embedding model, then signature
  policy) with WebCrypto Ed25519 and the desktop canonicalization; shared vectors in
  `contracts/pack-signature-vectors.json` run in desktop, browser and Python tests. The
  require-signature policy and trusted keys are baked at build time
  (`VITE_TRAININGAPP_PACKS_REQUIRE_SIGNATURE`, `VITE_TRAININGAPP_PACKS_TRUSTED_KEYS`), as desktop
  bakes its environment.
- **Signature scope:** the signed manifest hashes `docs[]` only. Player JavaScript and media are
  not bound by the signature on either runtime (pre-existing). Origin isolation is the control
  for executable course content.
- **Storage:** pack files in app-origin OPFS (`trainingapp-packs-<profile>`), versions in an
  IndexedDB registry; the active version flips atomically in one transaction; a newer install
  keeps the previous version for rollback; orphan directories are collected; installs of one
  pack are serialized with Web Locks. An install is refused before any write unless the free
  browser quota is at least twice the pack's unpacked size (room to keep the previous version for
  rollback), and the app asks for persistent storage.
- **Retrieval:** the browser does not mount the prebuilt `index.sqlite` (ADR-0009's finding
  stands). It ingests the pack's slide documents into the browser keyword index at install and
  embeds them with the browser model when it is ready; every chunk carries its `packId`, so Learn
  rows carry `pack_id` and linked rows are computed at ask time.

### Updates

`pack-update-browser.ts` and `pack-update-controller.ts` mirror `desktop/main/update-checker.ts`:
off by default with zero network before opt-in, the E5 feed schema, Ed25519 over the artifact
sha256 against the build-time feed key, artifact sha256 re-verified before install, and install
through the same guarded path. Requests are https-only (request and final URL), omit credentials
and the referrer, never cache, and are size-capped. Browser limits: `fetch` cannot inspect
intermediate redirect hops (desktop validates each hop), and the feed and artifact hosts must
allow CORS from the app origin; a GitHub Releases redirect does not, so browser updates need a
CORS-enabled mirror or the desktop app. The air-gapped build (`VITE_AIRGAP=1`) refuses the
opt-in and never fetches.

### Hosting requirements

Every server that hosts the web app serves `/training-boot.html` and `/training-boot.js` with
`Cross-Origin-Resource-Policy: cross-origin`, `Cross-Origin-Embedder-Policy: require-corp` and
`nosniff`, serves `/training/sw.js`, and answers every other `/training/*` path with 404, never
the SPA shell: vite dev and preview, `serve-offline.mjs`, `start.ps1`, and `api_server.py`'s
web-archive mount (pinned by `player-origin-hosting.test.ts` and
`tests/test_api_server_training_routes.py`).

### Browser support

| Browser | Status |
|---|---|
| Chrome / Edge (Chromium) | Supported. Course playback, Range media, storage isolation and exact-origin messaging measured on Chromium 153 (plan critic rounds 2-4) and exercised by `web_ui/e2e/packs-browser.spec.ts`. |
| Chrome with the `BlockThirdPartyCookies` policy, Edge strict tracking prevention | Not measured in this trace (the player origin is third-party to the app page, so partitioned third-party service workers are required). |
| Firefox | Untested. |
| Safari | Not supported for packs or course playback; the UI says so. |

### Divergences from desktop (disclosed)

| Area | Desktop | Browser | Why |
|---|---|---|---|
| Course origin | `app://training` host | dedicated player origin + relay | no custom schemes in a browser |
| CSP | training CSP | same minus `app:`, plus `frame-ancestors 'self' <app>` | the player is embeddable only by the app |
| Prebuilt index | mounted (`index.sqlite`) | not used; slide docs re-indexed in the browser | no SQLite in the browser (ADR-0009) |
| Linked Learn rows | `links` table | computed at ask time (cosine ≥ 0.5, top 3, 4 s budget) | no links store in the browser |
| Archive CRC | JSZip default (not verified) | not verified | JSZip parity |
| Large-entry memory | JSZip inflates whole entries | streams to OPFS; in-memory reads capped at 256 MiB, central directory at 64 MiB | bounded memory on 292 MB publishes |
| Quota | disk | refused below 2× declared size free | OPFS quota is shared and smaller |
| Update redirects | each hop https-checked | final URL https-checked; CORS required | `fetch` hides hops |

## Consequences

- The browser app installs, lists, rolls back and removes packs and plays courses with the same
  UI as desktop. The ADR-0009 gate, its `pack-detect.ts` classifier and its e2e specs are
  retired; `web_ui/e2e/packs-browser.spec.ts` replaces them.
- Every new host for the web app must meet the hosting requirements above, or courses will not
  play there (installs still work).
- A future packtool bridge injection, a per-pack player origin, or signing player assets would
  each need their own decision record.
- Manual measurements the plan called for (the real 292 MB publish in Chrome and Edge, the
  enterprise-policy and strict-tracking variants, a Firefox smoke check) were not performed in
  this trace and remain open.
