/**
 * e174-multichunk-sha256.test.ts — issue #174 AC2 (frozen check C10,
 * `multichunk-sha256-boundary`).
 *
 * The first-run manifest verifier hashes with a fixed 8 MiB readSync loop and
 * the manifest generator with a separate 8 MiB stream — and until this spec
 * the only proofs that both chunked paths produce correct cross-boundary
 * digests lived on git-excluded multi-GB trees. This spec writes a
 * DETERMINISTIC fixture that crosses exactly one 8 MiB boundary (the second
 * chunk is a 4,096-byte partial read, exercising the subarray tail path) and
 * pins BOTH implementations — and each other — against an independently
 * computed oracle digest (python hashlib; repro/c10-digest-oracle.txt in the
 * trace, recomputed by the plan critic).
 *
 * Boundary resolution (disclosed in the PR): the issue prose says ">9 MiB"
 * once, but the frozen AC2 wording governs — "larger than HASH_CHUNK_BYTES" —
 * and the verified boundary constant is 8 MiB (manifest-verifier.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HASH_CHUNK_BYTES, sha256File } from '../../main/first-run/manifest-verifier.js';
import { sha256File as generatorSha256File } from '../../scripts/build-installer-manifest.mjs';

const ORACLE_DIGEST = 'b010f28e6577479cd82871a94cac90149eebdae8c43a866ad463518c8711f8c4';
// b"trainingapp-multichunk-boundary\n" repeated: 32 bytes x 262272 = exactly
// HASH_CHUNK_BYTES + 4096 (one full chunk + a partial tail — no partial CHUNK
// at the hash level, but a partial READ at the OS level and a non-empty
// subarray tail on the second update).
const PATTERN = Buffer.from('trainingapp-multichunk-boundary\n', 'utf8');
const FIXTURE_BYTES = HASH_CHUNK_BYTES + 4096;

describe('multichunk-sha256-boundary (issue #174 AC2)', () => {
  it('crosses the committed 8 MiB chunk boundary with a deterministic fixture', () => {
    expect(HASH_CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(FIXTURE_BYTES % PATTERN.length).toBe(0);
    expect(FIXTURE_BYTES).toBeGreaterThan(HASH_CHUNK_BYTES);
  });

  it('verifier and generator produce the oracle digest across the boundary', async ({ }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e174-multichunk-'));
    try {
      const fixture = path.join(dir, 'cross-boundary.bin');
      const out = Buffer.alloc(FIXTURE_BYTES);
      for (let offset = 0; offset < FIXTURE_BYTES; offset += PATTERN.length) {
        PATTERN.copy(out, offset);
      }
      fs.writeFileSync(fixture, out);

      const fromVerifier = sha256File(fixture);
      const fromGenerator = await generatorSha256File(fixture);
      expect(fromVerifier).toBe(ORACLE_DIGEST);
      expect(fromGenerator).toBe(ORACLE_DIGEST);
      expect(fromVerifier).toBe(fromGenerator);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the generator module is import-safe (entry guard) and exports its stream hasher', async () => {
    // The static import at the top of this file already proves the guard:
    // before it existed, importing this module executed main() and exited.
    expect(typeof generatorSha256File).toBe('function');
    const mod = await import('../../scripts/build-installer-manifest.mjs');
    expect(typeof mod.sha256File).toBe('function');
  });
});
