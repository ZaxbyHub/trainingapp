#!/usr/bin/env python
"""run_interop.py — B5 Node<->Python sqlite-vec interop driver (issue #63).

Proves that ONE SQLite store file (contracts/store.schema.sql) written by
better-sqlite3 + sqlite-vec (Node) is read identically by Python's sqlite3 +
sqlite-vec, and vice versa.

Usage (from the repository root):
    python contracts/tests/store-interop/run_interop.py --direction node->python
    python contracts/tests/store-interop/run_interop.py --direction python->node

stdout contract: the LAST non-empty line is a single JSON verdict object
(see .agents issue-trace check-interface.md / docs/adr/0005). Diagnostics go
to stderr. Exit 0 iff rows, top-k and FTS invariants all held.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from pathlib import Path

# contracts/tests/store-interop/run_interop.py -> parents[3] is the repo root.
REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "contracts" / "store.schema.sql"
FIXTURE_PATH = Path(__file__).resolve().parent / "fixture.json"
NODE_DRIVER = Path(__file__).resolve().parent / "interop_node.mjs"
FIXTURE_LITERAL = "contracts/tests/store-interop/fixture.json"
SCHEMA_LITERAL = "contracts/store.schema.sql"
# sqlite-vec computes L2 distances in float32, so returned values differ from
# a pure-float64 oracle by up to ~1e-6 absolute (measured: 1.3e-9 on the
# fixture). Writer-vs-reader distances are compared with this same
# DISTANCE_TOLERANCE; bit-identity across runtimes is an observed property,
# not an assertion. Ids, hit order, row counts, and content hashes are
# compared exactly.
DISTANCE_TOLERANCE = 1e-6


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


INSERT_DOC_SQL = (
    "INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id)"
    " VALUES (?, ?, ?, ?, ?, ?, ?)"
)
INSERT_CHUNK_SQL = (
    "INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash)"
    " VALUES (?, ?, ?, ?, ?)"
)


def normalized(text: str) -> str:
    # Must match interop_node.mjs and the schema's normalization definition
    # exactly: line endings normalized to \n, trailing horizontal whitespace
    # stripped. Any divergence here yields different content_hash values
    # across runtimes (caught by the hashes_match verdict field).
    return re.sub(r"[ \t]+$", "", text.replace("\r\n", "\n"), flags=re.MULTILINE)


def sha256_hex(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sqlite_vec_version() -> str:
    try:
        return _pkg_version("sqlite-vec")
    except PackageNotFoundError:  # pragma: no cover - precondition checked earlier
        return "unknown"


def connect_with_vec(db_path: Path) -> sqlite3.Connection:
    import sqlite_vec

    conn = sqlite3.connect(str(db_path))
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    return conn


def apply_schema(conn: sqlite3.Connection, fixture: dict) -> None:
    dims = fixture["dims"]
    if not isinstance(dims, int) or dims <= 0:
        raise ValueError(f"invalid fixture dims: {dims!r}")
    raw = SCHEMA_PATH.read_text(encoding="utf-8")
    sql = raw.replace("__EMBEDDING_DIMS__", str(dims))
    if "__EMBEDDING_DIMS__" in sql:
        raise ValueError("schema substitution failed")
    conn.executescript(sql)


def write_fixture(conn: sqlite3.Connection, fixture: dict) -> None:
    # Insertion rules are identical to interop_node.mjs (fixture order,
    # chunk_index = fixture-array position, deterministic doc/column fills).
    for doc in fixture["docs"]:
        conn.execute(
            INSERT_DOC_SQL,
            (
                doc["id"],
                "test",
                f"{doc['id']}.md",
                sha256_hex(doc["text"]),
                doc["id"],
                None,
                None,
            ),
        )
    for index, chunk in enumerate(fixture["chunks"]):
        conn.execute(
            INSERT_CHUNK_SQL,
            (
                chunk["id"],
                chunk["doc_id"],
                index,
                chunk["text"],
                sha256_hex(normalized(chunk["text"])),
            ),
        )
        conn.execute(
            "INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)",
            (chunk["id"], chunk["text"]),
        )
        conn.execute(
            "INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)",
            (chunk["id"], json.dumps(fixture["vectors"][index])),
        )
    conn.commit()


def query_evidence(conn: sqlite3.Connection, fixture: dict) -> dict:
    topk = conn.execute(
        "SELECT chunk_id, distance FROM embeddings"
        " WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        (json.dumps(fixture["query_vector"]), fixture["k"]),
    ).fetchall()
    fts_hits = conn.execute(
        "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)",
        (fixture["query_fts"],),
    ).fetchall()
    # COMPUTE each side's own content hashes from the fixture with THIS
    # runtime's normalization implementation (never read the other writer's
    # stored values — that would make cross-runtime divergence invisible).
    # A normalization divergence between the two reference writers therefore
    # fails the driver's hashes_match comparison.
    content_hashes = [
        [chunk["id"], sha256_hex(normalized(chunk["text"]))]
        for chunk in fixture["chunks"]
    ]
    return {
        "content_hashes": content_hashes,
        "docs_rows": conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0],
        "chunks_rows": conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
        "embeddings_rows": conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[
            0
        ],
        "topk_ids": [row[0] for row in topk],
        "topk_distances": [row[1] for row in topk],
        "fts_hits": [row[0] for row in fts_hits],
    }


def node_side(db_path: Path, mode: str) -> dict:
    proc = subprocess.run(
        ["node", str(NODE_DRIVER), f"--{mode}", str(db_path)],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        log(proc.stderr.strip() or "node side failed with no stderr")
        raise RuntimeError(f"interop_node.mjs --{mode} exited {proc.returncode}")
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("node side produced no stdout")
    return json.loads(lines[-1])


def python_write(db_path: Path, fixture: dict) -> dict:
    conn = connect_with_vec(db_path)
    try:
        apply_schema(conn, fixture)
        write_fixture(conn, fixture)
        evidence = query_evidence(conn, fixture)
    finally:
        conn.close()
    evidence.update(
        {
            "runtime": "python",
            "sqlite_vec_version": sqlite_vec_version(),
            "fixture": FIXTURE_LITERAL,
        }
    )
    return evidence


def python_read(db_path: Path, fixture: dict) -> dict:
    conn = connect_with_vec(db_path)
    try:
        evidence = query_evidence(conn, fixture)
    finally:
        conn.close()
    evidence.update(
        {
            "runtime": "python",
            "sqlite_vec_version": sqlite_vec_version(),
            "fixture": FIXTURE_LITERAL,
        }
    )
    return evidence


# --- oracle: recompute expectations from fixture.json with pure stdlib ------


def oracle_topk(fixture: dict) -> tuple[list[str], list[float]]:
    q = fixture["query_vector"]
    scored = []
    for chunk, vector in zip(fixture["chunks"], fixture["vectors"]):
        distance = math.sqrt(sum((a - b) ** 2 for a, b in zip(q, vector)))
        scored.append((chunk["id"], distance))
    scored.sort(key=lambda item: item[1])
    k = fixture["k"]
    ids = [item[0] for item in scored[:k]]
    distances = [item[1] for item in scored[:k]]
    return ids, distances


def oracle_fts(fixture: dict) -> list[str]:
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute("CREATE VIRTUAL TABLE t USING fts5(chunk_id UNINDEXED, text)")
        for chunk in fixture["chunks"]:
            conn.execute(
                "INSERT INTO t (chunk_id, text) VALUES (?, ?)",
                (chunk["id"], chunk["text"]),
            )
        rows = conn.execute(
            "SELECT chunk_id FROM t WHERE t MATCH ? ORDER BY bm25(t)",
            (fixture["query_fts"],),
        ).fetchall()
        return [row[0] for row in rows]
    finally:
        conn.close()


def distances_match(a: list, b: list) -> bool:
    return len(a) == len(b) and all(
        math.isfinite(x) and math.isfinite(y) and abs(x - y) <= DISTANCE_TOLERANCE
        for x, y in zip(a, b)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--direction", required=True, choices=["node->python", "python->node"]
    )
    args = parser.parse_args()
    direction = args.direction

    check = "B5-C1" if direction == "node->python" else "B5-C2"
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    temp_dir = Path(tempfile.mkdtemp(prefix="b5-store-interop-"))
    db_path = temp_dir / "fixture.db"
    try:
        if direction == "node->python":
            writer = node_side(db_path, "write")
            reader = python_read(db_path, fixture)
            writer_runtime, reader_runtime = "node", "python"
        else:
            writer = python_write(db_path, fixture)
            reader = node_side(db_path, "read")
            writer_runtime, reader_runtime = "python", "node"

        o_ids, o_distances = oracle_topk(fixture)
        o_fts = oracle_fts(fixture)
        expected_rows = {
            "docs_rows": len(fixture["docs"]),
            "chunks_rows": len(fixture["chunks"]),
            "embeddings_rows": len(fixture["chunks"]),
        }

        rows_match = all(
            writer.get(key) == expected and reader.get(key) == expected
            for key, expected in expected_rows.items()
        )
        topk_match = (
            writer.get("topk_ids") == o_ids
            and reader.get("topk_ids") == o_ids
            and distances_match(writer.get("topk_distances"), o_distances)
            and distances_match(reader.get("topk_distances"), o_distances)
            and distances_match(
                writer.get("topk_distances"), reader.get("topk_distances")
            )
        )
        fts_match = writer.get("fts_hits") == o_fts and reader.get("fts_hits") == o_fts
        # Cross-runtime content-hash identity: both writers must derive the
        # SAME content_hash for every chunk from the frozen normalization rule.
        hashes_match = bool(writer.get("content_hashes")) and writer.get(
            "content_hashes"
        ) == reader.get("content_hashes")

        verdict = {
            "check": check,
            "direction": direction,
            "fixture": FIXTURE_LITERAL,
            "schema": SCHEMA_LITERAL,
            "sqlite_vec_version": reader.get(
                "sqlite_vec_version", writer.get("sqlite_vec_version")
            ),
            "writer": {
                "runtime": writer.get("runtime", writer_runtime),
                "docs_rows": writer.get("docs_rows"),
                "chunks_rows": writer.get("chunks_rows"),
                "embeddings_rows": writer.get("embeddings_rows"),
                "topk_ids": writer.get("topk_ids"),
                "topk_distances": writer.get("topk_distances"),
                "fts_hits": writer.get("fts_hits"),
            },
            "reader": {
                "runtime": reader.get("runtime", reader_runtime),
                "docs_rows": reader.get("docs_rows"),
                "chunks_rows": reader.get("chunks_rows"),
                "embeddings_rows": reader.get("embeddings_rows"),
                "topk_ids": reader.get("topk_ids"),
                "topk_distances": reader.get("topk_distances"),
                "fts_hits": reader.get("fts_hits"),
            },
            "topk": {
                "k": fixture["k"],
                "metric": "L2",
                "writer_ids": writer.get("topk_ids"),
                "reader_ids": reader.get("topk_ids"),
                "writer_distances": writer.get("topk_distances"),
                "reader_distances": reader.get("topk_distances"),
            },
            "fts": {
                "query": fixture["query_fts"],
                "writer_hits": writer.get("fts_hits"),
                "reader_hits": reader.get("fts_hits"),
            },
            "rows_match": rows_match,
            "topk_match": topk_match,
            "fts_match": fts_match,
            "hashes_match": hashes_match,
        }

        if not (rows_match and topk_match and fts_match and hashes_match):
            log(
                f"verdict mismatch: rows_match={rows_match} "
                f"topk_match={topk_match} fts_match={fts_match} "
                f"hashes_match={hashes_match}"
            )
            log(f"oracle topk ids={o_ids} distances={o_distances}")
            log(f"oracle fts hits={o_fts}")
            return 1

        # The verdict line MUST be the last stdout line (single line, ASCII, flushed).
        print(json.dumps(verdict), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001 - driver reports every failure on stderr
        log(f"driver error: {exc}")
        return 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
