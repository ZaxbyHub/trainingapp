# ADR-0006: Profile model, ingest configuration, and store backup/recovery

- **Status:** Accepted (B6, issue #64; epic #50). Companion to ADR-0005
  (store file format); ingestion content-hash identity is recorded there.
- **Context:** B5 froze ONE SQLite store file but left its location interim
  (`<userData>/store/store.db`), the embedding model unpinned (ADR-0001 #55
  still open), and backup/recovery undefined. B6 wires the production ingest
  pipeline and must decide where stores live, how the legacy layout moves
  forward, and what happens when a store is corrupt.

## Decision

1. **Profile model.** One OS-user-scoped profile is the DEFAULT: the store
   lives at `<userData>/profiles/default/store.sqlite`. A named-profiles mode
   is opt-in: `<userData>/profiles/<name>/store.sqlite`, selected via
   `TRAININGAPP_PROFILE_MODE` (`single` | `named`; default `single`) plus
   `TRAININGAPP_PROFILE_NAME` (REQUIRED in named mode — never a silent
   fallback to `default`). Profile names are allowlisted to
   `[a-z0-9-]{1,64}` and become directory names under `profiles/`, so path
   traversal is structurally impossible (no sanitization step to get wrong).
2. **Legacy migration.** B5's interim `<userData>/store/store.db` moves to
   `<userData>/profiles/default/store.sqlite` on first B6 launch via an
   atomic same-volume rename (`fs.renameSync`). Rollback is the reverse
   rename. Crash-safety comes from rename atomicity on NTFS/ext4: a crash
   mid-migration leaves the file at exactly one of the two paths, never torn.
3. **Ingest configuration** (per-key env, invalid values fall back to that
   key's default): `TRAININGAPP_INGEST_MAX_CONCURRENT_FILES` (default 2;
   coordinated with B8's runtime budget, issue #66),
   `TRAININGAPP_INGEST_CHUNK_WORD_COUNT` (256),
   `TRAININGAPP_INGEST_CHUNK_OVERLAP_WORDS` (100). A resolved pair with
   overlap >= word count falls back to BOTH defaults (a coherent chunker,
   never a rejected constructor).
4. **Embedding model pin** (pending ADR-0001, issue #55):
   `bge-small-en-v1.5` (384-dim) via transformers.js over the staged ONNX
   weights. `TRAININGAPP_EMBEDDING_MODEL_DIR` overrides the weights location;
   `TRAININGAPP_DESKTOP_EMBEDDER=hash` selects the deterministic dev/CI
   fixture and is NEVER a production default (same pattern as the B3 stub
   engine). The embedding width is validated against the store's recorded
   `meta.embedding_dims` on every write — a model contradicting the store
   fails loud instead of corrupting vec0. A future ADR-0001 re-pin is a
   configuration change here, not a schema change (ADR-0005 keeps dims data,
   not schema).
5. **Recovery contract.** Startup runs `PRAGMA integrity_check` (a file that
   cannot even open as SQLite counts as corrupt). A store failing integrity
   cannot be served, so the interactive prompt — Restore from backup / Start
   fresh — intentionally BLOCKS host start. Headless hosts (dev-server, CI)
   have no one to prompt and auto-recover: restore the latest valid backup,
   else re-initialize fresh.
6. **Clear Cache** targets the ACTIVE profile's store only; other profiles'
   bytes are untouched.
7. **Backup entry points.** Two: automatic recovery (above) and the
   `desktop:store-backup` IPC handler. Backups land at
   `<userData>/backups/<UTC-timestamp>/store.sqlite` (WAL checkpointed to
   TRUNCATE first, so the copied file is self-consistent). Restore validates
   `schema_version` and `embedding_dims` against the active store BEFORE
   replacing any byte — a refused restore leaves the active file identical.
8. **`ingest:progress` IPC channel.** Shape `{docId, phase, percent}`
   (phase: extract | chunk | embed | write | done) is the B6 deliverable; the
   renderer consumer arrives with B9 (issue #67) per the issue's scope.

## Consequences

- First B6 launch silently migrates B5 layouts; a downgrade back to B5 code
  requires the documented reverse rename (no code path does it). Without that
  reverse rename, a pre-B6 build recreates an empty store at the legacy path,
  so the migrated data stays invisible until the rename is undone. A failed
  migration (source locked, ACL denial) intentionally aborts launch — the
  same-volume rename is atomic, so nothing is half-migrated; resolve the lock
  and relaunch.
- Profile selection is env-driven; a profile-picker UI is out of B6 scope and
  would layer on `resolveProfileLayout` unchanged.
- Interactive corruption recovery means an unattended Electron launch CAN
  block on a modal — accepted, because serving from an untrusted store is the
  worse failure; headless hosts never block.
- Backups accumulate under `<userData>/backups/`; retention/pruning is not
  decided here (a store is ~MBs; the practical pressure is low until #84).
- The B9 renderer must tolerate missing `ingest:progress` events (headless /
  already-complete ingests emit none after subscription).
