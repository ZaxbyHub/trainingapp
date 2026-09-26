// AC5 — player assets are present and unmodified: bundled story.html and
// html5/ files byte-compare against the source publish folder (issue #79).
// Frozen driver: repro/c5-player-assets.sh filters this file via
// `vitest run build-storyline.ac5`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('build-storyline.ac5: player assets are byte-identical to the source', () => {
  it('bundles story.html and a spot-checked html5/ subset unmodified', { timeout: 20_000 }, async () => {
    // 20s: lazily loads the sqlite natives during the build.
    const root = mkdtempSync(join(tmpdir(), 'ac5-'));
    scratchRoots.push(root);
    const { publishDir } = makeSyntheticPublish(root);
    const result = await buildStorylinePack({
      publishDir,
      out: join(root, 'pack.zip'),
      embedder: 'hash',
      id: 'fixture-pack',
      version: '1.0.0',
    });

    const zip = await JSZip.loadAsync(readFileSync(result.packPath));
    const spotChecks = [
      'story.html',
      'html5/lib/loader.js',
      'html5/lib/framework/nested.js',
      'story_content/vidSide1_transcripts.js',
      // Review PRR-226: the optional mobile/ sibling must ride along
      // byte-identically when the publish carries it.
      'mobile/SYN79_slide_mobile.jpg',
    ];
    for (const rel of spotChecks) {
      const bundled = zip.file(`assets/player/${rel}`);
      expect(bundled, `assets/player/${rel} missing from the pack`).not.toBeNull();
      expect(Buffer.from(await bundled!.async('nodebuffer'))).toEqual(readFileSync(join(publishDir, rel)));
    }
  });
});
