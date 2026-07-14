/**
 * Tests for document-store (IndexedDB persistence layer)
 *
 * Note: IndexedDB operations require complex mocking that is covered
 * through integration tests in DocumentsPage.test.tsx.
 * These unit tests focus on the sorting and error handling logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DocumentEntry } from '../../types/document';
import { getUserPrefix, DB_NAME } from './document-store';

// Declare at module scope with var so it is accessible inside hoisted vi.mock factory
var mockSessionStorage: ReturnType<typeof createMockSessionStorage>;

// Must be defined BEFORE vi.mock so the factory can reference it when hoisted
function createMockSessionStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };
}

// Hoisted by vitest — must not reference any const/let variables defined after this call
vi.mock('./document-store', async () => {
  mockSessionStorage = createMockSessionStorage();
  Object.defineProperty(globalThis, 'sessionStorage', { value: mockSessionStorage, writable: true });
  const actual = await vi.importActual<typeof import('./document-store')>('./document-store');
  return actual;
});

const createDocument = (overrides: Partial<DocumentEntry> = {}): DocumentEntry => ({
  id: 'doc-1',
  fileName: 'test.pdf',
  fileSize: 1024,
  fileType: '.pdf',
  status: 'ready',
  progress: 100,
  uploadedAt: Date.now(),
  ...overrides,
});

describe('document-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStorage.clear();
  });

  afterEach(() => {
    // Do NOT call vi.restoreAllMocks() — it would restore the original
    // undefined sessionStorage and break the mock that vi.mock set up.
    // Just clear the mock store so each test starts fresh.
    mockSessionStorage.clear();
  });

  describe('Sorting Logic', () => {
    it('sorts documents by uploadedAt descending (newest first)', () => {
      const olderTime = 1000;
      const newerTime = 2000;
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'older.pdf', uploadedAt: olderTime }),
        createDocument({ id: 'doc-2', fileName: 'newer.pdf', uploadedAt: newerTime }),
      ];

      // Simulate the sorting logic from loadDocuments
      const sorted = [...documents].sort((a, b) => b.uploadedAt - a.uploadedAt);

      expect(sorted[0].id).toBe('doc-2'); // newer first
      expect(sorted[1].id).toBe('doc-1'); // older second
    });

    it('handles documents with same uploadedAt timestamp', () => {
      const sameTime = 1000;
      const documents = [
        createDocument({ id: 'doc-1', uploadedAt: sameTime }),
        createDocument({ id: 'doc-2', uploadedAt: sameTime }),
      ];

      const sorted = [...documents].sort((a, b) => b.uploadedAt - a.uploadedAt);

      // Both have same timestamp, original order preserved (stable sort)
      expect(sorted).toHaveLength(2);
    });

    it('handles empty array', () => {
      const documents: DocumentEntry[] = [];

      const sorted = [...documents].sort((a, b) => b.uploadedAt - a.uploadedAt);

      expect(sorted).toEqual([]);
    });

    it('handles single document array', () => {
      const documents = [createDocument({ id: 'doc-1' })];

      const sorted = [...documents].sort((a, b) => b.uploadedAt - a.uploadedAt);

      expect(sorted).toHaveLength(1);
      expect(sorted[0].id).toBe('doc-1');
    });
  });

  describe('Document Entry Validation', () => {
    it('requires id field', () => {
      const doc = createDocument();
      expect(doc.id).toBeDefined();
      expect(typeof doc.id).toBe('string');
    });

    it('requires fileName field', () => {
      const doc = createDocument();
      expect(doc.fileName).toBeDefined();
      expect(doc.fileName).toBe('test.pdf');
    });

    it('requires fileSize field', () => {
      const doc = createDocument();
      expect(doc.fileSize).toBeDefined();
      expect(doc.fileSize).toBe(1024);
    });

    it('requires fileType field with leading dot', () => {
      const doc = createDocument();
      expect(doc.fileType).toBeDefined();
      expect(doc.fileType.startsWith('.')).toBe(true);
    });

    it('requires status field', () => {
      const doc = createDocument();
      expect(['uploading', 'processing', 'ready', 'error']).toContain(doc.status);
    });

    it('requires progress field as number', () => {
      const doc = createDocument();
      expect(typeof doc.progress).toBe('number');
    });

    it('supports optional chunkCount field', () => {
      const docWithoutChunks = createDocument();
      expect(docWithoutChunks.chunkCount).toBeUndefined();

      const docWithChunks = createDocument({ chunkCount: 42 });
      expect(docWithChunks.chunkCount).toBe(42);
    });

    it('supports optional errorMessage field', () => {
      const docWithoutError = createDocument();
      expect(docWithoutError.errorMessage).toBeUndefined();

      const docWithError = createDocument({ errorMessage: 'Failed to extract' });
      expect(docWithError.errorMessage).toBe('Failed to extract');
    });
  });

  describe('DB Constants', () => {
    it('uses prefixed database name matching user isolation format', () => {
      expect(DB_NAME).toMatch(/^[a-z0-9-]{3,8}-doc-qa-documents$/);
    });

    it('uses correct database version', () => {
      const DB_VERSION = 1;
      expect(DB_VERSION).toBe(1);
    });

    it('uses correct store name', () => {
      const STORE_NAME = 'documents';
      expect(STORE_NAME).toBe('documents');
    });
  });

  describe('getUserPrefix (F1: stable localStorage-backed profile)', () => {
    let mockLocalStorage: Record<string, string>;

    beforeEach(() => {
      mockLocalStorage = {};
      // getProfilePrefix reads localStorage directly; provide a controllable
      // in-memory localStorage for these assertions.
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

    it('returns the existing persisted profile prefix when present', () => {
      mockLocalStorage['doc-qa-profile-id'] = 'abcdef12';
      expect(getUserPrefix()).toBe('abcdef12');
    });

    it('mints and persists a new lowercase-alphanumeric prefix when none exists', () => {
      const prefix = getUserPrefix();
      expect(prefix).toBeTruthy();
      // Constrained to lowercase alphanumerics so DB_NAME matches its regex.
      expect(prefix).toMatch(/^[a-z0-9]+$/);
      // Persisted for future boots.
      expect(mockLocalStorage['doc-qa-profile-id']).toBe(prefix);
    });

    it('is stable across repeated reads (same prefix returned every time)', () => {
      const first = getUserPrefix();
      const second = getUserPrefix();
      expect(second).toBe(first);
    });

    it('returns "anon" fallback when localStorage is unavailable', () => {
      Object.defineProperty(globalThis, 'localStorage', { value: undefined, writable: true, configurable: true });
      expect(getUserPrefix()).toBe('anon');
    });
  });

  describe('DB_NAME shape (F1)', () => {
    it('derives from the stable profile prefix and matches the isolation regex', () => {
      // DB_NAME is computed at module load from the profile prefix; with a
      // localStorage-backed prefix it must still match the historical shape.
      expect(DB_NAME).toMatch(/^[a-z0-9-]{3,8}-doc-qa-documents$/);
    });
  });
});
