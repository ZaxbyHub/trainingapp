// helpers/extract-pack-index.ts — materialize a pack zip's index.sqlite to a
// real file for sqlite opening (shared by the ac3/ac8 tests).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';

export async function extractPackIndex(packPath: string, scratchRoot: string): Promise<string> {
  const zip = await JSZip.loadAsync(await import('node:fs').then((fs) => fs.readFileSync(packPath)));
  const entry = zip.file('index.sqlite');
  if (entry === null) throw new Error('pack zip has no index.sqlite entry');
  const dir = mkdtempSync(join(scratchRoot, 'idx-'));
  const target = join(dir, 'index.sqlite');
  writeFileSync(target, Buffer.from(await entry.async('nodebuffer')));
  return target;
}

export async function readPackJson<T = unknown>(packPath: string): Promise<T> {
  const zip = await JSZip.loadAsync(await import('node:fs').then((fs) => fs.readFileSync(packPath)));
  const entry = zip.file('pack.json');
  if (entry === null) throw new Error('pack zip has no pack.json entry');
  return JSON.parse(await entry.async('string')) as T;
}
