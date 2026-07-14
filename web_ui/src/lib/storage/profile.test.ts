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
