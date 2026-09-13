// AC4 — reproducible build: two builds from identical input produce identical
// pack.json docs[] content, modulo the declared-volatile published_at field
// (issue #79). Frozen driver: repro/c4-reproducible.sh filters this file via
// `vitest run build-storyline.ac4`.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStorylinePack } from '../../build/compose';
import { readPackJson } from './helpers/extract-pack-index';
import { makeSyntheticPublish } from './helpers/build-fixture';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface PackShape {
  published_at: string;
  docs: Array<{ path: string; sha256: string; title: string; mime: string }>;
  [key: string]: unknown;
}

describe('build-storyline.ac4: two identical builds produce identical docs[] content', () => {
  it('pack.json minus published_at is identical across builds', { timeout: 30_000 }, async () => {
    // 30s: two full builds (each loads the sqlite natives lazily).
    const root = mkdtempSync(join(tmpdir(), 'ac4-'));
    scratchRoots.push(root);
    const { publishDir } = makeSyntheticPublish(root);
    const fixedTime = '2026-09-13T00:00:00.000Z';

    const first = await buildStorylinePack({
      publishDir,
      out: join(root, 'one.zip'),
      embedder: 'hash',
      id: 'fixture-pack',
      version: '1.0.0',
      publishedAt: fixedTime,
    });
    const second = await buildStorylinePack({
      publishDir,
      out: join(root, 'two.zip'),
      embedder: 'hash',
      id: 'fixture-pack',
      version: '1.0.0',
      publishedAt: fixedTime,
    });

    const one = await readPackJson<PackShape>(first.packPath);
    const two = await readPackJson<PackShape>(second.packPath);

    // With --published-at fixed, even the volatile field matches.
    expect(one.published_at).toBe(fixedTime);
    expect(two.published_at).toBe(fixedTime);

    // The AC's letter: hash of pack.json EXCLUDING published_at is identical.
    const withoutVolatile = (pack: PackShape): string => {
      const clone: Record<string, unknown> = { ...pack };
      delete clone['published_at'];
      return createHash('sha256').update(JSON.stringify(clone)).digest('hex');
    };
    expect(withoutVolatile(one)).toBe(withoutVolatile(two));

    // docs[] deep-equality (content-addressed identity holds across builds).
    expect(one.docs).toEqual(two.docs);

    // The built zips are byte-identical for a fully fixed input (stronger
    // than the AC requires; guards against hidden nondeterminism).
    expect(readFileSync(first.packPath)).toEqual(readFileSync(second.packPath));
  });
});
