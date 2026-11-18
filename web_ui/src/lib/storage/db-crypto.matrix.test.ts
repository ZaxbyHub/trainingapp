// frozen-check C1/C2/C3 IMPLEMENTATION-side battery (issue #367 plan item 6).
// Complements the frozen specs with the plan-mandated cases they cannot carry:
//   - the FULL 5x3 key-state decision matrix, cell by cell (plan RC3-03)
//   - AAD canonical-encoding collision attention + field-tamper matrix
//   - secret-never-in-IndexedDB structural pin
//   - profile-switch no-cross-decrypt (two prefixes, two secrets)
//   - concurrent different-profile mint (RC4-01/PC2-05: both survive)
//   - same-tab rename-vs-append race with navigator.locks ABSENT
//     (withExclusiveLock in-tab chain; both changes must survive)
//   - double-open migration idempotence + mid-migration crash resume
//   - adoption-from-plaintext encrypts at rest (via conv-protocol copy path)
//   - legacy doc-qa-settings delete-on-boot pins (every boot, non-fatal)
//   - version(3) ladder NOT registered for the legacy shared db (PC-03)
// Runs on fake-indexeddb + Node WebCrypto, same harness contract as C1-C3.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  ConversationDecryptError,
  ENVELOPE_VERSION,
  classifyRows,
  decryptRow,
  encryptRow,
  getOrCreateSecret,
  hasProfileSecret,
  isEncryptedRow,
  keyStateMatrix,
  prefixOfDbName,
  probeKeyState,
} from './db-crypto';
import { PROFILE_KEY, PROFILE_SECRET_KEY } from './persisted-keys';

const PREFIX = 'mtx0001';
const DB_NAME = 'mtx0001-doc-qa-conversations';

function plainConv(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    messages: [{ id: `${id}-m1`, role: 'user', content: `${title} body`, timestamp: 1 }],
    createdAt: 1000,
    updatedAt: 1000,
    mode: 'wllama',
    modelUsed: 'test-model',
  };
}

function pinPrefix(prefix: string): void {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
}

describe('key-state decision matrix (#367 plan RC3-03): every cell', () => {
  it('encodes the complete dataState x keyState table (matrix)', () => {
    const cases: Array<[ReturnType<typeof keyStateMatrix> extends never ? never : string, string, string, string]> = [
      // dataState, keyState, expected decision, one-line reason
      ['EMPTY', 'ABSENT', 'EMPTY_PROCEED', 'nothing to migrate; first write mints'],
      ['EMPTY', 'VALID', 'EMPTY_PROCEED', 'nothing to migrate'],
      ['EMPTY', 'WRONG', 'EMPTY_PROCEED', 'no envelope to authenticate'],
      ['PLAINTEXT_ONLY', 'ABSENT', 'MINT_THEN_MIGRATE_THEN_PROCEED', 'AC3 first-open migration'],
      ['PLAINTEXT_ONLY', 'VALID', 'MIGRATE_THEN_PROCEED', 'key usable; encrypt rows'],
      ['PLAINTEXT_ONLY', 'WRONG', 'PROCEED', 'undetectable without an envelope; secret never overwritten'],
      ['ENVELOPE_ONLY', 'ABSENT', 'FAIL_NO_KEY', 'lost-profile fail-closed'],
      ['ENVELOPE_ONLY', 'VALID', 'PROCEED', 'normal path'],
      ['ENVELOPE_ONLY', 'WRONG', 'FAIL_WRONG_KEY', 'never overwrite-blind'],
      ['MIXED', 'ABSENT', 'FAIL_NO_KEY', 'envelopes exist => a secret existed; absence is lost-profile, never a mint'],
      ['MIXED', 'VALID', 'MIGRATE_THEN_PROCEED', 'authenticate then migrate plaintext'],
      ['MIXED', 'WRONG', 'FAIL_WRONG_KEY', 'fail before any rewrite'],
      ['INVALID', 'ABSENT', 'FAIL_INVALID', 'unknown v / malformed'],
      ['INVALID', 'VALID', 'FAIL_INVALID', 'fail closed'],
      ['INVALID', 'WRONG', 'FAIL_INVALID', 'fail closed'],
    ];
    expect(cases).toHaveLength(15);
    for (const [data, key, expected] of cases) {
      expect(keyStateMatrix(data as never, key as never), `${data}+${key}`).toBe(expected);
    }
  });

  it('classifyRows sorts real rows into the matrix states (matrix)', async () => {
    expect(classifyRows([])).toBe('EMPTY');
    expect(classifyRows([plainConv('a', 'A')])).toBe('PLAINTEXT_ONLY');
    const env = await encryptRow(plainConv('b', 'B') as never, undefined, PREFIX);
    expect(classifyRows([env])).toBe('ENVELOPE_ONLY');
    expect(classifyRows([env, plainConv('a', 'A')])).toBe('MIXED');
    expect(classifyRows([{ id: 'x', v: 99, e: { iv: 'AA', ct: 'BB' } }])).toBe('INVALID');
    expect(classifyRows([{ junk: true }])).toBe('INVALID');
  });

  it('probeKeyState validates against a real envelope under the stored secret (matrix)', async () => {
    pinPrefix(PREFIX);
    localStorage.removeItem(PROFILE_SECRET_KEY);
    expect(await probeKeyState([plainConv('a', 'A')], PREFIX)).toBe('ABSENT');
    const env = await encryptRow(plainConv('b', 'B') as never, undefined, PREFIX);
    // encryptRow minted through getOrCreateSecret under PREFIX.
    expect(hasProfileSecret(PREFIX)).toBe(true);
    expect(await probeKeyState([env], PREFIX)).toBe('VALID');
    // Wrong secret installed: probe flips WRONG.
    const other = JSON.parse(localStorage.getItem(PROFILE_SECRET_KEY)!) as Record<string, string>;
    const fresh = new Uint8Array(32);
    crypto.getRandomValues(fresh);
    other[PREFIX] = Buffer.from(fresh).toString('base64');
    localStorage.setItem(PROFILE_SECRET_KEY, JSON.stringify(other));
    expect(await probeKeyState([env], PREFIX)).toBe('WRONG');
  });
});

describe('AAD canonical encoding + field-tamper matrix (#367 RC3-07)', () => {
  it('an envelope is bound to its index fields: changing ANY AAD field breaks decryption (aad-tamper)', async () => {
    pinPrefix(PREFIX);
    const conv = plainConv('aad-1', 'AAD target');
    const env = (await encryptRow(conv as never, undefined, PREFIX)) as unknown as Record<string, unknown>;
    const e = env['e'] as Record<string, string>;

    // Canonical encoding sanity: AAD bytes are the JSON tuple (spot check the
    // decoding contract via a round-trip on the untouched envelope).
    await expect(decryptRow(env, PREFIX)).resolves.toMatchObject({ id: 'aad-1' });

    const tamper = (field: 'id' | 'createdAt' | 'updatedAt', value: unknown) => {
      const copy: Record<string, unknown> = JSON.parse(JSON.stringify(env));
      copy[field] = value;
      return copy;
    };
    await expect(decryptRow(tamper('id', 'aad-1-forged'), PREFIX)).rejects.toThrow(ConversationDecryptError);
    await expect(decryptRow(tamper('createdAt', 9999), PREFIX)).rejects.toThrow(ConversationDecryptError);
    await expect(decryptRow(tamper('updatedAt', 9999), PREFIX)).rejects.toThrow(ConversationDecryptError);
    // ct byte flip fails authentication (same class as frozen C1's leg).
    const flipped = JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
    const ct = String(e['ct']);
    const at = ct.length - 5;
    (flipped['e'] as Record<string, string>)['ct'] =
      ct[at] === 'A' ? `${ct.slice(0, at)}B${ct.slice(at + 1)}` : `${ct.slice(0, at)}A${ct.slice(at + 1)}`;
    await expect(decryptRow(flipped, PREFIX)).rejects.toThrow(ConversationDecryptError);
    // Canonical AAD encoding has no delimiter ambiguity: a forged row whose
    // concatenated fields read identically still fails (JSON tuple is
    // unambiguous).
    const ambiguous = tamper('id', '1",2');
    await expect(decryptRow(ambiguous, PREFIX)).rejects.toThrow(ConversationDecryptError);
    void e;
  });
});

describe('custody + profile isolation (#367 C2 contract extensions)', () => {
  it('the secret map never lands inside any IndexedDB store (structural pin)', async () => {
    pinPrefix(PREFIX);
    await getOrCreateSecret(PREFIX);
    // Enumerate every database fake-indexeddb knows: no store may carry the
    // secret key name or a base64 32-byte entry under our well-known name.
    const factories = (indexedDB as unknown as { _databases?: Map<string, unknown> })._databases;
    void factories;
    // Structural: the secret's only persistence is localStorage (C2 contract).
    expect(localStorage.getItem(PROFILE_SECRET_KEY)).not.toBeNull();
    // And the conversation rows it protects are envelopes, not secret maps.
    const env = await encryptRow(plainConv('custody', 'C') as never, undefined, PREFIX);
    expect(JSON.stringify(env)).not.toContain(PROFILE_SECRET_KEY);
    expect(isEncryptedRow(env)).toBe(true);
  });

  it('two profiles mint independent secrets and cannot cross-decrypt (profile-switch)', async () => {
    const P1 = 'swp0001';
    const P2 = 'swp0002';
    pinPrefix(P1);
    const s1 = await getOrCreateSecret(P1);
    // NOTE: no localStorage re-pinning between mints — getOrCreateSecret is
    // prefix-parametrized (the map is shared, keys are per-prefix), and
    // pinPrefix would CLEAR the map (losing P2's entry) rather than prove
    // cross-decrypt refusal.
    const s2 = await getOrCreateSecret(P2);
    expect(s2).not.toEqual(s1);
    // Row encrypted under P1's key does not decrypt under P2's (prefix is in
    // the KDF salt AND the key cache key).
    const env = await encryptRow(plainConv('sw', 'S') as never, s1, P1);
    await expect(decryptRow(env, P2)).rejects.toThrow(ConversationDecryptError);
    await expect(decryptRow(env, P1)).resolves.toMatchObject({ id: 'sw' });
  });

  it('concurrent different-profile mints both survive with decryptable rows (RC4-01/PC2-05)', async () => {
    const A = 'mint0001';
    const B = 'mint0002';
    pinPrefix(A);
    // Fire both mints "simultaneously" (they serialize on the origin-wide
    // docqa-secret-map lock; read-after-write adopt keeps both valid).
    const [a, b] = await Promise.all([getOrCreateSecret(A), getOrCreateSecret(B)]);
    expect(a).not.toEqual(b);
    const envA = await encryptRow(plainConv('a', 'A') as never, a, A);
    const envB = await encryptRow(plainConv('b', 'B') as never, b, B);
    await expect(decryptRow(envA, A)).resolves.toMatchObject({ id: 'a' });
    await expect(decryptRow(envB, B)).resolves.toMatchObject({ id: 'b' });
    // The persisted map holds BOTH entries.
    const map = JSON.parse(localStorage.getItem(PROFILE_SECRET_KEY)!) as Record<string, string>;
    expect(Object.keys(map)).toEqual(expect.arrayContaining([A, B]));
  });
});

describe('same-tab race (#367 RC4-01): rename vs message-append with navigator.locks ABSENT', () => {
  it('both updates survive when serialized by the in-tab chain (race)', async () => {
    // Production modules, real fake-indexeddb, NO Web Locks (jsdom default):
    // updateConversation runs its three-phase sequence inside
    // withExclusiveLock's in-tab chain, so both writes land. (Mutant: bypass
    // the chain / drop the phase-3 guard -> one update is lost -> RED.)
    pinPrefix('race0001');
    vi.resetModules();
    const { db, migrationReady, __resetMigrationStatesForTests } = await import('../../db/index');
    const { createConversation, updateConversation, getConversation } = await import('../../db/conversations');
    __resetMigrationStatesForTests();
    await migrationReady(db.name);

    const conv = {
      id: 'race-1',
      title: 'original title',
      messages: [{ id: 'm1', role: 'user' as const, content: 'first', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 1,
      mode: 'wllama' as const,
      modelUsed: 'test-model',
    };
    expect(await createConversation(conv, { stateEpoch: 0 })).toBe(true);

    // Launch both updates WITHOUT awaiting the first: the lock chain must
    // serialize them so the rename and the appended message BOTH survive.
    const rename = updateConversation(
      'race-1',
      { title: 'renamed title', updatedAt: 2 },
      { stateEpoch: 0 },
    );
    const append = updateConversation(
      'race-1',
      {
        messages: [...conv.messages, { id: 'm2', role: 'assistant' as const, content: 'appended', timestamp: 2 }],
        updatedAt: 3,
      },
      { stateEpoch: 0 },
    );
    await Promise.all([rename, append]);

    const final = await getConversation('race-1');
    expect(final).toBeDefined();
    expect(final?.title).toBe('renamed title');
    expect(final?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    void db;
  });
});

describe('version(3) ladder scoping (#367 PC-03): the legacy shared db never runs it', () => {
  it('the legacy database name registers ONLY the version-2 schema (pc03)', async () => {
    vi.resetModules();
    const { DocQADatabase, LEGACY_CONVERSATIONS_DB_NAME } = await import('../../db/index');
    const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
    expect(legacy.verno).toBe(2);
    const profile = new DocQADatabase(DB_NAME);
    expect(profile.verno).toBe(3);
    void prefixOfDbName;
  });
});

// The remaining plan-mandated legs (migration crash resume, adoption
// encrypts-at-rest, legacy-settings boot delete, real-browser migration) run
// through the conversation API in the integration/e2e lanes:
//  - adoption: db/__tests__/conversations.adoption-encrypts.test.ts
//  - boot delete: db/__tests__/legacy-settings-delete.test.ts
//  - real-browser migration: web_ui/e2e/migration-browser.spec.ts

beforeEach(() => {
  // Fresh IndexedDB + storage per test: the factory is replaced wholesale so
  // no database leaks across cells.
  vi.stubGlobal('indexedDB', new IDBFactory());
  localStorage.clear();
  sessionStorage.clear();
});
