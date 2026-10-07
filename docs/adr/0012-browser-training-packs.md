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
- **Remote hosting** (the app served from a non-loopback name) needs a second hostname for the
  player, configured through `player-origin.json` or the build variable and answered by a
  static-only host that serves the same files (see Hosting requirements). `api_server.py` is not
  such a host.

### Player-origin components (stateless)

- `/training-boot.html` + `/training-boot.js` (`web_ui/public/`): a hidden frame the app page
  embeds on the player origin. It registers the course service worker and passes the relay port
  the app transfers to it; it accepts the handshake only from `window.parent` at the exact
  expected parent origin. It stores nothing. The boot page is served with a restrictive header
  CSP (`default-src 'none'; script-src <player origin>/training-boot.js; worker-src <player
  origin>/training/sw.js; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src
  'none'`) whose `frame-ancestors` names only the app origin, and the app embeds it in a frame
  sandboxed with `allow-scripts allow-same-origin` (final-critic FC6, below).
- `/training/sw.js` (scope `/training/`): serves only `/training/<packId>/<rest>`; every other
  request from a worker-controlled course page (a document under `/training/`) is refused with
  404, whether it targets another path, another origin, the app shell or an app API; methods
  other than GET/HEAD get 405. The worker never sees requests from uncontrolled player-origin
  documents such as the boot page (see the static-only hosting rule below). It holds no cache
  and writes no storage; every
  response is built from relay bytes. It waits up to 10 s for a relay port, then answers 503.
  `skipWaiting` is deferred while a course page is open.

### Framing rules (review round 1)

- **Framing is denied by default (final-critic FC6).** Every player host (vite dev/preview,
  `serve-offline.mjs`, `start.ps1`) sends `Content-Security-Policy: frame-ancestors 'none'` and
  `X-Frame-Options: DENY` on every response except `/training-boot.html`: the app shell and its
  assets, `/training-boot.js`, `/training/sw.js`, the `/training/*` 404 and the server's own
  error responses. The worker's own refusals carry `default-src 'none'; frame-ancestors 'none'`.
  `api_server.py` sends the same anti-framing headers on every response when it serves the web
  archive, as the desktop renderer CSP does (`frame-ancestors 'none'`). Two reasons:
  - course content on the player origin (which shares the server) must not load a live app
    instance in a frame; that instance would treat the real app origin as its "player origin";
  - course JS can script any same-origin document it frames, and that document's `fetch`, forms
    and subresources run under the document's own policy, not the course CSP. Before FC6 a course
    could frame the CSP-less boot page (or the boot script) and send requests to any origin from
    it, measured on Chromium by the FC6 row of `web_ui/e2e/isolation-browser.spec.ts`.
- **The boot page is the one embeddable document.** Its header CSP (above) allows no fetch, no
  form, no frame and no subresource, and it pins scripts and workers to the exact URLs of
  `/training-boot.js` and `/training/sw.js`, not `'self'`. Course JS can script the boot window
  (below), and a worker it started there would run under its own script's policy, so with
  `'self'` it could run any same-origin script unconfined. Neither pinned file makes a network
  request. The boot page's `frame-ancestors` names only the app origin: the loopback alias of
  the Host the boot page was requested on (`localhost` <-> `127.0.0.1`, same port). Any other Host
  gets `'none'` for all three sources, so a host reached under another name fails closed (no
  course playback) and a Host header is never reflected. The policy is a header, not a meta tag,
  so no same-origin script can act in the document before it applies.
- **The boot frame is sandboxed** with `allow-scripts allow-same-origin` (FC6). Course JS can
  script it as a sibling, so it must not grant what the course frame's sandbox withholds. Before
  this, a `target="_blank"` link clicked inside the unsandboxed boot frame opened a popup
  (measured on Chromium by a throwaway probe; the FC6 e2e row now pins it).
- **A framed app never runs training.** When the app document is not the top-level page
  (`isFramedContext`), it has no player origin, fetches no `player-origin.json`, embeds no boot
  frame, hands out no relay port, and the Training page says the app is embedded in another
  page. This is defense in depth for a host that omits the headers.
- **The boot frame runs only directly under the top-level page** (`window.parent ===
  window.top`), with the exact parent-origin check as before.
- **The course frame is sandboxed** with `allow-scripts allow-same-origin allow-forms`: no
  popups, no top navigation, no storage-access prompts (desktop parity: the main process denies
  window.open and navigation). `allow-same-origin` keeps the course on its own origin (the
  player origin in the browser, `app://training` on desktop), which is never the app origin, so
  it grants no access to app storage or DOM; the player-origin service worker and the course's
  own storage need it.
- **Course CSP keeps `frame-src 'self'`** (desktop parity: publishes may embed their own web
  objects). On the player origin `'self'` lets a course frame only the open pack's files: every
  other player-origin document refuses to be framed by it (`frame-ancestors 'none'`, or the app
  origin only for the boot page).
- **The player origin is served by a static-only host.** The worker controls only documents
  under `/training/`. The app's own boot frame is an uncontrolled same-origin document that
  course JS can still script directly: it is a sibling in `window.parent.frames`, so no framing
  is involved. Its header CSP stops `fetch`, beacons, images, forms, frames and any script or
  worker but its own two files (the FC6 e2e row measures zero requests to a cross-origin sink
  and the CSP violations). Course JS can still send same-origin GET requests that the worker
  never sees, to any path of the server that answers the player origin, by navigating its own
  frame or the boot frame: the app-shell frame policy (item 6 below) admits the player origin
  itself. That server must serve only static files: no API
  routes, no proxies, no authenticated or state-changing endpoints. `api_server.py` carries
  the unauthenticated
  document, ask, settings and packs API, so it is not a player host: it answers the boot files,
  `/training/sw.js` and every `/training/*` path with 404, and the browser app it serves reports
  that course playback is not available on this host (it probes `/training-boot.html` before
  falling back to the loopback alias). It can still serve the app with `player-origin.json`
  naming a separate static player host that sends the hosting headers below for the
  `api_server.py` app origin; the bundled static servers cannot be that host (they admit only
  their own loopback alias as the app origin).
- **Dev-only residual.** The vite dev server answers the player origin too, and it is not
  static-only: it serves `/@fs/` (files allowed by vite's `server.fs` rules) and proxies `/api`
  and `/auth` to the local API server on port 8000. Course JS can send GET requests to all of
  them by navigation (item 6). Play only trusted courses under `npm run dev`; `vite preview`,
  `serve-offline.mjs` and `start.ps1` are static-only.

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
  window, and at most 32 reads / 64 MiB materialized at once across every port; excess reads
  are answered `busy` and the worker retries). Range requests get 206/416 with desktop
  parsing.
- Responses carry the desktop MIME table, `Cross-Origin-Resource-Policy: cross-origin`,
  `nosniff`, `no-cache`, and the training CSP: the desktop `buildTrainingCspPolicy()` without the
  private `app:` sources plus `frame-ancestors 'self' <app origin>`, with one deliberate
  divergence: `worker-src blob: <player origin>/training/<open pack>/ <player origin>/training/sw.js` instead of `'self' blob:` (pinned by
  `desktop/src/__tests__/browser-training-serving-drift.test.ts`). A worker takes its CSP from
  its own script response. On the player origin `'self'` would admit every app asset
  (`/assets/*.js`, `/training-boot.js`, `/training/sw.js`), which the host serves with only
  `frame-ancestors 'none'`, so a worker built from one would run unconfined (review round 4 F1,
  measured: the pdf.js worker ran, and an app asset registered as a service worker at
  `/assets/`). Pack scripts come from the relay with this CSP, so a worker built from one stays
  confined, and a `blob:` worker inherits its creator's policy (HTML Standard, "run a worker": a
  local-scheme worker URL gets a clone of the owner's policy container). A service worker
  registered on a pack path is fetched past the relay and gets the host's reserved `/training/*`
  404. Relay refusals carry the same pin for the open pack (`blob:` alone when none is open).
  Desktop keeps `'self' blob:`: every successful `app://training` response carries the training
  CSP, so a `'self'` worker stays confined there. Its error responses (403/404,
  `desktop/main/protocol.ts` `forbidden`/`notFound`) carry the renderer CSP with
  `frame-ancestors 'none'` instead, but a 4xx can never be loaded as a worker script, and the
  renderer CSP belongs to a different origin. Course documents also carry
  `Cross-Origin-Embedder-Policy: require-corp`, without which the app's COEP blocks the frame.

### Threat model — nothing on the player origin is trusted

1. Course JS can read the app's boot frame DOM (a same-origin sibling), take any port the boot
   frame holds, and send the worker its own handshake. It cannot frame a boot page of its own
   (`frame-ancestors`). It can also SUPPLY the worker a relay port of its own and answer the
   worker's requests itself (final-critic round 3, NC1). The worker accepts a relay port only
   from the boot page client, but that check is defense in depth only: course JS can post
   through the boot frame's own controller. What bounds this is that the worker OWNS the
   security headers of every relay-served response. It computes the course CSP itself, with the
   pack id from the request path and its own origin (`courseCsp` in `sw.js`, kept in lockstep with
   `buildBrowserTrainingCsp` by `player-origin-hosting.test.ts`, which also pins the header
   ownership with unit tests; a real-browser regression row for the injection is tracked in
   follow-up #145). It forces COEP, COOP, CORP,
   nosniff and cache-control. From the relay it takes only an allowlisted status
   (200/206/403/404/405/416/429; anything else becomes a deny-all 502), the body, and
   `content-type`, `content-range` and `accept-ranges`. A relay-supplied CSP, `Set-Cookie`,
   `Location` or other header is dropped. A course that becomes its own relay can therefore only
   serve bytes that run under the course CSP on pack paths, which it could do anyway by shipping
   them in its pack; on another pack's path they get that pack's pinned `worker-src`. The app
   origin in the worker's `frame-ancestors` comes from the worker's own script URL
   (`/training/sw.js?app=<origin>`, set by the boot page from `location.ancestorOrigins`). It is
   validated (a bare origin, http only for loopback, loopback-only for a loopback player),
   falls back to the loopback alias, and otherwise to `'self'` only. Course JS can re-register the
   worker with a different `app` value through the boot frame; that changes only who may frame
   course documents, never the content directives. Residual, not fixed: a course that displaces
   the app's relay port denies playback to itself and, until their next re-handshake, to course
   frames in other app tabs of the same profile, and can show them content of its choosing under
   their pack's CSP (an extension of item 4). Recreating the boot frame and port on every course
   open raises the bar against stale instances but does not stop a live malicious course.
2. The app's relay port can read only files of the open pack's active version, inside its player
   asset directory, with bounded sizes and rates.
3. The worker and boot page never read or write player-origin Cache Storage, IndexedDB, OPFS or
   localStorage, so nothing a course writes is served to another pack.
4. **Shared untrusted player origin.** All packs share one player origin, as all packs share
   `app://training` on desktop. A live malicious pack cannot reach app data, but within a session
   it can interfere with the player origin, for example spoof what another pack's frame
   displays. Only one course is open at a time and the relay serves only the open pack, which
   limits this, but it is not prevented. This is parity with desktop.
5. Isolation from the app is by origin: app IndexedDB, localStorage, OPFS, Cache Storage and DOM
   are unreachable from course JS. Course JS reaches the app only through the slide bridge
   (exact origins, below) and the scoped relay, provided the player origin is served by a
   static-only host. The worker refuses only requests from worker-controlled course pages.
   Course JS cannot frame any other player-origin document, and the boot frame it can script
   allows no `fetch`, forms, beacons, images, popups or top navigation, and runs no script or
   worker but its own two files. The course's own `worker-src` admits only `blob:`, the open
   pack's relay path and the course service worker's own script `/training/sw.js` (Firefox needs it to start controlled dedicated workers; CSP matches that source against the percent-decoded path and ignores the query, so it also admits encoded spellings such as `/training/sw%2ejs` and `/training/%73w.js`. The service worker itself answers 404, before asking the relay, to every request whose path, decoded repeatedly, equals `/training/sw.js` exactly (case-sensitive, like CSP), and to any path that does not decode (the repeated decode stops being followed after 8 passes: a path still changing then fails closed, as refused). So a worker on that script never runs, whoever holds the relay port), so it cannot start an app asset as an unconfined worker or service worker
   (review round 4 F1; the worker-escape row of `web_ui/e2e/isolation-browser.spec.ts`).
6. **Navigation egress (closed).** CSP on a course document does not govern navigation of the
   course's own frame or of the boot frame (a frame the course creates is governed by the course
   CSP's `frame-src`): a course
   could navigate its own frame, or the boot frame through the boot frame's DOM (a link it inserts
   and clicks), to any URL and carry data in the address. Both were measured on Chromium before
   this fix. What decides where a frame may navigate is the EMBEDDING page's `frame-src` (for a
   frame the course itself creates, that is the course CSP's `frame-src 'self'`, pinned by the
   grandchild-iframe row of `web_ui/e2e/isolation-browser.spec.ts`). On
   desktop that is the renderer CSP's `frame-src 'self' app:`. In the browser app the app shell
   installs, once the player origin resolves, a runtime
   `<meta http-equiv="Content-Security-Policy" content="frame-src <player origin>">`
   (`installPlayerFramePolicy`, `web_ui/src/lib/packs/player-origin.ts`). The browser then
   refuses any navigation of either player frame to another origin before a request is sent.
   - **Ordering.** A meta CSP can only tighten, so it cannot be installed for the loopback-alias
     prediction and widened to a configured origin later. Neither player frame loads a
     player-origin URL before the policy for the RESOLVED origin is in place
     (`getResolvedPlayerOrigin`): the course frame stays `about:blank`, and the boot frame waits
     on the host's `framePolicyReady` gate. This also makes the app-wide course host always use
     the resolved origin. Before, it could be built for the alias prediction while the course
     frame used a configured origin.
   - **Why not a host header.** Policies from several headers intersect, and a host cannot know
     a player origin configured by `player-origin.json` or `VITE_TRAININGAPP_PLAYER_ORIGIN`. The
     policy is a runtime meta, installed once, browser app only.
   - **Not under Electron.** The renderer CSP already carries `frame-src 'self' app:`, and a
     second policy would intersect with it and block `app://training`. Not in a framed app,
     which plays nothing.
   - **Pinned by** `web_ui/src/lib/packs/__tests__/player-frame-policy.test.tsx` (unit) and by
     the navigation-egress row of `web_ui/e2e/isolation-browser.spec.ts`. That row asserts zero
     requests to a cross-origin sink; with the meta install removed, both requests reach it.
   - **Still open by design.** Navigation inside the player origin stays allowed, which is why
     the static-only host rule stays.
   - **Residual on both platforms.** Chromium's CSP does not govern WebRTC (STUN/TURN candidate
     gathering) or DNS prefetch, so a course can still signal out through those channels. This
     closes navigation egress; it does not seal every egress channel.

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
  - **Eviction and recovery (PR 144 review F1).** The persistence request is fire-and-forget and
    the browser may deny it. If the browser evicts the origin's storage, the pack bytes and the
    registry go together (eviction is origin-wide), so the evicted packs disappear from the
    list; nothing is restored automatically. The only recovery is to reinstall the pack from
    its `.zip` (a feed update does not help: it skips packs that are not installed). Packs shows
    "(not persistent: the browser may evict installed packs under storage pressure)" when
    persistence was not granted.
  - **No Web Locks (PR 144 review F6).** Without Web Locks the install lock falls back to a
    per-tab promise chain, so two tabs installing different versions of one pack concurrently
    could leave two active rows. Every supported engine has Web Locks; the state is recoverable
    with a rollback to the intended version.
- **Retrieval:** the browser does not mount the prebuilt `index.sqlite` (ADR-0009's finding
  stands). It ingests the pack's slide documents into the browser keyword index at install and
  embeds them with the browser model when it is ready; every chunk carries its `packId`, so Learn
  rows carry `pack_id` and linked rows are computed at ask time. The post-install keyword-index
  ingest is best-effort and does not resume: a failure is logged, the pack stays installed and
  active, and its slides are not searchable until the pack is removed and reinstalled
  (reinstalling the same active version is refused) or rolled back and re-activated (which
  re-runs the ingest); only the embedding half resumes, on `embedding-service-ready`.

### Updates

`pack-update-browser.ts` and `pack-update-controller.ts` mirror `desktop/main/update-checker.ts`:
off by default with zero network before opt-in, the E5 feed schema, Ed25519 over the artifact
sha256 against the build-time feed key, artifact sha256 re-verified before install, and install
through the same guarded path. Requests are https-only (request and final URL), omit credentials
and the referrer, never cache, and are size-capped. Browser limits: `fetch` cannot inspect
intermediate redirect hops (desktop validates each hop). This is an accepted residual (review
round 1 ruling): hops carry no credentials or referrer, and integrity rests on the signed sha256
plus the Ed25519 signature, re-verified before install. The feed and artifact hosts must
allow CORS from the app origin; a GitHub Releases redirect does not, so browser updates need a
CORS-enabled mirror or the desktop app. The air-gapped build (`VITE_AIRGAP=1`) refuses the
opt-in and never fetches.

### Hosting requirements

A server that answers the player origin must serve only static files (no API routes, proxies
or authenticated endpoints; see "The player origin is served by a static-only host"). Such a
server:
- serves `/training-boot.html` and `/training-boot.js` with
  `Cross-Origin-Resource-Policy: cross-origin`, `Cross-Origin-Embedder-Policy: require-corp` and
  `nosniff`, and serves `/training/sw.js`;
- answers every other `/training/*` path with 404, never the SPA shell;
- serves `/training-boot.html` with the boot page header CSP, whose `frame-ancestors` is the app
  origin only, and no `X-Frame-Options`;
- sends `Content-Security-Policy: frame-ancestors 'none'` plus `X-Frame-Options: DENY` on every
  other response, error responses included;
- sends no `frame-src`, `child-src` or restrictive `default-src` on the APP pages. The app adds its
  own runtime `frame-src <player origin>` (threat model item 6), and a host policy would intersect
  with it and could block the player frames.

Compliant hosts: `vite preview`, `serve-offline.mjs` and `start.ps1`, and `vite dev` with the
dev-only residual above. The vite middleware and `serve-offline.mjs` are pinned behaviorally by
`player-origin-hosting.test.ts`, and `start.ps1` by source scan only (Windows PowerShell; no test
harness). A host that answers the player origin under a separately configured origin
(`player-origin.json` or `VITE_TRAININGAPP_PLAYER_ORIGIN`) must send the same headers, with
`frame-ancestors` naming its app origin and the script and worker sources naming its own origin.
The bundled hosts derive these only for the loopback alias of their own port, so they cannot
serve as a separately configured player host: their boot page refuses any other app origin. Residual: an error the HTTP stack generates before the script sees the request (for
example an http.sys 400/403 under `start.ps1`) carries none of these headers. It carries no COEP
either, so the COEP `require-corp` app page and course pages cannot embed it.

`api_server.py`'s web-archive mount is an app host only: it sends COOP/COEP and the anti-framing
headers on every response and answers the boot files, `/training/sw.js` and every `/training/*`
path with 404 (pinned by `tests/test_api_server_training_routes.py`).

### Browser support

| Browser | Status |
|---|---|
| Chrome / Edge (Chromium) | Supported. Course playback, Range media, storage isolation and exact-origin messaging measured on Chromium 153 (plan critic rounds 2-4) and exercised by `web_ui/e2e/packs-browser.spec.ts`. |
| Chrome with the `BlockThirdPartyCookies` policy, Edge strict tracking prevention | Not measured in this trace (the player origin is third-party to the app page, so partitioned third-party service workers are required). |
| Firefox | Firefox 112 or newer supported; older Firefox is unsupported (no native `inert`), with the same upfront notice (decided after this ADR; PR #151 review, PRR-151-030). The browser e2e suite runs under both Chromium and Firefox in the required `web-ui e2e` CI job, including all six player-origin isolation specs in `web_ui/e2e/isolation-browser.spec.ts`. Five observe through out-of-band `postMessage` reports (Playwright's Firefox cannot reach into the course frame under COOP/COEP); the click-activation spec launches its own Firefox with Fission disabled (`MOZ_FORCE_DISABLE_FISSION=1`) because Playwright cannot send input into an out-of-process frame (microsoft/playwright#21780). Only the test browser's process model changes; real users are not expected to be affected. Firefox requires the course document's `worker-src` to admit the course service worker's script before it will start service-worker-controlled dedicated workers, which is why the list below names `/training/sw.js`. Engine difference, benign: Chromium's course frame is not `crossOriginIsolated` (the permissions-policy default) while Firefox reports true. |
| Safari and every other WebKit browser (including all iOS/iPadOS browsers) | Not supported for packs or course playback; the app says so up front: `browser-compat.ts` classifies them as unsupported and the browser app shows a dismissible notice at load, and the player's start-failure message names Safari as unsupported. |

### Divergences from desktop (disclosed)

| Area | Desktop | Browser | Why |
|---|---|---|---|
| Course origin | `app://training` host | dedicated player origin + relay | no custom schemes in a browser |
| CSP | training CSP | same minus `app:`, plus `frame-ancestors 'self' <app>`, and `worker-src blob: <player origin>/training/<open pack>/ <player origin>/training/sw.js` instead of `'self' blob:`; every other player-origin document refuses framing, and the boot page has its own header CSP (FC6) | the player is embeddable only by the app; course JS can frame no weaker same-origin document and start no app asset as a worker (on the player origin `'self'` reaches app assets served without the course CSP) |
| Course frame navigation | renderer `frame-src 'self' app:` refuses off-origin navigation of the course frame | runtime app-shell meta `frame-src <player origin>` refuses off-origin navigation of the course frame and the boot frame | a browser host cannot know a configured player origin, and header policies intersect (threat model item 6) |
| Prebuilt index | mounted (`index.sqlite`) | not used; slide docs re-indexed in the browser | no SQLite in the browser (ADR-0009) |
| Linked Learn rows | `links` table | computed at ask time (cosine ≥ 0.5, top 3, 4 s budget) | no links store in the browser |
| Archive CRC | JSZip default (not verified) | not verified | JSZip parity |
| Slide docs without a `text` field | refused unless the pack ships a prebuilt index | accepted (slide fields are re-indexed in the browser) | the browser never uses the prebuilt index; accepted parity difference (review round 1 ruling) |
| Large-entry memory | JSZip inflates whole entries | streams to OPFS; in-memory reads capped at 256 MiB, central directory at 64 MiB | bounded memory on 292 MB publishes |
| Quota | disk | refused below 2× declared size free | OPFS quota is shared and smaller |
| Update redirects | each hop https-checked | final URL https-checked; CORS required | `fetch` hides hops |

## Consequences

- The browser app installs, lists, rolls back and removes packs and plays courses with the same
  UI as desktop. The ADR-0009 gate, its `pack-detect.ts` classifier and its e2e specs are
  retired; `web_ui/e2e/packs-browser.spec.ts` replaces them.
- Every new host for the web app must meet the hosting requirements above, or courses will not
  play there (installs still work). A host that also runs an API must not answer the player
  origin; the browser app served by `api_server.py` plays no courses unless `player-origin.json`
  names a separate static player host that sends the hosting headers for that app origin (not one
  of the bundled static servers, which admit only their own loopback alias).
- The course-frame sandbox (`allow-scripts allow-same-origin allow-forms`) also applies on
  desktop. On both runtimes a course can no longer open modal dialogs (`alert`, `confirm`,
  `prompt`), call `window.print()` (no `allow-modals`), or start downloads from the frame. Course
  links that open a new window (`target="_blank"` or `window.open`) do nothing (no
  `allow-popups`).
- A future packtool bridge injection, a per-pack player origin, or signing player assets would
  each need their own decision record.
- Manual measurements the plan called for (the real 292 MB publish in Chrome and Edge, the
  enterprise-policy and strict-tracking variants, a Firefox smoke check; Firefox is now covered by the CI e2e suite, see Browser support) were not performed in
  this trace and remain open.
