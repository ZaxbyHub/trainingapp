// links-preserve-roundtrip.test.ts — D4 PRESERVING check (issue #80).
//
// Proves the D4 links work must not change existing pack behavior: a training
// pack built by buildStorylinePack over the synthetic fixture still
//   - passes verifyPack (manifest + index stamps + row parity), and
//   - installs via installPackRows into a fresh store with exact row-count
//     parity for docs/chunks/embeddings/chunks_fts, and
//   - leaves the links table EMPTY (a training pack carries no doc links —
//     links are a doc-pack product).
//
// GREEN at base and must STAY GREEN after the D4 fix (including the schema
// bump: the built index and the verify/install surfaces must move together).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStorylinePack } from '../../build/compose.js';
import { findRepoRoot, installPackRows, openStoreWithSchema } from '../../build/index-writer.js';
import { verifyPack } from '../../build/verify.js';
import { makeSyntheticPublish } from './helpers/build-fixture.js';
import { extractPackIndex } from './helpers/extract-pack-index.js';

const require = createRequire(import.meta.url);
interface TestDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
const Database = require('better-sqlite3') as new (dbPath: string) => TestDb;
const sqliteVec = require('sqlite-vec') as { load(db: TestDb): void };

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DIMS = 384;

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('links-preserve: training pack build/verify/install round-trip unchanged (D4, issue #80)', () => {
  it('verifies, installs with row parity, and carries zero links rows', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4preserve-'));
    scratchRoots.push(root);
    const repoRoot = findRepoRoot(REPO_ROOT);
    expect(repoRoot).toBeTruthy();

    // 1. Build a real training pack (production builder, hash embedder).
    const { publishDir } = makeSyntheticPublish(root);
    const build = await buildStorylinePack({
      publishDir,
      out: join(root, 'training-pack.zip'),
      embedder: 'hash',
      id: 'd4-preserve-training-pack',
      version: '1.0.0',
      publishedAt: '2026-09-13T00:00:00.000Z',
    });
    expect(build.docs).toBeGreaterThan(0);
    expect(build.chunks).toBeGreaterThan(0);

    // 2. The pack still verifies (manifest shape, index stamps, row parity).
    const verification = await verifyPack(build.packPath);
    expect(verification.ok, `verify problems: ${verification.problems.join('; ')}`).toBe(true);
    expect(verification.problems).toEqual([]);
    expect(verification.docs).toBe(build.docs);

    // 3. Source index row counts (read from the materialized index.sqlite).
    const indexPath = await extractPackIndex(build.packPath, root);
    const sourceDb = new Database(indexPath);
    let sourceCounts: Record<string, number>;
    try {
      sqliteVec.load(sourceDb);
      const count = (table: string): number =>
        (sourceDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0] as { n: number }).n;
      sourceCounts = {
        docs: count('docs'),
        chunks: count('chunks'),
        embeddings: count('embeddings'),
        chunks_fts: count('chunks_fts'),
      };
    } finally {
      sourceDb.close();
    }
    expect(sourceCounts['docs']).toBe(build.docs);
    expect(sourceCounts['chunks']).toBe(build.chunks);

    // 4. Install into a fresh profile-shaped store: pure row-count parity.
    //    (openStoreWithSchema returns the raw StoreDb, not a wrapper handle.)
    const storePath = join(root, 'store.sqlite');
    const target = openStoreWithSchema(storePath, DIMS, repoRoot as string);
    try {
      const counts = installPackRows(target, indexPath);
      expect(counts.docs).toBe(build.docs);
      expect(counts.chunks).toBe(build.chunks);
      const count = (table: string): number =>
        (target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0] as { n: number }).n;
      expect(count('docs')).toBe(sourceCounts['docs']);
      expect(count('chunks')).toBe(sourceCounts['chunks']);
      expect(count('embeddings')).toBe(sourceCounts['embeddings']);
      expect(count('chunks_fts')).toBe(sourceCounts['chunks_fts']);
      // A training pack contributes NO doc-to-slide links.
      expect(count('links')).toBe(0);
      const pack = target.prepare('SELECT id, source_class FROM packs').all()[0] as {
        id: string;
        source_class: string;
      };
      expect(pack.id).toBe('d4-preserve-training-pack');
      expect(pack.source_class).toBe('training');
    } finally {
      target.close();
    }
  });
});
