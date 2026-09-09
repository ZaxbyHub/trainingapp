# ADR-0005: SQLite store schema freeze and sqlite-vec Node/Python interop

- **Status:** Accepted (2026-09-09)
- **Context:** Workstream B5, issue #63 (epic #50). Roadmap target: ONE SQLite
  file per profile carrying documents, chunks, embeddings (sqlite-vec), full
  text (FTS5), packs, links, and metadata, shared by the desktop Node backend
  (better-sqlite3) and the Python sidecar (Python `sqlite3`). The "same
  SQLite file across runtimes" assumption had never been demonstrated.
- **Decision:** Freeze the authoritative schema at
  [`contracts/store.schema.sql`](../../contracts/store.schema.sql)
  (`meta.schema_version = 1`) and pin the sqlite-vec extension to
  **`sqlite-vec` 0.1.9** everywhere — the latest stable release on BOTH
  ecosystems at decision time (npm `sqlite-vec@0.1.9`; PyPI `sqlite-vec==0.1.9`;
  0.1.10 exists only as alpha). Because sqlite-vec is pre-1.0, no floating
  ranges are permitted: exact pins in `desktop/package.json` and
  `requirements.txt`, and the version repeated in the schema header. Any bump
  re-runs the full interop proof and records a new ADR.
- **Proof:** The bidirectional interop fixture suite at
  `contracts/tests/store-interop/` (driver:
  `contracts/tests/store-interop/run_interop.py`, directions
  `node->python` and `python->node`) builds a deterministic 2-doc/6-chunk
  fixture DB through one runtime and opens it with the other, asserting
  identical row counts, **bit-identical** vector top-k (ids and distances) for
  a fixed query vector, and identical FTS5 bm25 hit order for a fixed query —
  both directions green on Windows x64. CI re-runs both directions on every
  `contracts/**` or `desktop/**` change (`store-interop` job in
  `.github/workflows/desktop-build.yml`).

## Measurement notes

- sqlite-vec 0.1.9 `vec0` stores vectors as float32 and computes L2 distances
  in float32; returned distances from the Node and Python builds are
  **bit-identical** for identical files, while a pure-float64 oracle differs
  by ~1.3e-9 on the fixture (measured). Interop comparisons use exact
  cross-runtime equality; oracle comparisons carry a 1e-6 tolerance to absorb
  f32 quantization.
- FTS5 bm25 `rank`/`bm25()` is the NEGATED bm25 score: more negative is a
  better match; hit order is compared as `ORDER BY bm25(table)` ascending.
- `vec0` supports TEXT primary keys (used for `embeddings.chunk_id` →
  `chunks.id`); virtual tables cannot declare foreign keys, so that invariant
  is writer-enforced and covered by the interop suite.

## Consequences

- **Embedding dimensionality is data, not schema.** The `vec0` width is
  parameterized at apply time (the `__EMBEDDING_DIMS__` token) and recorded
  in `meta.embedding_dims`; nothing is hardcoded. The production dimension is
  owned by ADR-0001 (issue #55, still open). **Re-verification trigger:** if
  ADR-0001 lands with a different dimension than a deployed store's
  `meta.embedding_dims`, re-run the interop suite with the new dimension and
  re-verify the fixture before shipping.
- **Schema evolution** follows the `SCHEMA-BUMP-CONTRACT` in the schema
  header: DDL changes bump `meta.schema_version` and extend the migrate
  ladder (`desktop/main/backend/store/migrate.ts`,
  `contracts/tests/store-interop/migrate.py`). B6 (#64) owns the ladder and
  the ingestion wiring, including reconciling the legacy path-derived
  `doc_id` (`document_processor.py:349`) with the schema's content-hash chunk
  id (`sha256(doc_sha256 + chunk_index + normalized_text)`).
- **Scope:** this ADR freezes the file format and its cross-runtime proof.
  Ingestion, migrations execution, backup/recovery stay with B6 (#64);
  retrieval fusion with B7 (#65); browser-side storage is unchanged (C9/#76
  decides the browser adapter).

## Windows x64 caveats (reference platform)

- **Node side:** `better-sqlite3` (exact-pinned in `desktop/package.json`) is
  a Node-ABI native addon; it loads under plain Node (dev-server, vitest,
  CI) and in unpacked Electron layouts. **Packaged Electron uses a different
  Node ABI and asar packing — shipping the addon inside the installer is
  owned by #84 (E1)** (`desktop/electron-builder.yml` keeps
  `npmRebuild: false`; do not promise packaged-store behavior from B5).
- **Python side:** `sqlite-vec` ships a platform DLL loaded via
  `sqlite_vec.load(conn)` after `conn.enable_load_extension(True)`; CPython
  Windows builds (python.org) support extension loading. Python's bundled
  SQLite must have FTS5 (3.11.9 / SQLite 3.45.1 verified:
  `ENABLE_FTS5` present); better-sqlite3 bundles an FTS5-enabled SQLite.
- **Paths:** the driver and store module build every path with
  `os.path.join` / `path.join`; on Windows invoke `python` (not `python3`)
  and resolve the repo root by walking up to `contracts/store.schema.sql`.
- **Packaging of the schema file:** `contracts/store.schema.sql` is read at
  runtime from the repo root (dev/CI); installer embedding of the schema is
  an #84 concern and tracked there.
