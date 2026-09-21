// Minimal single-document index: better-sqlite3 + sqlite-vec (vec0), a schema
// subset of contracts/store.schema.sql v3. The native addons are require()'d
// via createRequire (the established loading pattern for Electron asar apps).
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { EMBEDDING_DIMS } from './embed';

export type Db = {
  exec: (sql: string) => void;
  loadExtension: (path: string) => void;
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
  };
};

export interface Chunk {
  chunkId: string;
  text: string;
}

const DOC_TEXT = `Issue #57 spike corpus: desktop backend architecture decision.

The trainingapp v3 roadmap (epic #50) splits delivery into five workstreams. Workstream A
freezes the contract and records decisions; workstream B builds the Electron shell and the
desktop backend; workstream C ships knowledge packs; workstream D builds the training pack
and Learn panel; workstream E hardens CI and release.

The desktop backend decision (ADR-0003) compares two packaged shapes. Option one is a Node
main-process server using node-llama-cpp for native LLM inference, onnxruntime-node for
ONNX embedding models, and better-sqlite3 with the sqlite-vec extension for the local
vector store. Option two is an Electron-hosted Python sidecar built with PyInstaller that
runs the existing FastAPI pipeline (api_server.py, llama-cpp-python,
sentence-transformers) as a child process on loopback.

The frozen API contract (contracts/api.openapi.yaml v2.6.0) defines /ask/stream as a POST
endpoint returning text/event-stream frames separated by CRLF: token events carry a JSON
token field, the single terminal done event carries sources, context_length, grounding,
and a cancelled flag when the client disconnected mid-generation.

Model profiles come from ADR-0002: the Quality profile is gemma-4-e2b-it Q4_K_M and the
Fast profile is lfm2.5-vl-450m Q4_K_M. The embedding model selected by ADR-0001 is
bge-small-en-v1.5 (384 dims). Benchmarks are machine-tagged; reference-i5 laptop rows stay
PENDING until the operator runs them, and dev-station rows are never presented as laptop
numbers.`;

export function openStore(dbPath: string): Db {
  const require = createRequire(__filename);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as new (p: string) => Db;
  const db = new Database(dbPath);
  // sqlite-vec's load() resolves vec0.dll via require.resolve inside its own
  // package dir; under asar that path is not a real file, so loadExtension
  // fails. Rewrite the asar path to the unpacked twin and load explicitly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqliteVec = require('sqlite-vec') as { getLoadablePath: () => string };
  const loadable = sqliteVec.getLoadablePath().replace('app.asar', 'app.asar.unpacked');
  db.loadExtension(loadable);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIMS}]
    );
  `);
  return db;
}

export function chunkText(text: string, maxChars = 400): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paras) {
    if ((current + '\n\n' + p).length > maxChars && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function ingestDocument(db: Db, docId: string, text: string, embedFn: (t: string) => Promise<Float32Array>): Promise<number> {
  return (async () => {
    // Single-document spike index: clear-then-build (vec0 has no upsert and
    // the DB persists across launches).
    db.exec('DELETE FROM vec_chunks; DELETE FROM chunks;');
    const chunks = chunkText(text);
    const insert = db.prepare('INSERT INTO chunks (chunk_id, doc_id, seq, text) VALUES (?, ?, ?, ?)');
    const insertVec = db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${docId}:${i}`;
      insert.run(chunkId, docId, i, chunks[i]);
      const vec = await embedFn(chunks[i]);
      insertVec.run(chunkId, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    }
    return chunks.length;
  })();
}

export function search(db: Db, queryVec: Float32Array, k: number): Chunk[] {
  const blob = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
  // vec0 knn queries under a JOIN need the 'k = N' constraint in WHERE (a
  // bound 'LIMIT ?' is rejected; a trailing LIMIT alone is not detected).
  const limit = Math.max(1, Math.floor(Number(k) || 1));
  const rows = db.prepare(
    `SELECT c.chunk_id AS chunkId, c.text AS text, v.distance AS distance
     FROM vec_chunks v JOIN chunks c ON c.chunk_id = v.chunk_id
     WHERE v.embedding MATCH ? AND k = ${limit} ORDER BY distance`
  ).all(blob) as Array<{ chunkId: string; text: string; distance: number }>;
  return rows.map((r) => ({ chunkId: r.chunkId, text: r.text }));
}

export { DOC_TEXT };
export const DOC_ID = 'spike-adoc';
export function defaultDbPath(): string {
  return path.join(process.env.TRAININGAPP_SPIKE_DATA ?? path.join(process.cwd(), 'spike-data'), 'spike-node.db');
}
