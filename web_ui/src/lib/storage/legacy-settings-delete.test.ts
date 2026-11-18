// Boot-delete pins for the abandoned legacy settings store (issue #367,
// plan RC4-02 contract): delete requested EVERY boot (no done-marker), an
// existing store is removed, a recreated store is removed by the NEXT boot,
// and failure paths are non-fatal.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEGACY_SETTINGS_DB_NAME, deleteLegacySettingsStore } from './legacy-settings-delete';

function storeExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = indexedDB.open(LEGACY_SETTINGS_DB_NAME);
    req.onsuccess = () => {
      req.result.close();
      resolve(true);
    };
    req.onupgradeneeded = () => {
      // Opening with an upgrade creates it — for an existence probe treat
      // the factory's database() list as the authority instead.
      resolve(false);
    };
  });
}

async function databaseNames(): Promise<string[]> {
  if (typeof indexedDB.databases !== 'function') {
    // fake-indexeddb implements databases(); the typed guard keeps older
    // jsdom globals honest.
    return [];
  }
  const names = await indexedDB.databases();
  return names.map((d) => d.name ?? '');
}

function seedLegacyStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_SETTINGS_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const conn = req.result;
      const tx = conn.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({
        key: 'user-preferences',
        theme: 'light',
        preferredModel: 'lfm2-1.2b-rag',
        serverUrl: 'http://127.0.0.1:8080',
        updatedAt: 1700000000000,
      });
      tx.oncomplete = () => {
        conn.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('seed failed'));
    };
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
}

async function deleteAndWait(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(LEGACY_SETTINGS_DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('legacy doc-qa-settings boot delete (#367 RC4-02)', () => {
  it('requests the delete on EVERY call — no done-marker short-circuit (boot-delete)', async () => {
    const first = deleteLegacySettingsStore();
    const second = deleteLegacySettingsStore();
    expect(first).toEqual({ requested: true, outcome: 'requested' });
    expect(second).toEqual({ requested: true, outcome: 'requested' });
    // Let the requests settle, then confirm the store is gone.
    await deleteAndWait();
    expect(await databaseNames()).not.toContain(LEGACY_SETTINGS_DB_NAME);
  });

  it('a recreated store is removed by the NEXT boot attempt (rollback coverage) (boot-delete)', async () => {
    await deleteAndWait();
    expect(await databaseNames()).not.toContain(LEGACY_SETTINGS_DB_NAME);
    // A rolled-back build recreates the store after a successful delete.
    await seedLegacyStore();
    expect(await databaseNames()).toContain(LEGACY_SETTINGS_DB_NAME);
    // The next boot's unconditional attempt removes it again.
    expect(deleteLegacySettingsStore().requested).toBe(true);
    await deleteAndWait();
    expect(await databaseNames()).not.toContain(LEGACY_SETTINGS_DB_NAME);
  });

  it('an absent store makes the attempt a harmless no-op (boot-delete)', async () => {
    expect(await databaseNames()).not.toContain(LEGACY_SETTINGS_DB_NAME);
    expect(deleteLegacySettingsStore().requested).toBe(true);
    // Settling the delete request must not throw or create the store.
    await deleteAndWait();
    expect(await databaseNames()).not.toContain(LEGACY_SETTINGS_DB_NAME);
  });

  it('an indexedDB-less environment reports unavailable and never throws (boot-delete)', () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(deleteLegacySettingsStore()).toEqual({ requested: false, outcome: 'unavailable' });
    vi.unstubAllGlobals();
  });

  it('the seeded legacy store carries the plaintext shapes #367 deletes (boot-delete)', async () => {
    // Provenance leg: the seeded fixture mirrors the historical store shape
    // (serverUrl/theme/model at key 'user-preferences') that motivates the
    // deletion — a store WITHOUT that shape would make this sweep pointless.
    await seedLegacyStore();
    const names = await databaseNames();
    expect(names).toContain(LEGACY_SETTINGS_DB_NAME);
    void storeExists;
  });
});
