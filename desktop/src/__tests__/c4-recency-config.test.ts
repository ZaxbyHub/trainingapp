// c4-recency-config.test.ts — packs.recency.* env keys on the Node backend
// (issue #71, AC6). Frozen check driver repro/check-c7.sh runs this file.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRIEVAL_CONFIG,
  PACKS_RECENCY_FLOOR_ENV,
  PACKS_RECENCY_FLOOR_MONTHS_ENV,
  PACKS_RECENCY_HALF_LIFE_MONTHS_ENV,
  resolveRetrievalConfig,
} from '../../main/backend/retrieval/config';
import { recencyMultiplier } from '../../main/backend/retrieval/recency';

describe('c4 packs.recency.* config keys (issue #71)', () => {
  it('defaults to floor 0.85 / floorMonths 18 / halfLifeMonths 9', () => {
    expect(DEFAULT_RETRIEVAL_CONFIG.packsRecencyFloor).toBe(0.85);
    expect(DEFAULT_RETRIEVAL_CONFIG.packsRecencyFloorMonths).toBe(18);
    expect(DEFAULT_RETRIEVAL_CONFIG.packsRecencyHalfLifeMonths).toBe(9);
    const config = resolveRetrievalConfig({});
    expect(config.packsRecencyFloor).toBe(0.85);
    expect(config.packsRecencyFloorMonths).toBe(18);
    expect(config.packsRecencyHalfLifeMonths).toBe(9);
  });

  it('honors TRAININGAPP_PACKS_RECENCY_* overrides', () => {
    const config = resolveRetrievalConfig({
      [PACKS_RECENCY_FLOOR_ENV]: '0.5',
      [PACKS_RECENCY_FLOOR_MONTHS_ENV]: '6',
      [PACKS_RECENCY_HALF_LIFE_MONTHS_ENV]: '12',
    });
    expect(config.packsRecencyFloor).toBe(0.5);
    expect(config.packsRecencyFloorMonths).toBe(6);
    expect(config.packsRecencyHalfLifeMonths).toBe(12);
  });

  it('falls back to defaults on invalid input', () => {
    const config = resolveRetrievalConfig({
      [PACKS_RECENCY_FLOOR_ENV]: 'banana',
      [PACKS_RECENCY_FLOOR_MONTHS_ENV]: 'zero',
      [PACKS_RECENCY_HALF_LIFE_MONTHS_ENV]: '-3',
    });
    expect(config.packsRecencyFloor).toBe(0.85);
    expect(config.packsRecencyFloorMonths).toBe(18);
    expect(config.packsRecencyHalfLifeMonths).toBe(9);
  });

  it('overrides observably change the multiplier', () => {
    const NOW = new Date('2026-09-18T12:00:00.000Z');
    const MONTH = 30.44 * 24 * 60 * 60 * 1000;
    const at = new Date(NOW.getTime() - 6 * MONTH).toISOString();
    const defaultMultiplier = recencyMultiplier(at, { now: NOW });
    const overrideMultiplier = recencyMultiplier(at, {
      now: NOW,
      floor: resolveRetrievalConfig({ [PACKS_RECENCY_FLOOR_ENV]: '0.5' })
        .packsRecencyFloor,
      floorMonths: resolveRetrievalConfig({
        [PACKS_RECENCY_FLOOR_MONTHS_ENV]: '6',
      }).packsRecencyFloorMonths,
    });
    // 6 months at defaults (floor 0.85, horizon 18) is one third of the way
    // down: 1 - 0.15 * (6/18) = 0.95; the override reaches its floor exactly.
    expect(defaultMultiplier).toBeCloseTo(0.95, 9);
    expect(overrideMultiplier).toBeCloseTo(0.5, 9);
  });
});

describe('c4 recency config end-to-end plumbing (reviewer follow-up)', () => {
  it('a non-default surface config changes and exactly predicts pipeline scores', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    const { openStore } = await import('../../main/backend/store/sqlite-store');
    const { hybridRetrieve } = await import('../../main/backend/retrieval/hybrid');
    const { fileURLToPath } = await import('node:url');

    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    let repoRoot = thisDir;
    for (let i = 0; i < 32; i += 1) {
      if (fs.existsSync(path.join(repoRoot, 'contracts', 'api.openapi.yaml'))) break;
      repoRoot = path.dirname(repoRoot);
    }
    const store = openStore({
      dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c4-cfg-e2e-')), 'store.db'),
      dims: 8,
      repoRoot,
    });
    try {
      const NOW_MS = Date.UTC(2026, 8, 18, 12, 0, 0);
      const MONTH = 30.44 * 24 * 60 * 60 * 1000;
      const isoAt = (monthsAgo: number) => new Date(NOW_MS - monthsAgo * MONTH).toISOString();
      const sha256Hex = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
      const seed = (sql: string, ...params: unknown[]): void => {
        store.db.prepare(sql).run(...params);
      };
      // One 36-month-old pack chunk with controlled leg geometry: rank 0 on
      // both legs => raw fused score exactly 1/60 + 1/61.
      seed("INSERT INTO packs (id, name, version, published_at, source_class, active) VALUES ('pack-old', 'Old', '1.0.0', ?, 'bundled', 1)", isoAt(36));
      seed("INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES ('doc-old', 'bundled', 'docs/old.json', 's1', 'Old', ?, 'pack-old')", isoAt(36));
      seed("INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES ('ch-old', 'doc-old', 0, 'configprobe zebra ledger', 'h1')");
      seed('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)', 'ch-old', 'configprobe zebra ledger');
      seed('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)', 'ch-old', JSON.stringify([1, 0, 0, 0, 0, 0, 0, 0]));
      const embedder = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]) };

      // Node fuse: 1/(rrfK + rank + 1); rank 0 on both legs => 2/61.
      const rawFused = 2 / 61;
      const asOf = new Date(NOW_MS);

      // Defaults (0.85 / 18): 36 months past the horizon clamps to the floor.
      const defaultRows = await hybridRetrieve('configprobe zebra', { store, embedder });
      expect(defaultRows[0]?.score).toBeCloseTo(rawFused * 0.85, 9);

      // Overrides (0.5 / 1) reach applyRecencyPrior: same geometry, floor 0.5.
      const overrideRows = await hybridRetrieve('configprobe zebra', {
        store,
        embedder,
        packsRecencyFloor: 0.5,
        packsRecencyFloorMonths: 1,
      });
      expect(overrideRows[0]?.score).toBeCloseTo(rawFused * 0.5, 9);

      // The same values via createRetrievalSurface's config (the production
      // path index.ts uses) are honored too.
      const { createRetrievalSurface } = await import('../../main/backend/retrieval/hybrid');
      const surface = createRetrievalSurface({
        store,
        embedder,
        config: { packsRecencyFloor: 0.5, packsRecencyFloorMonths: 1 },
      });
      const surfaced = await surface.search('configprobe zebra', 5);
      expect(surfaced[0]?.similarity).toBeCloseTo(rawFused * 0.5, 9);
      void asOf;
    } finally {
      store.close();
    }
  });
});
