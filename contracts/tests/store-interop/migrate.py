#!/usr/bin/env python
"""migrate.py — Python-side no-op migration skeleton for the B5 store (issue #63).

Establishes the migration pattern B6 (#64) extends: migrate(conn) reads
meta.schema_version and advances the store through the version ladder. v1
is the initial schema, so the current implementation is a verified no-op —
it must never raise on a v1 store and must never alter schema_version.
"""

import sqlite3

CURRENT_SCHEMA_VERSION = 1


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

    No-op for a v1 store. Future versions extend this ladder; a store from
    the future (version > CURRENT) fails loud instead of guessing.
    """
    version = _read_schema_version(conn)
    if version > CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f"store schema_version {version} is newer than "
            f"this code understands ({CURRENT_SCHEMA_VERSION})"
        )
    # version == CURRENT_SCHEMA_VERSION: nothing to do for v1 (verified no-op;
    # B6 appends the 1->2 step here).
    return version
