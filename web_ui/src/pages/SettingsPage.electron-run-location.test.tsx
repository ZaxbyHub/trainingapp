/**
 * #265 (AC7, frozen check C5): inside Electron the Settings run-location card
 * does not offer browser-local — the desktop package ships no browser-LLM
 * weights, so "In this window" is not a runnable target there (decision
 * comment 6825525627). The card offers the Desktop backend only.
 *
 * Electron is brought in the real way: the desktop bridge stub makes
 * isElectron() true, and the page renders inside a DesktopSessionProvider
 * (same pattern as settings-wiring-honesty.test.tsx).
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const H = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  snapshot: null as Record<string, unknown> | null,
  notify() {
    this.snapshot = null;
    this.listeners.forEach((l) => l());
  },
  set(patch: Record<string, unknown>) {
    this.state = { ...this.state, ...patch };
    this.notify();
  },
  reset(patch: Record<string, unknown> = {}) {
    this.state = {
      mode: 'api',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isServerConnected: false,
      isModelReady: false,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: 'http://127.0.0.1:4567',
      ...patch,
    };
    this.snapshot = null;
  },
  actions: {
    setMode: (m: string) => H.set({ mode: m }),
    setRagPreset: () => undefined,
    checkServerConnectivity: () => Promise.resolve(false),
    setModelReady: () => undefined,
    setModelLoadingProgress: () => undefined,
  },
}));
H.reset();

vi.mock('../lib/inference', async () => {
  const R = await import('react');
  return {
    InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
    useInferenceMode: () =>
      R.useSyncExternalStore(
        (cb: () => void) => {
          H.listeners.add(cb);
          return () => {
            H.listeners.delete(cb);
          };
        },
        () => (H.snapshot ??= { ...H.state, ...H.actions }),
      ),
  };
});
vi.mock('../lib/theme', () => ({
  useTheme: () => ({ theme: 'light', themePreference: 'system', setTheme: () => undefined, isDark: false }),
}));
vi.mock('../lib/storage/profile', () => ({
  getProfilePrefix: vi.fn(() => 'testprfx'),
  deleteNamespace: vi.fn(() => Promise.resolve()),
  listStalePrefixes: vi.fn(() => Promise.resolve([])),
  listRegisteredProfiles: vi.fn(() => ({ profiles: ['testprfx'], healthy: true })),
  isRegisteredProfile: vi.fn(() => false),
  registerProfile: vi.fn(() => true),
  unregisterProfile: vi.fn(() => true),
  newProfilePrefix: vi.fn(() => 'newprof'),
  resetProfileRegistry: vi.fn(() => false),
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
  checkPackagedModels: vi.fn((): Promise<null> => Promise.resolve(null)),
  LLM_MODEL_DIR: 'lfm2-1.2b-rag',
}));
vi.mock('../lib/llm/engine-capability', () => ({
  detectEngineCapability: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../components/ModelDownloadProgress', () => ({ ModelDownloadProgress: () => null }));
vi.mock('../lib/first-run', () => ({
  fetchFirstRunStatus: vi.fn(async () => null),
  resetFirstRun: vi.fn(async () => undefined),
  emitFirstRunReopen: vi.fn(),
}));

import { SettingsPage } from './SettingsPage';
import { DesktopSessionProvider, type DesktopSession } from '../lib/desktop-session';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../test/desktop-bridge-stub';
import type { ApiClient } from '../lib/api';

function makeSession(): { session: DesktopSession } {
  const apiClient = {
    getSettings: vi.fn(async () => ({
      n_results: 4,
      explicit_keys: [],
      requested: {},
      reranking_available: true,
    }) as never),
    updateSettings: vi.fn(async () => ({ status: 'ok' }) as never),
    getModelStatus: vi.fn(async () => ({ engine: 'stub', profile: 'auto', models: { quality: { present: false }, fast: { present: false } } }) as never),
  } as unknown as ApiClient;
  return {
    session: {
      baseUrl: 'http://127.0.0.1:4567',
      token: 'test-token',
      mode: 'node',
      apiClient,
      sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
    },
  };
}

function renderElectron(session: DesktopSession | null) {
  installDesktopBridgeStub();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
  return render(
    <DesktopSessionProvider value={{ session, models: null, loading: false, error: null }}>
      <SettingsPage />
    </DesktopSessionProvider>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

describe('SettingsPage run-location card in Electron (#265 AC7)', () => {
  beforeEach(() => {
    localStorage.clear();
    H.reset({ mode: 'api' });
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
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => {
    cleanup();
    removeDesktopBridgeStub();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test('the run-location card offers the desktop backend only — no "In this window"', async () => {
    const { session } = makeSession();
    const { container } = renderElectron(session);
    await settle();
    const model = within(screen.getByRole('region', { name: /^model & connection$/i }));
    expect(model.getByRole('radio', { name: /^desktop backend$/i })).toBeChecked();
    expect(screen.queryByRole('radio', { name: /^in this window$/i })).not.toBeInTheDocument();
    expect(container.querySelectorAll('input[name="inference-mode"]')).toHaveLength(1);
  });

  test('a legacy browser-local state still shows no way to pick it in the card', async () => {
    H.reset({ mode: 'browser-local' });
    const { session } = makeSession();
    const { container } = renderElectron(session);
    await settle();
    expect(screen.queryByRole('radio', { name: /^in this window$/i })).not.toBeInTheDocument();
    expect(container.querySelectorAll('input[name="inference-mode"]')).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: /^model & connection$/i })).toBeInTheDocument();
    });
    // TST-7: pin the checked state too. Under the legacy browser-local seed the
    // sole 'Desktop backend' radio renders UNCHECKED (mode !== 'api') — but an
    // unchecked sole radio is NOT a state production leaves the card in: the
    // real context normalizes a legacy blob (and every Electron mount without
    // a stored blob, #247 AC1) to 'api'. Seed the production state through
    // the harness's set seam and assert the radio is checked.
    const legacyRadio = screen.getByRole('radio', { name: /^desktop backend$/i }) as HTMLInputElement;
    expect(legacyRadio.checked).toBe(false);
    act(() => {
      H.set({ mode: 'api' });
    });
    await settle();
    expect(screen.getByRole('radio', { name: /^desktop backend$/i })).toBeChecked();
  });
});
