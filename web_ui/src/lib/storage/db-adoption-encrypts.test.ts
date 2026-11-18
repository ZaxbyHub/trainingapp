// Adoption-encrypts-at-rest (issue #367 plan item 6): the legacy shared db
// (docqa_conversations, pre-profile plaintext) is copied into the target
// profile db as ENCRYPTED envelopes — the raw copied rows carry no plaintext
// of title/messages/citation filenames, and public reads return the
// originals. Drives the REAL conv-protocol adoption path (claim transaction
// + page copy) over fake-indexeddb.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROFILE_KEY, PROFILE_SECRET_KEY } from './persisted-keys';

// The repo-root marker file anchors the same way the other db suites do.
const here = import.meta.url;

function repoRoot(): string {
  let dir = new URL('.', here).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'contracts', 'api.openapi.yaml'))) return dir.replace(/[/\\]$/, '');
    dir = new URL('..', `file://${dir}/`).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
  }
  throw new Error('repo root not found');
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY_DB = 'docqa_conversations';
const TARGET_PREFIX = 'adopt001';
const TARGET_DB = 'adopt001-doc-qa-conversations';

interface LegacyConversationRow {
  id: string;
  title: string;
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>;
  createdAt: number;
  updatedAt: number;
  mode: 'server' | 'wllama';
  modelUsed: string;
}

const MARKERS = ['AdoptTITLEmV4', 'AdoptMSGqR7t', 'AdoptSRCkW2f'];

function legacyRow(id: string, titleMarker: string, msgMarker: string, srcMarker: string): LegacyConversationRow {
  return {
    id,
    title: `Project ${titleMarker} brief`,
    messages: [
      { id: `${id}-m1`, role: 'user', content: `question about ${msgMarker} dosage`, timestamp: 1730000000000 },
    ],
    createdAt: 1730000000000,
    updatedAt: 1730000001000,
    mode: 'server',
    modelUsed: 'legacy-model',
    ...(srcMarker.length > 0 ? { citationSrc: `${srcMarker}.pdf` } : {}),
  } as LegacyConversationRow & { citationSrc?: string };
}

function seedLegacyDb(rows: LegacyConversationRow[]): Promise<void> {
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
      const tx = conn.transaction(['conversations', 'meta'], 'readwrite');
      const store = tx.objectStore('conversations');
      for (const row of rows) store.put(JSON.parse(JSON.stringify(row)));
      tx.oncomplete = () => {
        conn.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('seed failed'));
    };
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
}

function rawRows(dbName: string, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const conn = req.result;
      if (!conn.objectStoreNames.contains(storeName)) {
        conn.close();
        resolve([]);
        return;
      }
      const tx = conn.transaction(storeName, 'readonly');
      const getAll = tx.objectStore(storeName).getAll();
      getAll.onsuccess = () => {
        conn.close();
        resolve(getAll.result ?? []);
      };
      getAll.onerror = () => reject(getAll.error ?? new Error('raw getAll failed'));
    };
    req.onerror = () => reject(req.error ?? new Error('raw open failed'));
  });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adoption encrypts at rest (#367: legacy plaintext -> target envelopes)', () => {
  it('adoptLegacyConversations copies plaintext legacy rows as envelopes; reads return originals (adoption)', async () => {
    pin(TARGET_PREFIX);
    const rows = [
      legacyRow('adopt-a', MARKERS[0]!, MARKERS[1]!, MARKERS[2]!),
      legacyRow('adopt-b', `${MARKERS[0]}2`, `${MARKERS[1]}2`, `${MARKERS[2]}2`),
    ];
    await seedLegacyDb(rows);

    const { adoptLegacyConversations } = await import('../../db/conv-protocol');
    const result = await adoptLegacyConversations(TARGET_PREFIX);
    expect(result).toMatchObject({ outcome: 'adopted', count: 2 });

    // (1) The copied rows are ENVELOPES at rest — no plaintext marker.
    const stored = (await rawRows(TARGET_DB, 'conversations')) as Array<Record<string, unknown>>;
    expect(stored.length).toBe(2);
    const rawJson = JSON.stringify(stored);
    for (const marker of MARKERS) {
      expect(rawJson, `copied rows must not leak marker ${marker}`).not.toContain(marker);
    }
    for (const row of stored) {
      expect(row['v']).toBe(1);
      expect(row['e']).toBeDefined();
    }

    // (2) Public reads return the original values byte-identically.
    const { getConversation, listConversations } = await import('../../db/conversations');
    const a = await getConversation('adopt-a');
    expect(a?.title).toBe(rows[0]!.title);
    expect(a?.messages[0]?.content).toBe(rows[0]!.messages[0]!.content);
    const listed = await listConversations();
    expect(listed.map((c) => c.id).sort()).toEqual(['adopt-a', 'adopt-b']);
    expect(listed[0]?.id).toBe('adopt-b'); // newest first by updatedAt

    // (3) The legacy db was deleted after the done phase.
    expect(await rawRows(LEGACY_DB, 'conversations')).toEqual([]);
  });
});

function pin(prefix: string): void {
  localStorage.setItem(PROFILE_KEY, prefix);
  // No pre-seeded secret: adoption's copy mints through getOrCreateSecret on
  // the TARGET prefix (the same call site the matrix MINT row covers).
  localStorage.removeItem(PROFILE_SECRET_KEY);
}
