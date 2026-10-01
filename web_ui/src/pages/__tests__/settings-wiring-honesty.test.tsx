/**
 * settings-wiring-honesty: SettingsPage behavior behind AC1-AC10 that the
 * frozen acceptance checks do not pin directly — the desktop preset contract
 * (full-patch PUT, backend-as-truth display, PUT failure revert, reset, no
 * session), Clear Cache key removal + reload seam, the overlay destination's
 * focus, and the About credits. Assertions use roles, labels and backend calls.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Stateful inference-mode store so setters re-render (same pattern as the
// trace's frozen checks).
const H = vi.hoisted(() => {
  const h = {
    state: {} as Record<string, unknown>,
    snapshot: null as Record<string, unknown> | null,
    listeners: new Set<() => void>(),
    calls: { setRagPreset: [] as string[] },
    notify() {
      h.snapshot = null;
      h.listeners.forEach((l) => l());
    },
    set(patch: Record<string, unknown>) {
      h.state = { ...h.state, ...patch };
      h.notify();
    },
    reset(patch: Record<string, unknown> = {}) {
      h.calls.setRagPreset.length = 0;
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
    setRagPreset: (p: string) => {
      h.calls.setRagPreset.push(p);
      h.set({ ragPreset: p });
    },
    setServerUrl: (u: string) => h.set({ serverUrl: u }),
    setBrowserEngine: (e: string) => h.set({ browserEngine: e }),
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
const deleteNamespaceMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../lib/storage/profile', () => ({
  getProfilePrefix: vi.fn(() => 'testprfx'),
  deleteNamespace: deleteNamespaceMock,
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
  LLM_MODEL_DIR: 'gemma-4-e2b-it',
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

import { SettingsPage } from '../SettingsPage';
import { DesktopSessionProvider, type DesktopSession } from '../../lib/desktop-session';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../../test/desktop-bridge-stub';
import type { ApiClient } from '../../lib/api';
import { DESKTOP_PRESET_KEYS, DESKTOP_PRESET_SETTINGS } from '../../lib/rag/rag-presets';
import { INTERNAL_KEYS, USER_SETTING_KEYS } from '../../lib/storage/persisted-keys';
import pkg from '../../../package.json';

// Minimal IndexedDB / Cache Storage stubs: the Clear Cache handler opens
// edgevec-db and deletes the legacy settings DB.
function idbRequest(result: unknown = null) {
  const req: Record<string, unknown> = { onsuccess: null, onerror: null, onblocked: null, result };
  setTimeout(() => (req.onsuccess as ((e: Event) => void) | null)?.call(req, new Event('success')), 0);
  return req;
}
const fakeStore = {
  delete: vi.fn(() => {
    const req = idbRequest();
    setTimeout(() => fakeTx.oncomplete?.call(fakeTx, new Event('complete')), 0);
    return req;
  }),
};
const fakeTx = {
  objectStore: vi.fn(() => fakeStore),
  oncomplete: null as ((e: Event) => void) | null,
  onerror: null as ((e: Event) => void) | null,
  onabort: null as ((e: Event) => void) | null,
};
const fakeDb = { transaction: vi.fn(() => fakeTx), objectStoreNames: { contains: vi.fn(() => true) }, close: vi.fn() };
(globalThis as Record<string, unknown>).indexedDB = {
  open: vi.fn(() => idbRequest(fakeDb)),
  deleteDatabase: vi.fn(() => idbRequest()),
};

type Patch = Record<string, unknown>;

function makeSession(getSettingsResult: Record<string, unknown>, put?: (patch: Patch) => Promise<unknown>) {
  const updateSettings = vi.fn(put ?? (async (_patch: Patch) => ({ status: 'ok' })));
  const getSettings = vi.fn(async () => getSettingsResult as never);
  const apiClient = {
    getSettings,
    updateSettings,
    getModelStatus: vi.fn(async () => ({ engine: 'stub', profile: 'auto', models: { quality: { present: false }, fast: { present: false } } }) as never),
  } as unknown as ApiClient;
  const session: DesktopSession = {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'test-token',
    mode: 'node',
    apiClient,
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  };
  return { session, updateSettings, getSettings };
}

function renderElectron(session: DesktopSession | null, props: React.ComponentProps<typeof SettingsPage> = {}) {
  installDesktopBridgeStub();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
  return render(
    <DesktopSessionProvider value={{ session, models: null, loading: false, error: null }}>
      <SettingsPage {...props} />
    </DesktopSessionProvider>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

function checkedPreset(container: HTMLElement): string | null {
  const el = container.querySelector('input[name="rag-preset"]:checked') as HTMLInputElement | null;
  return el === null ? null : el.value;
}

function backend(explicit: string[], requested: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    n_results: 4,
    explicit_keys: explicit,
    requested: { n_results: null, reranking_enabled: null, max_tokens: null, temperature: null, ...requested },
    reranking_available: true,
    ...extra,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
});
afterEach(() => {
  cleanup();
  removeDesktopBridgeStub();
  vi.unstubAllGlobals();
  localStorage.clear();
  deleteNamespaceMock.mockImplementation(() => Promise.resolve());
});

describe('desktop Response Quality preset (AC1-AC3)', () => {
  test('a preset change PUTs the full patch and the confirmed explicit values drive the display', async () => {
    H.reset({ mode: 'api' });
    const q = DESKTOP_PRESET_SETTINGS.quality;
    const confirmed = backend([...DESKTOP_PRESET_KEYS], {
      n_results: q.rag_n_results,
      reranking_enabled: q.rag_reranking_enabled,
      max_tokens: q.rag_max_tokens,
      temperature: q.rag_temperature,
    });
    const { session, updateSettings } = makeSession(backend([], {}), async () => confirmed);
    const { container } = renderElectron(session);
    await settle();
    expect(checkedPreset(container)).toBeNull();
    expect(screen.getByText(/using server defaults/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(container.querySelector('input[name="rag-preset"][value="quality"]') as HTMLInputElement);
    });
    await settle();

    expect(updateSettings).toHaveBeenCalledWith({ ...q });
    expect(checkedPreset(container)).toBe('quality');
    expect(H.calls.setRagPreset).toEqual(['quality']);
  });

  test('backend values matching no preset show "Custom server settings" with nothing checked', async () => {
    H.reset({ mode: 'api', ragPreset: 'fast' });
    const { session } = makeSession(backend(['rag_n_results'], { n_results: 3 }));
    const { container } = renderElectron(session);
    await settle();
    expect(checkedPreset(container)).toBeNull();
    expect(screen.getByText(/custom server settings/i)).toHaveTextContent(/browser-local chat uses the fast preset/i);
  });

  test('no reranker on this installation is stated on the reranking presets', async () => {
    H.reset({ mode: 'api' });
    const { session } = makeSession(backend([], {}, { reranking_available: false }));
    renderElectron(session);
    await settle();
    // Balanced and Quality rerank; Fast does not.
    expect(screen.getAllByText(/reranking unavailable on this installation/i)).toHaveLength(2);
  });

  test('a failed PUT shows an error and reverts the selection', async () => {
    H.reset({ mode: 'api', ragPreset: 'balanced' });
    const b = DESKTOP_PRESET_SETTINGS.balanced;
    const { session } = makeSession(backend(['rag_n_results'], { n_results: b.rag_n_results }), async () => {
      throw new Error('backend down');
    });
    const { container } = renderElectron(session);
    await settle();
    expect(checkedPreset(container)).toBe('balanced');

    await act(async () => {
      fireEvent.click(container.querySelector('input[name="rag-preset"][value="fast"]') as HTMLInputElement);
    });
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be applied.*backend down/i);
    expect(checkedPreset(container)).toBe('balanced');
    expect(H.state.ragPreset).toBe('balanced');
  });

  test('Reset to defaults sends the reset directive for the preset keys and shows server defaults', async () => {
    H.reset({ mode: 'api' });
    const b = DESKTOP_PRESET_SETTINGS.balanced;
    const { session, updateSettings } = makeSession(
      backend(['rag_n_results'], { n_results: b.rag_n_results }),
      async () => backend([], {}),
    );
    const { container } = renderElectron(session);
    await settle();
    expect(checkedPreset(container)).toBe('balanced');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));
    });
    await settle();

    expect(updateSettings).toHaveBeenCalledWith({ reset: [...DESKTOP_PRESET_KEYS] });
    expect(checkedPreset(container)).toBeNull();
    expect(screen.getByText(/using server defaults/i)).toBeInTheDocument();
  });

  test('desktop app whose backend session is unavailable: error, and nothing changes', async () => {
    H.reset({ mode: 'api', ragPreset: 'balanced' });
    const { container } = renderElectron(null);
    await settle();
    await act(async () => {
      fireEvent.click(container.querySelector('input[name="rag-preset"][value="fast"]') as HTMLInputElement);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/desktop backend is not available/i);
    expect(H.calls.setRagPreset).toEqual([]);
    expect(checkedPreset(container)).toBe('balanced');
  });

  test('the browser app never PUTs: its preset applies to browser-local chat only', async () => {
    H.reset({ mode: 'browser-local', ragPreset: 'balanced' });
    const { container } = render(<SettingsPage />);
    await settle();
    await act(async () => {
      fireEvent.click(container.querySelector('input[name="rag-preset"][value="quality"]') as HTMLInputElement);
    });
    expect(H.calls.setRagPreset).toEqual(['quality']);
    expect(checkedPreset(container)).toBe('quality');
  });

  test('switching into api mode re-reads GET /settings and applies the result (no silent PUT)', async () => {
    H.reset({ mode: 'browser-local' });
    const { session, getSettings, updateSettings } = makeSession(backend([], {}));
    const { container } = renderElectron(session);
    await settle();
    expect(checkedPreset(container)).toBeNull();
    const reads = getSettings.mock.calls.length;
    // The backend changed while the app was in another mode (e.g. another
    // window applied Quality): the re-read must drive the display.
    getSettings.mockImplementation(async () => backend(['rag_n_results'], { n_results: DESKTOP_PRESET_SETTINGS.quality.rag_n_results }) as never);
    await act(async () => {
      (H.actions.setMode as (m: string) => void)('api');
    });
    await settle();
    expect(getSettings.mock.calls.length).toBe(reads + 1);
    expect(checkedPreset(container)).toBe('quality');
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe('Clear Cache (AC5)', () => {
  test('removes every registered user setting, keeps internal keys, then reloads through the seam', async () => {
    H.reset({ mode: 'browser-local' });
    for (const key of USER_SETTING_KEYS) localStorage.setItem(key, 'x');
    for (const key of INTERNAL_KEYS) localStorage.setItem(key, 'keep');
    const reloadPage = vi.fn();
    render(<SettingsPage reloadPage={reloadPage} />);
    const button = await screen.findByRole('button', { name: /clear cache/i });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/cache cleared/i);

    for (const key of USER_SETTING_KEYS) expect(localStorage.getItem(key)).toBeNull();
    for (const key of INTERNAL_KEYS) expect(localStorage.getItem(key)).toBe('keep');
    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
  });

  test('a failed clear reports the error and does not reload', async () => {
    H.reset({ mode: 'browser-local' });
    deleteNamespaceMock.mockImplementation(() => Promise.reject(new Error('blocked')));
    const reloadPage = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SettingsPage reloadPage={reloadPage} />);
    const button = await screen.findByRole('button', { name: /clear cache/i });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/could not clear all data/i);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(reloadPage).not.toHaveBeenCalled();
  });
});

describe('overlay destination (AC10)', () => {
  test('initialSection="model-connection" scrolls to the external-model section and focuses its heading', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage initialSection="model-connection" />);
    const heading = await screen.findByRole('heading', { name: /inference mode/i });
    await waitFor(() => expect(heading).toHaveFocus());
    // The destination hosts the external (OpenAI-compatible) model option.
    expect(document.getElementById('model-connection')).toContainElement(
      screen.getByRole('radio', { name: /provider server/i }),
    );
  });

  test('without initialSection nothing in the page takes focus', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await screen.findByRole('heading', { name: /inference mode/i });
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('About (AC8)', () => {
  const aboutText = () => screen.getByRole('region', { name: /^about$/i }).textContent ?? '';

  test('browser-local: real version, product name, browser engine credits', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await settle();
    expect(aboutText()).toContain(`Version: ${pkg.version}`);
    expect(aboutText()).toMatch(/TrainingApp/);
    expect(aboutText()).toMatch(/WebLLM \(WebGPU\) or wllama/);
  });

  test('desktop api mode credits the desktop backend, never WebGPU', async () => {
    H.reset({ mode: 'api' });
    const { session } = makeSession(backend([], {}));
    renderElectron(session);
    await settle();
    expect(aboutText()).toMatch(/built-in desktop backend/i);
    expect(aboutText()).not.toMatch(/WebGPU/);
  });

  test('provider mode credits the external server', async () => {
    H.reset({ mode: 'provider' });
    render(<SettingsPage />);
    await settle();
    expect(aboutText()).toMatch(/external OpenAI-compatible server/i);
  });
});
