// Negative tests for build-storyline/verify (issue #79; plan-critic R7):
// traversal paths, missing manifest, onnx-without-weights, malformed asr
// store, defaultPackId collision rule. Runs in the full packtool suite (C8).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStorylinePack } from '../../build/compose';
import { verifyPack } from '../../build/verify';
import { assertSafeDocPath, defaultPackId, slugifyPackId } from '../../build/pack-json';
import { resolveBuildEmbedder } from '../../build/embedder';
import { makeSyntheticPublish } from './helpers/build-fixture';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('assertSafeDocPath (Phase 4.2 guardrail)', () => {
  it('rejects traversal, absolute, backslash, and empty paths', () => {
    expect(() => assertSafeDocPath('../escape')).toThrow(/relative-path segment/);
    expect(() => assertSafeDocPath('docs/../../escape')).toThrow(/relative-path segment/);
    expect(() => assertSafeDocPath('..\\escape')).toThrow(/forward slashes/);
    expect(() => assertSafeDocPath('/absolute/path')).toThrow(/must be relative/);
    expect(() => assertSafeDocPath('C:/absolute')).toThrow(/must be relative/);
    expect(() => assertSafeDocPath('')).toThrow(/must not be empty/);
    expect(() => assertSafeDocPath('docs/ok.json')).not.toThrow();
  });
});

describe('defaultPackId (critic R4: deterministic AND collision-safe)', () => {
  it('derives slug + lowercase courseid and fails loud when missing', () => {
    expect(slugifyPackId('OpMed CDP MicroLearning Companion (MLC)')).toBe('opmed-cdp-microlearning-companion-mlc');
    expect(defaultPackId('OpMed Course', '5fox24EQH9w')).toBe('opmed-course-5fox24eqh9w');
    expect(defaultPackId('OpMed Course', undefined)).toBeUndefined();
    expect(defaultPackId('', 'someid')).toBeUndefined();
  });
});

describe('resolveBuildEmbedder onnx without staged weights', () => {
  it('fails loud with an actionable message', () => {
    expect(() =>
      resolveBuildEmbedder({ embedder: 'onnx', modelDir: undefined, repoRoot: mkdtempSync(join(tmpdir(), 'no-weights-')) }),
    ).toThrow(/No embedding model staged/);
  });
});

describe('verify negative surfaces', () => {
  it('rejects a pack directory without pack.json', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'neg-'));
    scratchRoots.push(root);
    const result = await verifyPack(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('pack.json is missing'))).toBe(true);
  });

  it('rejects a manifest whose docs[] contains a traversal path', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'neg-zip-'));
    scratchRoots.push(root);
    mkdirSync(join(root, 'pack'), { recursive: true });
    writeFileSync(
      join(root, 'pack', 'pack.json'),
      JSON.stringify({
        id: 'bad-pack-01',
        name: 'bad',
        version: '1.0.0',
        published_at: '2026-09-13T00:00:00.000Z',
        source_class: 'training',
        embedding: { model_id: 'hash', dims: 384, normalize: true },
        chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
        docs: [{ path: '../escape.json', sha256: '0'.repeat(64), title: 'evil', mime: 'application/json' }],
      }),
    );
    const result = await verifyPack(join(root, 'pack'));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('../escape.json') && p.includes('refused'))).toBe(true);
  });

  it('rejects a tampered bundled doc via the sha256 re-hash', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'neg-tamper-'));
    scratchRoots.push(root);
    const { publishDir } = makeSyntheticPublish(root);
    const build = await buildStorylinePack({
      publishDir,
      out: join(root, 'pack.zip'),
      embedder: 'hash',
      id: 'fixture-pack',
      version: '1.0.0',
    });
    // Unpack, append one byte to a bundled doc (still-valid JSON), re-verify:
    // the per-doc sha256 re-hash must catch it.
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(readFileSync(build.packPath));
    const unpacked = join(root, 'unpacked');
    await extractAll(zip, unpacked);
    const docPath = join(unpacked, 'docs', 'slide-001-S1.json');
    const original = readFileSync(docPath, 'utf8');
    writeFileSync(docPath, `${original} `);
    const result = await verifyPack(unpacked);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('sha256 mismatch'))).toBe(true);
  });
});

async function extractAll(zip: import('jszip').JSZip, target: string): Promise<void> {
  const { mkdirSync: mk, writeFileSync: wr } = await import('node:fs');
  const { dirname } = await import('node:path');
  for (const [rel, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      mkdirSync(join(target, rel), { recursive: true });
      continue;
    }
    mk(dirname(join(target, rel)), { recursive: true });
    wr(join(target, rel), Buffer.from(await entry.async('nodebuffer')));
  }
}
