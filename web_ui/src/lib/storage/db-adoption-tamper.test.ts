// Tamper leg for the ADOPTED rows (issue #367): the envelopes copied by the
// legacy adoption authenticate under the target profile key and fail closed
// when tampered. Isolated in its own file so its Dexie module state is fresh
// (per-file isolation in the forks pool); the shared adoption spec exercises
// the positive path.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROFILE_KEY } from './persisted-keys';

const LEGACY_DB = 'docqa_conversations';
const TARGET_PREFIX = 'adopt010';
const TARGET_DB = 'adopt010-doc-qa-conversations';
const TITLE_MARKER = 'AdoptTamperT5x';
const MSG_MARKER = 'AdoptTamperM9k';
const SRC_MARKER = 'AdoptTamperS3w';

function legacyRow(): Record<string, unknown> {
  return {
    id: 'adopt-t',
    title: `Project ${TITLE_MARKER} brief`,
    messages: [{ id: 'adopt-t-m1', role: 'user', content: `q about ${MSG_MARKER}`, timestamp: 1 }],
    createdAt: 1,
    updatedAt: 2,
    mode: 'server',
    modelUsed: 'legacy-model',
  };
}

function seedLegacyDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB, 2);
    req.onupgradeneeded = () => {
      const conn = req.result;
      const store = conn.createObjectStore('conversations', { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt', { unique: false });
      store.createIndex('createdAt', 'createdAt', { unique: false });
      store.createIndex('title', 'title', { unique: false });
      conn.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const conn = req.result;
      const tx = conn.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').put(legacyRow());
      tx.oncomplete = () => { conn.close(); resolve(); };
      tx.onerror = () => reject(tx.error ?? new Error('seed failed'));
    };
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
}

function rawRow(dbName: string): Promise<Record<string, unknown> | undefined> {
  return rawRows(dbName).then((rows) => rows[0] as Record<string, unknown> | undefined);
}

function rawRows(dbName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const conn = req.result;
      if (!conn.objectStoreNames.contains('conversations')) { conn.close(); resolve([]); return; }
      const tx = conn.transaction('conversations', 'readonly');
      const getAll = tx.objectStore('conversations').getAll();
      getAll.onsuccess = () => { conn.close(); resolve(getAll.result ?? []); };
      getAll.onerror = () => reject(getAll.error ?? new Error('getAll failed'));
    };
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
}

function rawPut(dbName: string, row: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const conn = req.result;
      const tx = conn.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').put(row);
      tx.oncomplete = () => { conn.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, TARGET_PREFIX);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adopted-row tamper (#367 plan item 6: adoption encrypts at rest)', () => {
  it('the copied envelope authenticates; a flipped ct byte fails closed (adoption-tamper)', async () => {
    await seedLegacyDb();
    const { adoptLegacyConversations } = await import('../../db/conv-protocol');
    const outcome = await adoptLegacyConversations(TARGET_PREFIX);
    expect(outcome.outcome).toBe('adopted');

    const stored = (await rawRows(TARGET_DB)) as Array<Record<string, unknown>>;
    expect(stored.length).toBe(1);
    const row = stored[0]!;
    const e = row['e'] as Record<string, string>;
    const ct = e['ct'];
    const at = ct.length - 5;
    e['ct'] = ct[at] === 'A' ? `${ct.slice(0, at)}B${ct.slice(at + 1)}` : `${ct.slice(0, at)}A${ct.slice(at + 1)}`;
    await rawPut(TARGET_DB, row);

    const { getConversation } = await import('../../db/conversations');
    await expect(getConversation('adopt-t')).rejects.toThrow();
    // Raw rows still hold the (tampered) envelope — nothing was decrypted
    // into storage and no plaintext leaked.
    const after = (await rawRows(TARGET_DB)) as Array<Record<string, unknown>>;
    expect(JSON.stringify(after)).not.toContain(TITLE_MARKER);
    expect(JSON.stringify(after)).not.toContain(MSG_MARKER);
    expect(JSON.stringify(after)).not.toContain(SRC_MARKER);
    void rawRow;
  });
});
