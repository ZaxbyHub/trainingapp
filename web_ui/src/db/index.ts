import Dexie, { type Table } from 'dexie';
import { getStorageDbNames } from '../lib/storage/profile';
import { withExclusiveLock } from '../lib/storage/exclusive-lock';
import {
  ConversationDecryptError,
  classifyRows,
  encryptRow,
  getOrCreateSecret,
  hasProfileSecret,
  keyStateMatrix,
  prefixOfDbName,
  probeKeyState,
  type EncryptedRow,
} from '../lib/storage/db-crypto';
import type { Conversation } from './conversations';

/**
 * Per-profile conversations database (issue #34 item 6p, R3-1): the Dexie
 * name derives from getStorageDbNames().conversations — `{prefix}-doc-qa-
 * conversations` for every profile (uniform rule; there is no default-''
 * branch). The page reloads on a profile switch, so this module-level
 * singleton re-derives per document.
 *
 * Version 2 adds the `meta` store (R4-3): the clear epoch that gates
 * cross-tab conversation writes. A fresh per-profile database starts at
 * version 2 directly; no upgrade path is needed from a version-1 schema
 * because the version-1 name (`docqa_conversations`) was the LEGACY shared
 * database, which is adopted separately (db/conv-protocol.ts, R7-1).
 *
 * Version 3 (issue #367): bumps the schema stamp for PROFILE databases only
 * — the LEGACY shared db (adoption SOURCE, known-plaintext) must never run
 * the encryption ladder (plan PC-03: one ladder for every instance would
 * upgrade the source out from under the adoption reader). The migration of
 * pre-#367 plaintext rows to envelopes is NOT a Dexie `.upgrade()` callback
 * (async WebCrypto inside a versionchange transaction auto-commits it —
 * PC-06); it runs as the first conversation-lock critical section via
 * migrationReady() below.
 */
/**
 * `meta` rows: the clear `epoch` (number) and the legacy-adoption claim
 * ({target, phase, epoch?}) — see db/conv-protocol.ts. key 'epoch' → number;
 * key 'legacy-adopt-claim' → LegacyAdoptClaim-shaped object (the optional
 * `epoch` is the copy's epoch binding, reviewer round 2 F3).
 */
export type ConversationMetaRow = {
  key: string;
  value: number | { target: string; phase: 'copying' | 'done'; epoch?: number };
};

/**
 * Raw stored row shape (issue #367): encrypted envelopes; pre-migration
 * plaintext Conversation rows are only ever observable on the LEGACY db and
 * transiently in a profile db whose migration has not completed (the public
 * gate prevents that window from being read).
 */
export type ConversationRow = Conversation | EncryptedRow;

/** Origin-wide conversation serialization lock name (RC5-01): every
 * migration-serialized path acquires it via withExclusiveLock — the legacy
 * direct-call wrapper (conv-protocol withConversationWriteLock) must not
 * carry multi-phase crypto read-merge-write sequences. */
export const CONV_WRITE_LOCK = 'docqa-conv-write';

/** The legacy SHARED conversations database name (pre-profile builds).
 * Declared before the class: the constructor references it (a TDZ read
 * would throw during the module-level `db` construction below). */
export const LEGACY_CONVERSATIONS_DB_NAME = 'docqa_conversations';

export class DocQADatabase extends Dexie {
  conversations!: Table<ConversationRow, string>;
  meta!: Table<ConversationMetaRow, string>;

  constructor(name?: string) {
    // The name parameter is a test seam: production derives it from the
    // active profile prefix; tests open isolated per-profile databases.
    const dbName = name ?? getStorageDbNames().conversations;
    super(dbName);
    this.version(2).stores({
      conversations: 'id, updatedAt, createdAt, title',
      meta: 'key',
    });
    if (dbName !== LEGACY_CONVERSATIONS_DB_NAME) {
      // Same stores; the version bump marks the at-rest-encryption schema
      // stamp. The row migration runs post-open (see migrationReady).
      this.version(3).stores({
        conversations: 'id, updatedAt, createdAt, title',
        meta: 'key',
      });
    }
  }
}

export const db = new DocQADatabase();

// ==========================================================================
// Issue #367: first-open row migration + matrix-gated encryption
// ==========================================================================

/**
 * Per-database-name migration state (RC3-02/PC-05: never one global promise
 * across profiles). Rejected entries are DELETED so a corrected key or a
 * transient failure can be retried by a later call.
 */
const migrationStates = new Map<string, Promise<void>>();

function openDbByName(name: string): DocQADatabase {
  if (name === db.name) return db;
  return new DocQADatabase(name);
}

/**
 * Run the plaintext->envelope migration assuming the caller ALREADY holds
 * the conversation write lock (RC5-01: never re-acquire the non-reentrant
 * lock). Three-phase (read-tx / crypto / write-tx): no WebCrypto await ever
 * runs inside an IndexedDB transaction; every waiter re-reads the stored
 * rows AFTER acquiring the lock so a stale snapshot cannot overwrite a
 * migrated row (RC3-02).
 */
export async function migrateUnderLock(target: DocQADatabase): Promise<void> {
  // Phase 1: read every stored row (short read tx).
  const rows = await target.transaction('r', target.conversations, () =>
    target.conversations.toArray(),
  );
  const prefix = prefixOfDbName(target.name);
  const data = classifyRows(rows);
  const key = await probeKeyState(rows, prefix);
  const decision = keyStateMatrix(data, key);
  switch (decision) {
    case 'PROCEED':
    case 'EMPTY_PROCEED':
      // Fully encrypted (usable key) or empty: nothing to migrate. An empty
      // db does NOT mint here — the first write mints through the same
      // matrix on demand.
      return;
    case 'MIGRATE_THEN_PROCEED':
    case 'MINT_THEN_MIGRATE_THEN_PROCEED': {
      // AC3 (issue #367): ANY stored plaintext row migrates on first open —
      // not only MIXED stores (a PLAINTEXT_ONLY legacy upgrade is the normal
      // rollout path and MUST encrypt here, not on some later write). Key:
      // VALID authenticates already (probeKeyState); ABSENT mints now (the
      // matrix's MINT row exists precisely because first-open migration of
      // existing plaintext is the rollout path; C3 pins it).
      const secret = await getOrCreateSecret(prefix);
      const plaintextRows = (rows as Conversation[]).filter((row) => !('e' in row));
      // Crypto outside any tx (PC-06).
      const envelopes = await Promise.all(plaintextRows.map((row) => encryptRow(row, secret, prefix)));
      // Phase 3: write back inside a short rw tx (serialized against every
      // other conversation mutation by the held lock).
      await target.transaction('rw', target.conversations, async () => {
        for (const envelope of envelopes) await target.conversations.put(envelope);
      });
      return;
    }
    case 'FAIL_NO_KEY':
      throw new ConversationDecryptError(
        'encrypted conversations exist but the profile secret is unavailable — refusing to open for reads/writes (lost profile = lost data)',
      );
    case 'FAIL_WRONG_KEY':
      throw new ConversationDecryptError(
        'existing envelopes do not authenticate under the current profile secret — refusing to read or rewrite',
      );
    case 'FAIL_INVALID':
      throw new ConversationDecryptError('unrecognized row shape in the conversations store — failing closed');
  }
}

/**
 * Public entry gate: await before ANY conversation-table touch (read or
 * write). Runs the first-open migration under the origin-wide conversation
 * lock; later callers hit the memoized settled promise (rejections are
 * cleared for retry). Callers that will take CONV_WRITE_LOCK themselves for
 * a mutation must await this BEFORE acquiring (no nested reacquisition of
 * the non-reentrant lock — RC5-01).
 */
export function migrationReady(name: string = db.name): Promise<void> {
  const existing = migrationStates.get(name);
  if (existing !== undefined) return existing;
  const run = withExclusiveLock(CONV_WRITE_LOCK, async () => {
    await migrateUnderLock(openDbByName(name));
  });
  const tracked = run.then(
    () => undefined,
    (error: unknown) => {
      // Drop the rejected entry so the next attempt re-probes (corrected key).
      if (migrationStates.get(name) === tracked) migrationStates.delete(name);
      throw error;
    },
  );
  migrationStates.set(name, tracked);
  return tracked;
}

/**
 * Write-path key gate (plan matrix rows): encryption-requiring writes must
 * NOT silently mint over an encrypted store. When the profile secret is
 * absent and the store already holds envelopes, fail closed. (Cheap fast
 * path: secret present => zero extra reads.)
 */
export async function requireKeyForWrite(target: DocQADatabase): Promise<void> {
  const prefix = prefixOfDbName(target.name);
  if (hasProfileSecret(prefix)) return;
  const rows = await target.transaction('r', target.conversations, () =>
    target.conversations.toArray(),
  );
  const data = classifyRows(rows);
  const key = await probeKeyState(rows, prefix);
  const decision = keyStateMatrix(data, key);
  if (
    decision === 'FAIL_NO_KEY' ||
    decision === 'FAIL_WRONG_KEY' ||
    decision === 'FAIL_INVALID'
  ) {
    throw new ConversationDecryptError(
      `write refused under key-state decision ${decision} for database ${target.name}`,
    );
  }
  if (decision === 'MINT_THEN_MIGRATE_THEN_PROCEED') await getOrCreateSecret(prefix);
}

/** Test seam: forget memoized migration state (fresh gate per spec file). */
export function __resetMigrationStatesForTests(): void {
  migrationStates.clear();
}
