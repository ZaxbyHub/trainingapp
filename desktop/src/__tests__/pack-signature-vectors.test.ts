// Shared pack-signature vectors, desktop leg (trace browser-training-parity AC2).
// contracts/pack-signature-vectors.json is consumed identically by
// web_ui/src/lib/packs/__tests__/pack-signature-vectors.test.ts and
// tests/test_pack_signature_vectors.py.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalManifestBytes, verifyPackSignature } from '../../main/backend/packs/pack-extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(here, '..', '..', '..', 'contracts', 'pack-signature-vectors.json');

interface VectorFile {
  vectors: Array<{ id: string; manifest_b64: string; signature: unknown; trusted: Array<{ key_id: string; public_key: string }>; ok: boolean }>;
  canonical: Array<{ id: string; manifest_b64: string; canonical_hex: string }>;
}

const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as VectorFile;

describe('contracts/pack-signature-vectors.json (desktop verifier)', () => {
  it('has both accept and refuse vectors (not vacuous)', () => {
    expect(data.vectors.some((vec) => vec.ok)).toBe(true);
    expect(data.vectors.filter((vec) => !vec.ok).length).toBeGreaterThan(10);
  });

  it.each(data.vectors.map((vec) => [vec.id, vec] as const))('verdict %s', (_id, vec) => {
    const res = verifyPackSignature(Buffer.from(vec.manifest_b64, 'base64'), vec.signature ?? undefined, vec.trusted);
    expect(res.ok, res.detail ?? '').toBe(vec.ok);
  });

  it.each(data.canonical.map((c) => [c.id, c] as const))('canonical bytes %s', (_id, c) => {
    expect(Buffer.from(canonicalManifestBytes(Buffer.from(c.manifest_b64, 'base64'))).toString('hex')).toBe(c.canonical_hex);
  });
});
