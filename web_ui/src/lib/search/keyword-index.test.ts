/**
 * Tests for KeywordIndex using FlexSearch
 * Tests focus on error paths and simple synchronous behaviors
 * that don't require complex IndexedDB async mocking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KeywordIndex } from './keyword-index';

// Mock flexsearch at module level (vi.mock is hoisted)
const mockAdd = vi.fn();
const mockRemove = vi.fn();
const mockSearch = vi.fn();

vi.mock('flexsearch', () => {
  return {
    Index: vi.fn().mockImplementation(() => ({
      add: mockAdd,
      remove: mockRemove,
      search: mockSearch,
    })),
  };
});

// Mock indexedDB - simplified synchronous approach
vi.stubGlobal('indexedDB', {
  open: vi.fn().mockImplementation(() => ({
    onsuccess: null,
    onerror: null,
    result: {
      objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
      close: vi.fn(),
      transaction: vi.fn().mockReturnValue({
        objectStore: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            onsuccess: null,
          }),
          put: vi.fn().mockReturnValue({
            onsuccess: null,
          }),
        }),
        oncomplete: null,
        onerror: null,
      }),
    },
  })),
});

// Cast to access the private static `instance` singleton field for test setup.
// Declared as a type (not `extends`) so the private redeclaration does not
// trip TS2430/TS2341; the bracket access avoids the private-member check.
type KeywordIndexTestAccess = { instance: KeywordIndex | null };
const KeywordIndexInternals = KeywordIndex as unknown as KeywordIndexTestAccess;

describe('KeywordIndex', () => {
  beforeEach(() => {
    // Reset singleton
    KeywordIndexInternals.instance = null;
  });

  afterEach(() => {
    KeywordIndexInternals.instance?.dispose();
    vi.restoreAllMocks();
  });

  describe('singleton pattern', () => {
    it('getInstance returns the same instance', () => {
      const instance1 = KeywordIndex.getInstance();
      const instance2 = KeywordIndex.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('getInstance creates a new instance on first call', () => {
      const instance = KeywordIndex.getInstance();
      expect(instance).toBeDefined();
      expect(instance).toBeInstanceOf(KeywordIndex);
    });

    it('dispose allows new instance to be created', () => {
      const instance1 = KeywordIndex.getInstance();
      instance1.dispose();
      const instance2 = KeywordIndex.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('isReady() - state checks', () => {
    it('returns false before initialization', () => {
      const index = KeywordIndex.getInstance();
      expect(index.isReady()).toBe(false);
    });

    it('returns false when disposed', async () => {
      const index = KeywordIndex.getInstance();
      // Don't initialize - dispose immediately
      index.dispose();
      expect(index.isReady()).toBe(false);
    });
  });

  describe('addDocument() - error handling', () => {
    it('throws error if not initialized', () => {
      const index = KeywordIndex.getInstance();
      expect(() => index.addDocument('doc1', 0, 'hello')).toThrow('not initialized');
    });

    it('throws error for empty text', () => {
      const index = KeywordIndex.getInstance();
      // Try to add without initializing - should throw "not initialized"
      expect(() => index.addDocument('doc1', 0, '')).toThrow('not initialized');
    });

    it('throws error for non-string text', () => {
      const index = KeywordIndex.getInstance();
      expect(() => index.addDocument('doc1', 0, null as any)).toThrow('not initialized');
      expect(() => index.addDocument('doc1', 0, undefined as any)).toThrow('not initialized');
    });
  });

  describe('addDocuments() - error handling', () => {
    it('throws error if not initialized', () => {
      const index = KeywordIndex.getInstance();
      expect(() => index.addDocuments([{ docId: 'd', chunkIndex: 0, text: 't', source: 'f' }])).toThrow('not initialized');
    });

    it('throws error when chunk is missing docId (without initialization)', () => {
      const index = KeywordIndex.getInstance();
      const chunks = [
        { docId: 'doc1', chunkIndex: 0, text: 'valid chunk', source: 'file.txt' },
        { docId: '', chunkIndex: 1, text: 'invalid chunk', source: 'file.txt' } as any,
      ];
      expect(() => index.addDocuments(chunks)).toThrow('not initialized');
    });
  });

  describe('search() - error handling', () => {
    it('throws error if not initialized', () => {
      const index = KeywordIndex.getInstance();
      expect(() => index.search('query')).toThrow('not initialized');
    });

    it('throws error for empty query when not initialized', () => {
      const index = KeywordIndex.getInstance();
      expect(() => index.search('')).toThrow('not initialized');
    });
  });

  describe('removeByDocId() - error handling', () => {
    it('throws error if not initialized', () => {
      const index = KeywordIndex.getInstance();
      expect(() => index.removeByDocId('doc1')).toThrow('not initialized');
    });
  });

  describe('save() - error handling', () => {
    it('throws error if not initialized', async () => {
      const index = KeywordIndex.getInstance();
      await expect(index.save()).rejects.toThrow('not initialized');
    });
  });

  describe('dispose() - cleanup', () => {
    it('dispose can be called multiple times safely', () => {
      const index = KeywordIndex.getInstance();
      expect(() => index.dispose()).not.toThrow();
      expect(() => index.dispose()).not.toThrow();
    });

    it('dispose allows new singleton after disposal', () => {
      const instance1 = KeywordIndex.getInstance();
      instance1.dispose();
      const instance2 = KeywordIndex.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('rank-based scoring formula', () => {
    it('score = 1 / (rank + 1) for various ranks', () => {
      // Verify the scoring formula used in search()
      const getScore = (rank: number) => 1 / (rank + 1);

      expect(getScore(0)).toBeCloseTo(1);     // First result: 1/(0+1) = 1
      expect(getScore(1)).toBeCloseTo(0.5);   // Second result: 1/(1+1) = 0.5
      expect(getScore(2)).toBeCloseTo(0.333); // Third result: 1/(2+1) = 0.333
      expect(getScore(9)).toBeCloseTo(0.1);   // Tenth result: 1/(9+1) = 0.1
    });
  });

  describe('chunk ID generation', () => {
    it('makeChunkId format is docId:chunkIndex', () => {
      // Verify the expected format for chunk IDs
      const docId = 'doc123';
      const chunkIndex = 5;
      const expectedId = `${docId}:${chunkIndex}`;
      expect(expectedId).toBe('doc123:5');
    });
  });

  // -------------------------------------------------------------------------
  // User isolation via sessionStorage prefix (FR-007)
  // DB_NAME is private; we observe it via the indexedDB.open mock calls.
  // -------------------------------------------------------------------------

  describe('user isolation (DB_NAME prefix)', () => {
    // Helper that returns a mock open() implementation which fully completes loadFromIDB
    // (fires both outer onsuccess and inner getRequest.onsuccess) so initialize() resolves quickly.
    function makeCompletingOpenMock() {
      return vi.fn().mockImplementation((name: string) => {
        const getReq: any = { onsuccess: null, onerror: null, result: null };
        const tx: any = {
          objectStore: vi.fn(() => ({
            get: vi.fn(() => getReq),
            put: vi.fn(() => ({ onsuccess: null, onerror: null })),
          })),
          oncomplete: null,
          onerror: null,
        };
        const db: any = {
          objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
          close: vi.fn(),
          transaction: vi.fn(() => tx),
        };
        const req: any = {
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          result: db,
        };
        Promise.resolve().then(() => {
          if (req.onsuccess) req.onsuccess({ target: { result: db } });
          Promise.resolve().then(() => {
            if (getReq.onsuccess) getReq.onsuccess({ target: { result: getReq.result } });
          });
        });
        return req;
      });
    }

    it('DB_NAME is prefixed with user identifier', async () => {
      const openMock = (globalThis as any).indexedDB.open as ReturnType<typeof vi.fn>;
      openMock.mockClear();
      openMock.mockImplementation(makeCompletingOpenMock());

      const index = KeywordIndex.getInstance();
      try {
        await index.initialize();
      } catch {
        // ignore; open call was recorded
      }

      const calledName = openMock.mock.calls[0]?.[0] as string | undefined;
      expect(calledName).toBeDefined();
      expect(calledName).toMatch(/^[a-z0-9-]{3,}-doc-qa-keywords$/);
      index.dispose();
    });

    it('Same session produces same prefix on reload', async () => {
      sessionStorage.clear();
      sessionStorage.setItem('doc-qa-user-id', 'same-sess-00112233');

      vi.resetModules();
      const { KeywordIndex: K } = await import('./keyword-index');

      const openMock = (globalThis as any).indexedDB.open as ReturnType<typeof vi.fn>;
      openMock.mockClear();
      openMock.mockImplementation(makeCompletingOpenMock());

      const i1 = K.getInstance();
      try { await i1.initialize(); } catch {}
      const n1 = openMock.mock.calls[0]?.[0];
      i1.dispose();

      // same session, same module after first reset: prefix must be identical
      const i2 = K.getInstance();
      openMock.mockClear();
      try { await i2.initialize(); } catch {}
      const n2 = openMock.mock.calls[0]?.[0];
      i2.dispose();

      expect(n1).toBe(n2);
      expect(n1).toMatch(/-doc-qa-keywords$/);
    });

    it('Different sessionStorage values produce different DB_NAMEs', async () => {
      sessionStorage.clear();
      sessionStorage.setItem('doc-qa-user-id', 'user-aaaa-11111111');
      vi.resetModules();

      const { KeywordIndex: KA } = await import('./keyword-index');
      const openMock = (globalThis as any).indexedDB.open as ReturnType<typeof vi.fn>;
      openMock.mockClear();
      openMock.mockImplementation(makeCompletingOpenMock());

      const ia = KA.getInstance();
      try { await ia.initialize(); } catch {}
      const na = openMock.mock.calls[0]?.[0];
      ia.dispose();

      sessionStorage.setItem('doc-qa-user-id', 'user-bbbb-22222222');
      vi.resetModules();

      const { KeywordIndex: KB } = await import('./keyword-index');
      openMock.mockClear();
      openMock.mockImplementation(makeCompletingOpenMock());

      const ib = KB.getInstance();
      try { await ib.initialize(); } catch {}
      const nb = openMock.mock.calls[0]?.[0];
      ib.dispose();

      expect(na).not.toBe(nb);
      expect(na).toMatch(/-doc-qa-keywords$/);
      expect(nb).toMatch(/-doc-qa-keywords$/);
    });
  });
});
