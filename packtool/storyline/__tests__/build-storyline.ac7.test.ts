// AC7 — D2's cached transcripts are resolved into the pack: --asr-dir
// pass-through lands sidecar/asr transcript text in the pack docs AND the
// prebuilt index chunks; narration-less slides still build (issue #79).
// Frozen driver: repro/c6-transcripts.sh filters this file via
// `vitest run build-storyline.ac7`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildStorylinePack } from '../../build/compose';
import { readPackJson, extractPackIndex } from './helpers/extract-pack-index';
import { makeSyntheticPublish } from './helpers/build-fixture';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

interface PackShape {
  docs: Array<{ path: string; sha256: string; title: string; mime: string }>;
}

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('build-storyline.ac7: transcripts are wired into docs and index chunks', () => {
  it('sidecar + asr transcript text lands in pack docs and chunks', { timeout: 20_000 }, async () => {
    // 20s: lazily loads the sqlite natives during the build.
    const root = mkdtempSync(join(tmpdir(), 'ac7-'));
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
    expect(result.docs).toBe(4);

    // Doc files keep the extractor's transcript_source verdicts verbatim.
    const zip = await JSZip.loadAsync(readFileSync(result.packPath));
    const s1 = JSON.parse((await zip.file('docs/slide-001-S1.json')!.async('string')) ?? '{}') as {
      transcript_source: string;
      transcript_text?: string;
    };
    const s2 = JSON.parse((await zip.file('docs/slide-002-S2.json')!.async('string')) ?? '{}') as {
      transcript_source: string;
      transcript_text?: string;
    };
    const s3 = JSON.parse((await zip.file('docs/slide-003-S3.json')!.async('string')) ?? '{}') as {
      transcript_source: string;
      transcript_text?: string;
    };
    expect(s1.transcript_source).toBe('sidecar');
    expect(s1.transcript_text).toContain('Quokka hydration overview');
    expect(s2.transcript_source).toBe('asr');
    expect(s2.transcript_text).toContain('Wombat splint drill narration');
    expect(['missing', 'none']).toContain(s3.transcript_source);

    // The prebuilt index chunks carry the transcript text for voiced slides
    // and the narration-less slide still contributed its document.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as new (p: string) => {
      prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
      close(): void;
    };
    const sqliteVec = require('sqlite-vec') as { load(db: unknown): void };
    const indexPath = await extractPackIndex(result.packPath, root);
    const db = new Database(indexPath);
    sqliteVec.load(db);
    try {
      const texts = (db.prepare('SELECT text FROM chunks').all() as Array<{ text: string }>).map(
        (row) => row.text,
      );
      const allText = texts.join('\n');
      expect(allText).toContain('Quokka hydration overview');
      expect(allText).toContain('Wombat splint drill narration');
      expect(allText).toContain('summary notes');

      const manifest = await readPackJson<PackShape>(result.packPath);
      const chunksTable = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      const embeddingsTable = db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number };
      expect(chunksTable.n).toBeGreaterThan(0);
      expect(chunksTable.n).toBe(embeddingsTable.n);
      expect(manifest.docs).toHaveLength(4);
    } finally {
      db.close();
    }
  });
});
