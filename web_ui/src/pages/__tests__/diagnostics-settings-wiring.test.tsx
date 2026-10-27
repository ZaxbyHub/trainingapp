/**
 * diagnostics-settings-wiring.test.tsx — issue #248 (AC2/AC3 wiring): the
 * Diagnostics block inside Settings → Storage & privacy in BOTH app modes.
 * Browser: the toggle persists through the registered persisted key and
 * applies the live renderer level; export uses the browser logging core.
 * Electron: the toggle/export ride the desktopApi.diagnostics bridge (main is
 * the sole persistence authority), with failure/cancel surfaced in the
 * always-mounted status region. Same harness seams as
 * settings-wiring-honesty.test.tsx.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const H = vi.hoisted(() => {
  const h = {
    state: {} as Record<string, unknown>,
    snapshot: null as Record<string, unknown> | null,
    listeners: new Set<() => void>(),
    notify() {
      h.snapshot = null;
      h.listeners.forEach((l) => l());
    },
    set(patch: Record<string, unknown>) {
      h.state = { ...h.state, ...patch };
      h.notify();
    },
    reset(patch: Record<string, unknown> = {}) {
      h.state = {
        mode: 'browser-local',
        browserEngine: 'wllama',
        ragPreset: 'balanced',
        isServerConnected: false,
        isModelReady: false,
        modelLoadingProgress: 0,
        modeError: null,
        serverUrl: '',
        ...patch,
      };
      h.snapshot = null;
    },
    actions: {} as Record<string, unknown>,
  };
  h.actions = {
    setMode: (m: string) => h.set({ mode: m }),
    setRagPreset: () => undefined,
    setServerUrl: () => undefined,
    setBrowserEngine: () => undefined,
    checkServerConnectivity: () => Promise.resolve(false),
    setModelReady: () => undefined,
    setModelLoadingProgress: () => undefined,
  };
  h.reset();
  return h;
});

vi.mock('../../lib/inference', async () => {
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
vi.mock('../../lib/theme', () => ({
  useTheme: () => ({ theme: 'light', themePreference: 'system', setTheme: () => undefined, isDark: false }),
}));
vi.mock('../../lib/storage/profile', () => ({
  getProfilePrefix: vi.fn(() => 'testprfx'),
  deleteNamespace: vi.fn(() => Promise.resolve()),
  listStalePrefixes: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../lib/llm/model-download', () => ({
  ModelDownloadManager: vi.fn().mockImplementation(() => ({ downloadModel: vi.fn(), cancelDownload: vi.fn() })),
}));
vi.mock('../../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn().mockImplementation(() => ({ checkModelCached: vi.fn(() => Promise.resolve(false)) })),
}));
vi.mock('../../lib/embeddings/memory-aware', () => ({
  getMemoryBudget: vi.fn(() => ({ availableMB: 8192, totalMB: 16384 })),
  getMemoryPressureStatus: vi.fn(() => 'normal'),
}));
vi.mock('../../lib/models/model-manifest', () => ({
  checkPackagedModels: vi.fn((): Promise<null> => Promise.resolve(null)),
  LLM_MODEL_DIR: 'lfm2-1.2b-rag',
}));
vi.mock('../../lib/llm/engine-capability', () => ({
  detectEngineCapability: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../components/ModelDownloadProgress', () => ({ ModelDownloadProgress: () => null }));
vi.mock('../../lib/first-run', () => ({
  fetchFirstRunStatus: vi.fn(async () => null),
  resetFirstRun: vi.fn(async () => undefined),
  emitFirstRunReopen: vi.fn(),
}));
// The browser export path is exercised directly; mock only the download seam.
vi.mock('../../lib/logging/export', () => ({
  exportDiagnostics: vi.fn(async () => ({ outcome: 'fallback' as const })),
  buildDiagnosticsBundle: vi.fn(() => '{}'),
}));

import { SettingsPage } from '../SettingsPage';
import { DesktopSessionProvider, type DesktopSession } from '../../lib/desktop-session';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../../test/desktop-bridge-stub';
import type { ApiClient } from '../../lib/api';
import { DIAGNOSTICS_ENHANCED_KEY } from '../../lib/storage/persisted-keys';
import { enhancedLoggingEnabled, __resetLoggingCoreForTests } from '../../lib/logging';
import { exportDiagnostics } from '../../lib/logging/export';
import type { DesktopApiBridge, DiagnosticsExportReply } from '../../types/desktop';

function statusText(): string {
  return (screen.getByTestId('diagnostics-status').textContent ?? '').trim();
}

function makeSession() {
  const apiClient = {
    getSettings: vi.fn(async () => ({
      n_results: 4,
      explicit_keys: [],
      requested: {},
      reranking_available: true,
    }) as never),
    updateSettings: vi.fn(async () => ({ status: 'ok' }) as never),
    getModelStatus: vi.fn(async () => ({ engine: 'stub', profile: 'auto' }) as never),
  } as unknown as ApiClient;
  const session: DesktopSession = {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'test-token',
    mode: 'node',
    apiClient,
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  };
  return session;
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

beforeEach(() => {
  localStorage.clear();
  __resetLoggingCoreForTests();
  vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
});
afterEach(() => {
  cleanup();
  removeDesktopBridgeStub();
  vi.unstubAllGlobals();
  localStorage.clear();
  __resetLoggingCoreForTests();
  delete (window as { desktopApi?: unknown }).desktopApi;
});

describe('Diagnostics wiring (issue #248): browser mode', () => {
  test('the toggle persists the registered key, applies the live level, and reports status', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    const toggle = await screen.findByTestId('diagnostics-enhanced-toggle');
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem(DIAGNOSTICS_ENHANCED_KEY)).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/enhanced logging on \(debug level\)/i);
    });
    expect(localStorage.getItem(DIAGNOSTICS_ENHANCED_KEY)).toBe('1');
    expect(enhancedLoggingEnabled()).toBe(true);

    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/enhanced logging off \(info level\)/i);
    });
    expect(localStorage.getItem(DIAGNOSTICS_ENHANCED_KEY)).toBe('0');
    expect(enhancedLoggingEnabled()).toBe(false);
  });

  test('a stored key reconciles the toggle on mount; export rides the browser core and reports the outcome', async () => {
    H.reset({ mode: 'browser-local' });
    localStorage.setItem(DIAGNOSTICS_ENHANCED_KEY, '1');
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('diagnostics-enhanced-toggle')).toBeChecked();
    });
    expect(enhancedLoggingEnabled()).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId('diagnostics-export'));
    });
    await waitFor(() => {
      expect(exportDiagnostics).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/downloaded \(save picker unavailable\)/i);
    });
  });

  test('a browser export write failure is surfaced in the status region', async () => {
    H.reset({ mode: 'browser-local' });
    vi.mocked(exportDiagnostics).mockResolvedValueOnce({ outcome: 'error', detail: 'disk full' });
    render(<SettingsPage />);
    await screen.findByTestId('diagnostics-export');
    await act(async () => {
      fireEvent.click(screen.getByTestId('diagnostics-export'));
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/export failed: disk full/i);
    });
  });
});

describe('Diagnostics wiring (issue #248): Electron mode', () => {
  function bridgeWith(overrides: Record<string, unknown> = {}) {
    return {
      getState: vi.fn(async () => ({ active: true, enhanced: false })),
      setEnhancedLevel: vi.fn(async (_enabled: boolean) => ({ ok: true as const, enhanced: true })),
      logEntry: vi.fn(async (_entry: unknown) => ({ ok: true })),
      exportDiagnostics: vi.fn(async (): Promise<DiagnosticsExportReply> => ({
        ok: true,
        path: 'C:\\Downloads\\bundle.json',
      })),
      ...overrides,
    };
  }

  test('the toggle rides setEnhancedLevel (no renderer localStorage), reconciles from getState, and reports status', async () => {
    H.reset({ mode: 'api' });
    const diagnostics = bridgeWith();
    installDesktopBridgeStub({ diagnostics } as unknown as Partial<DesktopApiBridge>);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    render(
      <DesktopSessionProvider value={{ session: makeSession(), models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>,
    );
    const toggle = await screen.findByTestId('diagnostics-enhanced-toggle');
    await waitFor(() => {
      expect(diagnostics.getState).toHaveBeenCalled();
    });

    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(diagnostics.setEnhancedLevel).toHaveBeenCalledWith(true);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/enhanced logging on \(debug level, both processes\)/i);
    });
    // The renderer NEVER writes the Electron persistence copy.
    expect(localStorage.getItem(DIAGNOSTICS_ENHANCED_KEY)).toBeNull();
  });

  test('a failed setEnhancedLevel answers a typed error and the toggle stays off', async () => {
    H.reset({ mode: 'api' });
    const diagnostics = bridgeWith({
      setEnhancedLevel: vi.fn(async () => ({ ok: false, detail: 'could not persist the diagnostics setting' })),
    });
    installDesktopBridgeStub({ diagnostics } as unknown as Partial<DesktopApiBridge>);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    render(
      <DesktopSessionProvider value={{ session: makeSession(), models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>,
    );
    const toggle = await screen.findByTestId('diagnostics-enhanced-toggle');
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/could not change the setting: could not persist/i);
    });
    expect(toggle).not.toBeChecked();
  });

  test('export reports saved / cancelled / typed failure from the bridge reply', async () => {
    H.reset({ mode: 'api' });
    const diagnostics = bridgeWith();
    installDesktopBridgeStub({ diagnostics } as unknown as Partial<DesktopApiBridge>);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    render(
      <DesktopSessionProvider value={{ session: makeSession(), models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>,
    );
    const button = await screen.findByTestId('diagnostics-export');

    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/diagnostics bundle written/i);
    });

    vi.mocked(diagnostics.exportDiagnostics).mockResolvedValueOnce({ cancelled: true });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/export cancelled/i);
    });

    vi.mocked(diagnostics.exportDiagnostics).mockResolvedValueOnce({ ok: false, error: 'live-destination' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(statusText()).toMatch(/export failed: live-destination/i);
    });
  });

  test('an older main without the diagnostics namespace keeps the controls present and inert-free', async () => {
    H.reset({ mode: 'api' });
    installDesktopBridgeStub({ diagnostics: undefined } as Partial<DesktopApiBridge>);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    render(
      <DesktopSessionProvider value={{ session: makeSession(), models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>,
    );
    // The block falls back to the browser behavior (no bridge calls crash it).
    const toggle = await screen.findByTestId('diagnostics-enhanced-toggle');
    expect(toggle).toBeInTheDocument();
    await settle();
    expect(statusText()).toBe('');
  });
});
