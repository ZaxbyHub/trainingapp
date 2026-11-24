/**
 * db-crypto — at-rest encryption for the browser conversations store
 * (issue #367, WI6 residual; maintainer ruling "proceed" recorded on epic
 * #34 decision comment 6932779750).
 *
 * Threat model (issue): a COPIED browser database (the IndexedDB files)
 * without the profile must be INERT — no plaintext recovery. This is a
 * confidentiality boundary against offline DB theft; it is NOT a defense
 * against an active same-profile-origin attacker (such an attacker can read
 * the localStorage secret directly) and AES-GCM here provides NO
 * freshness/anti-rollback: a previously captured envelope for the same row
 * with unchanged index fields replays undetectably (plan RC3-07 disclosure,
 * mirrored in CONFIGURATION.md).
 *
 * Design (plan rev6, exec-367-at-rest-encryption):
 *  - Boundary crypto, NOT Dexie hooks: Dexie 4 TableHooks subscribers are
 *    synchronous (dexie.d.ts:95-99) and WebCrypto is async.
 *  - Crypto NEVER runs inside an IndexedDB transaction (async awaits
 *    auto-commit the tx — PC-06); callers do read-tx / crypto / write-tx.
 *  - Envelope: { id, createdAt, updatedAt, v: 1, e: { iv, ct } } where ct =
 *    AES-GCM(JSON.stringify(Conversation)) with a canonical AAD — the UTF-8
 *    bytes of the JSON tuple [v, id, createdAt, updatedAt] (RC3-07: frozen
 *    encoding, no delimiter ambiguity). id/createdAt/updatedAt stay
 *    plaintext because the Dexie indexes (keyPath id, updatedAt, createdAt)
 *    must keep working; title/messages/mode/modelUsed live inside ct. The
 *    plaintext `title` index from the version(2) signature is vestigial
 *    (no where('title') query exists — verified at authoring).
 *  - Key custody (frozen C2 contract): a per-profile 256-bit secret in
 *    localStorage key `doc-qa-profile-secret` (registered in
 *    persisted-keys INTERNAL_KEYS), value JSON {<prefix>: base64(32B)}.
 *    NEVER inside IndexedDB (any store). PBKDF2-SHA256 (210k iterations,
 *    spec-conformant floor) derives a non-extractable AES-GCM CryptoKey
 *    per (secret, prefix), cached module-side.
 *  - The secret MAP is shared across profiles: every read/merge/write/adopt
 *    of it runs under ONE origin-wide lock (RC4-01: per-prefix locking
 *    would race the shared map). `withExclusiveLock` (exclusive-lock.ts)
 *    provides Web-Locks-preferred + in-tab-chain semantics; its absence
 *    (jsdom, non-secure contexts) degrades to the in-tab chain, which is
 *    the semantics the C1-C3 suite actually exercises.
 */

import { PROFILE_SECRET_KEY } from './persisted-keys';
import { withExclusiveLock } from './exclusive-lock';

/** Envelope version marker (unknown values fail closed — plan matrix INVALID). */
export const ENVELOPE_VERSION = 1;

/** PBKDF2 iteration floor (OWASP-aligned; derivation happens once per session per profile). */
export const PBKDF2_ITERATIONS = 210_000;

/** Fixed app salt component; the profile prefix is the per-profile component. */
const KDF_APP_SALT = 'trainingapp-db-crypto-v1';

const CONVERSATION_STORE = 'conversations';

/** Fail-closed decryption/verification error. Never falls back to plaintext. */
export class ConversationDecryptError extends Error {
  constructor(reason: string) {
    super(`[db-crypto] ${reason}`);
    this.name = 'ConversationDecryptError';
  }
}

/** Optimistic-concurrency conflict after bounded three-phase retries (plan RC4-01). */
export class ConversationConflictError extends Error {
  constructor(id: string) {
    super(`[db-crypto] concurrent modification of conversation ${id} persisted past the retry bound`);
    this.name = 'ConversationConflictError';
  }
}

interface EnvelopeFields {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface EncryptedRow extends EnvelopeFields {
  v: number;
  e: { iv: string; ct: string };
  /** M3v10 signals live beside the indexed identity fields. Absence is data. */
  afterClear?: number;
  sawPendingGoal?: number;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Secret custody (frozen C2 contract)
// ---------------------------------------------------------------------------

type SecretMap = Record<string, string>;

function readSecretMap(): SecretMap {
  try {
    const raw = localStorage.getItem(PROFILE_SECRET_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConversationDecryptError('secret map is malformed (fail closed, will be re-minted only through getOrCreateSecret)');
    }
    const map: SecretMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') map[k] = v;
    }
    return map;
  } catch (error) {
    if (error instanceof ConversationDecryptError) throw error;
    return {};
  }
}

/**
 * Get-or-mint the profile's 256-bit secret. The whole read/merge/write/adopt
 * sequence runs under ONE origin-wide lock — the map is shared across
 * profiles (RC4-01). Never call readSecretMap() outside this function when
 * minting.
 */
export async function getOrCreateSecret(prefix: string): Promise<string> {
  return withExclusiveLock('docqa-secret-map', async () => {
    const map = readSecretMap();
    const existing = map[prefix];
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const fresh = new Uint8Array(32);
    crypto.getRandomValues(fresh);
    const b64 = toBase64(fresh);
    // Read-after-write adopt: re-read and take the WINNER if a concurrent
    // tab minted first (its value is what the persisted map holds).
    map[prefix] = b64;
    localStorage.setItem(PROFILE_SECRET_KEY, JSON.stringify(map));
    const adopted = readSecretMap()[prefix];
    return typeof adopted === 'string' && adopted.length > 0 ? adopted : b64;
  });
}

/** True when the profile already has a secret (no minting side effect). */
export function hasProfileSecret(prefix: string): boolean {
  try {
    const value = readSecretMap()[prefix];
    return typeof value === 'string' && value.length > 0;
  } catch {
    return false;
  }
}

/** Test/ops seam: forget this profile's secret (lost-profile simulation). */
export function clearProfileSecret(prefix: string): void {
  withExclusiveLock('docqa-secret-map', () => {
    const map = readSecretMap();
    delete map[prefix];
    localStorage.setItem(PROFILE_SECRET_KEY, JSON.stringify(map));
  });
}

// ---------------------------------------------------------------------------
// Key derivation (cached per (prefix, secret))
// ---------------------------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

async function deriveKey(prefix: string, secretB64: string): Promise<CryptoKey> {
  const cacheKey = `${prefix}|${secretB64}`;
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      fromBase64(secretB64),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode(`${KDF_APP_SALT}|${prefix}`),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  keyCache.set(cacheKey, pending);
  // Evict a failed derivation so a corrected key can be retried fresh.
  void pending.catch(() => keyCache.delete(cacheKey));
  return pending;
}

/**
 * TEST SEAM (#367 review F5): encrypt raw plaintext bound to a DELIBERATELY
 * divergent AAD tuple — the only way to construct the inner/outer mismatch
 * an attacker-with-the-key could produce. Used by the matrix spec to pin the
 * decryptRow identity check. Not used by production code paths.
 */
export async function encryptWithAadForTests(
  plain: string,
  aadTuple: { id: string; createdAt: number; updatedAt: number },
  secret: string,
  prefix: string,
): Promise<EncryptedRow> {
  const key = await deriveKey(prefix, secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const rowShape: EncryptedRow = {
    id: aadTuple.id,
    createdAt: aadTuple.createdAt,
    updatedAt: aadTuple.updatedAt,
    v: ENVELOPE_VERSION,
    e: { iv: '', ct: '' },
  };
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadBytes(rowShape) },
    key,
    new TextEncoder().encode(plain),
  );
  return { ...rowShape, e: { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) } };
}

/**
 * Canonical AAD (RC3-07): UTF-8 bytes of the JSON tuple
 * [v, id, createdAt, updatedAt]. Frozen encoding — no delimiter
 * ambiguity; collision-focused test lives in the implementation spec.
 */
function aadBytes(row: { v: unknown } & EnvelopeFields): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([row.v, row.id, row.createdAt, row.updatedAt]));
}

// ---------------------------------------------------------------------------
// Row classification + (de)cryption
// ---------------------------------------------------------------------------

/** Shape test: does the stored row look like our envelope? */
export function isEncryptedRow(row: unknown): row is EncryptedRow {
  if (typeof row !== 'object' || row === null) return false;
  const candidate = row as Record<string, unknown>;
  return (
    candidate['v'] === ENVELOPE_VERSION &&
    typeof candidate['id'] === 'string' &&
    typeof candidate['createdAt'] === 'number' &&
    typeof candidate['updatedAt'] === 'number' &&
    typeof candidate['e'] === 'object' &&
    candidate['e'] !== null &&
    typeof (candidate['e'] as Record<string, unknown>)['iv'] === 'string' &&
    typeof (candidate['e'] as Record<string, unknown>)['ct'] === 'string'
  );
}

/** A row carrying an `e`/`v` shape that FAILS validation is INVALID (matrix
 *  row: fail closed, never treat as plaintext). */
export function isMalformedEnvelope(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const candidate = row as Record<string, unknown>;
  const carriesMarker = candidate['v'] !== undefined || candidate['e'] !== undefined;
  return carriesMarker && !isEncryptedRow(row);
}

/** Looks like a pre-encryption plaintext Conversation row? */
export function isPlaintextRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const candidate = row as Record<string, unknown>;
  return (
    candidate['v'] === undefined &&
    candidate['e'] === undefined &&
    typeof candidate['id'] === 'string' &&
    Array.isArray(candidate['messages'])
  );
}

/** The prefix is ALWAYS caller-supplied (the target database's own prefix,
 *  prefixOfDbName) — never guessed from localStorage. An omitted prefix is a
 *  programming error: fail loudly instead of silently encrypting/decrypting
 *  under the wrong profile key. */
function requirePrefix(prefix?: string): string {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('[db-crypto] prefix is required (the target database prefix via prefixOfDbName)');
  }
  return prefix;
}

/** Encrypt a Conversation object into its storage envelope. `secret` may be
 *  omitted (get-or-mint under the lock) — migration passes the already-minted
 *  secret so every row of one pass uses ONE key. `prefix` MUST be the target
 *  database's prefix (prefixOfDbName) — an omitted prefix throws. */
export async function encryptRow<T extends EnvelopeFields>(
  conversation: T,
  secret?: string,
  prefix?: string,
): Promise<EncryptedRow> {
  const resolvedPrefix = requirePrefix(prefix);
  const resolvedSecret = secret ?? (await getOrCreateSecret(resolvedPrefix));
  // Secret-stability re-check (PR #371 review F-A1): when THIS call acquired
  // the secret itself, re-read the custody map right before encrypting — a
  // concurrent tab's overwrite (no-Web-Locks deployments) must surface as a
  // visible refused write instead of persisting rows encrypted under a
  // secret that no longer exists in the map (silently undecryptable).
  if (secret === undefined) {
    const current = readSecretMap()[resolvedPrefix];
    if (current !== resolvedSecret) {
      throw new ConversationDecryptError(
        'profile secret changed while it was being acquired — refusing to encrypt (the retried write will use the stored secret)',
      );
    }
  }
  const key = await deriveKey(resolvedPrefix, resolvedSecret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const tagged = conversation as T & { afterClear?: number; sawPendingGoal?: number };
  const rowShape: EncryptedRow = {
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    v: ENVELOPE_VERSION,
    e: { iv: '', ct: '' },
    ...(tagged.afterClear === undefined ? {} : { afterClear: tagged.afterClear }),
    ...(tagged.sawPendingGoal === undefined ? {} : { sawPendingGoal: tagged.sawPendingGoal }),
  };
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadBytes(rowShape) },
    key,
    new TextEncoder().encode(JSON.stringify(conversation)),
  );
  return { ...rowShape, e: { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) } };
}

/**
 * Decrypt an envelope row back to the original object shape. Fail-closed:
 * missing secret, malformed envelope, or authentication failure all throw
 * ConversationDecryptError — there is NO plaintext fallback path.
 */
export async function decryptRow<T>(row: unknown, prefix?: string): Promise<T> {
  if (isMalformedEnvelope(row)) {
    throw new ConversationDecryptError('malformed envelope (unknown version or missing fields) — failing closed');
  }
  if (!isEncryptedRow(row)) {
    throw new ConversationDecryptError('row is not an envelope; decryptRow must not be used on plaintext');
  }
  const resolvedPrefix = requirePrefix(prefix);
  const secret = readSecretMap()[resolvedPrefix];
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new ConversationDecryptError('profile secret unavailable — encrypted data cannot be read (lost profile = lost data)');
  }
  const key = await deriveKey(resolvedPrefix, secret);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(row.e.iv), additionalData: aadBytes(row) },
      key,
      fromBase64(row.e.ct),
    );
  } catch {
    throw new ConversationDecryptError('authentication failed (wrong key, tampered ct, or foreign envelope)');
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as T & EnvelopeFields;
  // Inner/outer consistency (#367 review F5): the plaintext identity fields
  // must agree with the authenticated (AAD-bound) envelope fields — a
  // re-wrapped envelope whose inner row disagrees with its outer index
  // fields fails closed instead of decrypting to a mis-attributed row.
  if (parsed.id !== row.id) {
    throw new ConversationDecryptError('inner id does not match the envelope id');
  }
  if (parsed.createdAt !== row.createdAt || parsed.updatedAt !== row.updatedAt) {
    throw new ConversationDecryptError('inner timestamps do not match the envelope fields');
  }
  return parsed;
}

/** Read helper for public APIs: envelopes decrypt, verified plaintext rows
 *  pass through (only BEFORE migration completes — the gate normally
 *  guarantees post-migration reads see envelopes). */
export async function decryptRowOrPlain<T>(row: unknown, prefix?: string): Promise<T> {
  if (isEncryptedRow(row) || isMalformedEnvelope(row)) return decryptRow<T>(row, prefix);
  if (isPlaintextRow(row)) return row as T;
  throw new ConversationDecryptError('unrecognized row shape');
}

// ---------------------------------------------------------------------------
// Migration + key-state matrix (plan RC3-03 totalization)
// ---------------------------------------------------------------------------

export type DataState = 'EMPTY' | 'PLAINTEXT_ONLY' | 'ENVELOPE_ONLY' | 'MIXED' | 'INVALID';
export type KeyState = 'ABSENT' | 'VALID' | 'WRONG';

/** Classify raw stored rows (order-insensitive). */
export function classifyRows(rows: readonly unknown[]): DataState {
  if (rows.length === 0) return 'EMPTY';
  let plain = 0;
  let env = 0;
  for (const row of rows) {
    if (isMalformedEnvelope(row)) return 'INVALID';
    if (isEncryptedRow(row)) env += 1;
    else if (isPlaintextRow(row)) plain += 1;
    else return 'INVALID';
  }
  if (plain === rows.length) return 'PLAINTEXT_ONLY';
  if (env === rows.length) return 'ENVELOPE_ONLY';
  return 'MIXED';
}

/**
 * Key-state probe: authenticate one existing envelope (cheap trial decrypt).
 * VALID requires an existing secret AND a successful trial decrypt of every
 * sampled envelope (MIXED/ENVELOPE_ONLY rows).
 */
export async function probeKeyState(rows: readonly unknown[], prefix?: string): Promise<KeyState> {
  const resolvedPrefix = requirePrefix(prefix);
  if (!hasProfileSecret(resolvedPrefix)) return 'ABSENT';
  const sample = rows.filter((r) => isEncryptedRow(r) || isMalformedEnvelope(r));
  if (sample.length === 0) return 'VALID';
  for (const row of sample) {
    try {
      await decryptRow(row, resolvedPrefix);
    } catch (error) {
      if (error instanceof ConversationDecryptError) return 'WRONG';
      throw error;
    }
  }
  return 'VALID';
}

/**
 * The total decision matrix (plan RC3-03 + AC3 first-open migration). The
 * decision is evaluated INSIDE the lock against a fresh post-lock probe:
 *   EMPTY + any                       -> EMPTY_PROCEED (nothing to migrate;
 *                                        first write mints on demand)
 *   PLAINTEXT_ONLY|MIXED + ABSENT     -> MINT_THEN_MIGRATE_THEN_PROCEED
 *                                        (mint, then encrypt the plaintext
 *                                        rows — AC3 migration on first open)
 *   PLAINTEXT_ONLY|ENVELOPE_ONLY|MIXED + VALID -> PROCEED / MIGRATE_THEN_PROCEED
 *                                        (migrate iff any plaintext present)
 *   PLAINTEXT_ONLY + WRONG            -> PROCEED (no envelope to authenticate:
 *                                        WRONG is undetectable here; the
 *                                        existing secret is NEVER overwritten)
 *   ENVELOPE_ONLY|MIXED + ABSENT      -> FAIL_NO_KEY
 *   ENVELOPE_ONLY|MIXED + WRONG       -> FAIL_WRONG_KEY
 *   ANY + INVALID                     -> FAIL_INVALID
 */
export type MatrixDecision =
  | 'EMPTY_PROCEED'
  | 'PROCEED'
  | 'MIGRATE_THEN_PROCEED'
  | 'MINT_THEN_MIGRATE_THEN_PROCEED'
  | 'FAIL_NO_KEY'
  | 'FAIL_WRONG_KEY'
  | 'FAIL_INVALID';

export function keyStateMatrix(data: DataState, key: KeyState): MatrixDecision {
  if (data === 'INVALID') return 'FAIL_INVALID';
  if (data === 'EMPTY') return 'EMPTY_PROCEED';
  if (key === 'VALID') return hasPlaintext(data) ? 'MIGRATE_THEN_PROCEED' : 'PROCEED';
  if (key === 'ABSENT') {
    // MIXED means envelopes already exist — a secret existed and its absence
    // is lost-profile, NOT a mint opportunity (plan: "partial encryption
    // must not mint over it" — FAIL before any rewrite). Only a fully
    // plaintext store (pre-#367 rollout) may mint-and-migrate on first open.
    if (data === 'PLAINTEXT_ONLY') return 'MINT_THEN_MIGRATE_THEN_PROCEED';
    return 'FAIL_NO_KEY';
  }
  // key === 'WRONG'
  if (data === 'PLAINTEXT_ONLY') return 'PROCEED';
  return 'FAIL_WRONG_KEY';
}

function hasPlaintext(data: DataState): boolean {
  return data === 'PLAINTEXT_ONLY' || data === 'MIXED';
}

/** The profile prefix a database name belongs to (deterministic name rule:
 * `{prefix}-doc-qa-conversations`). Crypto is keyed by the TARGET db's
 * prefix — never the active localStorage profile — so adoption into a
 * non-active profile encrypts under the target's key (plan PC-03 family). */
export function prefixOfDbName(dbName: string): string {
  const prefix = dbName.replace(/-doc-qa-conversations$/, '');
  if (!/^[a-z0-9]{3,8}$/.test(prefix)) {
    throw new ConversationDecryptError(`cannot derive a profile prefix from database name "${dbName}"`);
  }
  return prefix;
}

export const CONVERSATION_STORE_NAME = CONVERSATION_STORE;
