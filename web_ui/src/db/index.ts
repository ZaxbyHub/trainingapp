import Dexie, { type Table } from 'dexie';
import { getStorageDbNames } from '../lib/storage/profile';
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
 */
/**
 * `meta` rows: the clear `epoch` (number) and the legacy-adoption claim
 * ({target, phase}) — see db/conv-protocol.ts. key 'epoch' → number;
 * key 'legacy-adopt-claim' → LegacyAdoptClaim-shaped object.
 */
export type ConversationMetaRow = {
  key: string;
  value: number | { target: string; phase: 'copying' | 'done' };
};

export class DocQADatabase extends Dexie {
  conversations!: Table<Conversation, string>;
  meta!: Table<ConversationMetaRow, string>;

  constructor(name?: string) {
    // The name parameter is a test seam: production derives it from the
    // active profile prefix; tests open isolated per-profile databases.
    super(name ?? getStorageDbNames().conversations);
    this.version(2).stores({
      conversations: 'id, updatedAt, createdAt, title',
      meta: 'key',
    });
  }
}

export const db = new DocQADatabase();

/** The legacy SHARED conversations database name (pre-profile builds). */
export const LEGACY_CONVERSATIONS_DB_NAME = 'docqa_conversations';
