/**
 * F-CLEAR-CACHE-OPFS CI-enforced coverage (PR #28 review, closeout critic
 * pass): SettingsPage.tsx's Clear Cache handler (`handleClearCacheClick`)
 * now also deletes the WebLLM Cache Storage entries (`webllm/model`,
 * `webllm/config`, `webllm/wasm`) in addition to the pre-existing
 * IndexedDB/OPFS cleanup. `SettingsPage.test.tsx` — the file that would
 * naturally cover this — is in vitest.config.ts's pre-existing exclude list
 * (unrelated flaky/drifted assertions, see that file's exclusion comment),
 * so this new Cache Storage deletion behavior had zero CI-enforced
 * regression protection. This file is deliberately narrow: it only exists to
 * exercise the Clear Cache -> caches.delete(...) path, reusing the mock
 * setup from the (excluded, but still valid as reference) SettingsPage.test.tsx.
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import * as inferenceModule from '../lib/inference';
import * as themeModule from '../lib/theme';

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../lib/theme', () => ({
  useTheme: vi.fn(),
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
// handleClearCacheClick also calls indexedDB.deleteDatabase(...).
const mockObjectStore = {
  get: vi.fn(),
  put: vi.fn(),
};

const mockTransaction = {
  objectStore: vi.fn(() => mockObjectStore),
};

const mockDB = {
  transaction: vi.fn(() => mockTransaction),
  objectStoreNames: {
    contains: vi.fn(() => true),
  },
  createObjectStore: vi.fn(),
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
    return req as unknown as IDBRequest;
  }),
  deleteDatabase: vi.fn(() => ({ onsuccess: null, onerror: null })),
} as unknown as IDBDatabase & typeof globalThis.indexedDB;

// Import after mocks, matching SettingsPage.test.tsx's convention.
import { SettingsPage } from './SettingsPage';

describe('SettingsPage — Clear Cache deletes WebLLM Cache Storage entries (F-CLEAR-CACHE-OPFS)', () => {
  beforeEach(() => {
    vi.mocked(inferenceModule.useInferenceMode).mockClear();
    vi.mocked(themeModule.useTheme).mockClear();
    mockModelReadinessGateInstance.checkModelCached.mockClear();
    mockModelReadinessGateInstance.checkModelCached.mockResolvedValue(false);
    mockObjectStore.get.mockClear();
    mockObjectStore.put.mockClear();

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
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });

    vi.mocked(themeModule.useTheme).mockReturnValue({
      theme: 'light',
      toggleTheme: vi.fn(),
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
      return req as unknown as IDBRequest;
    });
    mockTransaction.objectStore.mockReturnValue(mockObjectStore);

    // `caches` (Cache Storage API) isn't part of jsdom's global surface, so
    // without this stub `typeof caches !== 'undefined'` is false and the
    // handler's caches.delete(...) calls are silently skipped — which is
    // exactly how this behavior escaped CI coverage before.
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('second Clear Cache click deletes all three WebLLM Cache Storage entries', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Storage')).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });

    // First click — confirm state, no deletion yet.
    fireEvent.click(clearButton);
    expect(screen.getByText('Click Again to Confirm')).toBeInTheDocument();
    expect(caches.delete).not.toHaveBeenCalled();

    // Second click — actually clears, including Cache Storage.
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(caches.delete).toHaveBeenCalledTimes(3);
    });
    expect(caches.delete).toHaveBeenCalledWith('webllm/model');
    expect(caches.delete).toHaveBeenCalledWith('webllm/config');
    expect(caches.delete).toHaveBeenCalledWith('webllm/wasm');

    await waitFor(() => {
      expect(screen.queryByText('Click Again to Confirm')).not.toBeInTheDocument();
    });
  });
});
