// @vitest-environment node
// Shared pack-signature vectors, browser leg (trace browser-training-parity AC2):
// the WebCrypto verifier must reach the same verdict as desktop
// (desktop/src/__tests__/pack-signature-vectors.test.ts) and Python
// (tests/test_pack_signature_vectors.py) on contracts/pack-signature-vectors.json.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalManifestBytes, decodeBase64Lenient, enforceSignaturePolicy, verifyPackSignature } from '../pack-verify';

const FILE = path.resolve(__dirname, '..', '..', '..', '..', '..', 'contracts', 'pack-signature-vectors.json');

interface VectorFile {
  vectors: Array<{ id: string; manifest_b64: string; signature: unknown; trusted: Array<{ key_id: string; public_key: string }>; ok: boolean }>;
  canonical: Array<{ id: string; manifest_b64: string; canonical_hex: string }>;
}

const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as VectorFile;
const bytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('contracts/pack-signature-vectors.json (browser verifier)', () => {
  it.each(data.vectors.map((vec) => [vec.id, vec] as const))('verdict %s', async (_id, vec) => {
    const res = await verifyPackSignature(bytes(vec.manifest_b64), vec.signature ?? undefined, vec.trusted);
    expect(res.ok, res.detail ?? '').toBe(vec.ok);
  });

  it.each(data.canonical.map((c) => [c.id, c] as const))('canonical bytes %s', (_id, c) => {
    expect(hex(canonicalManifestBytes(bytes(c.manifest_b64)))).toBe(c.canonical_hex);
  });

  it('the require-signature gate passes a valid manifest and refuses a tampered one', async () => {
    const valid = data.vectors.find((vec) => vec.id === 'valid-compact')!;
    const tampered = data.vectors.find((vec) => vec.id === 'tampered-name')!;
    const policy = { requireSignature: true, trustedKeys: valid.trusted };
    await expect(enforceSignaturePolicy(bytes(valid.manifest_b64), policy)).resolves.toBeUndefined();
    await expect(enforceSignaturePolicy(bytes(tampered.manifest_b64), policy)).rejects.toMatchObject({
      name: 'PackManagerError',
      message: expect.stringMatching(/failed signature verification.*a trusted ed25519 pack signature is required/),
    });
    // Policy off: even the tampered manifest passes (desktop default).
    await expect(enforceSignaturePolicy(bytes(tampered.manifest_b64), { requireSignature: false, trustedKeys: [] })).resolves.toBeUndefined();
  });
});

describe('decodeBase64Lenient (Node Buffer semantics)', () => {
  it.each([
    ['aGVsbG8=', 'hello'],
    ['aGVs bG8=', 'hello'],
    ['aGVs\nbG8', 'hello'],
    ['aGVsbG8-_w', Buffer.from('aGVsbG8+/w', 'base64').toString('latin1')],
    ['not base64 !!!', Buffer.from('not base64 !!!', 'base64').toString('latin1')],
    ['', ''],
  ])('%j decodes like Buffer.from(_, "base64")', (input, _expected) => {
    expect(hex(decodeBase64Lenient(input))).toBe(Buffer.from(input, 'base64').toString('hex'));
  });
});
