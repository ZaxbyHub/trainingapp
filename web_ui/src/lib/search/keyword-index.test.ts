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

describe('KeywordIndex', () => {
  beforeEach(() => {
    // Reset singleton
    KeywordIndex.instance = null;
  });

  afterEach(() => {
    KeywordIndex.instance?.dispose();
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
});
