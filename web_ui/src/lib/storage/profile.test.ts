/**
 * Tests for the stable profile namespace helper (F1).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getProfilePrefix,
  getStorageDbNames,
  migrateOrphanedNamespaces,
  listStalePrefixes,
} from './profile';

describe('profile (F1 stable namespace)', () => {
  let mockLocalStorage: Record<string, string>;

  beforeEach(() => {
    mockLocalStorage = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => mockLocalStorage[key] ?? null,
        setItem: (key: string, value: string) => { mockLocalStorage[key] = value; },
        removeItem: (key: string) => { delete mockLocalStorage[key]; },
      },
      writable: true,
      configurable: true,
    });
  });

  describe('getProfilePrefix', () => {
    it('mints a lowercase-alphanumeric prefix on first read', () => {
      const prefix = getProfilePrefix();
      expect(prefix).toMatch(/^[a-z0-9]+$/);
      expect(prefix).toBe(getProfilePrefix()); // stable
    });

    it('persists the prefix in localStorage so it survives across sessions', () => {
      const prefix = getProfilePrefix();
      expect(mockLocalStorage['doc-qa-profile-id']).toBe(prefix);
    });

    it('returns the existing prefix when one is already persisted', () => {
      mockLocalStorage['doc-qa-profile-id'] = 'deadbeef';
      expect(getProfilePrefix()).toBe('deadbeef');
    });

    it('returns "anon" when localStorage is unavailable', () => {
      Object.defineProperty(globalThis, 'localStorage', { value: undefined, writable: true, configurable: true });
      expect(getProfilePrefix()).toBe('anon');
    });

    it('re-mints when the stored value is malformed', () => {
      mockLocalStorage['doc-qa-profile-id'] = 'has UPPERCASE and spaces';
      const prefix = getProfilePrefix();
      expect(prefix).toMatch(/^[a-z0-9]+$/);
      expect(prefix).not.toBe('has UPPERCASE and spaces');
    });
  });

  describe('getStorageDbNames', () => {
    it('derives all four names from the same prefix', () => {
      mockLocalStorage['doc-qa-profile-id'] = 'abc12345';
      const names = getStorageDbNames();
      expect(names.documents).toBe('abc12345-doc-qa-documents');
      expect(names.vectorMapping).toBe('abc12345-doc-qa-indexes');
      expect(names.vector).toBe('abc12345-doc-qa-index');
      expect(names.keyword).toBe('abc12345-doc-qa-keywords');
    });
  });

  describe('migrateOrphanedNamespaces', () => {
    it('is a no-op when indexedDB.databases() is unavailable (Firefox/Safari) and does NOT set the migration flag', async () => {
      // No indexedDB.databases() function present.
      await migrateOrphanedNamespaces();
      expect(mockLocalStorage['doc-qa-profile-migrated']).toBeUndefined();
    });

    it('sets the migration flag when the enumeration API is available and there are no orphans', async () => {
      const databases = vi.fn(async () => [
        { name: `${getProfilePrefix()}-doc-qa-documents` }, // only the current profile
      ]);
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { databases },
        writable: true,
        configurable: true,
      });
      await migrateOrphanedNamespaces();
      expect(mockLocalStorage['doc-qa-profile-migrated']).toBe('1');
    });

    it('does not re-run after the migration flag is set', async () => {
      mockLocalStorage['doc-qa-profile-migrated'] = '1';
      const databases = vi.fn(async () => [] as Array<{ name?: string }>);
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { databases },
        writable: true,
        configurable: true,
      });
      await migrateOrphanedNamespaces();
      expect(databases).not.toHaveBeenCalled();
    });

    it('never throws even if the enumeration API rejects', async () => {
      const databases = vi.fn(async () => {
        throw new Error('boom');
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { databases },
        writable: true,
        configurable: true,
      });
      await expect(migrateOrphanedNamespaces()).resolves.toBeUndefined();
    });

    it('PRR-003/PRR-002: copies orphan documents into the current namespace and sets the re-index flag', async () => {
      // Minimal fake IndexedDB. Request handlers (onsuccess/oncomplete) are
      // invoked on the next macrotask via a setter so they fire AFTER the caller
      // attaches them (mirroring real IDB async semantics).
      const current = getProfilePrefix();
      const orphanPrefix = 'oldold01';
      const orphanDocs = [
        { id: 'doc-a', fileName: 'a.pdf', status: 'ready' },
        { id: 'doc-b', fileName: 'b.pdf', status: 'ready' },
      ];

      // dbName → { storeName → record[] }. Orphan documents store pre-seeded.
      const dbStore: Record<string, Record<string, Array<Record<string, unknown>>>> = {
        [`${orphanPrefix}-doc-qa-documents`]: { documents: [...orphanDocs] },
        [`${orphanPrefix}-doc-qa-keywords`]: { 'keyword-index': [{ key: 'data', entries: [], documentChunks: {} }] },
      };

      const databases = vi.fn(async () => [
        { name: `${orphanPrefix}-doc-qa-documents` },
        { name: `${orphanPrefix}-doc-qa-keywords` },
        { name: `${current}-doc-qa-documents` },
      ]);

      // Helper: an IDBRequest-like object whose `onsuccess` fires next tick.
      function makeRequest(fire: (r: any) => void): any {
        const r: any = { result: undefined, onsuccess: null, onerror: null };
        setTimeout(() => {
          fire(r);
          if (typeof r.onsuccess === 'function') r.onsuccess();
        }, 0);
        return r;
      }

      function open(dbName: string): any {
        const stores = (dbStore[dbName] ?? (dbStore[dbName] = {}));
        const req: any = {
          result: undefined,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
        };
        const buildResult = () => ({
          objectStoreNames: { contains: (n: string) => Object.keys(stores).includes(n) },
          close: vi.fn(),
          createObjectStore: (n: string) => {
            if (!stores[n]) stores[n] = [];
            return {};
          },
          transaction: (storeName: string, _mode: string) => {
            const bucket = stores[storeName] ?? (stores[storeName] = []);
            const tx: any = { oncomplete: null, onerror: null };
            tx.objectStore = () => ({
              getAll: () => makeRequest((r: any) => { r.result = [...bucket]; }),
              get: (_key: string) => makeRequest((r: any) => { r.result = null; }),
              put: (rec: Record<string, unknown>) => {
                bucket.push(rec);
                return makeRequest(() => {});
              },
            });
            setTimeout(() => {
              if (typeof tx.oncomplete === 'function') tx.oncomplete();
            }, 0);
            return tx;
          },
        });
        setTimeout(() => {
          // Real IDB fires onupgradeneeded (creating stores) when the DB/store
          // is new, then onsuccess. mergeIntoStore opens at version 1; the
          // target documents DB is fresh, so simulate the upgrade.
          if (typeof req.onupgradeneeded === 'function') {
            req.result = buildResult();
            req.onupgradeneeded({ target: { result: req.result, oldVersion: 0 } });
          }
          req.result = buildResult();
          if (typeof req.onsuccess === 'function') req.onsuccess();
        }, 0);
        return req;
      }

      Object.defineProperty(globalThis, 'indexedDB', {
        value: { databases, open: vi.fn((name: string) => open(name)) },
        writable: true,
        configurable: true,
      });

      await migrateOrphanedNamespaces();

      // The orphan documents were copied into the current profile's documents DB.
      const targetDocs = dbStore[`${current}-doc-qa-documents`]?.documents ?? [];
      expect(targetDocs.some((d) => d.id === 'doc-a')).toBe(true);
      expect(targetDocs.some((d) => d.id === 'doc-b')).toBe(true);

      // PRR-002: the re-index flag is set because the vector index can't be copied.
      expect(mockLocalStorage['rag-reindex-required']).toBe('1');

      // Migration marked complete.
      expect(mockLocalStorage['doc-qa-profile-migrated']).toBe('1');
    });
  });

  describe('listStalePrefixes', () => {
    it('returns [] when the enumeration API is unavailable', async () => {
      Object.defineProperty(globalThis, 'indexedDB', { value: {}, writable: true, configurable: true });
      expect(await listStalePrefixes()).toEqual([]);
    });

    it('returns only prefixes that are not the current profile', async () => {
      const current = getProfilePrefix();
      const databases = vi.fn(async () => [
        { name: `${current}-doc-qa-documents` },
        { name: 'orphan01-doc-qa-documents' },
        { name: 'orphan02-doc-qa-keywords' },
      ]);
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { databases },
        writable: true,
        configurable: true,
      });
      const stale = await listStalePrefixes();
      expect(stale).toContain('orphan01');
      expect(stale).toContain('orphan02');
      expect(stale).not.toContain(current);
    });
  });
});
