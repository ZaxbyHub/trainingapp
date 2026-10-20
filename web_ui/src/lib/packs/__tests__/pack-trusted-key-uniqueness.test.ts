// web_ui leg of issue #225: an ambiguous trusted keyset is refused.
//
// This module is a FOURTH copy of the pack signature gate. The issue's decision
// named three implementations; web_ui's copy is live (imported by
// pack-update-browser.ts, pack-policy.ts and pack-manifest.ts, and covered by
// pack-signature-vectors.test.ts), so leaving it first-match would have recreated
// exactly the twin drift the change exists to remove.
//
// Two enforcement points are covered here, both in web_ui:
//   - parseTrustedKeys (CONFIG LOAD) trusts NOTHING when a key_id repeats,
//     matching the idiom its two siblings already use for a malformed keyset.
//   - verifyPackSignature (THE GATE) refuses it again, because trustedKeys is a
//     parameter and a caller that built the list itself bypasses the load.
//
// The public_key values below are deliberately NOT valid DER SPKI: the refusal
// must fire before any key material is parsed, and these tests prove that
// ordering rather than assuming it.
import { describe, expect, it } from 'vitest';

import { duplicateTrustedKeyId, verifyPackSignature } from '../pack-verify';
import { parseTrustedKeys } from '../pack-policy';

const AMBIGUOUS = [
  { key_id: 'dup', public_key: 'not-a-key-1' },
  { key_id: 'dup', public_key: 'not-a-key-2' },
];
const UNIQUE_SHAPE = [{ key_id: 'dup', public_key: 'not-a-key-1' }];
const GOOD_SIG = { algorithm: 'ed25519', key_id: 'dup', value: 'AA==' };
const MANIFEST = new TextEncoder().encode('{}');

describe('issue #225 (web_ui): an ambiguous trusted keyset is refused', () => {
  it('the gate rejects a keyset with a duplicated key_id', async () => {
    const result = await verifyPackSignature(MANIFEST, GOOD_SIG, AMBIGUOUS);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('dup');
    expect(result.detail).toContain('ambiguous');
  });

  it('returns the IDENTICAL refusal detail the desktop and packtool twins return', async () => {
    // One fault, one explanation, whichever surface reports it.
    const result = await verifyPackSignature(MANIFEST, GOOD_SIG, AMBIGUOUS);
    expect(result.detail).toBe(
      "trusted keyset has more than one entry with key_id 'dup'; a duplicated key_id is ambiguous and is refused",
    );
  });

  it('checks the keyset BEFORE the signature block (ordering, both directions)', async () => {
    const malformed = await verifyPackSignature(MANIFEST, 'not-a-signature-block', AMBIGUOUS);
    expect(malformed.detail).toContain('ambiguous');
    const absent = await verifyPackSignature(
      MANIFEST,
      { algorithm: 'ed25519', key_id: 'absent', value: 'AA==' },
      AMBIGUOUS,
    );
    expect(absent.detail).toContain('ambiguous');
  });

  it('reports the ambiguity, not a bad signature', async () => {
    const result = await verifyPackSignature(MANIFEST, GOOD_SIG, AMBIGUOUS);
    expect(result.detail).not.toContain('base64');
    expect(result.detail).not.toContain('DER SPKI');
  });

  it('does NOT fire on a unique keyset with the same unusable key material', async () => {
    const result = await verifyPackSignature(MANIFEST, GOOD_SIG, UNIQUE_SHAPE);
    expect(result.detail).not.toContain('ambiguous');
  });

  describe('duplicateTrustedKeyId', () => {
    it('returns the repeated id', () => {
      expect(duplicateTrustedKeyId(AMBIGUOUS)).toBe('dup');
    });
    it('returns null for unique ids and for the empty keyset', () => {
      expect(duplicateTrustedKeyId(UNIQUE_SHAPE)).toBeNull();
      expect(duplicateTrustedKeyId([])).toBeNull();
    });
    it('is not vacuous: one changed character flips the answer', () => {
      expect(
        duplicateTrustedKeyId([
          { key_id: 'a' },
          { key_id: 'a' },
        ]),
      ).toBe('a');
      expect(
        duplicateTrustedKeyId([
          { key_id: 'a' },
          { key_id: 'b' },
        ]),
      ).toBeNull();
    });
  });

  describe('parseTrustedKeys (config load)', () => {
    it('trusts NOTHING when a key_id repeats', () => {
      const raw = JSON.stringify([
        { key_id: 'k', public_key: 'AAA' },
        { key_id: 'k', public_key: 'BBB' },
      ]);
      // Trusting nothing is the fail-closed idiom parseTrustedKeys already uses
      // for malformed input; with requireSignature on, every pack is refused.
      expect(parseTrustedKeys(raw)).toEqual([]);
    });

    it('trusts NOTHING when the repeat is anywhere in the list', () => {
      const raw = JSON.stringify([
        { key_id: 'a', public_key: 'AAA' },
        { key_id: 'b', public_key: 'BBB' },
        { key_id: 'a', public_key: 'CCC' },
      ]);
      expect(parseTrustedKeys(raw)).toEqual([]);
    });

    it('PRESERVING: still accepts a keyset with unique key_ids', () => {
      const raw = JSON.stringify([
        { key_id: 'a', public_key: 'AAA' },
        { key_id: 'b', public_key: 'BBB' },
      ]);
      expect(parseTrustedKeys(raw)).toEqual([
        { key_id: 'a', public_key: 'AAA' },
        { key_id: 'b', public_key: 'BBB' },
      ]);
    });

    it('PRESERVING: its pre-existing malformed-input behaviour is unchanged', () => {
      expect(parseTrustedKeys(undefined)).toEqual([]);
      expect(parseTrustedKeys('   ')).toEqual([]);
      expect(parseTrustedKeys('not json')).toEqual([]);
      expect(parseTrustedKeys('{"key_id":"a"}')).toEqual([]);
      // Entries missing public_key are still dropped rather than refused.
      expect(parseTrustedKeys(JSON.stringify([{ key_id: 'a' }]))).toEqual([]);
    });
  });
});
