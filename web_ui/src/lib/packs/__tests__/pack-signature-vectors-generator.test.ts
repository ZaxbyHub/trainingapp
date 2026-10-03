// @vitest-environment node
// PR 144 review F9, required-job copy. contracts/pack-signature-vectors.json
// must match what contracts/tests/gen-pack-signature-vectors.mjs regenerates.
// A byte-level diff is impossible (the RSA key behind the one key-type-gate
// vector is generated per run; ed25519 keys and signatures are deterministic),
// so regenerate to a temp file and compare everything except that key's bytes.
// The same test also runs in desktop vitest; this copy runs in the required
// web-ui job (desktop vitest only runs in the non-required Electron job).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTRACTS = path.resolve(__dirname, '..', '..', '..', '..', '..', 'contracts');
const FILE = path.join(CONTRACTS, 'pack-signature-vectors.json');
const GENERATOR = path.join(CONTRACTS, 'tests', 'gen-pack-signature-vectors.mjs');

interface VectorFile {
  vectors: Array<{ id: string }>;
  canonical: Array<{ id: string }>;
}

// An ed25519 SPKI base64 starts MCow; the per-run RSA SPKI starts MIIB.
const isRsaKey = (key: string, value: unknown): value is string =>
  key === 'public_key' && typeof value === 'string' && value.startsWith('MIIB');
const maskRsa = (file: VectorFile): VectorFile =>
  JSON.parse(JSON.stringify(file, (key, value: unknown) => (isRsaKey(key, value) ? '<per-run-rsa-key>' : value))) as VectorFile;

describe('contracts/pack-signature-vectors.json vs its generator', () => {
  it('matches what gen-pack-signature-vectors.mjs regenerates (RSA key masked)', () => {
    const committed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as VectorFile;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-sig-vectors-'));
    try {
      const out = path.join(dir, 'regenerated.json');
      const run = spawnSync(process.execPath, [GENERATOR, out], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const regenerated = JSON.parse(fs.readFileSync(out, 'utf8')) as VectorFile;
      // Non-vacuous: the mask fired and there is something to compare.
      expect(JSON.stringify(maskRsa(committed))).toContain('<per-run-rsa-key>');
      expect(committed.vectors.length).toBeGreaterThan(0);
      expect(committed.canonical.length).toBeGreaterThan(0);
      expect(regenerated.vectors.length).toBe(committed.vectors.length);
      expect(regenerated.canonical.length).toBe(committed.canonical.length);
      expect(maskRsa(regenerated)).toEqual(maskRsa(committed));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
