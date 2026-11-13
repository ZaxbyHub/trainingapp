/**
 * #265 (AC3, frozen check C2): WebLLM is hidden in packaged/offline builds —
 * while the shared visibility gate is false, the Settings radio and the
 * Download panel never render a WebLLM surface, a persisted 'webllm'
 * preference normalizes to wllama at the context/factory seams, and a plain
 * production (non-dev, non-airgap) build is hidden too.
 *
 * The visibility gate is mocked FALSE for the UI legs (packaged/offline
 * builds); the env legs below re-import the real module under a stubbed env.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../lib/llm/engine-visibility', () => ({ WEBLLM_VISIBLE: false }));

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
vi.mock('../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn().mockImplementation(() => ({ checkModelCached: vi.fn(() => Promise.resolve(false)) })),
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

describe('SettingsPage hides WebLLM while the packaged/offline visibility gate is closed (#265 AC3)', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    stubIndexedDb();
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('no WebLLM radio option renders (wllama remains)', async () => {
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
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /wllama \(webgpu when available, cpu otherwise\)/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('radio', { name: /webllm/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download model/i })).not.toBeInTheDocument();
  });

  test('a legacy persisted webllm engine preference still shows no WebLLM surface', async () => {
    inferenceMock.state = {
      mode: 'browser-local',
      // A stale persisted value that outlived the switch to a packaged build
      // (the context normalizes it before rendering; the panel is gated on
      // visibility either way).
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
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /^browser engine$/i })).toBeInTheDocument();
    });
    expect(container.textContent ?? '').not.toMatch(/download model|webllm cdn/i);
  });

  test('INT-3: the About copy names only wllama while the gate is closed (no WebLLM advertisement)', async () => {
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
    render(<SettingsPage />);
    // The hidden-mode About sentence (scoped to this paragraph — other
    // sections legitimately mention WebLLM downloads in the abstract).
    await waitFor(() => {
      expect(
        screen.getByText('Runs in this browser with wllama (WebAssembly), or with the external model you configured; documents are stored in IndexedDB.'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/Runs in this browser with WebLLM/)).not.toBeInTheDocument();
  });
});

describe('persisted-WebLLM fallback legs (hidden builds)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  test('the factory boundary serves wllama for a hidden webllm request (A3-iii)', async () => {
    const { getLLMService, DEFAULT_BROWSER_ENGINE } = await import('../lib/llm/llm-factory');
    expect(DEFAULT_BROWSER_ENGINE).toBe('wllama');
    const service = getLLMService('webllm');
    const { WllamaService } = await import('../lib/llm/wllama-service');
    expect(service).toBe(WllamaService.getInstance());
  });

  test('a persisted webllm preference normalizes to wllama (A3-ii, getPreferredBrowserEngine)', async () => {
    const { getPreferredBrowserEngine } = await import('../lib/llm/llm-factory');
    const { INFERENCE_MODE_KEY } = await import('../lib/storage/persisted-keys');
    localStorage.setItem(
      INFERENCE_MODE_KEY,
      JSON.stringify({ mode: 'browser-local', browserEngine: 'webllm', ragPreset: 'balanced' }),
    );
    expect(getPreferredBrowserEngine()).toBe('wllama');
  });
});

describe('engine-visibility policy legs (non-airgap production visibility)', () => {
  afterEach(() => {
    vi.doMock('../lib/llm/engine-visibility', () => ({ WEBLLM_VISIBLE: false }));
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test('a plain production (non-dev, non-airgap) build hides WebLLM too', async () => {
    // The file-level vi.mock serves the UI legs above; these env legs need the
    // REAL module, freshly imported under a stubbed env.
    vi.doUnmock('../lib/llm/engine-visibility');
    vi.resetModules();
    vi.stubEnv('DEV', false);
    const { WEBLLM_VISIBLE } = await import('../lib/llm/engine-visibility');
    expect(WEBLLM_VISIBLE).toBe(false);
  });

  test('an airgap build hides WebLLM even in dev', async () => {
    vi.doUnmock('../lib/llm/engine-visibility');
    vi.resetModules();
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_AIRGAP', '1');
    const { WEBLLM_VISIBLE } = await import('../lib/llm/engine-visibility');
    expect(WEBLLM_VISIBLE).toBe(false);
  });

  test('a plain dev build without the airgap flag keeps WebLLM visible', async () => {
    vi.doUnmock('../lib/llm/engine-visibility');
    vi.resetModules();
    vi.stubEnv('DEV', true);
    const { WEBLLM_VISIBLE } = await import('../lib/llm/engine-visibility');
    expect(WEBLLM_VISIBLE).toBe(true);
  });
});
