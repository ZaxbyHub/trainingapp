// A trusted keyset with two entries under one key_id is refused (issue #225).
//
// Behavioural half of the decision on #225. The maintainer decision rejects the
// issue's original AC, which asked the TS twins to adopt python's all-keys loop
// and would have traded the TS false-reject side for python's false-accept side
// (a retired key reusing a key_id would then VERIFY). Instead a duplicated
// key_id is a CONFIGURATION error, refused at config load and again at the
// gate.
//
// `pack-twin-parity.test.ts` pins that all four implementations carry the same
// rule by reading their sources. This file pins that the rule actually BEHAVES,
// by calling the two TS gates desktop can import. The web_ui gate is exercised
// in web_ui/src/lib/packs/__tests__/pack-trusted-key-uniqueness.test.ts, in
// that project's own vitest project.
//
// The public_key values below are deliberately NOT valid DER SPKI. The refusal
// must fire before any key material is parsed, and these tests prove that
// ordering rather than assuming it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  duplicateTrustedKeyId as desktopDuplicateTrustedKeyId,
  verifyPackSignature as desktopVerifyPackSignature,
} from '../../main/backend/packs/pack-extract.js';
import {
  duplicateTrustedKeyId as packtoolDuplicateTrustedKeyId,
  verifyPackSignature as packtoolVerifyPackSignature,
} from '../../../packtool/build/pack-json.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..');
const VECTORS = path.join(REPO_ROOT, 'contracts', 'pack-signature-vectors.json');

const AMBIGUOUS = [
  { key_id: 'dup', public_key: 'not-a-key-1' },
  { key_id: 'dup', public_key: 'not-a-key-2' },
];
const UNIQUE_SHAPE = [{ key_id: 'dup', public_key: 'not-a-key-1' }];
const GOOD_SIG = { algorithm: 'ed25519', key_id: 'dup', value: 'AA==' };

interface VectorFile {
  vectors: Array<{
    id: string;
    manifest_b64: string;
    signature: unknown;
    trusted: Array<{ key_id: string; public_key: string }>;
    ok: boolean;
  }>;
}

const data = JSON.parse(fs.readFileSync(VECTORS, 'utf8')) as VectorFile;
const okVector = data.vectors.find((v) => v.ok);
if (okVector === undefined) throw new Error('the committed corpus has no accepting vector');

const manifest = Buffer.from(okVector.manifest_b64, 'base64');

/** The two TS gates desktop can import, under one name. */
const GATES: Array<[string, typeof desktopVerifyPackSignature, typeof desktopDuplicateTrustedKeyId]> = [
  ['desktop', desktopVerifyPackSignature, desktopDuplicateTrustedKeyId],
  ['packtool', packtoolVerifyPackSignature, packtoolDuplicateTrustedKeyId],
];

describe('issue #225: an ambiguous trusted keyset is refused', () => {
  describe.each(GATES)('%s gate', (_name, verify, duplicateOf) => {
    it('rejects a keyset with a duplicated key_id', async () => {
      const result = await verify(manifest, GOOD_SIG, AMBIGUOUS);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('dup');
      expect(result.detail).toContain('ambiguous');
    });

    it('reports the ambiguity, not a bad signature (the keyset is at fault)', async () => {
      // With key material that cannot parse, an implementation that reported a
      // signature problem would say so. The operator must be pointed at the
      // configuration instead.
      const result = await verify(manifest, GOOD_SIG, AMBIGUOUS);
      expect(result.detail).not.toContain('base64');
      expect(result.detail).not.toContain('DER SPKI');
    });

    it('checks the keyset BEFORE the signature block (ordering, both directions)', async () => {
      // Malformed signature + ambiguous keyset: the configuration error wins.
      const malformed = await verify(manifest, 'not-a-signature-block', AMBIGUOUS);
      expect(malformed.detail).toContain('ambiguous');
      // And the same refusal shape as the well-formed-signature case, so the
      // ordering is not an artefact of one input.
      const absent = await verify(manifest, { algorithm: 'ed25519', key_id: 'absent', value: 'AA==' }, AMBIGUOUS);
      expect(absent.detail).toContain('ambiguous');
    });

    it('does NOT fire on a unique keyset with the same unusable key material', async () => {
      // The control: same shape, same invalid public_key, one entry. If this
      // still said "ambiguous" the guard would be keying on the wrong thing.
      const result = await verify(manifest, GOOD_SIG, UNIQUE_SHAPE);
      expect(result.detail).not.toContain('ambiguous');
    });

    it('exposes the same duplicate-detection helper semantics', () => {
      expect(duplicateOf(AMBIGUOUS)).toBe('dup');
      expect(duplicateOf(UNIQUE_SHAPE)).toBeNull();
      expect(duplicateOf([])).toBeNull();
      // Repeat in the middle: the answer is the id, not a position.
      expect(
        duplicateOf([
          { key_id: 'a' },
          { key_id: 'b' },
          { key_id: 'b' },
        ]),
      ).toBe('b');
    });
  });

  it('the two TS gates return the IDENTICAL refusal detail', async () => {
    // Same message from both twins: an operator reading a desktop log and a
    // packtool log must not see two different explanations for one fault.
    const desktopResult = await desktopVerifyPackSignature(manifest, GOOD_SIG, AMBIGUOUS);
    const packtoolResult = await packtoolVerifyPackSignature(manifest, GOOD_SIG, AMBIGUOUS);
    expect(desktopResult.detail).toBe(packtoolResult.detail);
    expect(desktopResult.detail).toBe(
      "trusted keyset has more than one entry with key_id 'dup'; a duplicated key_id is ambiguous and is refused",
    );
  });

  it('PRESERVING: a unique key_id still verifies (real signed corpus data)', async () => {
    for (const [name, verify] of GATES) {
      const result = await verify(manifest, okVector.signature, okVector.trusted);
      expect(result.ok, `${name} must still accept the corpus vector`).toBe(true);
    }
  });

  it('PRESERVING: an untrusted key_id is still refused as before', async () => {
    const otherId = okVector.trusted.map((k) => ({ ...k, key_id: 'some-other-id' }));
    for (const [name, verify] of GATES) {
      const result = await verify(manifest, okVector.signature, otherId);
      expect(result.ok, `${name} must still refuse an untrusted key_id`).toBe(false);
      expect(result.detail).not.toContain('ambiguous');
    }
  });
});
