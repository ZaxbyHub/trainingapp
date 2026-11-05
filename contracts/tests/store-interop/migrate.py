#!/usr/bin/env python
"""migrate.py — Python-side migration ladder for the B5 store (issue #63).

Establishes the migration pattern B6 (#64) extends: migrate(conn) reads
meta.schema_version and advances the store through the version ladder. v1
was the initial schema. v2 (D4/#80) finalizes the links table (adds
pack_id/rank/computed_at); the v1 table was a write-free reserved shape, so
the 1->2 step drops and recreates it losslessly. v3 (C3/#70) makes the packs
table per-version — PK (id, version) with active/install_path — and drops the
inert docs.pack_id FK by re-creating docs with the v3 DDL. v4 (#278) adds
the doc_claims table, backfills one claim per docs row from docs.pack_id,
and reconciles additional pack claims from every ACTIVE pack's retained
manifest (pack.json at the stored absolute install_path), stamping
meta.doc_claims_reconciled 'pending' while any active manifest is unreadable
and re-attempting the pass on every migrate() entry. The DDL mirrors
contracts/store.schema.sql and the Node ladder in
desktop/main/backend/store/migrate.ts — the store-interop suite proves the
two runtimes agree.

Self-test CLI (consumed by the c3-schema-migration test): `python migrate.py
--selftest` builds a v2-shaped store in a temp dir, migrates it to v4, and
asserts the v3 packs shape/row mapping plus the v4 claims backfill; exits 0
on agreement.
"""

import json
import re
import sqlite3
import tempfile
from pathlib import Path

CURRENT_SCHEMA_VERSION = 4

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

# Shape mirror of contracts/store.schema.sql's doc_claims definition (v4).
_DOC_CLAIMS_V4_DDL = """
CREATE TABLE doc_claims (
    doc_id     TEXT NOT NULL,
    claimant   TEXT NOT NULL,
    PRIMARY KEY (doc_id, claimant)
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

    The FK pragma flip mirrors the Node ladder: sqlite3 leaves foreign_keys
    OFF by default (better-sqlite3 too — neither driver issues the pragma)
    and the restructure drops parent tables, so both runtimes ensure FK
    checks are OFF for the duration (official SQLite schema-change
    procedure). This mirror restores the pragma's prior value; the Node
    ladder leaves FKs ON for the connection that ran the migration
    (recorded divergence — see store/migrate.ts)."""
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


def _read_pack_manifest_or_none(install_path: str):
    """Read an installed pack's retained pack.json from its stored absolute
    install_path (the Node twin never recomputes the path either). Returns
    None when the manifest is missing, unparseable, or malformed."""
    try:
        raw = (Path(install_path) / "pack.json").read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (OSError, ValueError):
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("docs"), list):
        return None
    return parsed


def _reconcile_doc_claims_locked(conn: sqlite3.Connection) -> bool:
    """Reconcile pack claims from every ACTIVE pack's retained manifest: for
    each listed doc sha, resolve docs.id by content hash and INSERT OR IGNORE
    the (doc_id, 'pack:<id>') claim. Inactive versions and NULL-install_path
    rows (packtool wholesale rows with no managed folder) contribute nothing.
    Returns True when any active manifest was unreadable (pending marker)."""
    pending = False
    rows = conn.execute(
        "SELECT id, version, install_path FROM packs WHERE active = 1"
    ).fetchall()
    for pack_id, _version, install_path in rows:
        if not isinstance(install_path, str) or not install_path:
            continue
        manifest = _read_pack_manifest_or_none(install_path)
        if manifest is None:
            pending = True
            continue
        claimant = f"pack:{pack_id}"
        for entry in manifest["docs"]:
            if not isinstance(entry, dict):
                continue
            sha = entry.get("sha256")
            if not isinstance(sha, str):
                continue
            doc = conn.execute(
                "SELECT id FROM docs WHERE sha256 = ?", (sha,)
            ).fetchone()
            if doc is None:
                doc = conn.execute(
                    "SELECT id FROM docs WHERE sha256 = ?", (sha.lower(),)
                ).fetchone()
            if doc is not None:
                conn.execute(
                    "INSERT OR IGNORE INTO doc_claims (doc_id, claimant)"
                    " VALUES (?, ?)",
                    (doc[0], claimant),
                )
    return pending


def _stamp_reconciled(conn: sqlite3.Connection, pending: bool) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES"
        " ('doc_claims_reconciled', ?)",
        ("pending" if pending else "done",),
    )


def _reconcile_doc_claims(conn: sqlite3.Connection) -> None:
    """Reconciliation re-attempt for stores already at v4: runs on EVERY
    migrate() entry so a store that migrated while an active manifest was
    unreadable heals on the next open. Idempotent."""
    with conn:
        _stamp_reconciled(conn, _reconcile_doc_claims_locked(conn))


def _migrate_v3_to_v4(conn: sqlite3.Connection) -> None:
    """v3 -> v4 (#278): create doc_claims, backfill one claim per docs row
    from its recorded owner, then reconcile pack claims from every ACTIVE
    pack's retained manifest inside the same transaction and stamp the
    marker. Row mapping mirrors desktop/main/backend/store/migrate.ts."""
    with conn:
        conn.execute(_DOC_CLAIMS_V4_DDL)
        conn.execute(
            "INSERT OR IGNORE INTO doc_claims (doc_id, claimant)"
            " SELECT id, 'pack:' || pack_id FROM docs WHERE pack_id IS NOT NULL"
        )
        conn.execute(
            "INSERT OR IGNORE INTO doc_claims (doc_id, claimant)"
            " SELECT id, 'user' FROM docs WHERE pack_id IS NULL"
        )
        _stamp_reconciled(conn, _reconcile_doc_claims_locked(conn))
        conn.execute("UPDATE meta SET value = '4' WHERE key = 'schema_version'")


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
    if version < 4:
        _migrate_v3_to_v4(conn)
    else:
        # Stores already at v4 re-attempt the manifest reconciliation on
        # every migrate() entry (heals a pending store).
        _reconcile_doc_claims(conn)
    return _read_schema_version(conn)


def _selftest() -> int:
    """Build a v2-shaped store, migrate to v4, assert shape + row mapping."""
    # SCHEMA-BUMP-CONTRACT parity (issue #100 items 3/4): this runtime's
    # CURRENT_SCHEMA_VERSION must equal the meta.schema_version seed in the
    # authoritative schema file — otherwise cross-runtime readers break. The
    # path anchors on THIS file (cwd-independent), and the failure raises so
    # it also fires under `python -O`. Both ladders must change in the same
    # commit (#100): migrate.ts and migrate.py.
    schema_path = Path(__file__).resolve().parents[2] / "store.schema.sql"
    seed_match = re.search(
        r"\('schema_version',\s*'(\d+)'\)", schema_path.read_text(encoding="utf-8")
    )
    if seed_match is None:
        raise RuntimeError(f"meta.schema_version seed not found in {schema_path}")
    seed = int(seed_match.group(1))
    if seed != CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f"SCHEMA-BUMP-CONTRACT: contracts/store.schema.sql seed {seed} != "
            f"migrate.py CURRENT_SCHEMA_VERSION {CURRENT_SCHEMA_VERSION}; "
            # Deliberately does not name both ladder files on one line: the
            # canonical four-token #100 acknowledgment is single-sourced in
            # contracts/store.schema.sql (frozen check C4 reads raw lines).
            "land both runtime ladders in the same commit (#100)"
        )
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "selftest.sqlite"
        conn = sqlite3.connect(str(db_path))
        # issue #100 item 2: explicit pragmas on this runtime's open path
        # (mirrors sqlite-store.ts / run_interop.connect_with_vec), with
        # read-back verification of the best-effort WAL conversion.
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        if mode != "wal":
            conn.close()
            raise RuntimeError(
                f"PRAGMA journal_mode could not be set to wal (got {mode!r})"
            )
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
                INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id)
                VALUES ('packaged-doc', 'bundled', 'docs/p.json', 'aaa111', 'P', NULL, 'p1'),
                       ('user-doc', 'general', 'notes.txt', 'bbb222', 'U', NULL, NULL);
                """
            )
            conn.commit()
            final = migrate(conn)
            assert final == 4, f"expected final version 4, got {final}"
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
            assert version == 4, version
            # v4 claims backfill: every docs row carries exactly the claim its
            # recorded owner implies ('pack:<id>' / 'user'); doc_claims keys on
            # docs.id (PC-3), not the sha. The active packs have NULL
            # install_path (v2 rows map to install_path=NULL), so the manifest
            # reconciliation pass is vacuously complete -> 'done'.
            claim_cols = [
                row[1]
                for row in conn.execute("PRAGMA table_info(doc_claims)").fetchall()
            ]
            assert claim_cols == ["doc_id", "claimant"], claim_cols
            claims = conn.execute(
                "SELECT doc_id, claimant FROM doc_claims ORDER BY claimant"
            ).fetchall()
            assert claims == [("packaged-doc", "pack:p1"), ("user-doc", "user")], claims
            reconciled = conn.execute(
                "SELECT value FROM meta WHERE key = 'doc_claims_reconciled'"
            ).fetchone()
            assert reconciled == ("done",), reconciled
            print("selftest OK: v2 -> v4 ladder agrees with the Node mirror")
            return 0
        finally:
            conn.close()


if __name__ == "__main__":
    import sys

    raise SystemExit(_selftest() if "--selftest" in sys.argv[1:] else 0)
