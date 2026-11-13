# Store Migration Notes

Notes for downgrading the desktop app after a store schema migration. Companion to the
app-binary rollback runbook in [updates.md](updates.md) (the pointer target referenced as
"`docs/` migration notes").

## Current schema: v5 (forward-only)

The desktop store's current schema version is **5** (seeded by
`contracts/store.schema.sql` and applied by `desktop/main/backend/store/migrate.ts`). A build
from the prior release (schema v4) **cannot open a v5 store**: the ladder is forward-only by
design, and the schema-bump contract pins both runtime ladders (Node + python twins) to land
in the same commit.

What v5 changed (PR #323, issue #281 Workstream E): the derived lexical mirror `chunks_fts`
is rebuilt from `chunks.text` through the shared `normalizeForSearch` contract, and a pending
manifest reconciliation is healed inside the same open. Identity is untouched — `chunks.text`,
chunk ids and `content_hash` stay byte-identical; only the derived mirror and the
reconciliation marker change.

## Downgrade recipe

1. **Reinstall the prior installer** (the one whose `sha256` you can verify against the old
   feed entry — feeds for old releases stay valid). Per-user install; the app code is
   replaced, data is not.
2. **Restore the pre-upgrade store.** A downgrade cannot read a v5 store: close the app,
   then restore your pre-upgrade store files from the backup you made before upgrading (the
   per-user profile directory holding `store.sqlite` plus its `-wal`/`-shm` side files).
   The restored v4 store opens unchanged in the prior release.
3. No reverse migration is needed: everything v5 changed is DERIVED (the lexical mirror is
   rebuilt from `chunks.text` on the next open, and the reconciliation marker re-attempts on
   every open), so the v4 store carries the full authoritative corpus.

If no pre-upgrade backup exists, do not downgrade: reinstalling the prior app binary over a
v5 store leaves the app unable to open its data (fail-closed, no data loss — the store is
left intact for the newer build).
