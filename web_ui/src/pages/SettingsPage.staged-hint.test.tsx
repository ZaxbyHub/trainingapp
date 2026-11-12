/**
 * #265 (AC9, frozen check C7): the Settings missing-model note (browser app,
 * wllama engine, model not cached) carries the developer hint —
 * "Building from source? Run npm run build:offline to stage the model." —
 * and only while the model is actually missing.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

const inferenceMock = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => inferenceMock.state as unknown as ReturnType<typeof import('../lib/inference').useInferenceMode>,
}));
vi.mock('../lib/theme', () => ({
  useTheme: () => ({ theme: 'light', themePreference: 'system', setTheme: vi.fn(), isDark: false }),
}));
vi.mock('../lib/storage/profile', () => ({
  getProfilePrefix: () => 'testprfx',
  deleteNamespace: vi.fn(() => Promise.resolve()),
  listStalePrefixes: vi.fn(() => Promise.resolve([])),
  listRegisteredProfiles: () => ({ profiles: ['testprfx'], healthy: true }),
  isRegisteredProfile: () => false,
  registerProfile: () => true,
  unregisterProfile: () => true,
  newProfilePrefix: () => 'newprof',
  resetProfileRegistry: () => false,
  getStorageDbNames: () => ({
    documents: 'x-doc-qa-documents',
    vectorMapping: 'x-doc-qa-indexes',
    vector: 'x-doc-qa-index',
    keyword: 'x-doc-qa-keywords',
    conversations: 'x-doc-qa-conversations',
  }),
}));
vi.mock('../lib/llm/model-download', () => ({
  ModelDownloadManager: vi.fn().mockImplementation(() => ({ downloadModel: vi.fn(), cancelDownload: vi.fn() })),
}));
const readinessMock = vi.hoisted(() => ({ cached: false }));
vi.mock('../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn().mockImplementation(() => ({
    checkModelCached: vi.fn(() => Promise.resolve(readinessMock.cached)),
  })),
}));
vi.mock('../lib/embeddings/memory-aware', () => ({
  getMemoryBudget: vi.fn(() => ({ availableMB: 8192, totalMB: 16384 })),
  getMemoryPressureStatus: vi.fn(() => 'normal'),
}));
vi.mock('../lib/models/model-manifest', () => ({
  checkPackagedModels: vi.fn(() => Promise.resolve(null)),
  LLM_MODEL_DIR: 'lfm2-1.2b-rag',
}));
vi.mock('../lib/llm/engine-capability', () => ({
  detectEngineCapability: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../components/ModelDownloadProgress', () => ({ ModelDownloadProgress: () => null }));

import { SettingsPage } from './SettingsPage';

function stubIndexedDb() {
  (globalThis as Record<string, unknown>).indexedDB = {
    open: vi.fn(() => {
      const req: Record<string, unknown> = { onsuccess: null, onerror: null };
      setTimeout(() => (req.onsuccess as ((e: Event) => void) | null)?.call(req, new Event('success')), 0);
      return req;
    }),
    deleteDatabase: vi.fn(() => {
      const req: Record<string, unknown> = { onsuccess: null, onerror: null };
      setTimeout(() => (req.onsuccess as ((e: Event) => void) | null)?.call(req, new Event('success')), 0);
      return req;
    }),
  } as unknown as typeof globalThis.indexedDB;
}

describe('SettingsPage staged-weights hint (#265 AC9)', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    stubIndexedDb();
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
    readinessMock.cached = false;
    inferenceMock.state = {
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
    };
  });
  afterEach(() => vi.unstubAllGlobals());

  test('the missing-model note carries the build:offline developer hint', async () => {
    render(<SettingsPage />);
    const note = await waitFor(() => {
      const el = screen.getByTestId('missing-model-note');
      expect(el).toBeInTheDocument();
      return el;
    });
    expect(note).toHaveTextContent(/building from source\? run npm run build:offline to stage the model\./i);
    expect(note).toHaveTextContent(/the packaged model is missing from this build/i);
  });

  test('no hint (and no note) once the model is cached', async () => {
    readinessMock.cached = true;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /^browser engine$/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('missing-model-note')).not.toBeInTheDocument();
  });
});
