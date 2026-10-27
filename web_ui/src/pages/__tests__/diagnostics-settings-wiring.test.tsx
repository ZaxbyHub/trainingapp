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
import {
  __deliveryStateForTests,
  __resetLoggingCoreForTests,
  admittedEntries,
  createLogger,
  enhancedLoggingEnabled,
  FORWARD_QUEUE_LIMIT,
  PENDING_LIMIT,
  setConsoleSinks,
  setEnhancedLogging,
  type LogEntry,
} from '../../lib/logging';
import { exportDiagnostics } from '../../lib/logging/export';
import type { DesktopApiBridge, DiagnosticsExportReply } from '../../types/desktop';

function statusText(): string {
  return (screen.getByTestId('diagnostics-status').textContent ?? '').trim();
}

/** PRR-064 (pr255): failures render in their own alert region, not the polite
 * span — and the region mounts WITH its message (the updates-error
 * precedent), so absence means "no failure". */
function failureText(): string {
  const region = screen.queryByTestId('diagnostics-failure');
  return region === null ? '' : (region.textContent ?? '').trim();
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

  test('a browser export write failure is surfaced as an alert, never the polite status', async () => {
    H.reset({ mode: 'browser-local' });
    vi.mocked(exportDiagnostics).mockResolvedValueOnce({ outcome: 'error', detail: 'disk full' });
    render(<SettingsPage />);
    await screen.findByTestId('diagnostics-export');
    await act(async () => {
      fireEvent.click(screen.getByTestId('diagnostics-export'));
    });
    // PRR-064: the failure carries role=alert + the danger tone and takes
    // focus; the polite status span stays empty.
    await waitFor(() => {
      expect(failureText()).toMatch(/export failed: disk full/i);
    });
    const alert = screen.getByTestId('diagnostics-failure');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert.className).toContain('settings-tone--danger');
    expect(document.activeElement).toBe(alert);
    expect(statusText()).toBe('');
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

  test('a failed setEnhancedLevel answers a typed error in the alert region and the toggle stays off', async () => {
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
    await waitFor(() => {
      expect(diagnostics.getState).toHaveBeenCalled();
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    // PRR-064: the failure is announced (role=alert, danger tone) and takes
    // focus; it never rides the polite status span.
    await waitFor(() => {
      expect(failureText()).toMatch(/could not change the setting: could not persist/i);
    });
    expect(screen.getByTestId('diagnostics-failure')).toHaveAttribute('role', 'alert');
    expect(document.activeElement).toBe(screen.getByTestId('diagnostics-failure'));
    expect(statusText()).toBe('');
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
      expect(failureText()).toMatch(/export failed: live-destination/i);
    });
  });

  test('an enhanced-restart reconcile starts the toggle checked with no renderer localStorage write (PRR-059)', async () => {
    H.reset({ mode: 'api' });
    const diagnostics = bridgeWith({
      getState: vi.fn(async () => ({ active: true, enhanced: true })),
    });
    installDesktopBridgeStub({ diagnostics } as unknown as Partial<DesktopApiBridge>);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    render(
      <DesktopSessionProvider value={{ session: makeSession(), models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>,
    );
    // The authority reports enhanced:true -> the toggle starts CHECKED and
    // the renderer's live level follows; the browser persistence copy is
    // never written inside Electron.
    const toggle = await screen.findByTestId('diagnostics-enhanced-toggle');
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    await settle();
    expect(enhancedLoggingEnabled()).toBe(true);
    expect(localStorage.getItem(DIAGNOSTICS_ENHANCED_KEY)).toBeNull();
    expect(failureText()).toBe('');
  });

  test('an older main without the diagnostics namespace keeps the controls present and writes nothing', async () => {
    H.reset({ mode: 'api' });
    installDesktopBridgeStub({ diagnostics: undefined } as Partial<DesktopApiBridge>);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    render(
      <DesktopSessionProvider value={{ session: makeSession(), models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>,
    );
    // No bridge calls crash the block; inside Electron there is no browser
    // authority either (PRR-076): the toggle stays unavailable (focusable,
    // aria-disabled) and a click neither calls a bridge nor writes the key.
    const toggle = await screen.findByTestId('diagnostics-enhanced-toggle');
    expect(toggle).toBeInTheDocument();
    await settle();
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).not.toHaveAttribute('disabled');
    await act(async () => {
      fireEvent.click(toggle);
    });
    await settle();
    expect(statusText()).toBe('');
    expect(failureText()).toBe('');
    expect(localStorage.getItem(DIAGNOSTICS_ENHANCED_KEY)).toBeNull();
    expect(enhancedLoggingEnabled()).toBe(false);
  });

  test('the controls stay focusable while busy and the status region is wired to them (PRR-026/062/085)', async () => {
    H.reset({ mode: 'api' });
    let release!: () => void;
    const diagnostics = bridgeWith({
      setEnhancedLevel: vi.fn(
        (enabled: boolean) =>
          new Promise<{ ok: true; enhanced: boolean }>((resolve) => {
            release = () => resolve({ ok: true, enhanced: enabled });
          }),
      ),
    });
    installDesktopBridgeStub({ diagnostics } as unknown as Partial<DesktopApiBridge>);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    render(
      <DesktopSessionProvider value={{ session: makeSession(), models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>,
    );
    const toggle = await screen.findByTestId('diagnostics-enhanced-toggle');
    const button = screen.getByTestId('diagnostics-export');
    // PRR-085: both controls reference the status region; PRR-062: the region
    // is an atomic polite live region.
    expect(toggle).toHaveAttribute('aria-describedby', expect.stringContaining('diagnostics-status'));
    expect(button).toHaveAttribute('aria-describedby', 'diagnostics-status');
    const region = screen.getByTestId('diagnostics-status');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    // Wait for the mount reconcile before driving the busy window (the
    // unavailable state is aria-disabled too, for a different reason).
    await waitFor(() => {
      expect(diagnostics.getState).toHaveBeenCalled();
    });
    await settle();
    expect(toggle).not.toHaveAttribute('aria-disabled');
    await act(async () => {
      fireEvent.click(toggle);
    });
    // PRR-026: busy conveys aria-disabled and NEVER the native disabled
    // attribute (the control keeps focus); activation is suppressed.
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).not.toHaveAttribute('disabled');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toHaveAttribute('disabled');
    release();
    await waitFor(() => {
      expect(statusText()).toMatch(/enhanced logging on/i);
    });
    expect(toggle).not.toHaveAttribute('aria-disabled');
    expect(toggle).toBeChecked();
  });
});

describe('Diagnostics wiring (pr255 review): core mutation guards', () => {
  test('the export builder re-gates a RAW ring entry (PRR-050)', async () => {
    __resetLoggingCoreForTests();
    // Every legitimate producer pre-gates (the ring stores redacted
    // messages), so a re-gate assertion over ring content alone survives a
    // builder mutation. The injection seam used here: admittedEntries()
    // returns the LIVE ring array, so pushing through the snapshot feeds the
    // builder un-gated bytes — something no core producer can do.
    const rawEntry: LogEntry = {
      ts: new Date().toISOString(),
      level: 'error',
      scope: 'seam',
      message: 'raw probe password=hunter2',
      sessionId: 'seam-session',
      seq: 9999,
    };
    (admittedEntries() as LogEntry[]).push(rawEntry);
    // The real builder (this suite mocks the module for the PAGE; the guard
    // asserts the production code, not the mock).
    const actual = await vi.importActual<typeof import('../../lib/logging/export')>('../../lib/logging/export');
    const bundle = JSON.parse(actual.buildDiagnosticsBundle()) as { entries: LogEntry[] };
    expect(bundle.entries[bundle.entries.length - 1]?.message).toBe('raw probe password=[redacted]');
  });

  test('__resetLoggingCoreForTests restores the pristine state (reset symmetry, PRR-052)', () => {
    __resetLoggingCoreForTests();
    // Silence the console sinks for the duration (the recording-sinks idiom
    // from web-logging.test.ts) so the probe entries do not print.
    setConsoleSinks({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    // Drive every reachable holder away from its reset value, then reset and
    // assert the post-reset state — a reset that forgets a holder (the
    // mutation this kills) leaves it visible here.
    setEnhancedLogging(true);
    createLogger('reset-symmetry').info('entry one');
    expect(enhancedLoggingEnabled()).toBe(true);
    expect(admittedEntries().length).toBeGreaterThan(0);
    __resetLoggingCoreForTests();
    expect(enhancedLoggingEnabled()).toBe(false);
    expect(admittedEntries()).toEqual([]);
    expect(__deliveryStateForTests()).toEqual({ queued: 0, inFlight: false });
    // The seq counter restarts: the first post-reset entry is seq 1 again.
    createLogger('reset-symmetry').info('after reset');
    expect(admittedEntries()[0]?.seq).toBe(1);
  });

  test('the non-ring buffer caps stay pinned at their plan values (PRR-053)', () => {
    // Literals, not the constants: the caps are plan-pinned contracts, so a
    // mutated constant must fail here rather than stay self-consistent (the
    // rule web-logging.test.ts applies to RING_LIMIT).
    expect(PENDING_LIMIT).toBe(512);
    expect(FORWARD_QUEUE_LIMIT).toBe(1000);
  });
});
