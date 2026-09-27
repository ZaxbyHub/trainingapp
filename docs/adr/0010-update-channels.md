# ADR-0010: Signed update channels for the application and knowledge packs

- **Status:** Accepted (2026-09-27, implementation in issue #88, E5)
- **Context:** Workstream E, slot E5, issue #88 (epic #50). The app is offline-first
  (`.swarm/spec-snapshot.md:5`: no network connectivity required for any operation) and ships no
  update mechanism: `release.yml` publishes Release artifacts nothing consumes, packs reach users
  only by local drag-drop (C7/C8, signatures optional by default), and the 3–6 month pack refresh
  cadence has no delivery path. C8 (#75) deferred trusted-key distribution to this issue
  (`docs/security/packs.md` Known limits).

> **Numbering note:** the issue pinned this decision at `docs/adr/0005-update-channels.md`, but
> 0005–0009 were taken by the time work started (0005 is sqlite-vec interop; 0009 is browser
> packs). The next free number is 0010. The decision content is unchanged.

## Options

### Option A — `electron-updater` generic HTTP provider

`electron-updater` with the generic provider: the app polls a hosted `latest.yml`, downloads, and
(where signed) applies updates — including a full auto-update path for the NSIS installer.

- **For:** mature auto-update machinery; differential downloads; staged-rollout assumptions
  already solved; in-place NSIS upgrades retain the prior installer for uninstall.
- **Against (decisive here):** its defaults fight the offline-first posture — a background update
  process that phones a feed unless configured otherwise, its own feed/signature formats
  (minisign-style, Windows unsigned-allowance) that would supersede `contracts/` as the trust
  anchor, and a runtime dependency whose update flow is hard to make strictly opt-in-by-default.
  The frozen acceptance posture for this issue (`updates.json.optIn` default false, zero network
  calls on a fresh install) would be an uphill fight against the library's assumptions rather
  than a property of our own code.

### Option B — a manual channel (JSON poll → in-app notice → operator runs the existing installer), feed-backed and signed (selected)

One signed JSON feed document (`contracts/pack-feed.schema.json`), one default-OFF main-process
checker (`desktop/main/update-checker.ts`), notices in-app, and the operator applies updates:

- **Packs:** the checker verifies the feed signature, then downloads and applies through the
  existing loopback `POST /packs/install` — so the C8 zip guards, per-doc sha256 re-hash, and
  C1/C8 supersede/rollback semantics (inactive-but-retained) apply unchanged.
- **App binary:** the checker verifies the feed signature and surfaces the notice (version, link,
  sha256); the operator downloads and runs the installer per `docs/updates.md`. The checker never
  executes an installer itself.

- **For:** first-class opt-in (the gate is our code, before any fetch); no new runtime
  dependencies; `contracts/` stays the single authority for feed shape; pack updates ride the
  already-hardened install path; rollback semantics already exist and are proven (C4).
- **Against:** no silent background auto-update (users must click); the feed must be hosted and
  signed by the release process (a runbook concern, `docs/updates.md`).

## Decision table

| Option | Offline-first compatibility | Signing cost/ownership | Rollback complexity | Maintenance burden |
|---|---|---|---|---|
| A — electron-updater generic HTTP | Weak: background updater defaults on; strict opt-in fights the library | Library's own signature format; app must still be Authenticode-signed for silent install | Library retains prior installer; in-place upgrade otherwise | +1 runtime dep; feed format owned by upstream |
| B — manual signed feed (selected) | Strong: zero network until opt-in; the gate is our code | Ed25519 over artifact sha256; public key baked at build; **signing ceremony owned by us** (below) | Packs: existing inactive-but-retained rollback (C1/C8), reactivation without re-fetch; app: reinstall runbook | One module + one schema; no new deps |

## Recommendation

**Option B.** The offline-first property is the product's spine; the update channel must be a
door the user opens, not a process that quietly runs. Option A remains the right shape if the
product later wants silent auto-updates — nothing in this decision forecloses it; the feed
document and the baked-key trust anchor would carry over.

## Decision

1. **Transport (packs + app):** the manual channel described above (a signed feed polled into an in-app notice; the operator applies). `desktop/main/update-checker.ts`
   fetches `contracts/pack-feed.schema.json`-shaped documents, defaulting to the GitHub Releases
   "latest" asset URL (`https://github.com/ZaxbyHub/trainingapp/releases/latest/download/pack-feed.json`),
   overridable per profile via the `feedUrl` field of `<profileDir>/updates.json`.
2. **Opt-in (offline-first):** update checks are **disabled by default**. A fresh install makes
   zero update-related network calls (frozen check C5). The opt-in toggle lives in Settings →
   Updates (Electron-only); the state persists in `<profileDir>/updates.json` (fail-closed on
   corruption). Checks run at app start when opted in, and on the explicit "Check for updates
   now" action — no background timer.
3. **Signature scheme:** Ed25519 over each artifact's sha256 (the lowercase 64-hex digest string,
   UTF-8-encoded), base64 signature, `{algorithm: 'ed25519', key_id, value}` in the feed entry.
   The public key is **baked into the build** (`UPDATE_FEED_PUBLIC_KEY` in
   `desktop/main/update-checker.ts`); verification refuses missing signatures, unknown key_ids,
   wrong algorithms, and any digest mismatch — **no unsigned fallback** on the feed path. The
   feed format itself requires the signature block (the JSON Schema rejects unsigned entries).
   Local drag-drop installs keep C8's optional-signature behavior unchanged; the feed path is the
   mandatory-verify trust boundary (issue #88's different-trust-boundary rule).
4. **Key ceremony and custody:** keypair `trainingapp-update-feed-2026-09`, generated 2026-09-27
   with `node:crypto` (ed25519). The public half is committed as the baked constant. The private
   half was handed to the release owner (zaxbysauce) OUTSIDE any repository
   (`E:\ZCode\.secrets\trainingapp\` on the build machine at generation time) and must live in
   the offline release-signing store; it is never committed, never emailed, never left under
   `.agents/` (trace dirs are excluded only by unversioned local config). Rotation = generate a
   new keypair, ship a build with the new baked key, publish feed entries under the new `key_id`
   during transition. Signing procedure (offline, one command): see `docs/updates.md`.
5. **App-binary signing (Authenticode):** **deferred with an explicit risk acceptance.** The
   distributed NSIS installer remains unsigned for now (as at the issue's baseline). Risk
   accepted: an unsigned installer cannot prove publisher identity to Windows SmartScreen, and
   the app-update channel mitigates but does not eliminate social-engineering downloads — the
   compensating controls are the signed feed (sha256 + Ed25519 over the exact installer digest,
   verified in-app before a notice is shown), HTTPS-only transport, and the E1 integrity manifest
   for the installed payload. **Decision owner: zaxbysauce (maintainer).** Revisit when an EV
   certificate budget exists (`signtool verify /pa` then becomes the acceptance proof).
6. **App-binary rollback:** in-place NSIS upgrades replace the binary and do not retain the prior
   version. Named mechanism: **prior-installer retention + manual reinstall runbook** — the
   operator keeps (or re-downloads, sha256-verified) the previous installer and reinstalls;
   `deleteAppDataOnUninstall: false` (already the case) keeps profiles, packs, and settings
   across a reinstall. Documented step-by-step in `docs/updates.md`.
7. **Pre-release semantics:** the checker applies strict semver ordering identical to pack
   versioning (`pack-manager.ts`): a pre-release sorts below the release of the same triple but
   above any lower triple, so a `2.0.0-rc.1` feed entry IS offered to a `1.0.0` install. Feed
   publishers control exposure: publish stable-only feeds for stable channels.

## Consequences

- The feed is a published artifact: a release that should be updatable must attach a signed
  `pack-feed.json` (runbook: `docs/updates.md`). No feed published → opted-in installs get an
  explicit fetch error, nothing breaks.
- Replay/freshness residual (explicit): feed entries carry no expiry, so a captured old
  (validly-signed) feed remains verifiable until superseded; HTTPS + operator-controlled feed
  URLs are the mitigations. A schema `expires_at` field is the sanctioned follow-up if this ever
  matters in practice.
- The desktop update checker is the app's first public-internet outbound call; its hardening set
  (https-only, credentials omitted, explicit timeouts, size caps, no identifying payload) is
  pinned in `desktop/main/update-checker.ts` and reviewed in `docs/security/desktop.md`'s
  known-limits update.
- `applyPackUpdate` composition coverage is supplementary (`desktop/src/__tests__/e5-update-apply.test.ts`);
  the frozen acceptance floor (C1–C6) owns the diff/signature/rollback/opt-in seams.
- No shared Ed25519 test vectors between the Python and Node verifiers were added — out of scope
  here (the feed path is desktop-only); C8's canonical-bytes golden remains the only cross-
  language pin.
