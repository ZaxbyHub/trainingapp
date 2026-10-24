/**
 * desktop-readiness-gate.test.ts — issue #247 R2 (collated trace
 * .agents/issue-traces/collated-246-247, approved plan rev 5, AC11).
 *
 * AC11, layer 1 (model-readiness.ts): under Electron the wllama branch of
 * isModelAvailable must return false WITHOUT issuing ANY request — the
 * packaged-GGUF probe (a same-origin fetch of models/llm/...) must never
 * fire, because the desktop renderer cannot load the browser-LLM anyway and
 * a probe result would be dishonest. Pinned with BOTH a probeAsset mock
 * (call observation) and a global fetch stub (wire-level zero-request
 * assertion). The browser path is pinned unchanged.
 *
 * AC11, layer 2 (SettingsPage cache row): under Electron the browser-LLM
 * cache row renders a dedicated NOT-APPLICABLE state — pinned here as the
 * ABSENCE of the browser copy ('Not cached' badge, 'Contact your
 * administrator' rebuild guidance) inside Electron, plus its unchanged
 * presence in the browser app. The mock recipe is lifted from
 * web_ui/src/pages/SettingsPage.test.tsx (the repo's existing harness); the
 * REAL ModelReadinessGate is deliberately left in place so the Settings row
 * is driven by the same short-circuit layer 1 pins.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const electron = vi.hoisted(() => ({ on: false }));

vi.mock('../../desktop-session', () => ({
  isElectron: () => electron.on,
  initDesktopSession: vi.fn(async () => ({ token: 'stub-token' }) as never),
  useDesktopSession: vi.fn(() => ({ session: null, models: null, loading: false, error: null })),
  resetDesktopSession: vi.fn(),
  fetchModelStatus: vi.fn(async () => null),
  DesktopSessionError: class extends Error {},
}));

vi.mock('../web-llm-service', () => ({
  WebLLMService: {
    getInstance: vi.fn(() => {
      throw new Error('no webllm session in this spec');
    }),
  },
  WEBLLM_DEFAULT_MODEL_ID: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
}));

vi.mock('../../models/probe', () => ({
  probeAsset: vi.fn(async () => false),
}));

// Lifted from SettingsPage.test.tsx so the page mounts deterministically; the
// REAL constants (LLM_GGUF_URL etc.) pass through so layer-1 assertions
// reference the production URL.
vi.mock('../../models/model-manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../models/model-manifest')>();
  return { ...actual, checkPackagedModels: vi.fn(async () => null) };
});

import { probeAsset as probeAssetMock } from '../../models/probe';
import { LLM_GGUF_URL } from '../../models/model-manifest';
import { ModelReadinessGate } from '../model-readiness';

// ---------------------------------------------------------------------------
// Layer 2 mocks (SettingsPage harness, lifted from SettingsPage.test.tsx).
// ---------------------------------------------------------------------------
const useInferenceModeMock = vi.fn();
vi.mock('../../inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: (...args: unknown[]) => useInferenceModeMock(...args),
}));
vi.mock('../../theme', () => ({
  useTheme: vi.fn(() => ({ theme: 'light', themePreference: 'system', setTheme: vi.fn(), isDark: false })),
}));
vi.mock('../../storage/profile', () => ({
  getProfilePrefix: vi.fn(() => 'testprfx'),
  deleteNamespace: vi.fn(() => Promise.resolve()),
  listStalePrefixes: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../model-download', () => ({
  ModelDownloadManager: vi.fn().mockImplementation(() => ({
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
  })),
}));
vi.mock('../../embeddings/memory-aware', () => ({
  getMemoryBudget: vi.fn(() => ({ availableMB: 8192, totalMB: 16384, browserOverheadMB: 2048 })),
  getMemoryPressureStatus: vi.fn(() => 'normal'),
}));
vi.mock('../engine-capability', () => ({
  detectEngineCapability: vi.fn(async () => null),
}));
vi.mock('../../../components/ModelDownloadProgress', () => ({
  ModelDownloadProgress: () => null,
}));

import { SettingsPage } from '../../../pages/SettingsPage';

const fetchCalls: Array<{ url: string }> = [];
beforeEach(() => {
  electron.on = false;
  vi.clearAllMocks();
  localStorage.clear();
  fetchCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push({ url: String(input) });
      return { ok: false, status: 404 } as unknown as Response;
    }),
  );
  // Minimal IndexedDB stub (SettingsPage.test.tsx recipe): opens/answers
  // immediately so the page's storage effects settle inside the test.
  const fakeDB = {
    transaction: vi.fn(() => ({ objectStore: vi.fn(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() })), oncomplete: null, onerror: null, abort: vi.fn() })),
    objectStoreNames: { contains: vi.fn(() => true) },
    createObjectStore: vi.fn(),
    close: vi.fn(),
  };
  type FakeOpenRequest = {
    onsuccess: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
    result?: unknown;
  };
  vi.stubGlobal(
    'indexedDB',
    ({
      open: vi.fn(() => {
        const req: FakeOpenRequest = { onsuccess: null, onerror: null, result: fakeDB };
        setTimeout(() => {
          if (req.onsuccess) req.onsuccess(new Event('success'));
        }, 0);
        return req;
      }),
      deleteDatabase: vi.fn(() => {
        const req: FakeOpenRequest = { onsuccess: null, onerror: null };
        setTimeout(() => {
          if (req.onsuccess) req.onsuccess(new Event('success'));
        }, 0);
        return req;
      }),
    } as unknown) as typeof indexedDB,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('desktop-readiness-gate: isModelAvailable wllama branch under Electron', () => {
  test('Electron: result false with ZERO probeAsset calls and ZERO fetch requests', async () => {
    electron.on = true;
    const gate = new ModelReadinessGate();
    const cached = await gate.checkModelCached('lfm2-1.2b-rag', 'wllama');
    expect(cached, 'under Electron the wllama branch is honestly false').toBe(false);
    expect(probeAssetMock, 'the packaged-GGUF probe must never fire inside Electron').not.toHaveBeenCalled();
    expect(fetchCalls.filter((c) => c.url.includes('models/llm')), 'zero models/llm/* requests').toHaveLength(0);
    expect(fetchCalls, 'zero requests of any kind from the availability check').toHaveLength(0);
  });

  test('Electron: the full readiness result carries modelCached=false without a probe', async () => {
    electron.on = true;
    const gate = new ModelReadinessGate();
    const result = await gate.checkReadiness('lfm2-1.2b-rag', 'wllama');
    expect(result.checks.modelCached).toBe(false);
    expect(probeAssetMock).not.toHaveBeenCalled();
  });

  test('browser app: the packaged-GGUF probe still runs, once, at the production URL (unchanged path)', async () => {
    electron.on = false;
    vi.mocked(probeAssetMock).mockResolvedValueOnce(true);
    const gate = new ModelReadinessGate();
    const cached = await gate.checkModelCached('lfm2-1.2b-rag', 'wllama');
    expect(cached).toBe(true);
    expect(probeAssetMock).toHaveBeenCalledTimes(1);
    expect(probeAssetMock).toHaveBeenCalledWith(LLM_GGUF_URL);
  });
});

describe('desktop-readiness-gate: Settings browser-LLM cache row (AC11 rendering pin)', () => {
  function primeInferenceMode(mode: 'api' | 'browser-local'): void {
    useInferenceModeMock.mockReturnValue({
      mode,
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isServerConnected: mode === 'api',
      isModelReady: false,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: mode === 'api' ? 'http://127.0.0.1:54321' : '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      checkServerConnectivity: vi.fn(async () => false),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });
  }

  test('Electron: the cache row renders the not-applicable state — no "Not cached" badge, no administrator copy', async () => {
    electron.on = true;
    primeInferenceMode('api');
    render(React.createElement(SettingsPage));
    // Bounded settle: any (incorrect) async probe/verdict must have landed by
    // now, so the absence assertions below cannot pass by winning a race.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByText('Not cached'), 'no browser-cache verdict inside Electron').toBeNull();
    expect(screen.queryByText(/administrator/i), 'no rebuild/administrator copy inside Electron').toBeNull();
    expect(probeAssetMock, 'the Settings layer never probes inside Electron either').not.toHaveBeenCalled();
  });

  test('browser app: an uncached wllama row still shows the honest browser copy (unchanged path)', async () => {
    electron.on = false;
    primeInferenceMode('browser-local');
    vi.mocked(probeAssetMock).mockResolvedValue(false);
    render(React.createElement(SettingsPage));
    await waitFor(
      () => {
        expect(screen.getByText('Not cached')).toBeTruthy();
      },
      { timeout: 3000 },
    );
    expect(screen.getByText(/administrator/i)).toBeTruthy();
  });
});
