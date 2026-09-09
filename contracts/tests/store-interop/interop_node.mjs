// interop_node.mjs — Node side of the B5 store-interop driver (issue #63).
//
// Usage (invoked by run_interop.py from the repository root):
//   node contracts/tests/store-interop/interop_node.mjs --write <db-path>
//   node contracts/tests/store-interop/interop_node.mjs --read <db-path>
//
// --write: create the DB from contracts/store.schema.sql and insert the
//          fixture (docs, chunks, chunks_fts, embeddings) in fixture order,
//          then query top-k + FTS and emit this side's evidence JSON.
// --read:  open the DB written by the OTHER runtime, run the same queries,
//          and emit this side's evidence JSON.
//
// stdout contract: EXACTLY ONE JSON object on a single line (the only stdout
// output). Diagnostics go to stderr. Dependencies are resolved exclusively
// via createRequire anchored at desktop/package.json (better-sqlite3 +
// sqlite-vec are declared there — see docs/adr/0005-sqlite-vec-interop.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// contracts/tests/store-interop/ -> repo root is three levels up.
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'contracts', 'store.schema.sql');
const FIXTURE_PATH = path.join(THIS_DIR, 'fixture.json');
const DESKTOP_PKG = path.join(REPO_ROOT, 'desktop', 'package.json');

const requireFromDesktop = createRequire(DESKTOP_PKG);
const Database = requireFromDesktop('better-sqlite3');
const sqliteVec = requireFromDesktop('sqlite-vec');

// sqlite-vec's exports map does not expose ./package.json, so resolve the
// version by walking up from the resolved main entry to its package.json.
function sqliteVecVersion() {
  let dir = path.dirname(requireFromDesktop.resolve('sqlite-vec'));
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (parsed.name === 'sqlite-vec') return String(parsed.version);
    }
    dir = path.dirname(dir);
  }
  return 'unknown';
}

function fail(message) {
  process.stderr.write(`interop_node: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const mode = argv[0];
  const dbPath = argv[1];
  if ((mode !== '--write' && mode !== '--read') || !dbPath) {
    fail('usage: interop_node.mjs (--write|--read) <db-path>');
  }
  return { mode: mode === '--write' ? 'write' : 'read', dbPath };
}

// Matches the Python writer exactly: same normalization, same id/hash rules,
// same insertion order. chunk_index is the fixture-array position (0-based).
const normalized = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
const sha256Hex = (text) =>
  requireFromDesktop('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');

function openAndLoad(dbPath, mode) {
  if (mode === 'write' && fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const db = new Database(dbPath);
  sqliteVec.load(db); // must precede any vec0 DDL/DML
  return db;
}

function applySchema(db) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const dims = Number(fixture.dims);
  if (!Number.isInteger(dims) || dims <= 0) fail(`invalid fixture dims: ${fixture.dims}`);
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const sql = raw.split('__EMBEDDING_DIMS__').join(String(dims));
  if (sql.includes('__EMBEDDING_DIMS__')) fail('schema substitution failed');
  db.exec(sql);
  return fixture;
}

function writeFixture(db, fixture) {
  const insertDoc = db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertChunk = db.prepare(
    'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)'
  );
  const insertFts = db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
  const insertEmbedding = db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');
  const run = db.transaction(() => {
    for (const doc of fixture.docs) {
      insertDoc.run(doc.id, 'test', `${doc.id}.md`, sha256Hex(doc.text), doc.id, null, null);
    }
    fixture.chunks.forEach((chunk, index) => {
      insertChunk.run(chunk.id, chunk.doc_id, index, chunk.text, sha256Hex(normalized(chunk.text)));
      insertFts.run(chunk.id, chunk.text);
      insertEmbedding.run(chunk.id, JSON.stringify(fixture.vectors[index]));
    });
  });
  run();
}

function queryEvidence(db, fixture) {
  const topk = db
    .prepare('SELECT chunk_id, distance FROM embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance')
    .all(JSON.stringify(fixture.query_vector), fixture.k);
  const ftsHits = db
    .prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)')
    .all(fixture.query_fts);
  // COMPUTE this side's own content hashes from the fixture with THIS
  // runtime's normalization implementation (never read the other writer's
  // stored values — that would make cross-runtime divergence invisible).
  const contentHashes = fixture.chunks.map((chunk) => [
    chunk.id,
    sha256Hex(normalized(chunk.text)),
  ]);
  return {
    content_hashes: contentHashes,
    docs_rows: db.prepare('SELECT COUNT(*) AS n FROM docs').get().n,
    chunks_rows: db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n,
    embeddings_rows: db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n,
    topk_ids: topk.map((r) => r.chunk_id),
    topk_distances: topk.map((r) => r.distance),
    fts_hits: ftsHits.map((r) => r.chunk_id),
  };
}

const { mode, dbPath } = parseArgs(process.argv.slice(2));
const db = openAndLoad(dbPath, mode);
try {
  if (mode === 'write') {
    const fixture = applySchema(db);
    writeFixture(db, fixture);
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const evidence = queryEvidence(db, fixture);
  const payload = {
    runtime: 'node',
    sqlite_vec_version: sqliteVecVersion(),
    fixture: 'contracts/tests/store-interop/fixture.json',
    ...evidence,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} finally {
  db.close();
}
