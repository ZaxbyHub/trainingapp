# Store Migration Notes

Notes for downgrading the desktop app after a store schema migration. Companion to the
app-binary rollback runbook in [updates.md](updates.md) (the pointer target referenced as
"`docs/` migration notes").

## Current schema: v5 (forward-only)

The desktop store's current schema version is **5** (seeded by
`contracts/store.schema.sql` and applied by `desktop/main/backend/store/migrate.ts`). A build
that predates schema v5 **cannot open a v5 store**: the ladder is forward-only by design, and
the schema-bump contract pins both runtime ladders (Node + python twins) to land in the same
commit. (No released build has shipped a store yet — schema versions live in the Unreleased
changelog section — so "prior schema" here means the schema your installed build's ladder
last wrote, not a released version label.)

What v5 changed (PR #323, issue #281 Workstream E): the derived lexical mirror `chunks_fts`
is rebuilt from `chunks.text` through the shared `normalizeForSearch` contract, and a pending
manifest reconciliation is healed inside the same open. Identity is untouched — `chunks.text`,
chunk ids and `content_hash` stay byte-identical; only the derived mirror and the
reconciliation marker change.

## Downgrade recipe

1. **Reinstall the prior installer** (the one whose `sha256` you can verify against the old
   feed entry — feeds for old releases stay valid). Per-user install; the app code is
   replaced, data is not.
2. **Restore the pre-upgrade store** — this replaces your CURRENT store, so anything written
   since the backup (documents ingested after you upgraded) is NOT in the restored store and
   is gone from this profile once you continue. If that content matters, copy the whole
   current profile directory aside first (or use the app's backup feature) before touching
   anything.
3. With the app fully closed (no running process may hold the store), restore the pre-upgrade
   snapshot the backup holds. The app's own backup copies **only `store.sqlite`** (it
   checkpoints WAL first), so for an app-made backup restore exactly that one file. If your
   backup is a directory copy that also captured `-wal`/`-shm` side files, restore them
   together with the main file — never mix generations: a `-wal` from a DIFFERENT store
   generation replayed over the restored main file silently yields the wrong data (and can
   report a malformed database). When in doubt, restore the main file only and **delete any
   `store.sqlite-wal` / `store.sqlite-shm` left next to it in the profile** before starting
   the app — a leftover live log must never be allowed to replay over the restored database
   (the app's own restore path does exactly this; `desktop/main/backend/store/backup.ts`).
   Checkpointed correctly, the restored store opens unchanged in the prior build.
4. No reverse migration is needed: everything v5 changed is DERIVED (the lexical mirror is
   rebuilt from `chunks.text` on the next open, and the reconciliation marker re-attempts on
   every open), so the pre-upgrade store carries the full authoritative corpus AS OF THE
   BACKUP.

If no pre-upgrade backup exists, do not downgrade: reinstalling the prior app binary over a
v5 store leaves the app unable to open its data (fail-closed — the store is left intact for
the newer build; nothing is deleted, but you cannot read it with the older app).
