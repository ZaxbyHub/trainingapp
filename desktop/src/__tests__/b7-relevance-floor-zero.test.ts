// b7-relevance-floor-zero.test.ts — issue #280 (C3 / check C17): a relevance
// floor of 0 never actually gates anything, so the surface must not report
// floorActive (scores are NOT floor-qualified; grounding must resolve
// "general").
//
// RED at base, GREEN after the fix: at the base revision the surface factory
// latched `floorActive = effectiveReranker !== null` — true whenever a
// reranker was attached, even with relevanceFloor 0 (or unset), although the
// filter `score >= 0` passes EVERY finite score and the non-finite-to-0
// mapping (PRR-005) keeps even NaN-scored rows. After the fix floorActive is
// true only while the reranker path is live AND the wired floor is a
// positive number. The floor filter itself is unchanged.
//
// Harness: real SQLite store + hash embedder (the settings-wiring-hybrid /
// b7-hybrid-retrieval rig idiom) with a stub reranker — no ONNX weights.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect } from 'vitest';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { createRetrievalSurface, type RerankerSurface } from '../../main/backend/retrieval/hybrid.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(THIS_DIR);
const itReal = nativeDepsIt('b7-relevance-floor-zero');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-floor-zero-'));
  tempDirs.push(dir);
  const embedder = new HashEmbedder({ dims: DIMS });
  const store = openStore({ dbPath: path.join(dir, 'store.sqlite'), dims: DIMS, repoRoot: REPO_ROOT });
  const chunks = [
    { chunkId: 'c1', text: 'b7floorzebra marker one' },
    { chunkId: 'c2', text: 'b7floorzebra marker two' },
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

/** Reranker double scoring the "marker two" row NaN (the q8-model hazard) and the other 0.9. */
function stubReranker(): RerankerSurface {
  return {
    score: async (_query, texts) => texts.map((text) => (text.includes('marker two') ? Number.NaN : 0.9)),
  };
}

describe('b7 C17: a zero relevance floor is honestly reported as not floor-gating', () => {
  itReal('relevanceFloor 0: floorActive === false and the non-finite-scored chunk is still returned at score 0', async () => {
    const { store, embedder } = await makeStore();
    try {
      let scored = 0;
      const reranker: RerankerSurface = {
        score: async (q, texts) => {
          scored += 1;
          return stubReranker().score(q, texts);
        },
      };
      const surface = createRetrievalSurface({
        store,
        embedder,
        reranker,
        config: { topK: 2, candidateMultiplier: 1, relevanceFloor: 0 },
      });
      expect(surface.floorActive, 'a 0 floor gates nothing — the surface must not claim a floor decision').toBe(false);

      const rows = await surface.search('b7floorzebra', 2);
      expect(scored, 'the reranker ran (this is the rerank path, not a disabled one)').toBe(1);
      // Both window rows survive: the finite 0.9 row, and the NaN row mapped
      // to score 0 pre-filter (0 >= 0 passes the unchanged zero floor).
      expect(rows).toHaveLength(2);
      const nanRow = rows.find((row) => row.text.includes('marker two'));
      const finiteRow = rows.find((row) => row.text.includes('marker one'));
      expect(nanRow, 'the non-finite-scored chunk is still returned').toBeDefined();
      expect(nanRow?.similarity, 'the non-finite score maps to 0 (PRR-005), not NaN').toBe(0);
      expect(finiteRow?.similarity).toBe(0.9);
    } finally {
      store.close();
    }
  });

  itReal('an UNSET floor with a reranker attached is equally not floor-gating', async () => {
    const { store, embedder } = await makeStore();
    try {
      const surface = createRetrievalSurface({
        store,
        embedder,
        reranker: stubReranker(),
        config: { topK: 2, candidateMultiplier: 1 },
      });
      expect(surface.floorActive, 'no wired floor -> no floor decision to claim').toBe(false);
      const rows = await surface.search('b7floorzebra', 2);
      expect(rows).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  itReal('control: a POSITIVE floor with the reranker live keeps floorActive true', async () => {
    const { store, embedder } = await makeStore();
    try {
      const surface = createRetrievalSurface({
        store,
        embedder,
        reranker: stubReranker(),
        config: { topK: 2, candidateMultiplier: 1, relevanceFloor: 0.5 },
      });
      expect(surface.floorActive, 'a real floor on the live rerank path is still floor-qualified').toBe(true);
      // The unchanged filter: the 0-mapped NaN row now DROPS at floor 0.5.
      const rows = await surface.search('b7floorzebra', 2);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.similarity).toBe(0.9);
    } finally {
      store.close();
    }
  });
});
