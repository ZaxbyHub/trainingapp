/**
 * Clear Cache tests — issue #24 F1.
 *
 * Originally (PR #28) this file only asserted the three WebLLM Cache Storage
 * `caches.delete(...)` calls. Issue #24 F1 rebuilt Clear Cache to also delete
 * the real user-prefixed IndexedDB databases via PR-4's `deleteNamespace` /
 * `listStalePrefixes` (from `lib/storage/profile`) and the EdgeVec HNSW blob
 * from the shared `edgevec-db`. These tests cover the full deletion path.
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import * as inferenceModule from '../lib/inference';
import * as themeModule from '../lib/theme';

const deleteNamespaceMock = vi.fn((_prefix: string) => Promise.resolve());
const listStalePrefixesMock = vi.fn((): Promise<string[]> => Promise.resolve([]));
const getProfilePrefixMock = vi.fn(() => 'testprfx');

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../lib/theme', () => ({
  useTheme: vi.fn(),
}));

// browser-training-parity: the browser app's Clear Cache also removes the
// installed packs and releases the player-origin worker, each its own step.
// Pass-through stubs by default; one test makes the packs step fail.
const packsClearAllMock = vi.fn((): Promise<void> => Promise.resolve());
const releaseBrowserTrainingMock = vi.fn((): Promise<void> => Promise.resolve());

vi.mock('../lib/packs/browser-pack-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/packs/browser-pack-manager')>();
  return {
    ...actual,
    getBrowserPackManager: () => ({ clearAll: () => packsClearAllMock() }),
  };
});

vi.mock('../lib/packs/browser-training', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/packs/browser-training')>();
  return { ...actual, releaseBrowserTrainingIfEmpty: () => releaseBrowserTrainingMock() };
});

vi.mock('../lib/storage/profile', () => ({
  getProfilePrefix: () => getProfilePrefixMock(),
  deleteNamespace: (prefix: string) => deleteNamespaceMock(prefix),
  listStalePrefixes: () => listStalePrefixesMock(),
}));

const mockModelReadinessGateInstance = {
  checkModelCached: vi.fn(() => Promise.resolve(false)),
};

vi.mock('../lib/llm/model-download', () => ({
  ModelDownloadManager: vi.fn().mockImplementation(() => ({
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
  })),
}));

vi.mock('../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn().mockImplementation(() => mockModelReadinessGateInstance),
}));

vi.mock('../lib/embeddings/memory-aware', () => ({
  getMemoryBudget: vi.fn(() => ({ availableMB: 8192, totalMB: 16384 })),
  getMemoryPressureStatus: vi.fn(() => 'normal'),
}));

vi.mock('../components/ModelDownloadProgress', () => ({
  ModelDownloadProgress: () => null,
}));

// IndexedDB mock — same shape as SettingsPage.test.tsx's, since
// handleClearCacheClick calls indexedDB.open(...) and deleteDatabase(...).
const mockObjectStore = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

const mockTransaction = {
  objectStore: vi.fn(() => mockObjectStore),
  oncomplete: null as ((e: Event) => void) | null,
  onerror: null as ((e: Event) => void) | null,
  abort: vi.fn(),
};

/**
 * Schedule the transaction's oncomplete to fire after a write operation
 * (put/delete) is issued — mirrors real IDB where the transaction commits
 * after all operations complete. Called from put/delete mock implementations
 * in beforeEach.
 */
function scheduleOnComplete() {
  setTimeout(() => {
    if (mockTransaction.oncomplete) {
      mockTransaction.oncomplete.call(mockTransaction, new Event('complete'));
    }
  }, 0);
}

const mockDB = {
  transaction: vi.fn(() => mockTransaction),
  objectStoreNames: {
    contains: vi.fn(() => true),
  },
  createObjectStore: vi.fn(),
  close: vi.fn(),
};

function createIDBRequest() {
  const request: Record<string, unknown> = {
    onsuccess: null,
    onerror: null,
    result: null,
  };
  return request as unknown as IDBRequest;
}

global.indexedDB = {
  open: vi.fn((_name: string, _version: number) => {
    const req = createIDBRequest();
    (req as unknown as Record<string, unknown>).result = mockDB;
    setTimeout(() => {
      const onsuccess = (req as unknown as Record<string, (e: Event) => void>).onsuccess;
      if (onsuccess) onsuccess.call(req, new Event('success'));
    }, 0);
    return req as unknown as IDBOpenDBRequest;
  }),
  deleteDatabase: vi.fn(() => {
    const req = createIDBRequest();
    setTimeout(() => {
      const onsuccess = (req as unknown as Record<string, (e: Event) => void>).onsuccess;
      if (onsuccess) onsuccess.call(req, new Event('success'));
    }, 0);
    return req as unknown as IDBOpenDBRequest;
  }),
} as unknown as IDBDatabase & typeof globalThis.indexedDB;

// Import after mocks, matching SettingsPage.test.tsx's convention.
import { RELOAD_AFTER_CLEAR_MS, SettingsPage } from './SettingsPage';
import { INTERNAL_KEYS, USER_SETTING_KEYS } from '../lib/storage/persisted-keys';

/** The always-mounted Clear Cache live region (PR #140 review FB140-002). */
function clearStatusRegion(): HTMLElement | null {
  return document.getElementById('clear-cache-status');
}

/**
 * Under fake timers (installed after the page is ready): step the clock 1 ms
 * at a time until the clear finishes. The handler schedules the reload in
 * the same turn it sets the final status, so on return the reload timer was
 * scheduled at the current fake time.
 */
async function stepUntilSettled(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const text = document.body.textContent ?? '';
    if (/cache cleared|could not clear all data/i.test(text)) return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
  throw new Error(`Clear Cache never settled; status: ${clearStatusRegion()?.textContent ?? '<no region>'}`);
}

/** Render, wait for the Storage section with REAL timers, then switch to fake ones. */
async function renderReadyWithFakeTimers(reloadPage: () => void): Promise<HTMLElement> {
  render(<SettingsPage reloadPage={reloadPage} />);
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
  });
  vi.useFakeTimers();
  return screen.getByRole('button', { name: /clear cache/i });
}

describe('SettingsPage — Clear Cache (issue #24 F1)', () => {
  beforeEach(() => {
    vi.mocked(inferenceModule.useInferenceMode).mockClear();
    vi.mocked(themeModule.useTheme).mockClear();
    mockModelReadinessGateInstance.checkModelCached.mockClear();
    mockModelReadinessGateInstance.checkModelCached.mockResolvedValue(false);
    mockObjectStore.get.mockClear();
    mockObjectStore.put.mockClear();
    mockObjectStore.delete.mockClear();
    deleteNamespaceMock.mockClear();
    packsClearAllMock.mockReset();
    packsClearAllMock.mockResolvedValue(undefined);
    releaseBrowserTrainingMock.mockReset();
    releaseBrowserTrainingMock.mockResolvedValue(undefined);
    listStalePrefixesMock.mockClear();
    getProfilePrefixMock.mockClear();
    getProfilePrefixMock.mockReturnValue('testprfx');

    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isServerConnected: false,
      isModelReady: false,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });

    // Updated mock shape (issue #24 F5): setTheme + themePreference, no toggleTheme.
    vi.mocked(themeModule.useTheme).mockReturnValue({
      theme: 'light',
      themePreference: 'system',
      setTheme: vi.fn(),
      isDark: false,
    });

    mockObjectStore.get.mockImplementation((_key) => {
      const req = createIDBRequest();
      setTimeout(() => {
        const onsuccess = (req as unknown as Record<string, (e: Event) => void>).onsuccess;
        if (onsuccess) onsuccess.call(req, new Event('success'));
      }, 0);
      return req as unknown as IDBRequest;
    });
    mockObjectStore.put.mockImplementation((_data) => {
      const req = createIDBRequest();
      setTimeout(() => {
        const onsuccess = (req as unknown as Record<string, (e: Event) => void>).onsuccess;
        if (onsuccess) onsuccess.call(req, new Event('success'));
      }, 0);
      scheduleOnComplete();
      return req as unknown as IDBRequest;
    });
    mockObjectStore.delete.mockImplementation((_key) => {
      const req = createIDBRequest();
      setTimeout(() => {
        const onsuccess = (req as unknown as Record<string, (e: Event) => void>).onsuccess;
        if (onsuccess) onsuccess.call(req, new Event('success'));
      }, 0);
      scheduleOnComplete();
      return req as unknown as IDBRequest;
    });
    mockTransaction.objectStore.mockReturnValue(mockObjectStore);

    // `caches` (Cache Storage API) isn't part of jsdom's global surface, so
    // without this stub `typeof caches !== 'undefined'` is false and the
    // handler's caches.delete(...) calls are silently skipped.
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('second Clear Cache click deletes the current profile namespace via deleteNamespace', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });

    // First click — confirm state, no deletion yet.
    fireEvent.click(clearButton);
    expect(screen.getByText('Click Again to Confirm')).toBeInTheDocument();
    expect(deleteNamespaceMock).not.toHaveBeenCalled();

    // Second click — actually clears.
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(deleteNamespaceMock).toHaveBeenCalledWith('testprfx');
    });
  });

  test('Clear Cache deletes the EdgeVec blob key from edgevec-db (PRR-008)', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    // The EdgeVec blob is stored as a key in the shared edgevec-db 'data'
    // store. Verify deleteEdgeVecBlob issued store.delete with the correct
    // profile-scoped key — this is the subtle PRR-008 fix that
    // deleteNamespace cannot reach.
    await waitFor(() => {
      expect(mockObjectStore.delete).toHaveBeenCalledWith('testprfx-doc-qa-index');
    });
  });

  test('second Clear Cache click deletes all three WebLLM Cache Storage entries', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });

    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(caches.delete).toHaveBeenCalledTimes(3);
    });
    expect(caches.delete).toHaveBeenCalledWith('webllm/model');
    expect(caches.delete).toHaveBeenCalledWith('webllm/config');
    expect(caches.delete).toHaveBeenCalledWith('webllm/wasm');
  });

  test('second Clear Cache click deletes the settings IndexedDB', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(indexedDB.deleteDatabase).toHaveBeenCalledWith('doc-qa-settings');
    });
  });

  test('Clear Cache does NOT delete the bare (non-prefixed) doc-qa-documents name', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(deleteNamespaceMock).toHaveBeenCalled();
    });

    // The old bug deleted 'doc-qa-documents' (no prefix). Verify the bare name
    // is never passed to deleteDatabase — only the profile-scoped deleteNamespace
    // path and the settings DB are used.
    const deleteCalls = (indexedDB.deleteDatabase as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(deleteCalls).not.toContain('doc-qa-documents');
  });

  test('shows "Cache cleared" result feedback after clearing', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(screen.getByText('Cache cleared')).toBeInTheDocument();
    });
  });

  test('confirmation text describes what will be deleted', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);

    // PRR-003: text mentions orphan cleanup from previous sessions.
    // settings-wiring-honesty (AC5): it lists exactly what is removed,
    // including the browser-stored settings.
    expect(
      screen.getByText(/this deletes the documents and keyword\/vector indexes stored in this browser/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/orphaned data from earlier sessions/i)
    ).toBeInTheDocument();
  });

  test('confirmation text names the course progress and last-opened course it removes (PRR-220)', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /clear cache/i }));

    expect(screen.getByText(/last-opened course, course progress/i)).toBeInTheDocument();
  });

  test('returns to idle after clearing', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(screen.queryByText('Click Again to Confirm')).not.toBeInTheDocument();
    });
  });

  // F-001: deleteNamespace rejection → "Could not clear all data"
  test('deleteNamespace rejection shows error feedback (F-001)', async () => {
    deleteNamespaceMock.mockRejectedValueOnce(new Error('IndexedDB quota exceeded'));

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(screen.getByText('Could not clear all data')).toBeInTheDocument();
    });
  });

  // F-002: caches.delete rejection does not abort the clear
  test('caches.delete rejection does not prevent the rest of clearing (F-002)', async () => {
    // One cache rejects, the others resolve. The .catch(() => {}) suppression
    // must swallow the rejection so clearing still completes.
    const cachesDeleteSpy = vi.fn((name: string) =>
      name === 'webllm/model'
        ? Promise.reject(new Error('Cache Storage quota'))
        : Promise.resolve(true)
    );
    vi.stubGlobal('caches', { delete: cachesDeleteSpy });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    // Despite one rejection, the clear succeeds (catch swallows it).
    await waitFor(() => {
      expect(screen.getByText('Cache cleared')).toBeInTheDocument();
    });
    expect(cachesDeleteSpy).toHaveBeenCalledTimes(3);
  });

  // F-003/PRR-002: deleteEdgeVecBlob rejection surfaces as error feedback
  test('EdgeVec blob deletion failure shows error feedback (F-003)', async () => {
    // Make the EdgeVec transaction error: mockDB.transaction will return
    // a transaction whose objectStore triggers an error. We simulate by
    // making the objectStore delete trigger tx.onerror.
    const errorTx = {
      objectStore: vi.fn(() => {
        // Schedule tx.onerror asynchronously (the store.delete call triggers it)
        setTimeout(() => {
          if (errorTx.onerror) errorTx.onerror.call(errorTx, new Event('error'));
        }, 0);
        return mockObjectStore;
      }),
      oncomplete: null as ((e: Event) => void) | null,
      onerror: null as ((e: Event) => void) | null,
      onabort: null as ((e: Event) => void) | null,
    };

    // Override mockDB.transaction to return the error tx for 'data' store
    // (edgevec) requests, while keeping the normal tx for settings.
    const originalTransaction = mockDB.transaction;
    mockDB.transaction = vi.fn((storeName: string) => {
      if (storeName === 'data') return errorTx;
      return mockTransaction;
    }) as typeof mockDB.transaction;

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(screen.getByText('Could not clear all data')).toBeInTheDocument();
    });

    // Restore.
    mockDB.transaction = originalTransaction;
  });

  // ADV-2: EdgeVec "data" store doesn't exist → clean resolve (not an error)
  test('EdgeVec blob deletion when data store is absent resolves cleanly (ADV-2)', async () => {
    // Temporarily make objectStoreNames.contains('data') return false so
    // deleteEdgeVecBlob takes the "no store → nothing to delete" path.
    const originalContains = mockDB.objectStoreNames.contains;
    mockDB.objectStoreNames.contains = vi.fn((name: string) => {
      // The settings DB does contain 'settings'; only 'data' is absent.
      return name !== 'data';
    }) as typeof mockDB.objectStoreNames.contains;

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    // Should still clear successfully (no EdgeVec store is not an error).
    await waitFor(() => {
      expect(screen.getByText('Cache cleared')).toBeInTheDocument();
    });

    mockDB.objectStoreNames.contains = originalContains;
  });

  describe('status announcement, reload timing and partial failure (PR #140 review)', () => {
    afterEach(() => {
      vi.useRealTimers();
      localStorage.clear();
    });

    // FB140-002: the live region exists BEFORE the click and only its text
    // changes — a region inserted together with its message is not reliably
    // announced.
    test('an always-mounted polite status region carries Clearing… then Cache cleared / Reloading', async () => {
      const reloadPage = vi.fn();
      const button = await renderReadyWithFakeTimers(reloadPage);
      const region = clearStatusRegion();
      expect(region).not.toBeNull();
      expect(region).toHaveAttribute('role', 'status');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region?.textContent).toBe('');

      fireEvent.click(button);
      fireEvent.click(button);
      await act(async () => {});
      expect(clearStatusRegion()).toBe(region);
      expect(region?.textContent).toMatch(/clearing/i);

      await stepUntilSettled();
      expect(clearStatusRegion()).toBe(region);
      expect(region?.textContent).toMatch(/cache cleared/i);
      expect(region?.textContent).toMatch(/reloading/i);
      // The visible badge text stays exactly "Cache cleared".
      expect(screen.getByText('Cache cleared')).toBe(region);
      // After a SUCCESSFUL clear the reload suffix is for screen readers only.
      expect(screen.getByText(/reloading the page/i)).toHaveClass('ui-visually-hidden');
    });

    // FB140-002: the reload waits long enough for the announcement, and
    // happens before the 3 s status reset would clear the message.
    test('reload fires exactly RELOAD_AFTER_CLEAR_MS after the status, not before', async () => {
      expect(RELOAD_AFTER_CLEAR_MS).toBeGreaterThanOrEqual(2000);
      expect(RELOAD_AFTER_CLEAR_MS).toBeLessThan(3000);
      const reloadPage = vi.fn();
      const button = await renderReadyWithFakeTimers(reloadPage);
      fireEvent.click(button);
      fireEvent.click(button);
      await stepUntilSettled();
      expect(reloadPage).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_AFTER_CLEAR_MS - 1);
      });
      expect(reloadPage).not.toHaveBeenCalled();
      expect(clearStatusRegion()?.textContent).toMatch(/cache cleared/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(reloadPage).toHaveBeenCalledTimes(1);
    });

    // FB140-011: one failed step (the EdgeVec delete) no longer skips the
    // rest: saved settings are still removed, the error is reported, and the
    // page reloads because the settings were cleared.
    test('an EdgeVec delete failure still clears saved settings, reports the error and reloads', async () => {
      for (const key of USER_SETTING_KEYS) localStorage.setItem(key, 'x');
      for (const key of INTERNAL_KEYS) localStorage.setItem(key, 'keep');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const errorTx = {
        objectStore: vi.fn(() => {
          setTimeout(() => {
            if (errorTx.onerror) errorTx.onerror.call(errorTx, new Event('error'));
          }, 0);
          return mockObjectStore;
        }),
        oncomplete: null as ((e: Event) => void) | null,
        onerror: null as ((e: Event) => void) | null,
        onabort: null as ((e: Event) => void) | null,
      };
      const originalTransaction = mockDB.transaction;
      mockDB.transaction = vi.fn((storeName: string) => (storeName === 'data' ? errorTx : mockTransaction)) as typeof mockDB.transaction;
      try {
        const reloadPage = vi.fn();
        const button = await renderReadyWithFakeTimers(reloadPage);
        fireEvent.click(button);
        fireEvent.click(button);
        await stepUntilSettled();

        expect(screen.getByText('Could not clear all data')).toBe(clearStatusRegion());
        // Stage B review (L2): sighted users also see why the page reloads.
        const note = screen.getByText(/your saved settings were removed; reloading the page/i);
        expect(clearStatusRegion()).toContainElement(note);
        // Lumen phase 4: screen-reader-only text is the ui-visually-hidden class, so
        // assert the class (an inline-style check would now pass vacuously).
        expect(note).not.toHaveClass('ui-visually-hidden');
        expect(note.closest('.ui-visually-hidden')).toBeNull();
        for (const key of USER_SETTING_KEYS) expect(localStorage.getItem(key)).toBeNull();
        for (const key of INTERNAL_KEYS) expect(localStorage.getItem(key)).toBe('keep');
        // The steps after the failed one still ran.
        expect(indexedDB.deleteDatabase).toHaveBeenCalledWith('doc-qa-settings');
        expect(caches.delete).toHaveBeenCalledWith('webllm/model');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(RELOAD_AFTER_CLEAR_MS);
        });
        expect(reloadPage).toHaveBeenCalledTimes(1);
      } finally {
        mockDB.transaction = originalTransaction;
      }
    });
  });

  // browser-training-parity composed onto FB140-011's per-step clear: the
  // browser app's installed-packs step is its own step — a failure there is
  // reported, the worker release still runs, the saved settings are still
  // removed and the page still reloads.
  describe('installed packs step (browser app, browser-training-parity)', () => {
    afterEach(() => {
      vi.useRealTimers();
      localStorage.clear();
    });

    test('a successful clear removes the installed packs and releases the course player worker', async () => {
      const reloadPage = vi.fn();
      const button = await renderReadyWithFakeTimers(reloadPage);
      fireEvent.click(button);
      fireEvent.click(button);
      await stepUntilSettled();
      expect(packsClearAllMock).toHaveBeenCalledTimes(1);
      expect(releaseBrowserTrainingMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Cache cleared')).toBe(clearStatusRegion());
    });

    test('a packs clear failure is reported, the worker release and settings removal still run, and the page reloads', async () => {
      for (const key of USER_SETTING_KEYS) localStorage.setItem(key, 'x');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      packsClearAllMock.mockRejectedValue(new Error('OPFS remove failed'));
      const reloadPage = vi.fn();
      const button = await renderReadyWithFakeTimers(reloadPage);
      fireEvent.click(button);
      fireEvent.click(button);
      await stepUntilSettled();

      expect(screen.getByText('Could not clear all data')).toBe(clearStatusRegion());
      expect(releaseBrowserTrainingMock).toHaveBeenCalledTimes(1);
      for (const key of USER_SETTING_KEYS) expect(localStorage.getItem(key)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_AFTER_CLEAR_MS);
      });
      expect(reloadPage).toHaveBeenCalledTimes(1);
    });
  });

  // ADV-3: stale prefix cleanup path (listStalePrefixes returns non-empty)
  test('Clear Cache deletes stale orphan namespaces (ADV-3)', async () => {
    listStalePrefixesMock.mockResolvedValueOnce(['orphan1', 'orphan2']);

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Storage & privacy' })).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    // deleteNamespace should be called for the current profile AND both orphans.
    await waitFor(() => {
      expect(deleteNamespaceMock).toHaveBeenCalledWith('orphan1');
      expect(deleteNamespaceMock).toHaveBeenCalledWith('orphan2');
    });
  });
});
