// AC3 — installing the pack's prebuilt index performs ZERO embedder calls
// (issue #79). Frozen driver: repro/c3-install-no-embed.sh filters this file
// via `vitest run build-storyline.ac3`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStorylinePack } from '../../build/compose';
import { installPackRows, openStoreWithSchema, findRepoRoot } from '../../build/index-writer';
import { HashEmbedder } from '../../build/embedder';
import { fileURLToPath } from 'node:url';
import { makeSyntheticPublish } from './helpers/build-fixture';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('build-storyline.ac3: install is pure data movement (no re-embedding)', () => {
  it('copies pack rows into a profile-shaped store with zero embed() calls', { timeout: 20_000 }, async () => {
    // 20s: lazily loads the better-sqlite3/sqlite-vec natives.
    const root = mkdtempSync(join(tmpdir(), 'ac3-'));
    scratchRoots.push(root);
    const { publishDir } = makeSyntheticPublish(root);
    const build = await buildStorylinePack({
      publishDir,
      out: join(root, 'pack.zip'),
      embedder: 'hash',
      id: 'fixture-pack',
      version: '1.0.0',
    });

    // Materialize the pack's index.sqlite (the zip holds it compressed).
    const { extractPackIndex } = await import('./helpers/extract-pack-index');
    const indexPath = await extractPackIndex(build.packPath, root);

    // A spy embedder proves install never re-embeds: the counter must stay 0.
    const spy = new HashEmbedder({ dims: 384 });
    let embedCalls = 0;
    const original = spy.embed.bind(spy);
    spy.embed = (texts: string[]) => {
      embedCalls += 1;
      return original(texts);
    };

    const storePath = join(root, 'store.sqlite');
    const repoRoot = findRepoRoot(REPO_ROOT);
    expect(repoRoot).toBeTruthy();
    const db = openStoreWithSchema(storePath, 384, repoRoot as string);
    try {
      const counts = installPackRows(db, indexPath);
      expect(counts.docs).toBe(build.docs);
      expect(counts.chunks).toBe(build.chunks);
      expect(embedCalls).toBe(0);

      const rows = (sql: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;
      expect(rows('docs')).toBe(build.docs);
      expect(rows('chunks')).toBe(build.chunks);
      expect(rows('embeddings')).toBe(build.chunks);
      expect(rows('chunks_fts')).toBe(build.chunks);
      // The store's pack registry carries the installed pack.
      const pack = db.prepare('SELECT id, source_class FROM packs').get() as { id: string; source_class: string };
      expect(pack.id).toBe('fixture-pack');
      expect(pack.source_class).toBe('training');
    } finally {
      db.close();
    }
  });
});
