// b6-stale-chunk.test.ts — B6 stale-chunk regression check (issue #64, C2/AC4).
//
// Pipeline-level pins against the real SQLite store (no HTTP layer):
//   - DELETE-BEFORE-REINGEST: re-ingesting a file whose bytes CHANGED at the
//     same path must replace the old doc row AND all of its chunks,
//     embeddings, and chunks_fts rows — no stale revision-1 text may survive;
//   - chunk identity: id = sha256(docSha256 + ':' + chunkIndex + ':' +
//     normalizedText), with normalization matching contracts/tests/store-interop/run_interop.py;
//   - content dedupe: identical bytes are a no-op success (documents:0).
//
// RED AT BASE: statically imports the not-yet-existing ingest modules
// (pipeline.js / embedder.js / config.js) — the intended failing-first state.
// Requires desktop/node_modules (better-sqlite3); CI always has it.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { DEFAULT_INGEST_CONFIG } from '../../main/backend/ingest/config.js';
import { IngestPipeline } from '../../main/backend/ingest/pipeline.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Mirrors run_interop.py normalized(): \n line endings, trailing [ \t] per line stripped. */
function normalized(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

function words(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

function countRows(store: StoreHandle, table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('b6 C2 (AC4): delete-before-reingest leaves no stale chunks', () => {
  itReal('re-ingesting a changed file replaces doc+chunks+embeddings+fts entirely', async () => {
    const root = makeTempDir('b6-c2-');
    const store = openStore({ dbPath: path.join(root, 'store.sqlite'), dims: 8, repoRoot: REPO_ROOT });
    try {
      const filePath = path.join(root, 'guide.txt');
      fs.writeFileSync(filePath, `${words(300, 'revone')} REV1 UNIQUE MARKER alpha.\n`, 'utf8');
      const pipeline = new IngestPipeline({
        store,
        embedder: new HashEmbedder({ dims: 8 }),
        config: { ...DEFAULT_INGEST_CONFIG },
      });

      const first = await pipeline.ingestFile({ name: filePath, data: fs.readFileSync(filePath) });
      expect(first.success).toBe(true);
      expect(first.documents).toBe(1);
      expect(countRows(store, 'docs')).toBe(1);

      // Revision 2: different content AND length, same on-disk path.
      fs.writeFileSync(filePath, `${words(600, 'revtwo')} REV2 UNIQUE MARKER beta.\n`, 'utf8');
      const rev2Bytes = fs.readFileSync(filePath);
      const second = await pipeline.ingestFile({ name: filePath, data: rev2Bytes });
      expect(second.success).toBe(true);

      // Exactly ONE doc row for the path, keyed to the NEW bytes.
      const docRows = store.db
        .prepare('SELECT id, sha256, path FROM docs WHERE path = ?')
        .all(filePath) as Array<{ id: string; sha256: string; path: string }>;
      expect(docRows).toHaveLength(1);
      expect(docRows[0].sha256).toBe(sha256hex(rev2Bytes));
      expect(countRows(store, 'docs')).toBe(1);

      // No stale revision-1 chunk text anywhere in the store.
      const stale = store.db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE text LIKE '%REV1 UNIQUE MARKER%'")
        .get() as { n: number };
      expect(stale.n).toBe(0);

      const chunkRows = store.db
        .prepare('SELECT id, chunk_index, text FROM chunks WHERE doc_id = ? ORDER BY chunk_index')
        .all(docRows[0].id) as Array<{ id: string; chunk_index: number; text: string }>;
      expect(chunkRows.length).toBeGreaterThan(0);
      expect(chunkRows.map((chunk) => chunk.chunk_index)).toEqual(chunkRows.map((_, i) => i));

      // Identity pin: chunk id = sha256(docSha + ':' + chunkIndex + ':' + normalizedText).
      for (const chunk of chunkRows) {
        expect(chunk.id).toBe(sha256hex(`${docRows[0].sha256}:${chunk.chunk_index}:${normalized(chunk.text)}`));
      }
      // The embeddings and FTS mirrors cover EXACTLY the surviving chunk set.
      expect(countRows(store, 'chunks')).toBe(chunkRows.length);
      expect(countRows(store, 'embeddings')).toBe(chunkRows.length);
      expect(countRows(store, 'chunks_fts')).toBe(chunkRows.length);
    } finally {
      store.close();
    }
  });

  itReal('ingesting identical bytes is a no-op success (content dedupe)', async () => {
    const root = makeTempDir('b6-c2-dedupe-');
    const store = openStore({ dbPath: path.join(root, 'store.sqlite'), dims: 8, repoRoot: REPO_ROOT });
    try {
      const pipeline = new IngestPipeline({
        store,
        embedder: new HashEmbedder({ dims: 8 }),
        config: { ...DEFAULT_INGEST_CONFIG },
      });
      const filePath = path.join(root, 'stable.txt');
      const bytes = Buffer.from(`${words(200, 'dedupe')} stable content\n`, 'utf8');

      const first = await pipeline.ingestFile({ name: filePath, data: bytes });
      expect(first.success).toBe(true);
      expect(first.documents).toBe(1);
      const docsBefore = countRows(store, 'docs');
      const chunksBefore = countRows(store, 'chunks');
      expect(docsBefore).toBe(1);

      const second = await pipeline.ingestFile({ name: filePath, data: bytes });
      expect(second.success).toBe(true);
      expect(second.documents).toBe(0);
      expect(second.chunks_added).toBe(0);
      expect(countRows(store, 'docs')).toBe(docsBefore);
      expect(countRows(store, 'chunks')).toBe(chunksBefore);
    } finally {
      store.close();
    }
  });
});

describe('b6 C2: HashEmbedder determinism', () => {
  itReal('same text maps to the same finite vector; different text maps to a different one', async () => {
    const embedder = new HashEmbedder({ dims: 8 });
    expect(embedder.modelId).toBe('hash');
    const [a1, b1] = await embedder.embed(['deterministic input', 'other input']);
    const [a2] = await embedder.embed(['deterministic input']);
    expect(a1).toHaveLength(8);
    expect(a2).toEqual(a1);
    expect(b1).not.toEqual(a1);
    for (const vector of [a1, b1]) {
      for (const component of vector) expect(Number.isFinite(component)).toBe(true);
    }
  });
});
