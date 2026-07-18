/**
 * SettingsPage tests — issue #24.
 *
 * The component was substantially rebuilt:
 * - The dead Model Selection section was deleted (preferredModel had no
 *   runtime consumer).
 * - Cache status is now engine-aware (passes browserEngine to
 *   checkModelCached, not a webllm default).
 * - Theme uses setTheme/themePreference from ThemeContext (no toggleTheme).
 * - Server URL persists on blur (not onChange).
 * - Radio cards use <label> + native input (no duplicate role="radio").
 *
 * Tests updated to match actual (correct) behavior. This file was previously
 * in vitest.config.ts's exclude list (masked failing assertions); issue #24
 * acceptance criterion requires it to pass, so it is un-excluded.
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import * as inferenceModule from '../lib/inference';
import * as themeModule from '../lib/theme';

const deleteNamespaceMock = vi.fn((_prefix: string) => Promise.resolve());
const listStalePrefixesMock = vi.fn(() => Promise.resolve([]));
const getProfilePrefixMock = vi.fn(() => 'testprfx');

// Mock modules before importing component
vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../lib/theme', () => ({
  useTheme: vi.fn(),
}));

vi.mock('../lib/storage/profile', () => ({
  getProfilePrefix: () => getProfilePrefixMock(),
  deleteNamespace: (prefix: string) => deleteNamespaceMock(prefix),
  listStalePrefixes: () => listStalePrefixesMock(),
}));

// Create a shared mock instance for ModelReadinessGate
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

// PRR-005: mock checkPackagedModels so the PackagedModelReadiness component
// mounts with controlled data (real HEAD probes fail in jsdom). Default
// returns null so existing tests that don't care about readiness still pass.
import type { PackagedModelsReport } from '../lib/models/model-manifest';
const checkPackagedModelsMock = vi.fn((): Promise<PackagedModelsReport | null> => Promise.resolve(null));
vi.mock('../lib/models/model-manifest', () => ({
  checkPackagedModels: (..._args: unknown[]) => checkPackagedModelsMock(),
  LLM_MODEL_DIR: 'gemma-4-e2b-it',
}));

// Mock detectEngineCapability so it doesn't do real WebGPU probes in jsdom.
vi.mock('../lib/llm/engine-capability', () => ({
  detectEngineCapability: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../components/ModelDownloadProgress', () => ({
  ModelDownloadProgress: () => null,
}));

// IndexedDB mock - properly structured
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
 * after all operations complete.
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

// Factory for creating IDBRequest-like objects with proper event handling
function createIDBRequest() {
  const request: Record<string, unknown> = {
    onsuccess: null,
    onerror: null,
    result: null,
  };
  return request as unknown as IDBRequest;
}

// Set up indexedDB mock before tests
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

// Import after mocks
import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Reset mock call history only, not implementations
    vi.mocked(inferenceModule.useInferenceMode).mockClear();
    vi.mocked(themeModule.useTheme).mockClear();
    mockModelReadinessGateInstance.checkModelCached.mockClear();
    mockModelReadinessGateInstance.checkModelCached.mockResolvedValue(false);
    mockObjectStore.get.mockClear();
    mockObjectStore.put.mockClear();
    mockObjectStore.delete.mockClear();
    deleteNamespaceMock.mockClear();
    listStalePrefixesMock.mockClear();
    getProfilePrefixMock.mockClear();
    getProfilePrefixMock.mockReturnValue('testprfx');
    // Reset checkPackagedModels to default (null = no panel rendered).
    checkPackagedModelsMock.mockClear();
    checkPackagedModelsMock.mockResolvedValue(null);

    // Setup default mock returns
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

    // Updated mock shape (issue #24 F5): setTheme + themePreference, no toggleTheme.
    vi.mocked(themeModule.useTheme).mockReturnValue({
      theme: 'light',
      themePreference: 'system',
      setTheme: vi.fn(),
      isDark: false,
    });

    // Default IndexedDB mock - successful load
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

    // Cache Storage API stub (jsdom lacks `caches`).
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('renders the browser-engine selector and hardware-capability panel', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Browser Engine')).toBeInTheDocument();
    });
    expect(screen.getByText('Hardware Capability')).toBeInTheDocument();
    // Both engine options present and the persisted choice (wllama) is selected.
    const wllamaRadio = screen.getByRole('radio', { name: /wllama \(cpu/i });
    const webllmRadio = screen.getByRole('radio', { name: /webllm \(webgpu/i });
    expect(wllamaRadio).toBeChecked();
    expect(webllmRadio).not.toBeChecked();
  });

  test('selecting WebLLM calls setBrowserEngine', async () => {
    const setBrowserEngine = vi.fn();
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
      setBrowserEngine,
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });

    render(<SettingsPage />);
    const webllmRadio = await screen.findByRole('radio', { name: /webllm \(webgpu/i });
    fireEvent.click(webllmRadio);
    expect(setBrowserEngine).toHaveBeenCalledWith('webllm');
  });

  test('renders the main sections (no dead Model Selection section)', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Inference Mode')).toBeInTheDocument();
    });

    expect(screen.getByText('Browser Engine')).toBeInTheDocument();
    expect(screen.getByText('Response Quality')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('About')).toBeInTheDocument();

    // The dead Model Selection section was deleted (issue #24 F2).
    expect(screen.queryByText('Model Selection')).not.toBeInTheDocument();
  });

  test('Inference mode radio toggle changes mode', async () => {
    const setMode = vi.fn();
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isServerConnected: false,
      isModelReady: false,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode,
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Inference Mode')).toBeInTheDocument();
    });

    const browserLocalRadio = screen.getByRole('radio', { name: /browser-local/i });
    const apiRadio = screen.getByRole('radio', { name: /api server/i });

    expect(browserLocalRadio).toBeChecked();
    expect(apiRadio).not.toBeChecked();

    fireEvent.click(apiRadio);

    expect(setMode).toHaveBeenCalledWith('api');
  });

  test('Server URL input updates value on change but persists on blur (issue #24 F8)', async () => {
    const setServerUrl = vi.fn();
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'api',
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
      setServerUrl,
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    });

    const serverUrlInput = screen.getByLabelText(/server url/i) as HTMLInputElement;

    // Change updates the input value (local state) but does NOT persist.
    fireEvent.change(serverUrlInput, { target: { value: 'http://localhost:8080' } });
    expect(serverUrlInput.value).toBe('http://localhost:8080');
    expect(setServerUrl).not.toHaveBeenCalled();

    // Blur persists (the correct UX — issue #24 F8).
    fireEvent.blur(serverUrlInput);
    expect(setServerUrl).toHaveBeenCalledWith('http://localhost:8080');
  });

  test('Theme selection calls setTheme (not toggleTheme) (issue #24 F5)', async () => {
    const setTheme = vi.fn();
    vi.mocked(themeModule.useTheme).mockReturnValue({
      theme: 'light',
      themePreference: 'system',
      setTheme,
      isDark: false,
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Appearance')).toBeInTheDocument();
    });

    const darkOption = screen.getByRole('radio', { name: /dark/i });
    fireEvent.click(darkOption);

    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  test('System theme radio is selected when themePreference is system', async () => {
    vi.mocked(themeModule.useTheme).mockReturnValue({
      theme: 'light',
      themePreference: 'system',
      setTheme: vi.fn(),
      isDark: false,
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Appearance')).toBeInTheDocument();
    });

    const systemRadio = screen.getByRole('radio', { name: /system/i });
    expect(systemRadio).toBeChecked();
  });

  test('Clear cache requires two clicks (confirm)', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Storage')).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });

    // First click - should show confirm state
    fireEvent.click(clearButton);
    expect(screen.getByText('Click Again to Confirm')).toBeInTheDocument();

    // Second click - should actually clear
    fireEvent.click(clearButton);

    // After clearing, should return to idle state
    await waitFor(() => {
      expect(screen.queryByText('Click Again to Confirm')).not.toBeInTheDocument();
    });
  });

  test('Clear cache deletes the profile namespace via deleteNamespace (issue #24 F1)', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Storage')).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: /clear cache/i });
    fireEvent.click(clearButton);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(deleteNamespaceMock).toHaveBeenCalledWith('testprfx');
    });
  });

  test('Settings persist to IndexedDB via SettingsStore (serverUrl on blur)', async () => {
    const savedData: unknown[] = [];

    mockObjectStore.put.mockImplementation((data) => {
      savedData.push(data);
      const req = createIDBRequest();
      setTimeout(() => {
        const onsuccess = (req as unknown as Record<string, (e: Event) => void>).onsuccess;
        if (onsuccess) onsuccess.call(req, new Event('success'));
      }, 0);
      return req as unknown as IDBRequest;
    });

    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'api',
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

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    });

    // Trigger a settings persist by typing + blurring the server URL.
    const serverUrlInput = screen.getByLabelText(/server url/i) as HTMLInputElement;
    fireEvent.change(serverUrlInput, { target: { value: 'http://localhost:8080' } });
    fireEvent.blur(serverUrlInput);

    await waitFor(() => {
      expect(savedData.length).toBeGreaterThan(0);
    });

    // Verify the saved data structure — theme and preferredModel are no longer
    // part of the persisted shape (issue #24 F2/F5).
    const savedSettings = savedData[savedData.length - 1] as Record<string, unknown>;
    expect(savedSettings).toMatchObject({
      key: 'user-preferences',
      serverUrl: 'http://localhost:8080',
    });
    expect(savedSettings).not.toHaveProperty('theme');
    expect(savedSettings).not.toHaveProperty('preferredModel');
  });

  test('Server Configuration section is hidden in browser-local mode', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Inference Mode')).toBeInTheDocument();
    });

    expect(screen.queryByText('Server Configuration')).not.toBeInTheDocument();
  });

  test('wllama engine shows "no download needed" and no download button (issue #24 F3)', async () => {
    // Issue #37 P6: the "Weights are bundled" copy is now gated on actual
    // model presence (modelCached). Mock the packaged weights as present.
    mockModelReadinessGateInstance.checkModelCached.mockResolvedValue(true);

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Browser Engine')).toBeInTheDocument();
    });

    // wllama is the default engine — weights are bundled, no download button.
    expect(screen.getByText(/weights are bundled with this build/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download model/i })).not.toBeInTheDocument();
  });

  test('webllm engine shows download button when model not cached (issue #24 F3)', async () => {
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'webllm',
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

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /download model/i })).toBeInTheDocument();
    });

    // The "requires internet" warning must be shown.
    expect(screen.getByText(/requires internet access/i)).toBeInTheDocument();
  });

  test('cache status checks the selected engine, not a hardcoded default (issue #24 F4)', async () => {
    // Default mock: browserEngine = 'wllama'. The cache check should pass
    // the wllama engine + the wllama model id (LLM_MODEL_DIR), not the
    // webllm default.
    render(<SettingsPage />);

    await waitFor(() => {
      expect(mockModelReadinessGateInstance.checkModelCached).toHaveBeenCalled();
    });

    const call = mockModelReadinessGateInstance.checkModelCached.mock.calls[0] as unknown as [string, string];
    // Second arg must be the browserEngine ('wllama'), not the old 'webllm' default.
    expect(call[1]).toBe('wllama');
    // First arg is the model id — for wllama it's LLM_MODEL_DIR. We use the
    // explicit literal here because model-manifest is mocked in this test file,
    // so importing LLM_MODEL_DIR would read the mock (tautological). The real
    // value is 'gemma-4-e2b-it' (model-manifest.ts LLM_MODEL_DIR). If that
    // constant changes, update this literal AND the mock factory's LLM_MODEL_DIR.
    expect(call[0]).toBe('gemma-4-e2b-it');
  });

  test('clicking a radio circle changes selection exactly once (no double-fire) (issue #24 F9)', async () => {
    const setRagPreset = vi.fn();
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'fast',
      isServerConnected: false,
      isModelReady: false,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset,
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Response Quality')).toBeInTheDocument();
    });

    // Click directly on the radio input (the circle). With the <label> pattern,
    // the native input's onChange is the sole handler — no div onClick to
    // double-fire.
    const balancedRadio = screen.getByRole('radio', { name: /balanced/i });
    fireEvent.click(balancedRadio);

    // Should fire exactly once, not twice.
    expect(setRagPreset).toHaveBeenCalledTimes(1);
    expect(setRagPreset).toHaveBeenCalledWith('balanced');
  });

  test('memory pressure refreshes on an interval (issue #24 F7)', async () => {
    const { getMemoryPressureStatus } = await import('../lib/embeddings/memory-aware');
    const { unmount } = render(<SettingsPage />);

    // Wait for settings to load (the memory effect is gated on settingsLoaded).
    await waitFor(() => {
      expect(screen.getByText('Inference Mode')).toBeInTheDocument();
    });

    // ADV-4: exact call count, not just "> initial". After settings load the
    // memory effect fires once (the initial updateMemoryStatus).
    await waitFor(() => {
      expect((getMemoryPressureStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const callsAfterMount = (getMemoryPressureStatus as ReturnType<typeof vi.fn>).mock.calls.length;

    // One 5s interval tick → exactly one more call.
    vi.advanceTimersByTime(5000);
    expect((getMemoryPressureStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount + 1);

    // Another tick → +1 more.
    vi.advanceTimersByTime(5000);
    expect((getMemoryPressureStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount + 2);

    // Unmount → interval cleared, no further calls.
    unmount();
    vi.advanceTimersByTime(15000);
    expect((getMemoryPressureStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount + 2);
  });

  test('radio groups use native input as the sole radio (no duplicate role) (issue #24 F9)', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Inference Mode')).toBeInTheDocument();
    });

    // Every radio found by role should be a native <input> (the wrapping
    // element is a <label>, which has no implicit role="radio").
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThanOrEqual(4);
    for (const radio of radios) {
      expect(radio.tagName).toBe('INPUT');
    }
  });

  // PRR-005: PackagedModelReadiness component tests. The component renders
  // per-kind readiness from the PackagedModelsReport. These tests mock
  // checkPackagedModels/detectEngineCapability so the component mounts with
  // controlled data.

  test('PackagedModelReadiness renders per-kind status badges (PRR-005, issue #24 F6)', async () => {
    // Override checkPackagedModels to return a report with known kinds.
    checkPackagedModelsMock.mockResolvedValue({
      allReady: false,
      models: [
        { id: 'emb1', label: 'Embeddings', kind: 'embedding', group: 'core', ready: true, excluded: false, files: [] },
        { id: 'rt1', label: 'ONNX Runtime', kind: 'runtime', group: 'core', ready: true, excluded: false, files: [] },
        { id: 'rr1', label: 'Reranker', kind: 'reranker', group: 'optional', ready: false, excluded: false, files: [{ path: '/x.onnx', required: true, present: false }] },
        { id: 'llm1', label: 'Browser LLM', kind: 'llm', group: 'llm', ready: true, excluded: false, files: [] },
      ],
      missing: ['/x.onnx'],
    });

    render(<SettingsPage />);

    // Wait for the readiness panel to render.
    await waitFor(() => {
      expect(screen.getByText('Embeddings')).toBeInTheDocument();
    });

    // Per-kind labels rendered.
    expect(screen.getByText('ONNX Runtime')).toBeInTheDocument();
    expect(screen.getByText('Reranker')).toBeInTheDocument();

    // Overall aggregate shows the missing-files message (reranker not ready).
    expect(screen.getByText(/required model file/i)).toBeInTheDocument();
  });

  test('PackagedModelReadiness suppresses llm row for webllm engine (PRR-005, issue #24 F6)', async () => {
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'webllm',
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

    checkPackagedModelsMock.mockResolvedValue({
      allReady: true,
      models: [
        { id: 'emb1', label: 'Embeddings', kind: 'embedding', group: 'core', ready: true, excluded: false, files: [] },
        { id: 'llm1', label: 'Browser LLM', kind: 'llm', group: 'llm', ready: true, excluded: false, files: [] },
      ],
      missing: [],
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('Embeddings')).toBeInTheDocument();
    });

    // The webllm-suppression note must be shown instead of the llm "Ready" row.
    expect(screen.getByText(/webllm weights are not packaged/i)).toBeInTheDocument();
  });

  test('PackagedModelReadiness shows "Excluded from build" for excluded groups (PRR-005)', async () => {
    checkPackagedModelsMock.mockResolvedValue({
      allReady: true,
      models: [
        { id: 'emb1', label: 'Embeddings', kind: 'embedding', group: 'core', ready: true, excluded: false, files: [] },
        { id: 'llm1', label: 'Browser LLM', kind: 'llm', group: 'llm', ready: true, excluded: true, files: [] },
      ],
      missing: [],
    });

    render(<SettingsPage />);

    // wllama engine (default) → llm row shows, but it's excluded.
    await waitFor(() => {
      expect(screen.getByText('Excluded from build')).toBeInTheDocument();
    });
  });
});
