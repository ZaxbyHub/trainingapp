-- =============================================================================
-- contracts/store.schema.sql — AUTHORITATIVE per-profile store schema (v3)
-- =============================================================================
-- This file is the single source of truth for the SQLite store shared by the
-- desktop Node backend (better-sqlite3) and the Python sidecar (sqlite3 +
-- sqlite-vec). One store file per profile; both runtimes MUST be able to open
-- and read a file written by the other (proven bidirectionally by
-- contracts/tests/store-interop/).
--
-- v2 (D4/#80): the links table gains pack_id/rank/computed_at (was a
-- write-free reserved table in v1, so the 1->2 ladder drops and recreates it
-- losslessly — see both migrate ladders).
--
-- v3 (C3/#70): the packs table becomes per-version — PK (id, version) — with
-- active/install_path lifecycle columns, because the PackManager semantics
-- (mirror: pack_manager.py) require multiple installed versions per pack id
-- (supersede needs both rows; rollback reactivates a retained row). The
-- packs.supersedes and docs.pack_id FKs are dropped: a composite-PK parent can
-- no longer serve a lone-id FK, and both columns are content-carried references
-- (supersedes is a JSON array of "id@version" strings; docs.pack_id follows the
-- links.pack_id precedent of being deliberately FK-free).
--
-- Pinned extension: sqlite-vec 0.1.9 (pre-1.0; exact pin required — no ranges).
--   Node: desktop/package.json "sqlite-vec": "0.1.9"  (dependencies, exact)
--   Python: requirements.txt "sqlite-vec==0.1.9"
--   Decision record: docs/adr/0005-sqlite-vec-interop.md
--
-- SCHEMA-BUMP-CONTRACT: any change to the DDL below MUST bump the
-- meta.schema_version seed and extend the migrate() version ladder
-- (desktop/main/backend/store/migrate.ts + contracts/tests/store-interop/
-- migrate.py). The version ladder and ingestion wiring are owned by B6
-- (#64), which must also reconcile the legacy path-derived doc_id in
-- document_processor.py with the content-hash chunk id defined below.
--
-- Concurrency: v1 assumes a single writer per store file; the multi-writer
-- policy is owned by B6 (#66/#64).
--
-- Parameterized DDL: the token __EMBEDDING_DIMS__ is substituted with the
-- profile's embedding dimension at apply time (positive integer). The
-- dimension is recorded in meta.embedding_dims and comes from the embedding
-- decision (ADR-0001, issue #55 — still open); nothing is hardcoded here.
-- =============================================================================

CREATE TABLE docs (
    id           TEXT PRIMARY KEY,           -- store-level doc id
    source_class TEXT NOT NULL,              -- e.g. 'general' | 'training'
    path         TEXT NOT NULL,              -- provenance path (display/audit only; NEVER used for identity)
    sha256       TEXT NOT NULL,              -- content hash of the source document bytes
    title        TEXT,
    published_at TEXT,
    pack_id      TEXT                        -- owning pack id when the doc came from a pack (v3: reference by value, like links.pack_id)
);
CREATE UNIQUE INDEX docs_sha256_uq ON docs(sha256);

CREATE TABLE chunks (
    id           TEXT PRIMARY KEY,
    -- Content-derived chunk identity:
    --   id = sha256(doc_sha256 + chunk_index + normalized_text)
    -- (normalized_text = text with line endings normalized to \n and
    -- trailing whitespace stripped). Identity is NEVER derived from the
    -- document path, so moving or renaming a source file cannot orphan or
    -- duplicate chunks (fixes the path-based dedup defect at
    -- document_processor.py:349 at the contract level; ingestion catches up in B6).
    doc_id       TEXT NOT NULL REFERENCES docs(id),
    chunk_index  INTEGER NOT NULL,
    text         TEXT NOT NULL,
    content_hash TEXT NOT NULL,              -- sha256 of the chunk text (normalized), for recompute checks
    UNIQUE(doc_id, chunk_index)
);
CREATE INDEX chunks_doc_id_idx ON chunks(doc_id);

-- Embeddings: sqlite-vec vec0 virtual table keyed to chunks.id.
-- Foreign keys are not enforceable on virtual tables; the chunk_id ->
-- chunks.id invariant is maintained by writers (both runtimes use the same
-- fixture/driver rules) and asserted by the interop suite.
CREATE VIRTUAL TABLE embeddings USING vec0 (
    chunk_id  TEXT PRIMARY KEY,              -- references chunks(id)
    embedding float[__EMBEDDING_DIMS__]      -- default metric: L2 (Euclidean)
);

-- Full-text mirror of chunks.text (FTS5, default unicode61 tokenizer).
-- rank is the NEGATED bm25 score: more negative = better match.
CREATE VIRTUAL TABLE chunks_fts USING fts5 (
    chunk_id UNINDEXED,                      -- references chunks(id)
    text
);

-- One row per INSTALLED PACK VERSION (v3, C3/#70): the PackManager lifecycle
-- (mirror: pack_manager.py) keeps superseded versions installed-but-inactive
-- so rollback can reactivate them without re-obtaining the pack. active is the
-- SQLite boolean convention (0/1); exactly one version per pack id is active
-- at a time (enforced by writers, not constraints). install_path points at the
-- managed folder copy for folder-form installs (C3 PackManager) and is NULL
-- for prebuilt-index rows (D3 packtool wholesale installs). supersedes is a
-- JSON array of "id@version" strings (the C2 registry shape).
CREATE TABLE packs (
    id           TEXT NOT NULL,
    version      TEXT NOT NULL,
    name         TEXT NOT NULL,
    published_at TEXT,
    source_class TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    install_path TEXT,
    supersedes   TEXT,
    PRIMARY KEY (id, version)
);

-- Reserved for D4/#80 (doc-to-slide links recomputed on pack changes).
-- Live since schema v2: each row records one doc chunk's k-th nearest
-- training slide above the cosine threshold (top-3 cap, rank 1..3, scores
-- descending). Rows are computed at pack-build time for doc packs
-- (`packtool links`) and recomputed in-store whenever doc content changes
-- (ingest pipeline) or a pack lifecycle event lands (#70 composes the same
-- store-layer operations). pack_id is the owning DOC pack id — NULL for
-- runtime-ingested unpackaged docs, which is why it is deliberately FK-free.
CREATE TABLE links (
    chunk_id    TEXT NOT NULL REFERENCES chunks(id),
    slide_id    TEXT NOT NULL,              -- Storyline slide.id (docs/slide-<digits>-<slide_id>.json)
    pack_id     TEXT,                       -- owning doc pack id; NULL = unpackaged doc
    score       REAL NOT NULL,              -- cosine similarity in [-1, 1]
    rank        INTEGER NOT NULL,           -- 1..3, scores descending within a chunk
    computed_at TEXT NOT NULL,              -- ISO-8601 UTC timestamp of computation
    PRIMARY KEY (chunk_id, slide_id)
);
CREATE INDEX links_slide_id_idx ON links(slide_id);

-- Profile-level metadata. Seeded by this schema; consumed by both runtimes.
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES
    ('schema_version', '3'),
    ('embedding_model_id', ''),
    ('embedding_dims', '__EMBEDDING_DIMS__');
