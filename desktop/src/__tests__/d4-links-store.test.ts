// d4-links-store.test.ts — runtime link maintenance + migrate ladder (D4/#80).
//
// Covers the store-layer surface (desktop/main/backend/store/links.ts) the
// ingest pipeline calls inside its writeDocument transaction: slide loading,
// recompute (delete-then-insert, idempotent, training-docs excluded),
// orphan pruning, pack-scoped removal, and the v1->v2 migrate ladder —
// including the parity pin that the ladder's links DDL matches a fresh v2
// store (the ladder duplicates contracts/store.schema.sql's shape by
// necessity; this pin is what catches drift).
//
// GOLDEN PARITY: the hand-computed vectors/rows case at the bottom is the
// mirror of packtool/storyline/__tests__/links-compute-unit.test.ts (the
// desktop cannot import the packtool package) — same vectors, same expected
// rows. Keep both in sync.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-links-'));
  tempDirs.push(dir);
  return path.join(dir, 'store.db');
}

async function loadModules() {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const linksMod = await import('../../main/backend/store/links.js');
  const migrateMod = await import('../../main/backend/store/migrate.js');
  return { openStore: storeMod.openStore, ...linksMod, migrate: migrateMod.migrate, CURRENT_SCHEMA_VERSION: migrateMod.CURRENT_SCHEMA_VERSION };
}

interface Row {
  [key: string]: unknown;
}

/** Seed one training slide doc + chunk + embedding (JSON-serialized, pipeline parity). */
function seedTraining(db: import('../../main/backend/store/sqlite-store.js').StoreHandle['db'], slideId: string, vector: number[]): void {
  // OR IGNORE: several slides share one training pack row.
  db.prepare(
    "INSERT OR IGNORE INTO packs (id, name, version, published_at, source_class, supersedes) VALUES ('p-train', 'Training', '1.0.0', '2026-09-13T00:00:00.000Z', 'training', NULL)",
  ).run();
  db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, pack_id) VALUES (?, ?, ?, ?, ?)',
  ).run(`doc-slide-${slideId}`, 'training', `docs/slide-001-${slideId}.json`, `sha-${slideId}`, 'p-train');
  db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(
    `ch-slide-${slideId}`,
    `doc-slide-${slideId}`,
    0,
    `slide ${slideId} text`,
    `hash-${slideId}`,
  );
  db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(`ch-slide-${slideId}`, JSON.stringify(vector));
}

/** Seed one general doc + chunk + embedding (JSON-serialized, pipeline parity). */
function seedGeneral(db: import('../../main/backend/store/sqlite-store.js').StoreHandle['db'], docId: string, chunkId: string, vector: number[], withPack: string | null = null): void {
  db.prepare(
    withPack === null
      ? 'INSERT INTO docs (id, source_class, path, sha256) VALUES (?, ?, ?, ?)'
      : 'INSERT INTO docs (id, source_class, path, sha256, pack_id) VALUES (?, ?, ?, ?, ?)',
  ).run(...(withPack === null ? [docId, 'general', `${docId}.txt`, `sha-${docId}`] : [docId, 'general', `${docId}.txt`, `sha-${docId}`, withPack]));
  db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(chunkId, docId, 0, `${docId} text`, `hash-${docId}`);
  db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(chunkId, JSON.stringify(vector));
}

describe('d4 links runtime maintenance (issue #80)', () => {
  itReal('slideIdFromDocPath mirrors the packtool parser', async () => {
    const { slideIdFromDocPath } = await loadModules();
    expect(slideIdFromDocPath('docs/slide-001-S1.json')).toBe('S1');
    expect(slideIdFromDocPath('docs/slide-042-5b8obQzpBWu.json')).toBe('5b8obQzpBWu');
    expect(slideIdFromDocPath('docs/slide-1000-big.json')).toBe('big');
    expect(slideIdFromDocPath('docs/outline.json')).toBeNull();
    expect(slideIdFromDocPath('slide-001-S1.json')).toBeNull();
  });

  itReal('recompute no-ops on a store with no training slides but still clears stale rows', async () => {
    const { openStore, recomputeLinksForDocs } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 3, repoRoot: REPO_ROOT });
    try {
      const db = store.db;
      seedGeneral(db, 'doc-a', 'ch-a', [1, 0, 0]);
      db.prepare("INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES ('ch-a', 'S9', NULL, 0.9, 1, '2026-09-13T00:00:00.000Z')").run();
      const written = recomputeLinksForDocs(db, ['doc-a'], { now: () => '2026-09-13T00:00:00.000Z' });
      expect(written).toBe(0);
      const left = db.prepare('SELECT COUNT(*) AS n FROM links').get() as Row;
      expect(left.n).toBe(0);
    } finally {
      store.close();
    }
  });

  itReal('recompute links a general doc chunk against installed training slides', async () => {
    const { openStore, recomputeLinksForDocs } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 3, repoRoot: REPO_ROOT });
    try {
      const db = store.db;
      seedTraining(db, 'S1', [1, 0, 0]);
      // The doc pack's packs row must exist (docs.pack_id is FK-enforced).
      db.prepare(
        "INSERT OR IGNORE INTO packs (id, name, version, published_at, source_class, supersedes) VALUES ('p-doc', 'Docs', '1.0.0', '2026-09-13T00:00:00.000Z', 'user', NULL)",
      ).run();
      seedGeneral(db, 'doc-a', 'ch-a', [1, 0, 0], 'p-doc');
      const written = recomputeLinksForDocs(db, ['doc-a'], { now: () => '2026-09-13T00:00:00.000Z' });
      expect(written).toBeGreaterThan(0);
      const rows = db.prepare('SELECT slide_id, pack_id, score, rank FROM links WHERE chunk_id = ?').all('ch-a') as Array<Row>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.slide_id).toBe('S1');
      expect(rows[0]?.pack_id).toBe('p-doc');
      expect(Number(rows[0]?.score)).toBeCloseTo(1, 6);
      expect(rows[0]?.rank).toBe(1);
      // Idempotent: a second pass rewrites the same rows, not duplicates.
      const second = recomputeLinksForDocs(db, ['doc-a'], { now: () => '2026-09-13T00:00:00.000Z' });
      expect(second).toBe(written);
      const total = db.prepare('SELECT COUNT(*) AS n FROM links').get() as Row;
      expect(total.n).toBe(written);
    } finally {
      store.close();
    }
  });

  itReal('recompute skips training docs and prunes-orphan semantics hold on supersede-shaped deletion', async () => {
    const { openStore, recomputeLinksForDocs, pruneOrphanLinks, removeLinksForPack } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 3, repoRoot: REPO_ROOT });
    try {
      const db = store.db;
      seedTraining(db, 'S1', [1, 0, 0]);
      seedGeneral(db, 'doc-a', 'ch-a', [1, 0, 0]);
      // Training docs are link TARGETS, never sources.
      expect(recomputeLinksForDocs(db, ['doc-slide-S1'])).toBe(0);
      expect(recomputeLinksForDocs(db, ['doc-a'])).toBeGreaterThan(0);
      // Supersede shape: the old chunks disappear; orphan links must prune.
      // The orphan row is injected with FKs off — deliberately creating the
      // exact state the prune (and the C3 check) must catch.
      db.prepare('PRAGMA foreign_keys = OFF').run();
      db.prepare("INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES ('ch-old', 'S1', NULL, 0.9, 1, '2026-09-13T00:00:00.000Z')").run();
      expect(pruneOrphanLinks(db)).toBe(1);
      const orphans = db.prepare('SELECT COUNT(*) AS n FROM links WHERE chunk_id NOT IN (SELECT id FROM chunks)').get() as Row;
      expect(orphans.n).toBe(0);
      // Pack-scoped removal only touches that pack's rows.
      db.prepare("UPDATE links SET pack_id = 'p-doc' WHERE chunk_id = 'ch-a'").run();
      expect(removeLinksForPack(db, 'p-other')).toBe(0);
      expect(removeLinksForPack(db, 'p-doc')).toBe(1);
      const total = db.prepare('SELECT COUNT(*) AS n FROM links').get() as Row;
      expect(total.n).toBe(0);
    } finally {
      store.close();
    }
  });

  itReal('loadSlideVectors decodes JSON embeddings and skips non-slide paths', async () => {
    const { openStore, loadSlideVectors } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 3, repoRoot: REPO_ROOT });
    try {
      const db = store.db;
      seedTraining(db, 'S1', [1, 0, 0]);
      // An auxiliary training doc whose path is not a slide doc: skipped.
      db.prepare(
        'INSERT INTO docs (id, source_class, path, sha256, pack_id) VALUES (?, ?, ?, ?, ?)',
      ).run('doc-aux', 'training', 'docs/outline.json', 'sha-aux', 'p-train');
      db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run('ch-aux', 'doc-aux', 0, 'outline text', 'hash-aux');
      db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run('ch-aux', JSON.stringify([0, 1, 0]));
      const slides = loadSlideVectors(db);
      expect(slides).toHaveLength(1);
      expect(slides[0]?.slideId).toBe('S1');
      expect(slides[0]?.vector).toEqual([1, 0, 0]);
    } finally {
      store.close();
    }
  });

  itReal('loadSlideVectors decodes raw float32 blobs (PRR-022: the vec0 read-back shape)', async () => {
    const { openStore, loadSlideVectors, recomputeLinksForDocs } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 2, repoRoot: REPO_ROOT });
    try {
      const db = store.db;
      // Seed the slide embedding as a raw little-endian float32 blob — the
      // shape sqlite-vec actually returns on SELECT — not the JSON the
      // writer serialized.
      seedTraining(db, 'S1', [1, 0]);
      db.prepare('UPDATE embeddings SET embedding = ? WHERE chunk_id = ?').run(
        Buffer.from(new Float32Array([1, 0]).buffer),
        'ch-slide-S1',
      );
      seedGeneral(db, 'doc-a', 'ch-a', [1, 0]);
      const slides = loadSlideVectors(db);
      expect(slides).toHaveLength(1);
      expect(slides[0]?.vector).toEqual([1, 0]);
      // End-to-end: the blob-decoded slide still links a matching doc chunk.
      recomputeLinksForDocs(db, ['doc-a'], { now: () => '2026-09-13T00:00:00.000Z' });
      const rows = db.prepare('SELECT slide_id, score FROM links WHERE chunk_id = ?').all('ch-a') as Array<Row>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.slide_id).toBe('S1');
      expect(Number(rows[0]?.score)).toBeCloseTo(1, 6);
    } finally {
      store.close();
    }
  });

  itReal('recompute throws on invalid options', async () => {
    const { openStore, recomputeLinksForDocs } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 3, repoRoot: REPO_ROOT });
    try {
      expect(() => recomputeLinksForDocs(store.db, ['doc-a'], { topK: 0 })).toThrowError(/topK/);
      expect(() => recomputeLinksForDocs(store.db, ['doc-a'], { threshold: 7 })).toThrowError(/threshold/);
    } finally {
      store.close();
    }
  });

  itReal('threshold boundary is strict (> not >=), mirroring the packtool kernel exactly', async () => {
    // Reviewer Probe D follow-up: pins the desktop kernel's strict-> floor.
    // chunk [3,4] vs slide [0,5]: cosine = 20/25 = 0.8 (an exactly
    // representable division result, so the boundary is deterministic) —
    // same construction as packtool links-compute-unit.test.ts.
    const { openStore, recomputeLinksForDocs } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 2, repoRoot: REPO_ROOT });
    try {
      const db = store.db;
      seedTraining(db, 'at', [0, 5]);
      seedGeneral(db, 'doc-a', 'ch-a', [3, 4]);
      recomputeLinksForDocs(db, ['doc-a'], { threshold: 0.8, now: () => '2026-09-13T00:00:00.000Z' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM links').get() as Row).n).toBe(0);
      recomputeLinksForDocs(db, ['doc-a'], { threshold: 0.79, now: () => '2026-09-13T00:00:00.000Z' });
      const rows = db.prepare('SELECT slide_id, score FROM links').all() as Array<Row>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.slide_id).toBe('at');
      expect(Number(rows[0]?.score)).toBeCloseTo(0.8, 12);
    } finally {
      store.close();
    }
  });

  itReal('GOLDEN PARITY: same vectors and expected rows as the packtool kernel mirror', async () => {
    const { openStore, recomputeLinksForDocs } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 3, repoRoot: REPO_ROOT });
    try {
      const db = store.db;
      // Same fixture as packtool/storyline/__tests__/links-compute-unit.test.ts.
      seedTraining(db, 'A', [6, 8, 0]);
      seedTraining(db, 'B', [4, 3, 0]);
      seedTraining(db, 'C', [0, 5, 0]);
      seedTraining(db, 'D', [5, 0, 0]);
      seedTraining(db, 'E', [0, 0, 7]);
      seedGeneral(db, 'doc-g', 'ch-g', [3, 4, 0]);
      recomputeLinksForDocs(db, ['doc-g'], { now: () => '2026-09-13T00:00:00.000Z' });
      const rows = db.prepare('SELECT slide_id, score, rank FROM links WHERE chunk_id = ? ORDER BY rank').all('ch-g') as Array<Row>;
      expect(rows.map((r) => r.slide_id)).toEqual(['A', 'B', 'C']);
      expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
      expect(Number(rows[0]?.score)).toBeCloseTo(1.0, 12);
      expect(Number(rows[1]?.score)).toBeCloseTo(0.96, 12);
      expect(Number(rows[2]?.score)).toBeCloseTo(0.8, 12);
      // D (0.6) is above threshold but capped; E (0) is below threshold.
    } finally {
      store.close();
    }
  });
});

describe('d4 migrate ladder v1 -> v2 (issue #80)', () => {
  itReal('upgrades a v1 store: reserved links shape gains pack_id/rank/computed_at', async () => {
    const { openStore, migrate, CURRENT_SCHEMA_VERSION } = await loadModules();
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    const dbPath = makeTempDbPath();
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      // Downgrade the fresh v2 store to the v1 reserved shape + version seed.
      store.db.exec('DROP INDEX IF EXISTS links_slide_id_idx');
      store.db.exec('DROP TABLE links');
      store.db.exec('CREATE TABLE links (chunk_id TEXT NOT NULL REFERENCES chunks(id), slide_id TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (chunk_id, slide_id))');
      store.db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    } finally {
      store.close();
    }
    // Re-open runs the ladder via openStore's migrate call.
    const upgraded = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(upgraded.schemaVersion).toBe(3);
      const version = upgraded.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row;
      expect(version.value).toBe('3');
      const columns = upgraded.db.prepare('PRAGMA table_info(links)').all() as Array<Row>;
      const names = columns.map((c) => c.name).sort();
      expect(names).toEqual(['chunk_id', 'computed_at', 'pack_id', 'rank', 'score', 'slide_id']);
    } finally {
      upgraded.close();
    }
    // The explicit ladder is idempotent at v2.
    const again = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(migrate(again.db)).toBe(3);
    } finally {
      again.close();
    }
  });

  itReal('ladder-created links table matches a fresh v2 store byte-for-byte in shape (parity pin)', async () => {
    const { openStore, migrate } = await loadModules();
    // Fresh v2 store (schema file DDL).
    const freshPath = makeTempDbPath();
    const fresh = openStore({ dbPath: freshPath, dims: 8, repoRoot: REPO_ROOT });
    // Downgraded v1 store, then explicit migrate (ladder DDL).
    const v1Path = makeTempDbPath();
    const seed = openStore({ dbPath: v1Path, dims: 8, repoRoot: REPO_ROOT });
    seed.db.exec('DROP INDEX IF EXISTS links_slide_id_idx');
    seed.db.exec('DROP TABLE links');
    seed.db.exec('CREATE TABLE links (chunk_id TEXT NOT NULL REFERENCES chunks(id), slide_id TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (chunk_id, slide_id))');
    seed.db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    expect(migrate(seed.db)).toBe(3);
    try {
      const shapeOf = (db: import('../../main/backend/store/sqlite-store.js').StoreHandle['db']): string =>
        JSON.stringify(
          (db.prepare('PRAGMA table_info(links)').all() as Array<Row>).map((c) => [c.name, c.type, c.notnull, c.pk]),
        );
      const indexesOf = (db: import('../../main/backend/store/sqlite-store.js').StoreHandle['db']): string[] =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'links'").all() as Array<Row>)
          .map((r) => String(r.name))
          .sort();
      expect(shapeOf(seed.db)).toBe(shapeOf(fresh.db));
      expect(indexesOf(seed.db)).toEqual(indexesOf(fresh.db));
    } finally {
      fresh.close();
      seed.close();
    }
  });

  itReal('fails loud on a store from the future', async () => {
    const { openStore, migrate } = await loadModules();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 8, repoRoot: REPO_ROOT });
    try {
      store.db.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
      expect(() => migrate(store.db)).toThrowError(/newer than this code understands/);
    } finally {
      store.close();
    }
  });
});
