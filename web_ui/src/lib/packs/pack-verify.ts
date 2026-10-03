// pack-verify.ts — browser twin of the desktop pack-signature gate
// (desktop/main/backend/packs/pack-extract.ts canonicalManifestBytes /
// verifyPackSignature and the requireSignature gate in
// desktop/main/backend/store/pack-manager.ts), trace browser-training-parity
// AC2.
//
// Same canonical payload (manifest minus `signature`, keys recursively
// sorted, compact separators, raw UTF-8, non-integer numbers refused), same
// ed25519-only rule (an RSA or other SPKI in the trusted set never verifies),
// same check order and the same refusal detail text as desktop. The verifier
// is WebCrypto Ed25519 (no dependency). Shared vectors:
// contracts/pack-signature-vectors.json, consumed by the desktop, browser and
// Python suites.
//
// Scope (ADR-0012): the signed manifest binds pack.json and, through each
// docs[] sha256, the slide/knowledge documents. Player JS and media are NOT
// covered by the signature on either runtime; origin isolation of the player
// (AC11) is the control for executable course content.
import { PackManagerError } from './pack-extract-browser';

/** One trusted signing key: key_id selects it, public_key is base64 DER SPKI. */
export interface TrustedPackKey {
  key_id: string;
  /** base64-encoded DER SubjectPublicKeyInfo (ed25519). */
  public_key: string;
}

export interface SignatureVerification {
  ok: boolean;
  detail?: string;
}

export interface SignaturePolicy {
  requireSignature: boolean;
  trustedKeys: ReadonlyArray<TrustedPackKey>;
}

/**
 * Recursively sort object keys (arrays keep order); FAIL-CLOSED on
 * non-integer numbers, exactly like desktop sortKeysDeep.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new PackManagerError(
      `manifest carries the non-integer number ${String(value)}; signature canonicalization is fail-closed`,
    );
  }
  return value;
}

/**
 * Decode raw manifest bytes the way desktop does for canonicalization
 * (Buffer.toString('utf8')): replacement characters for invalid sequences and
 * a leading BOM KEPT (so a BOM-prefixed manifest is not valid JSON here,
 * matching desktop).
 */
function decodeLikeNodeBuffer(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

/** The detached-signature payload (byte-identical to desktop canonicalManifestBytes). */
export function canonicalManifestBytes(manifestBytes: Uint8Array): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeLikeNodeBuffer(manifestBytes));
  } catch (error) {
    throw new PackManagerError(
      `signature canonicalization failed: manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackManagerError('signature canonicalization failed: manifest is not a JSON object');
  }
  const bare = { ...(parsed as Record<string, unknown>) };
  delete bare['signature'];
  return new TextEncoder().encode(JSON.stringify(sortKeysDeep(bare)));
}

// --------------------------------------------------------------------- //
// base64 with Node Buffer semantics (lenient: both alphabets, characters
// outside the alphabet skipped, decoding stops at '='), so a signature the
// desktop accepts decodes to the same bytes here.
// --------------------------------------------------------------------- //

const B64_VALUES = (() => {
  const table = new Int16Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

export function decodeBase64Lenient(text: string): Uint8Array {
  const sextets: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 61 /* '=' */) break;
    const value = code < 128 ? (B64_VALUES[code] ?? -1) : -1;
    if (value >= 0) sextets.push(value);
  }
  const out: number[] = [];
  let i = 0;
  for (; i + 4 <= sextets.length; i += 4) {
    const n = (sextets[i]! << 18) | (sextets[i + 1]! << 12) | (sextets[i + 2]! << 6) | sextets[i + 3]!;
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const rest = sextets.length - i;
  if (rest === 2) {
    out.push(((sextets[i]! << 2) | (sextets[i + 1]! >> 4)) & 0xff);
  } else if (rest === 3) {
    const n = (sextets[i]! << 10) | (sextets[i + 1]! << 4) | (sextets[i + 2]! >> 2);
    out.push((n >> 8) & 0xff, n & 0xff);
  }
  return new Uint8Array(out);
}

// --------------------------------------------------------------------- //
// SPKI key-type gate (desktop: createPublicKey(...).asymmetricKeyType)
// --------------------------------------------------------------------- //

const KEY_TYPE_BY_OID: Record<string, string> = {
  '2b6570': 'ed25519',
  '2b6571': 'ed448',
  '2b656e': 'x25519',
  '2b656f': 'x448',
  '2a864886f70d010101': 'rsa',
  '2a864886f70d01010a': 'rsa-pss',
  '2a8648ce380401': 'dsa',
  '2a8648ce3d0201': 'ec',
  '2a864886f70d010301': 'dh',
};

/** Read a DER length at `pos`; returns [length, headerBytes] or null. */
function derLength(der: Uint8Array, pos: number): [number, number] | null {
  const first = der[pos];
  if (first === undefined) return null;
  if (first < 0x80) return [first, 1];
  const count = first & 0x7f;
  if (count === 0 || count > 4) return null;
  let length = 0;
  for (let i = 1; i <= count; i += 1) {
    const byte = der[pos + i];
    if (byte === undefined) return null;
    length = length * 256 + byte;
  }
  return [length, 1 + count];
}

/**
 * The SubjectPublicKeyInfo algorithm (Node's asymmetricKeyType names), or
 * null when the bytes are not a DER SPKI: SEQUENCE { SEQUENCE { OID, ... }, BIT STRING }.
 */
export function spkiKeyType(der: Uint8Array): string | null {
  if (der[0] !== 0x30) return null;
  const outer = derLength(der, 1);
  if (outer === null || 1 + outer[1] + outer[0] !== der.length) return null;
  let pos = 1 + outer[1];
  if (der[pos] !== 0x30) return null;
  const algorithm = derLength(der, pos + 1);
  if (algorithm === null) return null;
  pos += 1 + algorithm[1];
  if (der[pos] !== 0x06) return null;
  const oid = derLength(der, pos + 1);
  if (oid === null) return null;
  const start = pos + 1 + oid[1];
  const bytes = der.subarray(start, start + oid[0]);
  if (bytes.length !== oid[0]) return null;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return KEY_TYPE_BY_OID[hex] ?? 'unknown';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Verify an ed25519 signature over `message` with a base64 DER SPKI key.
 * Shared by the pack-manifest gate and the update-feed gate. Never throws.
 */
export async function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  spkiBase64: string,
): Promise<{ ok: boolean; keyType: string | null; error?: string }> {
  const der = decodeBase64Lenient(spkiBase64);
  const keyType = spkiKeyType(der);
  if (keyType !== 'ed25519') return { ok: false, keyType };
  try {
    const key = await crypto.subtle.importKey('spki', toArrayBuffer(der), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, toArrayBuffer(signature), toArrayBuffer(message));
    return { ok, keyType };
  } catch (error) {
    return { ok: false, keyType, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Verify a manifest's detached ed25519 signature. Same check order and the
 * same refusal details as desktop verifyPackSignature; FAIL-CLOSED on every
 * malformed input (a refusal, never an exception).
 */
export async function verifyPackSignature(
  manifestBytes: Uint8Array,
  signature: unknown,
  trustedKeys: ReadonlyArray<TrustedPackKey>,
): Promise<SignatureVerification> {
  if (typeof signature !== 'object' || signature === null) {
    return { ok: false, detail: 'signature block is missing' };
  }
  const block = signature as Record<string, unknown>;
  if (block['algorithm'] !== 'ed25519') {
    return { ok: false, detail: `signature algorithm ${JSON.stringify(block['algorithm'])} is not supported (want 'ed25519')` };
  }
  const keyId = block['key_id'];
  if (typeof keyId !== 'string' || keyId.length === 0) {
    return { ok: false, detail: 'signature key_id is missing' };
  }
  const trusted = trustedKeys.find((key) => key.key_id === keyId);
  if (trusted === undefined) {
    return { ok: false, detail: `signature key_id '${keyId}' is not in the trusted keyset` };
  }
  const value = block['value'];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, detail: 'signature value is missing' };
  }
  const sig = decodeBase64Lenient(value);
  let canonical: Uint8Array;
  try {
    canonical = canonicalManifestBytes(manifestBytes);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const result = await verifyEd25519(canonical, sig, trusted.public_key);
  if (result.keyType === null) {
    return { ok: false, detail: `trusted key ${trusted.key_id} is not parseable as DER SPKI` };
  }
  if (result.keyType !== 'ed25519') {
    return { ok: false, detail: `trusted key ${trusted.key_id} is not an ed25519 public key (${result.keyType})` };
  }
  if (result.error !== undefined) return { ok: false, detail: result.error };
  return { ok: result.ok };
}

/** The desktop refusal text of the requireSignature gate (pack-manager.ts). */
export function signatureRequiredMessage(id: string, version: string, detail: string | undefined): string {
  return `${id}@${version} failed signature verification (${detail ?? 'unknown reason'}); a trusted ed25519 pack signature is required`;
}

/**
 * The opt-in require-signature gate: off => resolves (unsigned and even
 * tampered manifests install, desktop parity); on => a manifest without a
 * valid trusted ed25519 signature rejects with a PackManagerError.
 */
export async function enforceSignaturePolicy(manifestBytes: Uint8Array, policy: SignaturePolicy): Promise<void> {
  if (!policy.requireSignature) return;
  let parsed: Record<string, unknown> = {};
  try {
    // Desktop reads the manifest with TextDecoder('utf-8', { fatal: true })
    // (BOM stripped) before the gate; canonicalization keeps the raw bytes.
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const verification = await verifyPackSignature(manifestBytes, parsed['signature'], policy.trustedKeys);
  if (!verification.ok) {
    const id = typeof parsed['id'] === 'string' ? parsed['id'] : 'pack';
    const version = typeof parsed['version'] === 'string' ? parsed['version'] : 'unknown';
    throw new PackManagerError(signatureRequiredMessage(id, version, verification.detail));
  }
}
