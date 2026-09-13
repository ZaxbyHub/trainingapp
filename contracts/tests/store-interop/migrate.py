#!/usr/bin/env python
"""migrate.py — Python-side migration ladder for the B5 store (issue #63).

Establishes the migration pattern B6 (#64) extends: migrate(conn) reads
meta.schema_version and advances the store through the version ladder. v1
was the initial schema. v2 (D4/#80) finalizes the links table (adds
pack_id/rank/computed_at); the v1 table was a write-free reserved shape, so
the 1->2 step drops and recreates it losslessly. The DDL mirrors
contracts/store.schema.sql's links definition and the Node ladder in
desktop/main/backend/store/migrate.ts — the store-interop suite proves the
two runtimes agree.
"""

import sqlite3

CURRENT_SCHEMA_VERSION = 2

# Shape mirror of contracts/store.schema.sql's links definition (v2).
_LINKS_V2_DDL = """
CREATE TABLE links (
    chunk_id    TEXT NOT NULL REFERENCES chunks(id),
    slide_id    TEXT NOT NULL,
    pack_id     TEXT,
    score       REAL NOT NULL,
    rank        INTEGER NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (chunk_id, slide_id)
)
"""


def _read_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    if row is None:
        raise RuntimeError(
            "store is missing meta.schema_version; apply contracts/store.schema.sql first"
        )
    try:
        return int(row[0])
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            f"meta.schema_version is not an integer: {row[0]!r}"
        ) from exc


def migrate(conn: sqlite3.Connection) -> int:
    """Bring the store to CURRENT_SCHEMA_VERSION. Returns the final version.

    Future versions extend this ladder; a store from the future (version >
    CURRENT) fails loud instead of guessing.
    """
    version = _read_schema_version(conn)
    if version > CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f"store schema_version {version} is newer than "
            f"this code understands ({CURRENT_SCHEMA_VERSION})"
        )
    if version < 2:
        # v1 -> v2: finalize the links table (was a write-free reserved shape).
        with conn:
            conn.execute("DROP INDEX IF EXISTS links_slide_id_idx")
            conn.execute("DROP TABLE IF EXISTS links")
            conn.execute(_LINKS_V2_DDL)
            conn.execute("CREATE INDEX links_slide_id_idx ON links(slide_id)")
            conn.execute("UPDATE meta SET value = '2' WHERE key = 'schema_version'")
    return _read_schema_version(conn)
