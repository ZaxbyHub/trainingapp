# Update channels — operator and release runbook (E5, issue #88)

This runbook operationalizes ADR-0010: how a release owner publishes a signed update feed, and
how a user applies (or rolls back) app and pack updates. The mechanism shipped with issue #88:
`desktop/main/update-checker.ts` (default-OFF checker), `contracts/pack-feed.schema.json` (feed
format), and the Ed25519 trust anchor baked into the build.

## Update flow (what the app does)

1. The user opts in (Settings → Updates). Until then the app makes **zero** update-related
   network calls.
2. On start (opted in) or on "Check for updates now", the checker fetches the feed — by default
   `https://github.com/ZaxbyHub/trainingapp/releases/latest/download/pack-feed.json`, overridable
   per profile in `<profileDir>/updates.json` (`feedUrl`). HTTPS-only, no credentials, no
   identifying payload.
3. The feed document is validated against `contracts/pack-feed.schema.json`; every version entry
   must carry an Ed25519 signature over the artifact's sha256 verifiable with the baked public
   key. Failures are refused and surfaced ("N updates refused") — **there is no unsigned
   fallback**.
4. Pack updates appear as an "Update available: vNext" badge on the Knowledge Packs panel
   (Documents page). **Update** downloads the artifact (size-checked), re-verifies the digest +
   signature, and installs through the same loopback route as a drag-drop zip — so every C8 zip
   guard and the regular version semantics apply.
5. App-binary updates surface in Settings → Updates with the download link and the expected
   sha256. The app never installs its own binary: download, verify the digest if you want to be
   thorough, run the installer.

## Publishing a feed (release owner)

The feed is a Release asset named exactly `pack-feed.json` on the release the feed should
resolve to (the default URL uses the Releases "latest" asset pattern).

1. Build the artifacts (installer, pack zips) and compute digests:
   `sha256sum <artifact>` (lowercase hex, 64 chars).
2. Sign each digest with the release signing key (offline store; see ADR-0010 §4 for custody):

   ```bash
   printf '%s' "<64-hex-sha256>" | openssl pkeyutl -sign -inkey update-feed-ed25519.pem | base64 -w0
   ```

   The message is the digest string itself (UTF-8, no trailing newline — hence `printf '%s'`).
   `key_id` is `trainingapp-update-feed-2026-09` (or the current baked key's id).
3. Assemble `pack-feed.json` per `contracts/pack-feed.schema.json` (`signature` is required in
   the format — the schema rejects unsigned entries). Validate:

   ```bash
   python -m pytest contracts/tests/test_pack_feed_schema.py -q   # format guards
   python -c "import json,sys; from jsonschema import Draft202012Validator; \
     s=json.load(open('contracts/pack-feed.schema.json')); \
     d=json.load(open('pack-feed.json')); \
     Draft202012Validator(s).validate(d); print('feed ok')"
   ```

4. Attach `pack-feed.json` to the GitHub Release. Verify the default URL resolves:
   `https://github.com/ZaxbyHub/trainingapp/releases/latest/download/pack-feed.json`.

## Applying updates (user)

- **Packs:** Documents page → Knowledge Packs → **Update** on the badge row. Requires the
  opt-in; installation reuses the hardened zip pipeline, then the new version becomes active.
- **App binary:** Settings → Updates → download from the notice → run the installer
  (per-user NSIS; profiles, packs, and settings survive — `deleteAppDataOnUninstall` is false).

## Rolling back

- **Packs (automatic-safe):** superseded versions are retained on disk (C1/C8
  inactive-but-retained semantics). Knowledge Packs → row of the prior version → **Rollback**.
  No re-download: the retained files are reactivated in place.
- **Packs (failed update):** a refused update never touched the store — the prior version stays
  active; the refusal reason is shown on the panel/in Settings.
- **App binary (manual runbook):** reinstall the prior installer (keep it, or re-download from
  the Release whose `sha256` you can verify against the old feed entry — feeds for old releases
  stay valid). Per-user install; data survives. If the new build migrated data forward, check
  `docs/` migration notes before downgrading.

## Verification recipe (local, offline)

```bash
# frozen acceptance checks (C1-C6) + suites
bash .agents/issue-traces/88-signed-update-channels-rollback/repro/check-C2.sh
cd desktop && npm test -- src/__tests__/e5-update-apply.test.ts
python -m pytest contracts/tests/test_pack_feed_schema.py -q
```

## Decision summary (issue #88 acceptance)

- transport: manual signed feed (ADR-0010 Option B)
- opt-in: default OFF; zero calls until enabled (C5)
- signatures: Ed25519 over artifact sha256, baked public key, mandatory, no fallback (C3)
- pack rollback: retained-version reactivation without re-fetch (C4)
- app updates: detect + notify + operator-run installer; Authenticode deferred with named risk
  acceptance and owner (ADR-0010 §5)
- feed format: `contracts/pack-feed.schema.json` (authoritative)

## Invalidations

Re-verify this runbook if: the baked key rotates (new `key_id`, new default URL owner), the feed
moves off GitHub Releases (update `DEFAULT_UPDATE_FEED_URL` and this doc), C1/C8's
supersede/rollback semantics change (the pack flow builds on them — the issue explicitly
invalidates on that), or electron-updater is revisited per ADR-0010.
