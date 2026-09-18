// c4-recency-pipeline.test.ts — AC2/AC5/AC7 pipeline integration on the real
// hybrid retrieval path (issue #71). Frozen check driver repro/check-c9.sh
// runs this file.
//
// Determinism: the vector leg is pinned with hand-built vectors via a custom
// EmbeddingSurface (the query embeds to Q; chunk embeddings are seeded
// directly), and the FTS5 leg is pinned by doc length, so raw fused ranks are
// exact: ch-old leads ch-fresh by ~1.7% before the prior; the 15% recency
// gap (old pack = 36 months -> multiplier 0.85) flips the final order. That
// flip IS the AC7 proof that the prior runs AFTER fusion on real fused
// scores. Exclusion/precedence/orphan cases are invariant by construction.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { EmbeddingSurface } from '../../main/backend/ingest/embedder.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';
import {
  createRetrievalSurface,
  hybridRetrieve,
  type RerankerSurface,
} from '../../main/backend/retrieval/hybrid.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
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

const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const tempDirs: string[] = [];
const stores: StoreHandle[] = [];
afterEach(() => {
  // Close BEFORE temp-dir removal: Windows locks the open sqlite file.
  while (stores.length > 0) {
    const handle = stores.pop();
    handle?.close();
  }
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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const QUERY = 'zebra pack freshness ledger';
/** Query embedding; chunk embeddings place ch-old CLOSER than ch-fresh so
 * the old chunk leads BOTH legs pre-prior. */
const Q = [1, 0, 0, 0, 0, 0, 0, 0];
const OLD_VEC = [0.9, 0.1, 0, 0, 0, 0, 0, 0];
const FRESH_VEC = [0.8, 0.2, 0, 0, 0, 0, 0, 0];
const NEUTRAL_VEC = [0.7, 0.3, 0, 0, 0, 0, 0, 0];

const PINNED_VECTORS: Record<string, number[]> = {};

const pinEmbedder: EmbeddingSurface = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => Q);
  },
};

const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 18, 12, 0, 0);

function isoAt(monthsAgo: number): string {
  return new Date(NOW_MS - monthsAgo * MONTH_MS).toISOString();
}

interface SeedOptions {
  withOldPack?: boolean;
  oldPackActive?: boolean;
  withDualPack?: boolean;
  withOrphanDoc?: boolean;
  withNeutralDoc?: boolean;
}

async function makeStore(prefix: string, options: SeedOptions = {}): Promise<StoreHandle> {
  const store = openStore({ dbPath: path.join(makeTempDir(prefix), 'store.db'), dims: DIMS, repoRoot: REPO_ROOT });
  stores.push(store);
  const seed = (sql: string, ...params: unknown[]): void => {
    store.db.prepare(sql).run(...params);
  };
  const insertPack = store.db.prepare(
    "INSERT INTO packs (id, name, version, published_at, source_class, active, install_path, supersedes) VALUES (?, ?, ?, ?, 'bundled', ?, NULL, NULL)",
  );
  const insertDoc = store.db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertChunk = store.db.prepare(
    'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
  );
  const insertFts = store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
  const insertEmbedding = store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');

  const addChunk = (chunkId: string, docId: string, text: string, vector: number[]): void => {
    PINNED_VECTORS[chunkId] = vector;
    insertChunk.run(chunkId, docId, 0, text, sha256Hex(text));
    insertFts.run(chunkId, text);
    insertEmbedding.run(chunkId, JSON.stringify(vector));
  };

  if (options.withOldPack !== false) {
    const oldActive = options.oldPackActive === false ? 0 : 1;
    insertPack.run('pack-old', 'Old Pack', '1.0.0', isoAt(36), oldActive);
    insertDoc.run('doc-old', 'bundled', 'docs/old.json', sha256Hex('doc-old'), 'Old', isoAt(36), 'pack-old');
    // Shorter FTS text: the old chunk leads the FTS leg as well.
    addChunk('ch-old', 'doc-old', 'zebra pack ledger', OLD_VEC);
  }
  insertPack.run('pack-fresh', 'Fresh Pack', '3.0.0', isoAt(0), 1);
  insertDoc.run('doc-fresh', 'bundled', 'docs/fresh.json', sha256Hex('doc-fresh'), 'Fresh', isoAt(0), 'pack-fresh');
  addChunk('ch-fresh', 'doc-fresh', 'zebra pack freshness ledger extended', FRESH_VEC);

  if (options.withDualPack) {
    // Two ACTIVE versions of one pack id sharing published_at (the versioned-a
    // fixture shape): the semver tie-break must attribute 2.0.0.
    insertPack.run('pack-dual', 'Dual', '1.0.0', isoAt(2), 1);
    insertPack.run('pack-dual', 'Dual', '2.0.0', isoAt(2), 1);
    insertDoc.run('doc-dual', 'bundled', 'docs/dual.json', sha256Hex('doc-dual'), 'Dual', isoAt(2), 'pack-dual');
    addChunk('ch-dual', 'doc-dual', 'dualpack contorion uniquebody', NEUTRAL_VEC);
  }
  if (options.withOrphanDoc) {
    // docs.pack_id points at a pack with NO active row: orphan -> excluded.
    insertDoc.run('doc-orphan', 'bundled', 'docs/orphan.json', sha256Hex('doc-orphan'), 'Orphan', isoAt(1), 'pack-gone');
    addChunk('ch-orphan', 'doc-orphan', 'zebra orphan vanished ledger', NEUTRAL_VEC);
  }
  if (options.withNeutralDoc !== false) {
    insertDoc.run('doc-neutral', 'general', 'notes.txt', sha256Hex('doc-neutral'), 'Notes', null, null);
    addChunk('ch-neutral', 'doc-neutral', 'plainnote unboxed neutral ledger zebra', NEUTRAL_VEC);
  }
  return store;
}

const idsOf = (rows: Array<{ chunkId: string }>): string[] => rows.map((row) => row.chunkId);

describe('c4 pack-aware hybrid pipeline (issue #71)', () => {
  itReal('recency flips the fused order AFTER fusion (AC7)', async () => {
    const store = await makeStore('c4-pipeline-flip-');
    const rows = await hybridRetrieve(QUERY, { store, embedder: pinEmbedder });
    expect(idsOf(rows)).toContain('ch-old');
    expect(idsOf(rows)).toContain('ch-fresh');
    // Raw fused order would put ch-old first (it leads both legs by
    // construction); the 0.85 multiplier on the 36-month-old pack must
    // promote ch-fresh to the top.
    expect(idsOf(rows)[0]).toBe('ch-fresh');
    const fresh = rows.find((row) => row.chunkId === 'ch-fresh');
    expect(fresh?.packId).toBe('pack-fresh');
    expect(fresh?.packVersion).toBe('3.0.0');
    expect(typeof fresh?.packPublishedAt).toBe('string');
  });

  itReal('excludes chunks of a deactivated pack version entirely (AC2)', async () => {
    const store = await makeStore('c4-pipeline-inactive-', { oldPackActive: false });
    const rows = await hybridRetrieve(QUERY, { store, embedder: pinEmbedder });
    expect(idsOf(rows)).not.toContain('ch-old');
    expect(idsOf(rows)).toContain('ch-fresh');
  });

  itReal('attributes the semver winner when two versions are both active (AC1 tie-break)', async () => {
    const store = await makeStore('c4-pipeline-dual-', { withDualPack: true });
    const rows = await hybridRetrieve('contorion dualpack', { store, embedder: pinEmbedder });
    const dual = rows.find((row) => row.chunkId === 'ch-dual');
    expect(dual).toBeDefined();
    expect(dual?.packId).toBe('pack-dual');
    expect(dual?.packVersion).toBe('2.0.0');
    expect(dual?.packPublishedAt).toBe(isoAt(2));
  });

  itReal('drops orphan chunks whose pack has no active row (AC2 defense-in-depth)', async () => {
    const store = await makeStore('c4-pipeline-orphan-', { withOrphanDoc: true });
    const rows = await hybridRetrieve(QUERY, { store, embedder: pinEmbedder });
    expect(idsOf(rows)).not.toContain('ch-orphan');
  });

  itReal('keeps unpackaged chunks neutral (never excluded, multiplier 1)', async () => {
    const store = await makeStore('c4-pipeline-neutral-', { withNeutralDoc: true });
    const rows = await hybridRetrieve('plainnote zebra', { store, embedder: pinEmbedder });
    const neutral = rows.find((row) => row.chunkId === 'ch-neutral');
    expect(neutral).toBeDefined();
    expect(neutral?.packId ?? null).toBeNull();
    expect(neutral?.packVersion ?? null).toBeNull();
  });

  itReal('reranker scores replace prior-adjusted scores with no double multiplication', async () => {
    const store = await makeStore('c4-pipeline-rerank-');
    const reranker: RerankerSurface = {
      async score(_query: string, candidates: string[]): Promise<number[]> {
        // True reversal: the LAST window candidate gets the best score.
        // Prior-adjusted order is [ch-fresh, ..., ch-old], so a working
        // reranker puts ch-old first; any prior leakage (multiplying these
        // scores by the pack multiplier) would break the exact-equality
        // assertions below.
        const n = candidates.length;
        return candidates.map((_, index) => 0.5 - (n - 1 - index) * 0.1);
      },
    };
    const rows = await hybridRetrieve(QUERY, {
      store,
      embedder: pinEmbedder,
      reranker,
      relevanceFloor: 0.1,
    });
    expect(rows.length).toBeGreaterThan(0);
    // Replacement: ch-old (demoted to LAST by the prior) is the winner.
    expect(idsOf(rows)[0]).toBe('ch-old');
    expect(idsOf(rows)[idsOf(rows).length - 1]).toBe('ch-fresh');
    // Exact reranker-scale scores — no double multiplication, no fusion of
    // prior-adjusted values into the reranker scale.
    const oldRow = rows.find((row) => row.chunkId === 'ch-old');
    const freshRow = rows.find((row) => row.chunkId === 'ch-fresh');
    expect(oldRow?.score).toBeCloseTo(0.5, 12);
    expect(freshRow?.score).toBeCloseTo(0.3, 12);
  });

  itReal('createRetrievalSurface passes pack attribution through for citations', async () => {
    const store = await makeStore('c4-pipeline-surface-');
    const surface = createRetrievalSurface({ store, embedder: pinEmbedder });
    const results = await surface.search(QUERY, 5);
    const fresh = results.find((row) => row.chunkId === 'ch-fresh');
    expect(fresh).toBeDefined();
    expect(fresh?.packId).toBe('pack-fresh');
    expect(fresh?.packVersion).toBe('3.0.0');
  });
});
