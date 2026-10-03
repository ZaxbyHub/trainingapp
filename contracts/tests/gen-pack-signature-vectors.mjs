#!/usr/bin/env node
// gen-pack-signature-vectors.mjs — regenerates contracts/pack-signature-vectors.json,
// the shared pack-signature vectors (trace browser-training-parity AC2) consumed by
//   desktop/src/__tests__/pack-signature-vectors.test.ts   (node:crypto verifier)
//   web_ui/src/lib/packs/__tests__/pack-signature-vectors.test.ts (WebCrypto verifier)
//   tests/test_pack_signature_vectors.py                    (Python verifier)
// Every runtime must reach the recorded `ok` verdict for every vector and produce the
// recorded canonical bytes. Node built-ins only; the ed25519 keys derive from fixed
// labels (deterministic); the RSA key is generated per run (its only use is the
// key-type gate, whose verdict does not depend on the key bytes).
//
// usage: node contracts/tests/gen-pack-signature-vectors.mjs [outFile]
// (outFile defaults to the committed corpus; desktop/src/__tests__/pack-signature-vectors.test.ts
// passes a temp path to prove the committed corpus still matches this generator.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'pack-signature-vectors.json');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function keypair(label) {
  const seed = createHash('sha256').update(`pack-signature-vectors:${label}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, publicKey };
}
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}
const canonical = (manifest) => {
  const bare = { ...manifest };
  delete bare.signature;
  return Buffer.from(JSON.stringify(sortKeysDeep(bare)), 'utf8');
};
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

const trusted = keypair('trusted');
const attacker = keypair('attacker');
const KEY_ID = 'vectors-trusted';
const TRUSTED = [{ key_id: KEY_ID, public_key: trusted.publicKey }];
const signWith = (manifest, key = trusted, keyId = KEY_ID) => ({
  ...manifest,
  signature: { algorithm: 'ed25519', key_id: keyId, value: sign(null, canonical(manifest), key.privateKey).toString('base64') },
});

const base = {
  id: 'vectors-pack',
  name: 'Café — 日本語 \u{1F393}',
  version: '1.2.3',
  published_at: '2026-10-01T00:00:00Z',
  source_class: 'training',
  embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
  chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
  docs: [{ path: 'docs/slide-001-AAAAAAAAAAA.json', sha256: 'a'.repeat(64), title: 'Welcome', mime: 'application/json' }],
  meta: { z: 1, a: { y: [3, 2, 1], x: null, w: true }, m: 'k' },
};
const signed = signWith(base);
const vectors = [];
const add = (id, manifestText, signature, ok, trustedKeys = TRUSTED) =>
  vectors.push({ id, manifest_b64: b64(manifestText), signature: signature ?? null, trusted: trustedKeys, ok });

add('valid-compact', JSON.stringify(signed), signed.signature, true);
add('valid-unsorted-pretty', JSON.stringify(Object.fromEntries(Object.entries(signed).reverse()), null, '\t'), signed.signature, true);
add('valid-escaped-unicode-source', JSON.stringify(signed).replace('é', '\\u00e9'), signed.signature, true);
add('tampered-name', JSON.stringify({ ...signed, name: 'Tampered' }), signed.signature, false);
const nested = JSON.parse(JSON.stringify(signed));
nested.meta.a.y = [3, 2, 0];
add('tampered-nested-array', JSON.stringify(nested), signed.signature, false);
const docSha = JSON.parse(JSON.stringify(signed));
docSha.docs[0].sha256 = '0'.repeat(64);
add('tampered-doc-sha', JSON.stringify(docSha), signed.signature, false);
const wrongKey = signWith(base, attacker, KEY_ID);
add('wrong-private-key-trusted-id', JSON.stringify(wrongKey), wrongKey.signature, false);
const unknown = signWith(base, trusted, 'vectors-unknown');
add('unknown-key-id', JSON.stringify(unknown), unknown.signature, false);
add('wrong-algorithm', JSON.stringify(signed), { ...signed.signature, algorithm: 'rsa-sha256' }, false);
add('missing-signature', JSON.stringify(base), null, false);
add('empty-value', JSON.stringify(signed), { ...signed.signature, value: '' }, false);
add('missing-key-id', JSON.stringify(signed), { algorithm: 'ed25519', value: signed.signature.value }, false);
add('truncated-signature', JSON.stringify(signed), { ...signed.signature, value: signed.signature.value.slice(0, 20) }, false);
add('empty-trusted-set', JSON.stringify(signed), signed.signature, false, []);
add('non-integer-number', JSON.stringify({ ...base, weight: 1.5 }), signed.signature, false);
add('manifest-not-json', '{not json', signed.signature, false);
add('manifest-is-array', '[1,2,3]', signed.signature, false);
add('bom-prefixed-manifest', `﻿${JSON.stringify(signed)}`, signed.signature, false);
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
add('rsa-key-in-trusted-set', JSON.stringify(signed), { algorithm: 'ed25519', key_id: 'vectors-rsa', value: signed.signature.value }, false, [
  { key_id: 'vectors-rsa', public_key: rsa },
]);

const canonicalCases = [
  '{"b":1,"a":{"d":[3,{"z":1,"y":2}],"c":"é—"},"signature":{"value":"x"}}',
  '{"k":"🎓","n":-0,"big":9007199254740991,"s":"tab\\tnl\\nquote\\"bs\\\\"}',
].map((text, i) => ({ id: `canon-${i}`, manifest_b64: b64(text), canonical_hex: canonical(JSON.parse(text)).toString('hex') }));

const doc = {
  description:
    'Shared ed25519 pack-signature vectors (trace browser-training-parity AC2). Regenerate with node contracts/tests/gen-pack-signature-vectors.mjs. Consumers: desktop pack-extract.ts verifyPackSignature, web_ui pack-verify.ts, Python pack_extract.verify_pack_signature. manifest_b64 is the RAW pack.json text; signature is the detached block passed to the verifier (null = absent); ok is the required verdict.',
  vectors,
  canonical: canonicalCases,
};
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`wrote ${vectors.length} vectors and ${canonicalCases.length} canonical cases to ${out}`);
