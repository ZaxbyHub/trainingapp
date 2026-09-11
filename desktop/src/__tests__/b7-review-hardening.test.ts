// b7-review-hardening.test.ts — ADDITIVE regression tests for the PR #102
// review findings (PRR-004/005/008/011/017/018). Deliberately a NEW file: the
// frozen B7 acceptance specs must not be edited (issue-tracer checkpoint
// contract). Mirrors the C1 spec's fixture style (HashEmbedder, dims 8,
// interop-pinned store seed).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreHandle } from '../../main/backend/store/sqlite-store.js';
import type { EmbeddingSurface } from '../../main/backend/ingest/embedder.js';
import { openStore } from '../../main/backend/store/sqlite-store.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { resolveRetrievalConfig } from '../../main/backend/retrieval/config.js';
import {
  createRetrievalSurface,
  hybridRetrieve,
  sanitizeFtsQuery,
  type RerankerSurface,
} from '../../main/backend/retrieval/hybrid.js';

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

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
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

interface Fixture {
  store: StoreHandle;
  embedder: EmbeddingSurface;
}

async function makeFixture(prefix: string): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const docOne = path.join(dir, 'docs', 'hardening-one.md');
  const docTwo = path.join(dir, 'docs', 'hardening-two.md');
  fs.mkdirSync(path.dirname(docOne), { recursive: true });
  const embedder = new HashEmbedder({ dims: DIMS });
  const store = openStore({ dbPath: path.join(dir, 'store.sqlite'), dims: DIMS, repoRoot: REPO_ROOT });
  const insertDoc = store.db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertChunk = store.db.prepare(
    'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
  );
  const insertFts = store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
  const insertEmbedding = store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');
  const docs = [
    {
      docId: 'd1',
      path: docOne,
      chunks: [
        { chunkId: 'c1', text: 'b7zebra marker one' },
        { chunkId: 'c2', text: 'beta gamma two' },
      ],
    },
    {
      docId: 'd2',
      path: docTwo,
      chunks: [
        { chunkId: 'c3', text: 'delta epsilon three' },
        { chunkId: 'c4', text: 'zeta eta four' },
      ],
    },
  ];
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const doc of docs) {
      insertDoc.run(doc.docId, 'test', doc.path, sha256Hex(doc.chunks.map((c) => c.text).join('\n')), doc.docId, null, null);
      doc.chunks.forEach((chunk, index) => {
        insertChunk.run(chunk.chunkId, doc.docId, index, chunk.text, sha256Hex(chunk.text));
        insertFts.run(chunk.chunkId, chunk.text);
      });
    }
    store.db.exec('COMMIT');
  } catch (err) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      /* closed by caller */
    }
    throw err;
  }
  const allTexts = docs.flatMap((doc) => doc.chunks.map((chunk) => chunk.text));
  const vectors = await embedder.embed(allTexts);
  let vectorIndex = 0;
  docs.forEach((doc) => {
    doc.chunks.forEach((chunk) => {
      insertEmbedding.run(chunk.chunkId, JSON.stringify(vectors[vectorIndex]));
      vectorIndex += 1;
    });
  });
  return { store, embedder };
}

describe('b7 review hardening (PR #102 findings)', () => {
  itReal('PRR-004: a failed reranker latches off for the surface lifetime (no per-query retry)', async () => {
    const fx = await makeFixture('b7-hard-latch-');
    try {
      let calls = 0;
      const flaky: RerankerSurface = {
        score: vi.fn(async () => {
          calls += 1;
          throw new Error('worker exploded');
        }),
      };
      const surface = createRetrievalSurface({
        store: fx.store,
        embedder: fx.embedder,
        reranker: flaky,
      });
      const first = await surface.search('b7zebra', 4);
      expect(first.length).toBeGreaterThanOrEqual(1); // degraded, not thrown
      const second = await surface.search('b7zebra', 4);
      expect(second.length).toBeGreaterThanOrEqual(1);
      // The latch: the broken reranker is never consulted again.
      expect(calls).toBe(1);
    } finally {
      fx.store.close();
    }
  });

  itReal('PRR-005: non-finite reranker scores map to a finite score instead of poisoning the sort', async () => {
    const fx = await makeFixture('b7-hard-nan-');
    try {
      const NaNReranker: RerankerSurface = { score: async () => [Number.NaN, 0.9, Number.NaN, 0.4] };
      const rows = await hybridRetrieve('b7zebra', {
        store: fx.store,
        embedder: fx.embedder,
        reranker: NaNReranker,
        relevanceFloor: undefined,
        topK: 4,
        candidateMultiplier: 1,
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(Number.isFinite(row.score)).toBe(true);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
      }
    } finally {
      fx.store.close();
    }
  });

  itReal('PRR-008: a reranker that throws on every score degrades to the fused, floor-free ordering', async () => {
    const fx = await makeFixture('b7-hard-degrade-');
    try {
      const broken: RerankerSurface = { score: async () => Promise.reject(new Error('dead')) };
      const withBrokenFloor = createRetrievalSurface({
        store: fx.store,
        embedder: fx.embedder,
        reranker: broken,
        // A floor that would empty reranked RRF-scale results if wrongly applied.
        config: { relevanceFloor: 1.0 },
      });
      const rows = await withBrokenFloor.search('b7zebra', 4);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(row.similarity).toBeLessThan(1.0);
    } finally {
      fx.store.close();
    }
  });

  it('PRR-011: absurd env integers fall back to defaults (upper sanity bounds)', () => {
    const env = (k: string, v: string): Record<string, string> => ({ [k]: v });
    expect(resolveRetrievalConfig(env('TRAININGAPP_RETRIEVAL_TOPK', '999999999')).topK).toBe(10);
    expect(resolveRetrievalConfig(env('TRAININGAPP_RETRIEVAL_TOPK', '1001')).topK).toBe(10);
    expect(resolveRetrievalConfig(env('TRAININGAPP_RETRIEVAL_TOPK', '1000')).topK).toBe(1000);
    expect(
      resolveRetrievalConfig(env('TRAININGAPP_RETRIEVAL_CANDIDATE_MULTIPLIER', '999')).candidateMultiplier,
    ).toBe(3);
    expect(resolveRetrievalConfig(env('TRAININGAPP_RETRIEVAL_RRF_K', '99999999')).rrfK).toBe(60);
  });

  it('PRR-017: sanitizeFtsQuery preserves hyphen and tilde tokens', () => {
    expect(sanitizeFtsQuery('well-known')).toBe('"well-known"');
    expect(sanitizeFtsQuery('~prefix')).toBe('"~prefix"');
    // The star in c* is an FTS5 operator and IS dropped (frozen rule); the
    // hyphenated and tilde tokens must survive untouched.
    expect(sanitizeFtsQuery('a "b" AND c*')).toBe('"a"');
    expect(sanitizeFtsQuery('state-of-the-art ~2')).toBe('"state-of-the-art" "~2"');
  });

  itReal('PRR-018: surface rows are ordered by descending similarity', async () => {
    const fx = await makeFixture('b7-hard-order-');
    try {
      const surface = createRetrievalSurface({ store: fx.store, embedder: fx.embedder });
      const rows = await surface.search('b7zebra', 5);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].similarity).toBeGreaterThanOrEqual(rows[i].similarity);
      }
    } finally {
      fx.store.close();
    }
  });
});
