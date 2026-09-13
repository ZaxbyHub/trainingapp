// AC2 — the pack contains every slide document plus the course-outline
// document (issue #79). Frozen driver: repro/c2-docs-count.sh filters this
// file via `vitest run build-storyline.ac2`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildStorylinePack } from '../../build/compose';
import { makeSyntheticPublish } from './helpers/build-fixture';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('build-storyline.ac2: docs[] includes every slide doc + the outline doc', () => {
  it('packs N slide docs + 1 outline doc with the outline present', { timeout: 20_000 }, async () => {
    // 20s: first build in a suite lazily loads better-sqlite3/sqlite-vec natives.
    const root = mkdtempSync(join(tmpdir(), 'ac2-'));
    scratchRoots.push(root);
    const { publishDir, asrDir } = makeSyntheticPublish(root);
    const result = await buildStorylinePack({
      publishDir,
      asrDir,
      out: join(root, 'pack.zip'),
      embedder: 'hash',
      id: 'fixture-pack',
      version: '1.0.0',
    });

    expect(result.docs).toBe(4); // 3 walked slides + 1 outline document

    const zip = await JSZip.loadAsync(await import('node:fs').then((fs) => fs.readFileSync(result.packPath)));
    const pack = JSON.parse((await zip.file('pack.json')?.async('string')) ?? 'null') as {
      docs: Array<{ path: string; sha256: string; title: string; mime: string }>;
    };
    expect(Array.isArray(pack.docs)).toBe(true);
    expect(pack.docs).toHaveLength(4);

    const paths = pack.docs.map((doc) => doc.path);
    // Every walked slide document is present, in spine order (message scene
    // MSG excluded by the extractor).
    expect(paths.filter((p) => p.startsWith('docs/slide-'))).toHaveLength(3);
    expect(paths[0]).toMatch(/^docs\/slide-001-S1\.json$/);
    expect(paths[1]).toMatch(/^docs\/slide-002-S2\.json$/);
    expect(paths[2]).toMatch(/^docs\/slide-003-S3\.json$/);
    // The course-outline document is present.
    expect(paths).toContain('docs/outline.json');
    const outline = pack.docs.find((doc) => doc.path === 'docs/outline.json');
    expect(outline?.title).toBe('SYN79 Course');
    expect(outline?.mime).toBe('application/json');
  });
});
