// Shared pack-signature vectors, desktop leg (trace browser-training-parity AC2).
// contracts/pack-signature-vectors.json is consumed identically by
// web_ui/src/lib/packs/__tests__/pack-signature-vectors.test.ts and
// tests/test_pack_signature_vectors.py.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  it('has both accept and refuse vectors and the expected keys (not vacuous)', () => {
    expect(data.vectors.length).toBeGreaterThan(0);
    expect(data.canonical.length).toBeGreaterThan(0);
    expect(data.vectors.some((vec) => vec.ok)).toBe(true);
    expect(data.vectors.filter((vec) => !vec.ok).length).toBeGreaterThan(10);
    for (const vec of data.vectors) {
      expect(typeof vec.id).toBe('string');
      expect(typeof vec.manifest_b64).toBe('string');
      expect(typeof vec.ok).toBe('boolean');
      expect(Array.isArray(vec.trusted)).toBe(true);
      expect('signature' in vec).toBe(true);
    }
    for (const c of data.canonical) {
      expect(typeof c.manifest_b64).toBe('string');
      expect(typeof c.canonical_hex).toBe('string');
    }
  });

  // PR 144 review F9: nothing else ties the committed corpus to its generator.
  // A byte-level regen diff is impossible (the RSA key behind the one
  // key-type-gate vector is generated per run; ed25519 keys and signatures are
  // deterministic), so regenerate to a temp file and compare everything except
  // that single key's bytes: ids, verdicts, signatures, manifests, canonical
  // forms and counts must all match.
  it('matches what contracts/tests/gen-pack-signature-vectors.mjs regenerates', () => {
    const generator = path.resolve(here, '..', '..', '..', 'contracts', 'tests', 'gen-pack-signature-vectors.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-sig-vectors-'));
    try {
      const out = path.join(dir, 'regenerated.json');
      const run = spawnSync(process.execPath, [generator, out], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const regenerated = JSON.parse(fs.readFileSync(out, 'utf8')) as VectorFile;
      // An ed25519 SPKI base64 starts MCow; the per-run RSA SPKI starts MIIB.
      const isRsaKey = (key: string, value: unknown): value is string =>
        key === 'public_key' && typeof value === 'string' && value.startsWith('MIIB');
      const maskRsa = (file: VectorFile): VectorFile =>
        JSON.parse(JSON.stringify(file, (key, value: unknown) => (isRsaKey(key, value) ? '<per-run-rsa-key>' : value))) as VectorFile;
      expect(JSON.stringify(maskRsa(data))).toContain('<per-run-rsa-key>');
      expect(regenerated.vectors.length).toBe(data.vectors.length);
      expect(regenerated.canonical.length).toBe(data.canonical.length);
      expect(maskRsa(regenerated)).toEqual(maskRsa(data));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(data.vectors.map((vec) => [vec.id, vec] as const))('verdict %s', (_id, vec) => {
    const res = verifyPackSignature(Buffer.from(vec.manifest_b64, 'base64'), vec.signature ?? undefined, vec.trusted);
    expect(res.ok, res.detail ?? '').toBe(vec.ok);
  });

  it.each(data.canonical.map((c) => [c.id, c] as const))('canonical bytes %s', (_id, c) => {
    expect(Buffer.from(canonicalManifestBytes(Buffer.from(c.manifest_b64, 'base64'))).toString('hex')).toBe(c.canonical_hex);
  });
});
