# Knowledge Pack Security: Threat Model and Install Gate (issue #75)

Scope: the Knowledge Pack installation surface — every path that turns
pack bytes into an installed pack: the Python `PackManager`
(`pack_manager.py`, whose zip-upload extractor lives behind the
`POST /packs/install` route in `api_server.py` and shares `pack_extract.py`),
the Node `PackManager` (`desktop/main/backend/store/pack-manager.ts` with
its zip extractor `pack-extract.ts`), the browser app's pack manager
(`web_ui/src/lib/packs/browser-pack-manager.ts` with its extractor
`pack-extract-browser.ts`, ADR-0012), and `packtool verify` (the offline
gate over the same dispositions). This document cross-references
`docs/security/desktop.md` (the desktop transport threat model, issue #60)
and is cross-referenced from it. Pack format semantics are frozen by C1
(`contracts/pack.schema.json`); Python-side server hardening generally is
`docs/archive/pre-v3/security_hardening_guide.md`.

## Architecture invariants

1. **Every install path passes the shared validation core.** The checks
   live in ONE module per language — Python `pack_extract.py` (consumed by
   both the api_server zip route and `pack_manager.install`) and the Node
   twin `desktop/main/backend/packs/pack-extract.ts` (consumed by both the
   zip-upload surface and `pack-manager.ts`) — with `packtool verify`
   enforcing the same entry-safety and limit rules on ZIP-form packs via
   `packtool/build/zip-safety.ts` and the manifest-level rules via
   `packtool/build/pack-json.ts`. (packtool and desktop are separate npm
   packages with no workspace root; cross-package parity is pinned by the
   frozen C8/C11 checks.) The browser app shares the desktop rules through
   `pack-archive-rules.ts`, kept byte-identical in
   `desktop/main/backend/packs/` and `web_ui/src/lib/packs/` (drift test
   `desktop/src/__tests__/pack-archive-rules-drift.test.ts`), and runs the
   desktop manifest gates and Ed25519 check (`pack-manifest.ts`,
   `pack-verify.ts`) against the shared vectors in
   `contracts/pack-signature-vectors.json`. A new check goes into a shared
   core, never into a caller only.
2. **Containment is proven on the RESOLVED path, never on token shape
   alone.** An entry name is first rejected by `safeEntryName` /
   `safe_entry_name` (empty, backslash, leading `/`, drive-relative or
   drive-absolute names matching `^[A-Za-z]:`, `..`/`.` path elements,
   NUL/control characters), and the resolved target —
   `os.path.normpath(join(root, name))` on the Python side,
   `path.relative`-based containment on the Node side — is then verified
   against the extraction root with a trailing-separator-safe,
   case-insensitive-on-Windows comparison BEFORE any bytes are written.
   Token-shape guards (element equality, `isAbsolute`) are the exact RC1
   defect class this invariant exists to kill: `E:../x.txt` passes both
   yet `ntpath.join` treats its drive-letter segment as a new anchor and
   silently discards the extraction root.
3. **sha256 verification is mandatory and fail-closed.** Every
   `docs[].sha256` in the manifest is verified against the extracted file
   bytes BEFORE any chunking or insert; a mismatch refuses the install
   with zero chunks written and no partial state.
4. **Compatibility gates refuse before any write or insert.** The
   embedding-model, `index.schema_version`, and `index.sqlite_vec_version`
   comparisons run after manifest validation and before the symlink
   walk/copytree/chunking — a mismatch is an explicit refusal, never an
   auto-migration and never a warning.
5. **Limits are config, not constants.** Byte, entry, and ratio caps plus
   signature policy are read from configuration (see Configuration
   surface) with the issue-pinned defaults; none is a module-level
   constant.

## Threats and mitigations

### Path traversal
- **Threat:** a crafted entry name in an uploaded pack zip writes outside
  the extraction root — classic zip-slip, including drive-relative
  variants (`E:../x.txt`, `C:/evil`) that defeat token-shape guards
  because `ntpath.join` treats a drive-letter segment as a new anchor and
  discards the temp root entirely.
- **Mitigations:**
  - `safeEntryName` / `safe_entry_name` rejects the malformed name classes
    outright: empty, `\`, leading `/`, drive-relative/absolute
    (`^[A-Za-z]:`), `..`/`.` elements, NUL/control chars.
  - `ensureContained` / `ensure_contained` then proves containment on the
    RESOLVED path (normpath/relative, trailing-separator-safe,
    case-folded on Windows) — guard G2 of the extraction matrix, enforced
    before ANY write. The guard order is safest-first: per-entry name and
    symlink validation precede even the manifest-presence check (G1), and
    symlink entries are refused on `external_attr` (G3).
  - Both extractors (Python `safe_extract_pack_zip`, Node `extractPackZip`)
    share these rules, and `packtool verify` re-checks `docs[].path`
    shape offline — one disposition vocabulary across every install path.

### Zip bomb
- **Threat:** an archive whose decompressed content vastly exceeds its
  compressed size exhausts disk or memory during extraction.
- **Mitigations:**
  - Declared-size pre-filter (G4): the sum of declared uncompressed entry
    sizes is checked against `packs.security.maxUncompressedBytes`
    (default 2147483648, i.e. 2 GiB) before decompression starts.
  - Declared-ratio pre-filter (G5): total declared uncompressed size over
    total declared compressed size (directory and zero-size entries
    skipped) is checked against `packs.security.maxCompressionRatio`
    (default 100).
  - Unspoofable backstop (G6): a written-bytes cap — streaming with a
    running total in Python, post-hoc in Node — bounds actual disk writes
    regardless of what the archive declared. Declared metadata is
    advisory; written bytes are truth.

### Entry-count bomb
- **Threat:** a huge number of tiny entries slips under the byte caps and
  exhausts file handles, inodes, or extraction time instead.
- **Mitigations:** the archive's entry count is capped by
  `packs.security.maxEntries` (default 5000) before extraction; the Node
  central-directory pre-parser enforces the same bound from archive
  metadata, and the ZIP32 limit itself refuses >65535 entries outright
  (see Known limits).

### Tampering
- **Threat:** pack contents are modified after build (or in transit) so
  that chunk text no longer matches the hashed bytes the index was built
  from — silent misalignment rather than a crash.
- **Mitigations:** `docs[].sha256` verification is mandatory and
  fail-closed: the manifest's hash is compared against the extracted file
  bytes BEFORE any chunking or insert, and any mismatch refuses the
  install with zero chunks written (present at base and preserved by C8;
  the compatibility gates below run before the copytree/chunking stage so
  a refused pack leaves no partial state).

### Embedding model mismatch
- **Threat:** a pack built for a different embedding model installs into
  a live index; every vector is silently misaligned with the chunk text
  beside it.
- **Mitigations:**
  - The gate compares `embedding.model_id` against the install target
    after canonicalization (basename via strip-through-last-`/`,
    casefold) so `BAAI/bge-small-en-v1.5` and `bge-small-en-v1.5` agree.
  - A mismatch refuses with an explicit remedy telling the operator to
    rebuild the pack with `packtool build-docs --embedding-model`.
  - Gate target: the live embedder's model id — Python resolves it from
    `settings.rag_embedding_model` (canonicalized), Node from
    `packs.security.embeddingModelId` overridable via
    `TRAININGAPP_PACKS_EMBEDDING_MODEL_ID`, defaulting to the ADR-0006 pin
    `bge-small-en-v1.5`. `packtool verify` applies the same refusal when
    `--embedding-model` is passed (advisory warning otherwise).

### Schema/sqlite-vec mismatch
- **Threat:** a pack built against a different store schema or a
  different sqlite-vec extension version installs and corrupts or
  misreads the index.
- **Mitigations:** `index.schema_version` is pinned to 3 and
  `index.sqlite_vec_version` to 0.1.9; any deviation is REFUSED with an
  explicit error when an `index` block is present (packs without one
  bypass both stamp gates by design, matching the C1 fixtures) — never
  auto-migrated. The pins mirror the packtool build-time stamps so a pack
  cannot be built for one version and installed into another.

### Unsigned packs
- **Threat:** no provenance — anyone can build a structurally valid pack,
  so the structural gates above prove shape, not origin.
- **Mitigations:** opt-in ed25519 signature verification, config
  `packs.security.requireSignature` (default false) and
  `packs.security.trustedKeys` (a list of `{key_id, public_key}` pairs,
  public key as base64 DER SPKI). The signature is verified over
  CANONICAL manifest bytes: the `pack.json` object with
  signature block removed, keys recursively sorted at every depth
  (arrays keep order), compact separators `(",", ":")`, raw UTF-8 output
  with no `\uXXXX` escapes, and integers only — a non-integer number
  fails closed as unverifiable rather than risk cross-language
  repr divergence. Python verifies via `cryptography` ed25519; Node via
  `node:crypto` DER SPKI keys; `packtool verify` accepts the same
  `--require-signature` / `--trusted-keys-file` semantics.

### Key rotation and revocation (`trustedKeys`)
- **Additive key sets.** `trustedKeys` is a set, not a single anchor. A
  pack's signature names a `key_id`; the verifier looks that id up in the set
  and verifies against the matching key (an id that is absent fails closed, and
  so does a non-ed25519 key). Any number of keys can be trusted at once, so
  adding a key never invalidates packs signed by the keys already present.
  `key_id`s must be unique within a keyset: with duplicates, browser and
  desktop use the first match, while Python tries every matching key.
- **Rotate.** (1) Generate the new ed25519 keypair offline and keep the
  private half out of every repository. (2) Add `{key_id, public_key}` to the
  set (desktop: `TRAININGAPP_PACKS_TRUSTED_KEYS`; Python:
  `RAG_PACKS_SECURITY_TRUSTED_KEYS`; browser: ship a build with a new
  `VITE_TRAININGAPP_PACKS_TRUSTED_KEYS`, since that value is baked in at
  build time). (3) Sign new packs with the new `key_id`. (4) Once packs
  signed by the old key are no longer being installed, remove the old key
  from the set.
- **Revoke / retire.** There is no revocation list and no key expiry:
  retiring a key means removing it from the set (and, for the browser,
  shipping a new build). Retirement only has an effect when
  `requireSignature` is enabled (it defaults to false on every runtime); with
  it off the trusted set is never consulted and unsigned or tampered packs
  install. With it on, a pack signed only by the retired key is refused at
  install with a not-in-the-trusted-keyset error (browser and desktop:
  `signature key_id '<id>' is not in the trusted keyset`; Python:
  `... is not in packs.security.trustedKeys`). The gate runs at install
  time only: packs already installed are not re-verified, and a rollback or
  re-activation of a retained version does not re-check the signature (a
  registry flip on the browser, desktop and Python managers). To purge content
  signed by a compromised key, also remove its installed packs (and their
  retained versions) explicitly.
- **Separate anchors.** The update feed has its own trust anchor
  (`VITE_TRAININGAPP_UPDATE_TRUSTED_KEYS` in the browser, the baked key in
  `desktop/main/update-checker.ts` on desktop); its rotation is described in
  ADR-0010 and `docs/updates.md`. Rotating the pack-signing set does not
  change it.

## Browser app: install path and course isolation (ADR-0012)

- **Install.** The browser extractor reads the central directory first
  (through `Blob.slice`, bounded to 64 MiB), applies the shared limits,
  entry-name rules, symlink/encrypted/compression-method/ZIP64 refusals and
  the desktop messages, then inflates entries with
  `DecompressionStream('deflate-raw')` straight into OPFS, counting written
  bytes against each entry's declared size and the total cap. Entries read
  into memory (`pack.json`, docs being hashed) are capped at 256 MiB. Manifest
  gates and the signature policy run before any file is written.
- **Trust policy** is baked at build time (`VITE_TRAININGAPP_PACKS_REQUIRE_SIGNATURE`,
  `VITE_TRAININGAPP_PACKS_TRUSTED_KEYS`, `VITE_TRAININGAPP_PACKS_EMBEDDING_MODEL_ID`),
  as desktop bakes its environment; nothing reads a runtime-editable trust
  anchor.
- **Signature scope.** The signed manifest hashes `docs[]` only. Player
  JavaScript and media are not covered on either runtime; origin isolation is
  the control for executable course content.
- **Course isolation.** Course JS runs on a dedicated player origin, never the
  app origin, so it cannot read app IndexedDB, localStorage, OPFS, Cache
  Storage or DOM (documents, settings, the external-model API key). Nothing on
  the player origin is trusted: the app-side relay serves only the open pack's
  active version, with the desktop `resolveTrainingRequest` containment rules
  (shared vectors `contracts/training-path-vectors.json`), bounded reads and a
  request-rate window. The player-origin worker and boot page store nothing.
  The worker refuses other requests only from worker-controlled course pages
  (documents under `/training/`). Course JS can still script the app's boot
  frame (a same-origin sibling). The boot frame's header CSP blocks `fetch`,
  forms, beacons, images, frames and every script or worker but its own two
  files, and its sandbox blocks popups and top navigation. Course JS can still
  send GET requests to any path of the server that answers the player origin by
  navigating its own frame or the boot frame (the app-shell frame policy admits
  the player origin itself). That server must therefore serve
  only static files. `api_server.py` (unauthenticated API) is not a player
  host: it answers the boot files, the worker and every `/training/*` path
  with 404. `vite dev` also serves `/@fs/` and proxies `/api`/`/auth` on the
  player origin (dev-only residual: GET requests by navigation).
- **Framing (final-critic FC6).** Framing is denied by default on every player
  host: every response except `/training-boot.html` carries
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`. That covers the app
  shell and assets, `/training-boot.js`, `/training/sw.js`, the
  `/training/*` 404, error responses, and the worker's own refusals, which
  also carry `default-src 'none'`. A course therefore cannot frame a
  same-origin player document that would run under a weaker policy than its
  own CSP. The boot page carries a restrictive header CSP: `default-src
  'none'`, `connect-src 'none'`, `form-action 'none'`, and `script-src` /
  `worker-src` pinned to the exact URLs of `/training-boot.js` and
  `/training/sw.js` (a worker started from the boot window would otherwise run
  any same-origin script under that script's own, unrestricted policy). Its
  `frame-ancestors` names only the app origin (the loopback alias of the
  request Host; any other Host gets `'none'` for all three). The app embeds
  the boot page in a frame sandboxed with `allow-scripts allow-same-origin`. Pinned by `player-origin-hosting.test.ts` (vite middleware and
  `serve-offline.mjs` behaviorally, `start.ps1` by source scan) and by the
  FC6 row of `web_ui/e2e/isolation-browser.spec.ts`, which counts zero
  requests to a cross-origin sink. A framed app never runs training (no player
  origin, no boot frame, no relay port), and the boot frame runs only directly
  under the top-level page.
- **Navigation egress (closed).** CSP on a course document does not govern
  navigation of the course's own frame or the boot frame, where the embedding
  page's `frame-src` decides; a frame the course creates is governed by the
  course CSP's `frame-src`. Desktop's renderer CSP
  carries `frame-src 'self' app:`. Once the player origin resolves, the
  browser app installs a runtime `frame-src <player origin>` meta CSP, once,
  never under Electron or in a framed app. Neither player frame loads a
  player-origin URL before it is in place. So a course can no longer navigate
  its own frame, or the boot frame through its DOM, to another origin with
  data in the URL; Chromium refuses it before a request is sent. Pinned by
  `player-frame-policy.test.tsx` and the navigation-egress row of
  `web_ui/e2e/isolation-browser.spec.ts` (ADR-0012, threat model item 6).
  Navigation within the player origin stays allowed, hence the static-only
  host rule.
- **Course workers (review round 4 F1).** The course CSP's `worker-src` is
  `blob:` plus the open pack's relay path
  (`<player origin>/training/<pack>/`), not `'self'`. On the player origin
  `'self'` admits every app asset, which the host serves without the course
  CSP, and a worker takes its policy from its own script response; before the
  pin, a course could run the pdf.js worker unconfined and register an app
  asset as a service worker. Pack scripts carry the course CSP and `blob:`
  workers inherit it, so both stay confined. Pinned by
  `training-relay.test.ts`, the two drift tests and the worker-escape row of
  `web_ui/e2e/isolation-browser.spec.ts`. Desktop keeps `'self' blob:`
  because every successful `app://training` response carries the training
  CSP; its 403/404 responses carry the renderer CSP with
  `frame-ancestors 'none'`, and a 4xx can never be loaded as a worker
  script.
- **Residual egress (both platforms).** Chromium's CSP does not govern WebRTC
  (STUN/TURN) or DNS prefetch. Course JS can still signal out through them.
  Navigation egress is closed; egress is not sealed.
- **Course frame sandbox.** `allow-scripts allow-same-origin allow-forms`: no popups, no top
  navigation, no storage-access prompts. `allow-same-origin` keeps the course on its own origin
  (player origin / `app://training`), never the app's.
- **Relay memory bound.** At most 32 reads / 64 MiB in flight across every relay port; excess
  reads are answered `busy` and retried by the worker.
- **Shared player origin (accepted, desktop parity).** All packs share one
  player origin, as all packs share `app://training` on desktop. A live
  malicious pack can interfere with the player origin within a session (for
  example spoof what another pack's frame displays) but cannot reach app data.
- **Relay-port injection (final-critic round 3, NC1).** Course JS can hand
  the player-origin worker a relay port of its own, directly or through the
  boot frame's controller, and answer the worker's requests itself. The
  worker accepts ports only from the boot page client (defense in depth), and
  it OWNS the security headers of every relay-served response: it computes the
  course CSP from the request path, forces COEP/COOP/CORP/nosniff, and takes
  from the relay only an allowlisted status, the body, and
  `content-type`/`content-range`/`accept-ranges`. A course that becomes its
  own relay can therefore serve only bytes that run under the course CSP on
  pack paths. Residual: it can deny playback (and spoof course content under
  the other pack's CSP) in other app tabs until they re-handshake. Pinned by
  the worker unit tests in `player-origin-hosting.test.ts`; a real-browser
  regression row is not yet written and is tracked in follow-up #145.
- **Storage eviction.** Persistent storage is requested fire-and-forget and
  may be denied. If the browser evicts the origin's storage, installed pack
  bytes and the registry go together (eviction is origin-wide), so the evicted
  packs disappear from the list; nothing is restored automatically. The only recovery is to reinstall the pack from its `.zip`
  (a feed update does not help: it skips packs that are not installed). Packs shows
  "(not persistent: the browser may evict installed packs under storage
  pressure)" when persistence was not granted.
- **Install concurrency.** Installs of one pack are serialized with Web Locks.
  Without Web Locks (no supported engine lacks them) the lock falls back to a
  per-tab chain, so concurrent installs of different versions from two tabs
  could leave two active rows; roll back to the intended version to recover.
- **Search indexing.** The post-install keyword-index ingest is best-effort and
  does not resume: a failure is logged, the pack stays installed and active,
  and its slides are not searchable until the pack is removed and reinstalled
  (reinstalling the same active version is refused) or rolled back and
  re-activated. Only the embedding half resumes (on
  `embedding-service-ready`).
- **Messaging.** The slide bridge uses exact target origins and one-shot
  `MessagePort` replies; no first-party `postMessage` uses `'*'` (source
  guardrail `web_ui/src/lib/packs/__tests__/browser-isolation-guards.test.ts`).
- **Updates.** The browser update channel is opt-in (zero network before
  opt-in), https-only on the request and final URL, credential-free, size
  capped, verifies the Ed25519 feed signature and the artifact sha256, and
  installs through the guarded path. It cannot validate intermediate redirect
  hops (`fetch` hides them; desktop checks each hop): an accepted residual, since
  hops carry no credentials or referrer and integrity rests on the signed sha256
  plus Ed25519. It needs a CORS-enabled feed host. Air-gapped builds refuse it.
- **Parity difference (accepted).** Slide documents without a `text` field are
  accepted in the browser (slide fields are re-indexed there) but refused on
  desktop unless the pack ships a prebuilt index.

## Configuration surface

Canonical keys are `packs.security.*`; each backend spells them as
follows. Defaults: `maxUncompressedBytes` 2147483648 (2 GiB),
`maxEntries` 5000, `maxCompressionRatio` 100, `requireSignature` false,
`trustedKeys` empty.

Python (`config.py` field, env alias):

| Canonical key | config field | Env alias |
|---|---|---|
| maxUncompressedBytes | `rag_packs_security_max_uncompressed_bytes` | `RAG_PACKS_SECURITY_MAX_UNCOMPRESSED_BYTES` |
| maxEntries | `rag_packs_security_max_entries` | `RAG_PACKS_SECURITY_MAX_ENTRIES` |
| maxCompressionRatio | `rag_packs_security_max_compression_ratio` | `RAG_PACKS_SECURITY_MAX_COMPRESSION_RATIO` |
| requireSignature | `rag_packs_security_require_signature` | `RAG_PACKS_SECURITY_REQUIRE_SIGNATURE` |
| trustedKeys | `rag_packs_security_trusted_keys` | `RAG_PACKS_SECURITY_TRUSTED_KEYS` |

`RAG_PACKS_SECURITY_TRUSTED_KEYS` is a JSON string
(`[{"key_id": ..., "public_key": ...}]`, base64 DER SPKI). The embedding
gate target is `settings.rag_embedding_model` (canonicalized; default
`BAAI/bge-small-en-v1.5`).

Node (`BackendHostConfig.packsSecurity` fields, env override):

| Canonical key | Env |
|---|---|
| maxUncompressedBytes | `TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES` |
| maxEntries | `TRAININGAPP_PACKS_MAX_ENTRIES` |
| maxCompressionRatio | `TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO` |
| requireSignature | `TRAININGAPP_PACKS_REQUIRE_SIGNATURE` |
| trustedKeys | `TRAININGAPP_PACKS_TRUSTED_KEYS` |
| embeddingModelId | `TRAININGAPP_PACKS_EMBEDDING_MODEL_ID` |

`TRAININGAPP_PACKS_TRUSTED_KEYS` uses the same JSON shape;
`TRAININGAPP_PACKS_EMBEDDING_MODEL_ID` defaults to
`bge-small-en-v1.5` (ADR-0006).

Browser app (build-time Vite variables, inlined into the bundle; the byte,
entry and ratio limits are the shared defaults):

| Canonical key | Variable |
|---|---|
| requireSignature | `VITE_TRAININGAPP_PACKS_REQUIRE_SIGNATURE` |
| trustedKeys | `VITE_TRAININGAPP_PACKS_TRUSTED_KEYS` |
| embeddingModelId | `VITE_TRAININGAPP_PACKS_EMBEDDING_MODEL_ID` |
| update-feed trust anchor | `VITE_TRAININGAPP_UPDATE_TRUSTED_KEYS` (default: the desktop feed key) | The route-level upload cap
(`PACK_ZIP_MAX_UPLOAD_BYTES`, 50 MiB compressed) is unchanged and sits in
front of these decompression-side limits.

## Known limits (explicit, not silent)

- The declared compression-ratio cap (default 100:1) is enforced only for
  archives at or above 16 MiB uncompressed (`RATIO_FLOOR_BYTES` in all three
  implementations). Below the floor the absolute byte cap bounds the archive,
  so the ratio is not applied; legitimate sqlite vector pages compress far
  beyond 100:1 on small indexes.
- An empty-string value for a numeric `RAG_PACKS_SECURITY_*` env variable
  fails Pydantic parsing at Python startup (set an explicit value or unset
  the variable). The desktop `TRAININGAPP_PACKS_*` reader instead falls back
  to the default. (PRR-020, repo-wide Pydantic convention.)
- The desktop install-path central-directory parser anchors its walk at
  `eocd - centralSize` and does not consume the declared `cdOffset` (and so
  has no cdOffset-consistency refusal); `packtool verify`'s parser additionally
  checks `cdOffset <= eocd - cdSize` and exact region consumption. Both are
  immune to the prepended-decoy layout; the difference is defense-in-depth
  depth only.
- Containment wording, Node twin: `ensureContained` derives containment from
  `path.relative` (which is case-insensitive on win32) rather than an explicit
  case fold; the safety property is identical to the Python
  `os.path.normcase` form. (PRR-016 wording fix.)

More known limits:
- Entry names may contain a non-drive colon (e.g. `name:stream`): it does not escape the extraction root — the file lands inside it — but on NTFS a colon is ADS syntax, so such entries are best treated as opaque. The manifest-level `docs[].path` validators share this gap; a strict `":" in name` rejection is a possible future tightening (4.5 review, 2026-09-20).

- Node/JSZip decompresses one entry fully before the unspoofable
  written-bytes cap counts it: the declared-metadata pre-filter rejects
  spoofed declarations early, but a single entry with a spoofed (small)
  declared size still forces one memory allocation up to its real
  decompressed size. JSZip offers no streaming decompress, so this
  residual is accepted and bounded by the upload cap plus the ratio
  ceiling on honest declarations.
- Declared central-directory metadata is spoofable in general; every
  pre-filter keyed on it (G4/G5, entry count) is an early-out, and the
  written-bytes cap (G6) is the authoritative backstop.
- The Node central-directory pre-parser is ZIP32-only: ZIP64 archives
  (above 4 GiB or with more than 65535 entries) are refused with an
  explicit error rather than misparsed. Unreachable for legitimate packs
  under the 2 GiB default `maxUncompressedBytes`.
- Local-install signature verification remains opt-in
  (`requireSignature` false): an operator who wants it provisions
  `trustedKeys` by hand. The REMOTE update-feed path (E5, #88) is
  different: it is mandatory-verify — `desktop/main/update-checker.ts`
  refuses any feed entry whose Ed25519 signature (over the artifact
  sha256, against the build-time-baked public key) does not verify, and
  the feed format itself rejects unsigned entries. See ADR-0010 and
  `docs/updates.md`.
