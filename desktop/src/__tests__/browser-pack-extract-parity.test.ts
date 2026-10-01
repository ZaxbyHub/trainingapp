// Desktop <-> browser archive-guard parity (trace browser-training-parity AC1).
//
// Every hostile and control archive runs through the REAL desktop extractor
// (main/backend/packs/pack-extract.ts, JSZip) and the REAL browser extractor
// (web_ui/src/lib/packs/pack-extract-browser.ts, streaming DecompressionStream):
// same verdict, same error class name, and for the deterministic guards the
// byte-identical message. The browser module is pure (no DOM) and runs under
// node here.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPackZip as desktopExtract } from '../../main/backend/packs/pack-extract.js';
import { extractPackZip as browserExtract } from '../../../web_ui/src/lib/packs/pack-extract-browser';
import { buildRawZip, packWith, type RawEntry } from '../../../web_ui/src/lib/packs/__tests__/zip-fixture';

const MiB = 1024 * 1024;

interface Outcome {
  outcome: 'accepted' | 'rejected';
  name?: string;
  message?: string;
}

async function runDesktop(zip: Uint8Array, filename: string, limits?: object): Promise<Outcome> {
  try {
    const dir = await desktopExtract(zip, filename, limits);
    fs.rmSync(dir, { recursive: true, force: true });
    return { outcome: 'accepted' };
  } catch (error) {
    return { outcome: 'rejected', name: (error as Error).name, message: (error as Error).message };
  }
}

async function runBrowser(zip: Uint8Array, filename: string, limits?: object): Promise<Outcome> {
  try {
    await browserExtract(zip, filename, limits);
    return { outcome: 'accepted' };
  } catch (error) {
    return { outcome: 'rejected', name: (error as Error).name, message: (error as Error).message };
  }
}

interface Vector {
  id: string;
  zip: Uint8Array;
  filename?: string;
  limits?: object;
  /** true: messages must be byte-identical; false: same verdict + class only. */
  exact: boolean;
}

const v = (id: string, extra: RawEntry[], exact = true, limits?: object): Vector => ({ id, zip: packWith(extra), exact, limits });

const VECTORS: Vector[] = [
  v('ok-small', [{ name: 'docs/a.json', data: '{"text":"x"}' }]),
  v('ok-deflated', [{ name: 'assets/player/story.html', data: '<html>'.repeat(500), method: 8 }]),
  v('ok-dir-entry', [{ name: 'docs/', data: '' }, { name: 'docs/a.txt', data: 'x' }]),
  v('dot-segment', [{ name: '../evil.txt', data: 'x' }]),
  v('nested-dot-segment', [{ name: 'docs/../../evil.txt', data: 'x' }]),
  v('single-dot-segment', [{ name: 'docs/./a.txt', data: 'x' }]),
  v('absolute', [{ name: '/etc/passwd', data: 'x' }]),
  v('drive-relative', [{ name: 'E:../x', data: 'x' }]),
  v('drive-absolute', [{ name: 'C:/x', data: 'x' }]),
  v('backslash', [{ name: 'docs\\..\\x', data: 'x' }]),
  v('control-char', [{ name: 'docs/a\u0001b', data: 'x' }]),
  v('del-char', [{ name: 'docs/a\u007fb', data: 'x' }]),
  v('symlink', [{ name: 'docs/link', data: '/etc/passwd', externalAttrs: (0o120777 << 16) >>> 0 }]),
  v('duplicate-name', [{ name: 'docs/a.txt', data: '1' }, { name: 'docs/a.txt', data: '2' }]),
  v('entry-cap', Array.from({ length: 12 }, (_, i) => ({ name: `docs/f${i}.txt`, data: 'x' })), true, { maxEntries: 10 }),
  v('byte-cap', [{ name: 'docs/big.bin', data: new Uint8Array(3 * MiB) }], true, { maxUncompressedBytes: 2 * MiB }),
  v('ratio-bomb', [{ name: 'docs/zeros.bin', data: new Uint8Array(20 * MiB), method: 8 }]),
  v('ratio-floor-ok', [{ name: 'docs/zeros.bin', data: new Uint8Array(2 * MiB), method: 8 }]),
  // Decompressor-view refusals: same verdict and class; desktop's text comes from JSZip internals.
  v('spoofed-declared-size', [{ name: 'docs/big.bin', data: new Uint8Array(4 * MiB), method: 8, declaredUncompressed: 100 }], false, {
    maxUncompressedBytes: 1 * MiB,
  }),
  v('encrypted', [{ name: 'docs/a.txt', data: 'x', flags: 1 }], false),
  v('unknown-method', [{ name: 'docs/a.txt', data: 'x', method: 12 }], false),
  { id: 'zip64-entry-count', zip: packWith([], { eocdEntriesOverride: 0xffff }), exact: true },
  { id: 'zip64-locator', zip: packWith([], { zip64Locator: true }), exact: true },
  { id: 'missing-manifest', zip: buildRawZip([{ name: 'docs/a.md', data: 'x' }]), exact: true },
  { id: 'not-a-zip', zip: new TextEncoder().encode('plain text, not an archive'), exact: true },
  { id: 'non-zip-extension', zip: packWith([]), filename: 'pack.tar', exact: true },
  { id: 'sfx-prefix-ok', zip: packWith([{ name: 'docs/a.txt', data: 'x', method: 8 }], { prefix: new Uint8Array(64).fill(1) }), exact: true },
];

describe('desktop and browser extractors agree on every archive', () => {
  it.each(VECTORS.map((vec) => [vec.id, vec] as const))('%s', async (_id, vec) => {
    const filename = vec.filename ?? `${vec.id}.zip`;
    const desktop = await runDesktop(vec.zip, filename, vec.limits);
    const browser = await runBrowser(vec.zip, filename, vec.limits);
    expect(browser.outcome, `verdict (desktop: ${desktop.message ?? 'accepted'}; browser: ${browser.message ?? 'accepted'})`).toBe(desktop.outcome);
    if (desktop.outcome === 'rejected') {
      expect(browser.name).toBe('PackManagerError');
      expect(desktop.name).toBe('PackManagerError');
      if (vec.exact) expect(browser.message).toBe(desktop.message);
    }
  }, 60_000);
});
