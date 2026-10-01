// settings-wiring-honesty: real-seam pin for the per-query rerank flag on the
// production retrieval surface (createRetrievalSurface over a real SQLite
// store + hash embedder). `rerank: false` must skip the reranker for THAT
// query only, without latching the surface; the surface reports its env
// rerank default for engines to follow when nothing is explicit.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { createRetrievalSurface, type RerankerSurface } from '../../main/backend/retrieval/hybrid.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;
const DIMS = 8;

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

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function makeStore(): Promise<{ store: StoreHandle; embedder: HashEmbedder }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-wiring-hybrid-'));
  tempDirs.push(dir);
  const embedder = new HashEmbedder({ dims: DIMS });
  const store = openStore({ dbPath: path.join(dir, 'store.sqlite'), dims: DIMS, repoRoot: REPO_ROOT });
  const chunks = [
    { chunkId: 'c1', text: 'swhzebra marker one' },
    { chunkId: 'c2', text: 'swhzebra marker two' },
  ];
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  store.db
    .prepare('INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'test', path.join(dir, 'doc.md'), sha('d1'), 'd1', null, null);
  const vectors = await embedder.embed(chunks.map((c) => c.text));
  chunks.forEach((chunk, index) => {
    store.db
      .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run(chunk.chunkId, 'd1', index, chunk.text, sha(chunk.text));
    store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(chunk.chunkId, chunk.text);
    store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(chunk.chunkId, JSON.stringify(vectors[index]));
  });
  return { store, embedder };
}

describe('settings-wiring-honesty: per-query rerank flag on the real retrieval surface', () => {
  itReal('rerank:false skips the reranker for that query only; the next default query reranks again', async () => {
    const { store, embedder } = await makeStore();
    try {
      let scored = 0;
      const reranker: RerankerSurface = {
        score: async (_query, texts) => {
          scored += 1;
          return texts.map(() => 0.95);
        },
      };
      const surface = createRetrievalSurface({ store, embedder, reranker });
      expect(surface.rerankDefault).toBe(true);

      const off = await surface.search('swhzebra', 2, { rerank: false });
      expect(off.length).toBeGreaterThanOrEqual(1);
      expect(scored).toBe(0);
      // Fused RRF-scale scores, never the reranker's sigmoid.
      for (const row of off) expect(row.similarity).toBeLessThan(0.95);
      expect(surface.floorActive).toBe(true);

      const on = await surface.search('swhzebra', 2);
      expect(scored).toBe(1);
      for (const row of on) expect(row.similarity).toBeCloseTo(0.95);
      await surface.search('swhzebra', 2, { rerank: true });
      expect(scored).toBe(2);
    } finally {
      store.close();
    }
  });

  itReal('an env-disabled surface reports rerankDefault=false and never reranks', async () => {
    const { store, embedder } = await makeStore();
    try {
      let scored = 0;
      const reranker: RerankerSurface = {
        score: async (_query, texts) => {
          scored += 1;
          return texts.map(() => 0.95);
        },
      };
      const surface = createRetrievalSurface({ store, embedder, reranker, config: { rerank: false } });
      expect(surface.rerankDefault).toBe(false);
      expect(surface.floorActive).toBe(false);
      await surface.search('swhzebra', 2, { rerank: true });
      expect(scored).toBe(0);
    } finally {
      store.close();
    }
  });
});
