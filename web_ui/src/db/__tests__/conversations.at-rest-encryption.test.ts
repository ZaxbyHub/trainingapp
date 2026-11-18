// frozen-check C1 — #367 AC1: at-rest encryption of the conversations store.
//
// FROZEN SPEC — authored by the independent check author at base
// 1cfde07b73b52fa906da7bd3f316d7805b638e2f, before any implementation
// exists. The implementer must make this pass WITHOUT editing it; the
// canonical copy lives in the issue trace and is dropped into the repo
// byte-identical at web_ui/src/db/__tests__/conversations.at-rest-encryption.test.ts.
//
// Harness contract (declared for the implementer):
//   - This spec runs against REAL IndexedDB semantics via the
//     `fake-indexeddb` devDependency (added by the implementer to
//     web_ui/package.json). `import 'fake-indexeddb/auto'` installs the
//     global before any Dexie open. The repo's hand-rolled
//     src/test/fake-dexie.ts is crypto-blind and is NOT used here.
//   - crypto.subtle is available under this vitest jsdom environment
//     (Node 24 global; repo precedent:
//     web_ui/src/lib/packs/__tests__/pack-signature-vectors.test.ts).
//   - The spec touches ONLY: (i) the public API of
//     web_ui/src/db/conversations.ts, (ii) the global indexedDB for RAW
//     storage reads (bypassing Dexie entirely), and (iii) localStorage to
//     pin the profile prefix. No implementation-internal module is
//     imported.
//
// Observable contract pinned (issue #367 AC1):
//   1. A conversation written through the public API
//      (createConversation/updateConversation) must leave NO plaintext of
//      title, messages[].content, legacy sources[], or citations[].source
//      in the RAW IndexedDB record (read back with a plain
//      indexedDB.open + getAll, no Dexie).
//   2. Reading the same conversation back through the public API returns
//      the original object byte-identically (JSON equality).
//   3. The row really is in the store under its id (guards against a
//      vacuous pass where the implementation writes somewhere else).
//   4. listConversations still returns it (the updatedAt index remains
//      functional post-encryption).
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';
import { getStorageDbNames } from '../../lib/storage/profile';
import type { Conversation } from '../conversations';
import type { CitationRef } from '../../types/chat';

// High-entropy markers: cannot appear inside base64/hex ciphertext by chance.
const TITLE_MARKER = 'Zk7qTITLEmV4cQ1';
const MSG1_MARKER = 'Xq3wMSGAeR9tK2';
const MSG2_MARKER = 'Vb5nMSGBkU7mZ3';
const SRC_MARKER = 'Jm4hSRCFILEpW6y';
const TITLE2_MARKER = 'Rt8yTITLE2xN4vB7';
const MSG3_MARKER = 'Gf6cMSGCwQ1jH9';

/** Prefixes satisfy the base shape regex ^[a-z0-9]{3,8}$. */
function pinProfilePrefix(prefix: string): void {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
}

/**
 * Fresh module graph for a pinned profile. The db singleton in
 * web_ui/src/db/index.ts captures its NAME at import time, so the prefix
 * must be pinned BEFORE the dynamic import (static imports would hoist).
 */
async function freshConversationsModule(prefix: string) {
  pinProfilePrefix(prefix);
  vi.resetModules();
  return import('../conversations');
}

/** RAW read of every record in a store, bypassing Dexie completely. */
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
      getAll.onerror = () => {
        conn.close();
        reject(getAll.error ?? new Error('raw getAll failed'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('raw open failed'));
  });
}

/** RAW write of rows (tamper simulation), bypassing Dexie entirely. */
function rawPut(dbName: string, storeName: string, rows: Array<Record<string, unknown>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const conn = req.result;
      const tx = conn.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const row of rows) store.put(row);
      tx.oncomplete = () => {
        conn.close();
        resolve();
      };
      tx.onerror = () => {
        conn.close();
        reject(tx.error ?? new Error('raw put failed'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('raw open failed'));
  });
}

function baseConversation(): Conversation {
  const citations: CitationRef[] = [
    { docId: 'doc-77', chunkIndex: 3, source: `${SRC_MARKER}-protocol.pdf`, page: 2, text: 'quoted passage' },
  ];
  return {
    id: 'conv-c1-001',
    title: `Project ${TITLE_MARKER} brief`,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: `question about ${MSG1_MARKER} dosage schedule`,
        timestamp: 1730000000000,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: `answer citing ${MSG2_MARKER} evidence`,
        timestamp: 1730000001000,
        sources: [`${SRC_MARKER}-protocol.pdf`],
        citations,
      },
    ],
    createdAt: 1730000000000,
    updatedAt: 1730000001000,
    mode: 'wllama',
    modelUsed: 'test-model',
  } as Conversation;
}

const PLAINTEXT_MARKERS = [TITLE_MARKER, MSG1_MARKER, MSG2_MARKER, SRC_MARKER];

describe('at-rest-encryption (#367 AC1): public-API writes leave no plaintext at rest and read back byte-identical', () => {
  it('createConversation stores an encrypted row (at-rest-encryption) and getConversation returns the original byte-identical', async () => {
    const conv = baseConversation();
    const api = await freshConversationsModule('c1enc001');
    const dbName = getStorageDbNames().conversations;
    expect(dbName).toBe('c1enc001-doc-qa-conversations');

    const applied = await api.createConversation(conv);
    expect(applied).toBe(true);

    // RAW storage read (no Dexie): the row is THERE, under its id...
    const rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length, 'the conversation row must exist in the raw conversations store').toBe(1);
    expect(rows[0]?.id).toBe(conv.id);

    // ...and carries NO plaintext of any sensitive field.
    const rawJson = JSON.stringify(rows);
    for (const marker of PLAINTEXT_MARKERS) {
      expect(rawJson, `raw stored row must not contain plaintext marker ${marker}`).not.toContain(marker);
    }

    // Public read-back: the original VALUES byte-identically — deep equality
    // over the full object plus exact sensitive-field strings (key order is
    // not part of the contract; the values are).
    const readBack = await api.getConversation(conv.id);
    expect(readBack).toBeDefined();
    expect(readBack).toEqual(conv);
    expect(readBack?.title).toBe(conv.title);
    expect(readBack?.messages[0]?.content).toBe(conv.messages[0]!.content);
    expect(readBack?.messages[1]?.content).toBe(conv.messages[1]!.content);
    expect(readBack?.messages[1]?.sources).toEqual(conv.messages[1]!.sources);
    expect(readBack?.messages[1]?.citations).toEqual(conv.messages[1]!.citations);

    // The updatedAt index remains functional: listConversations returns it.
    const listed = await api.listConversations();
    expect(listed.length).toBe(1);
    expect(listed[0]).toEqual(conv);
  });

  it('updateConversation re-encrypts: a renamed title and appended message never appear in plaintext at rest (at-rest-encryption)', async () => {
    const conv = baseConversation();
    const api = await freshConversationsModule('c1enc002');
    const dbName = getStorageDbNames().conversations;
    expect(await api.createConversation(conv)).toBe(true);

    const appended = {
      id: 'm3',
      role: 'assistant' as const,
      content: `follow-up mentioning ${MSG3_MARKER} and file ${SRC_MARKER}-appendix.pdf`,
      timestamp: 1730000002000,
      sources: [`${SRC_MARKER}-appendix.pdf`],
    };
    const ok = await api.updateConversation(conv.id, {
      title: `renamed to ${TITLE2_MARKER}`,
      messages: [...conv.messages, appended],
      updatedAt: 1730000002000,
    });
    expect(ok).toBe(true);

    const rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(conv.id);
    const rawJson = JSON.stringify(rows);
    const allMarkers = [...PLAINTEXT_MARKERS, TITLE2_MARKER, MSG3_MARKER];
    for (const marker of allMarkers) {
      expect(rawJson, `raw stored row after update must not contain plaintext marker ${marker}`).not.toContain(marker);
    }

    // Public read-back merges exactly: new title, three messages, all
    // original values preserved (deep equality + exact new-value strings).
    const readBack = await api.getConversation(conv.id);
    expect(readBack?.title).toBe(`renamed to ${TITLE2_MARKER}`);
    expect(readBack?.messages.length).toBe(3);
    expect(readBack?.messages[2]?.content).toBe(appended.content);
    expect(readBack?.messages[2]?.sources).toEqual(appended.sources);
    expect(readBack?.messages[0]?.content).toBe(conv.messages[0]!.content);
    const expected = { ...conv, title: `renamed to ${TITLE2_MARKER}`, messages: [...conv.messages, appended], updatedAt: 1730000002000 };
    expect(readBack).toEqual(expected);
  });

  it('ciphertext is not a trivial encoding of the plaintext: raw stored row is not the plain JSON of the conversation (at-rest-encryption)', async () => {
    const conv = baseConversation();
    const api = await freshConversationsModule('c1enc003');
    expect(await api.createConversation(conv)).toBe(true);

    const rows = (await rawRows(getStorageDbNames().conversations, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const rawJson = JSON.stringify(rows[0]);
    // The stored representation must differ from the plaintext row shape:
    // not the plain object, and not merely reordered keys of it.
    expect(rawJson).not.toBe(JSON.stringify(conv));
    // Sensitive string fields are absent as VALUES anywhere in the row.
    expect(rawJson).not.toContain(conv.title);
    expect(rawJson).not.toContain(conv.messages[0]!.content);
    expect(rawJson).not.toContain(conv.messages[1]!.content);

    // Envelope invariants (PC-08): the row is {id, createdAt, updatedAt, v:1,
    // e:{iv, ct}} with a 12-byte IV and a base64 ct whose DECODED bytes are
    // not a reversible trivial encoding of the plaintext row.
    const row = rows[0] as Record<string, unknown> & { e?: Record<string, unknown> };
    expect(row.v, 'envelope must carry the v:1 version marker').toBe(1);
    expect(row.e, 'envelope must carry an e object').toBeDefined();
    const ivB64 = String(row.e!['iv']);
    const ctB64 = String(row.e!['ct']);
    const ivBytes = Buffer.from(ivB64, 'base64');
    expect(ivBytes.length, 'AES-GCM IV must be exactly 12 bytes').toBe(12);
    const ctBytes = Buffer.from(ctB64, 'base64');
    expect(ctBytes.length, 'ciphertext must carry the full payload').toBeGreaterThan(32);
    const decoded = ctBytes.toString('utf8');
    expect(decoded, 'decoded ct must not be the plaintext JSON').not.toBe(JSON.stringify(conv));
    expect(decoded).not.toContain(TITLE_MARKER);
    expect(decoded).not.toContain(MSG1_MARKER);
    // A base64(JSON) "encryption" mutant stores reversible text; its decoded
    // bytes would parse back to the row object — require it NOT to parse to
    // anything carrying the plaintext title.
    let parses: unknown = undefined;
    try {
      parses = JSON.parse(decoded);
    } catch {
      parses = undefined;
    }
    expect((parses as { title?: unknown } | undefined)?.title, 'decoded ct must not expose the plaintext title').not.toBe(conv.title);
  });

  it('tampering is detected: a flipped ciphertext byte and swapped row envelopes both fail closed (at-rest-encryption)', async () => {
    const convA = baseConversation();
    const convB = { ...baseConversation(), id: 'conv-c1-002', title: `second ${TITLE2_MARKER}`, updatedAt: 1730000002000, createdAt: 1730000002000 };
    const api = await freshConversationsModule('c1enc004');
    const dbName = getStorageDbNames().conversations;
    expect(await api.createConversation(convA)).toBe(true);
    expect(await api.createConversation(convB)).toBe(true);

    // (1) flip one base64 payload char of convA's ct (keep it valid base64 by
    // replacing, not inserting) — the read must REJECT (auth failure), never
    // silently return tampered or plaintext data.
    const rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    const rowA = rows.find((r) => r.id === convA.id)! as Record<string, unknown> & { e: Record<string, unknown> };
    const tamperedCt = String(rowA.e['ct']);
    const flipIdx = tamperedCt.length - 5;
    const flipped = tamperedCt[flipIdx] === 'A' ? `${tamperedCt.slice(0, flipIdx)}B${tamperedCt.slice(flipIdx + 1)}` : `${tamperedCt.slice(0, flipIdx)}A${tamperedCt.slice(flipIdx + 1)}`;
    const tamperedRow = { ...rowA, e: { ...rowA.e, ct: flipped } };
    await rawPut(dbName, 'conversations', [tamperedRow]);
    await expect(api.getConversation(convA.id)).rejects.toThrow();

    // (2) swap the e envelopes between the two rows (ids/index fields stay) —
    // AAD binding must make BOTH reads reject.
    const rows2 = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    const freshA = rows2.find((r) => r.id === convA.id)! as Record<string, unknown> & { e: Record<string, unknown> };
    const freshB = rows2.find((r) => r.id === convB.id)! as Record<string, unknown> & { e: Record<string, unknown> };
    await rawPut(dbName, 'conversations', [
      { ...freshA, e: freshB.e },
      { ...freshB, e: freshA.e },
    ]);
    await expect(api.getConversation(convA.id)).rejects.toThrow();
    await expect(api.getConversation(convB.id)).rejects.toThrow();
  });
});
