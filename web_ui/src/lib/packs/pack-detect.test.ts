/**
 * pack-detect.test.ts — unit coverage for the browser pack-signature detector
 * (ADR-0009 PoC gate, issue #76 / C9). Provenance: mutation probes for these
 * cases live in .agents/issue-traces/76-browser-packs-adr/repro/ (trace-local,
 * not committed, per repo convention).
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { isKnowledgePackZip, looksLikePackManifest, MAX_PACK_DETECT_BYTES } from './pack-detect';
import { fileFromBytes } from '../../test/pack-test-utils';

/** A schema-honest minimal C1 manifest (mirrors web_ui/e2e/packs-gate.spec.ts). */
function manifestJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'opmed-core',
    name: 'OpMed Core Bundle',
    version: '1.0.0',
    published_at: '2026-09-20T00:00:00Z',
    source_class: 'bundled',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'fixed-words', size: 220, overlap: 30 },
    docs: [
      {
        path: 'docs/welcome.md',
        sha256: 'a'.repeat(64),
        title: 'Welcome',
        mime: 'text/markdown',
      },
    ],
    ...overrides,
  };
}

async function zipBytesWith(manifest: Record<string, unknown> | null): Promise<Uint8Array> {
  const zip = new JSZip();
  if (manifest !== null) {
    zip.file('pack.json', JSON.stringify(manifest));
  }
  zip.file('docs/welcome.md', '# Welcome\n\nHello from the fixture pack.');
  return zip.generateAsync({ type: 'uint8array' });
}

describe('looksLikePackManifest (minimal C1 signature)', () => {
  it('accepts a schema-honest manifest', () => {
    expect(looksLikePackManifest(manifestJson())).toBe(true);
  });

  it('rejects non-object payloads', () => {
    expect(looksLikePackManifest(null)).toBe(false);
    expect(looksLikePackManifest('pack.json')).toBe(false);
    expect(looksLikePackManifest([])).toBe(false);
  });

  it('rejects manifests missing a required field', () => {
    const { embedding, ...withoutEmbedding } = manifestJson();
    void embedding;
    expect(looksLikePackManifest(withoutEmbedding)).toBe(false);
    expect(looksLikePackManifest(manifestJson({ docs: [] }))).toBe(false);
    expect(looksLikePackManifest(manifestJson({ chunking: undefined }))).toBe(false);
  });

  it('rejects pattern-invalid id and sha256 values', () => {
    expect(looksLikePackManifest(manifestJson({ id: 'Bad ID' }))).toBe(false);
    expect(looksLikePackManifest(manifestJson({ id: '-leading-dash' }))).toBe(false);
    const badSha = manifestJson();
    (badSha.docs as Array<Record<string, unknown>>)[0].sha256 = 'not-hex';
    expect(looksLikePackManifest(badSha)).toBe(false);
  });

  it('rejects an out-of-enum source_class', () => {
    expect(looksLikePackManifest(manifestJson({ source_class: 'public' }))).toBe(false);
  });
});

describe('isKnowledgePackZip', () => {
  it('accepts a zip carrying a schema-honest root pack.json', async () => {
    const file = fileFromBytes(await zipBytesWith(manifestJson()), 'opmed-core-v1.0.0.zip');
    await expect(isKnowledgePackZip(file)).resolves.toBe(true);
  });

  it('rejects a zip without a root pack.json', async () => {
    const file = fileFromBytes(await zipBytesWith(null), 'plain-archive.zip');
    await expect(isKnowledgePackZip(file)).resolves.toBe(false);
  });

  it('rejects corrupt zip bytes without throwing', async () => {
    const file = fileFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'broken.zip');
    await expect(isKnowledgePackZip(file)).resolves.toBe(false);
  });

  it('rejects a pack.json that is not valid JSON', async () => {
    const zip = new JSZip();
    zip.file('pack.json', '{ not json');
    const file = fileFromBytes(await zip.generateAsync({ type: 'uint8array' }), 'badjson.zip');
    await expect(isKnowledgePackZip(file)).resolves.toBe(false);
  });

  it('rejects a manifest with pattern-invalid fields inside a real zip', async () => {
    const file = fileFromBytes(await zipBytesWith(manifestJson({ id: 'Bad ID' })), 'badid.zip');
    await expect(isKnowledgePackZip(file)).resolves.toBe(false);
  });

  it('rejects non-zip names without reading the file', async () => {
    const file = fileFromBytes(await zipBytesWith(manifestJson()), 'notes.txt');
    await expect(isKnowledgePackZip(file)).resolves.toBe(false);
  });

  it('rejects oversized files before buffering them', async () => {
    const oversized = { size: MAX_PACK_DETECT_BYTES + 1, name: 'huge.zip', type: 'application/zip' } as File;
    await expect(isKnowledgePackZip(oversized)).resolves.toBe(false);
  });
});
