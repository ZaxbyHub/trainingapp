#!/usr/bin/env python
"""migrate.py — Python-side migration ladder for the B5 store (issue #63).

Establishes the migration pattern B6 (#64) extends: migrate(conn) reads
meta.schema_version and advances the store through the version ladder. v1
was the initial schema. v2 (D4/#80) finalizes the links table (adds
pack_id/rank/computed_at); the v1 table was a write-free reserved shape, so
the 1->2 step drops and recreates it losslessly. v3 (C3/#70) makes the packs
table per-version — PK (id, version) with active/install_path — and drops the
inert docs.pack_id FK by re-creating docs with the v3 DDL. The DDL mirrors
contracts/store.schema.sql and the Node ladder in
desktop/main/backend/store/migrate.ts — the store-interop suite proves the
two runtimes agree.

Self-test CLI (consumed by the c3-schema-migration test): `python migrate.py
--selftest` builds a v2-shaped store in a temp dir, migrates it to v3, and
asserts the v3 packs shape and row mapping; exits 0 on agreement.
"""

import json
import sqlite3
import tempfile
from pathlib import Path

CURRENT_SCHEMA_VERSION = 3

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

# Shape mirror of contracts/store.schema.sql's packs definition (v3).
_PACKS_V3_DDL = """
CREATE TABLE packs_v3 (
    id           TEXT NOT NULL,
    version      TEXT NOT NULL,
    name         TEXT NOT NULL,
    published_at TEXT,
    source_class TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    install_path TEXT,
    supersedes   TEXT,
    PRIMARY KEY (id, version)
)
"""

# Shape mirror of contracts/store.schema.sql's docs definition (v3).
_DOCS_V3_DDL = """
CREATE TABLE docs_v3 (
    id           TEXT PRIMARY KEY,
    source_class TEXT NOT NULL,
    path         TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    title        TEXT,
    published_at TEXT,
    pack_id      TEXT
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


def _migrate_v2_to_v3(conn: sqlite3.Connection) -> None:
    """v2 -> v3 (C3/#70): per-version packs + lifecycle columns; docs loses its
    inert packs FK. Row mapping mirrors desktop/main/backend/store/migrate.ts:
    active=1 (a v2 packs row was a live install), install_path=NULL, supersedes
    normalized to a JSON array (scalar ids wrapped; NULL preserved).

    The FK pragma flip mirrors the Node ladder: better-sqlite3 runs with
    foreign_keys ON by default and the restructure drops parent tables, so
    both runtimes disable FK checks for the duration (official SQLite
    schema-change procedure)."""
    was_on = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    if was_on:
        conn.execute("PRAGMA foreign_keys = OFF")
    try:
        _migrate_v2_to_v3_inner(conn)
    finally:
        if was_on:
            conn.execute("PRAGMA foreign_keys = ON")


def _migrate_v2_to_v3_inner(conn: sqlite3.Connection) -> None:
    with conn:
        conn.execute(_PACKS_V3_DDL)
        rows = conn.execute(
            "SELECT id, version, name, published_at, source_class, supersedes FROM packs"
        ).fetchall()
        for pack_id, version, name, published_at, source_class, supersedes in rows:
            if supersedes is None or (
                isinstance(supersedes, str) and supersedes.startswith("[")
            ):
                normalized = supersedes
            else:
                normalized = json.dumps([str(supersedes)])
            conn.execute(
                "INSERT INTO packs_v3 (id, version, name, published_at, source_class,"
                " active, install_path, supersedes) VALUES (?, ?, ?, ?, ?, 1, NULL, ?)",
                (pack_id, version, name, published_at, source_class, normalized),
            )
        conn.execute("DROP TABLE packs")
        conn.execute("ALTER TABLE packs_v3 RENAME TO packs")

        conn.execute(_DOCS_V3_DDL)
        conn.execute(
            "INSERT INTO docs_v3 (id, source_class, path, sha256, title, published_at,"
            " pack_id) SELECT id, source_class, path, sha256, title, published_at,"
            " pack_id FROM docs"
        )
        conn.execute("DROP INDEX IF EXISTS docs_sha256_uq")
        conn.execute("DROP TABLE docs")
        conn.execute("ALTER TABLE docs_v3 RENAME TO docs")
        conn.execute("CREATE UNIQUE INDEX docs_sha256_uq ON docs(sha256)")
        conn.execute("UPDATE meta SET value = '3' WHERE key = 'schema_version'")


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
    if version < 3:
        _migrate_v2_to_v3(conn)
    return _read_schema_version(conn)


def _selftest() -> int:
    """Build a v2-shaped store, migrate to v3, assert shape + row mapping."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "selftest.sqlite"
        conn = sqlite3.connect(str(db_path))
        try:
            # Minimal v2 store: meta (version 2), packs (v2 shape), docs (v2
            # shape with the FK that v3 drops), plus the tables the v3 step
            # does not touch (empty links suffices for the ladder).
            conn.executescript(
                """
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT INTO meta (key, value) VALUES ('schema_version', '2');
                CREATE TABLE packs (
                    id           TEXT PRIMARY KEY,
                    name         TEXT NOT NULL,
                    version      TEXT NOT NULL,
                    published_at TEXT,
                    source_class TEXT NOT NULL,
                    supersedes   TEXT REFERENCES packs(id)
                );
                CREATE TABLE docs (
                    id           TEXT PRIMARY KEY,
                    source_class TEXT NOT NULL,
                    path         TEXT NOT NULL,
                    sha256       TEXT NOT NULL,
                    title        TEXT,
                    published_at TEXT,
                    pack_id      TEXT REFERENCES packs(id)
                );
                INSERT INTO packs (id, name, version, published_at, source_class, supersedes)
                VALUES ('p1', 'Pack One', '1.0.0', NULL, 'bundled', NULL),
                       ('p2', 'Pack Two', '2.0.0', NULL, 'training', 'p1');
                """
            )
            conn.commit()
            final = migrate(conn)
            assert final == 3, f"expected final version 3, got {final}"
            cols = [
                row[1] for row in conn.execute("PRAGMA table_info(packs)").fetchall()
            ]
            assert cols == [
                "id",
                "version",
                "name",
                "published_at",
                "source_class",
                "active",
                "install_path",
                "supersedes",
            ], f"unexpected packs columns: {cols}"
            pk = [
                row[1]
                for row in conn.execute("PRAGMA table_info(packs)").fetchall()
                if row[5]
            ]
            assert pk == ["id", "version"], f"unexpected packs PK: {pk}"
            rows = conn.execute(
                "SELECT id, version, active, install_path, supersedes FROM packs ORDER BY id"
            ).fetchall()
            assert rows[0] == ("p1", "1.0.0", 1, None, None), rows[0]
            # Legacy scalar supersedes 'p1' wraps into a JSON array.
            assert rows[1][4] == '["p1"]', rows[1]
            doc_cols = [
                row[1] for row in conn.execute("PRAGMA table_info(docs)").fetchall()
            ]
            assert doc_cols == [
                "id",
                "source_class",
                "path",
                "sha256",
                "title",
                "published_at",
                "pack_id",
            ], f"unexpected docs columns: {doc_cols}"
            version = _read_schema_version(conn)
            assert version == 3, version
            print("selftest OK: v2 -> v3 ladder agrees with the Node mirror")
            return 0
        finally:
            conn.close()


if __name__ == "__main__":
    import sys

    raise SystemExit(_selftest() if "--selftest" in sys.argv[1:] else 0)
