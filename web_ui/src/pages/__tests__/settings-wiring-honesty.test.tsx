/**
 * settings-wiring-honesty: SettingsPage behavior behind AC1-AC10 that the
 * frozen acceptance checks do not pin directly — the desktop preset contract
 * (full-patch PUT, backend-as-truth display, PUT failure revert, reset, no
 * session), Clear Cache key removal + reload seam, the overlay destination's
 * focus, and the About credits. Assertions use roles, labels and backend calls.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import { RELOAD_AFTER_CLEAR_MS, SettingsPage } from '../SettingsPage';
import { DesktopSessionProvider, type DesktopSession } from '../../lib/desktop-session';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../../test/desktop-bridge-stub';
import type { ApiClient } from '../../lib/api';
import { DESKTOP_MODELS_CHANGED_EVENT } from '../../lib/desktop-models-events';
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
    expect(screen.getByText(/custom server settings/i)).toHaveTextContent(/chat in this window uses the fast preset/i);
  });

  test('a preset matched on n_results alone does not claim its other settings and re-applies on re-select (final-critic F2)', async () => {
    H.reset({ mode: 'api' });
    const q = DESKTOP_PRESET_SETTINGS.quality;
    const confirmed = backend([...DESKTOP_PRESET_KEYS], {
      n_results: q.rag_n_results,
      reranking_enabled: q.rag_reranking_enabled,
      max_tokens: q.rag_max_tokens,
      temperature: q.rag_temperature,
    });
    // Saved before presets wrote the full patch: only rag_n_results is explicit.
    const { session, updateSettings } = makeSession(
      backend(['rag_n_results'], { n_results: q.rag_n_results }),
      async () => confirmed,
    );
    const { container } = renderElectron(session);
    await settle();
    expect(checkedPreset(container)).toBe('quality'); // IC4: still reads back
    const desc = (p: string) => document.getElementById(`rag-${p}-desc`)?.textContent ?? '';
    expect(desc('quality')).toMatch(/re-select a preset to apply its reranking and answer settings/i);
    expect(desc('quality')).not.toMatch(/overrides the inference profile/i);
    // Selecting another preset sends the full patch, so its card may promise it.
    expect(desc('fast')).toMatch(/overrides the inference profile/i);

    // Clicking the already-checked card (no change event) re-applies the full patch.
    await act(async () => {
      fireEvent.click(container.querySelector('input[name="rag-preset"][value="quality"]') as HTMLInputElement);
    });
    await settle();
    expect(updateSettings).toHaveBeenCalledWith({ ...q });
    expect(desc('quality')).toMatch(/overrides the inference profile/i);
    expect(desc('quality')).not.toMatch(/re-select a preset/i);
  });

  test('a fully explicit preset states the override and shows no re-select caption; clicking it again sends nothing', async () => {
    H.reset({ mode: 'api' });
    const q = DESKTOP_PRESET_SETTINGS.quality;
    const { session, updateSettings } = makeSession(
      backend([...DESKTOP_PRESET_KEYS], {
        n_results: q.rag_n_results,
        reranking_enabled: q.rag_reranking_enabled,
        max_tokens: q.rag_max_tokens,
        temperature: q.rag_temperature,
      }),
    );
    const { container } = renderElectron(session);
    await settle();
    expect(checkedPreset(container)).toBe('quality');
    const quality = document.getElementById('rag-quality-desc')?.textContent ?? '';
    expect(quality).toMatch(/overrides the inference profile's answer length and temperature/i);
    expect(quality).not.toMatch(/re-select a preset/i);
    await act(async () => {
      fireEvent.click(container.querySelector('input[name="rag-preset"][value="quality"]') as HTMLInputElement);
    });
    await settle();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  test('no reranker on this installation is stated on the reranking presets', async () => {
    H.reset({ mode: 'api' });
    const { session } = makeSession(backend([], {}, { reranking_available: false }));
    renderElectron(session);
    await settle();
    // Balanced and Quality rerank; Fast does not.
    expect(screen.getAllByText(/reranking unavailable on this installation/i)).toHaveLength(2);
  });

  test('saving the inference profile notifies the app to re-read /status/models (footer chip), only after the PUT succeeds', async () => {
    H.reset({ mode: 'api' });
    const changed = vi.fn();
    window.addEventListener(DESKTOP_MODELS_CHANGED_EVENT, changed);
    try {
      let fail = false;
      const { session, updateSettings } = makeSession(backend([], {}), async () => {
        if (fail) throw new Error('backend down');
        return { status: 'ok' };
      });
      const { container } = renderElectron(session);
      await settle();
      const radio = (v: string) => container.querySelector(`input[name="desktop-inference-profile"][value="${v}"]`) as HTMLInputElement;
      await act(async () => {
        fireEvent.click(radio('fast'));
      });
      await settle();
      expect(updateSettings).toHaveBeenCalledWith({ 'inference.profile': 'fast' });
      expect(changed).toHaveBeenCalledTimes(1);

      fail = true;
      await act(async () => {
        fireEvent.click(radio('quality'));
      });
      await settle();
      expect(changed).toHaveBeenCalledTimes(1); // a failed save must not announce a change
    } finally {
      window.removeEventListener(DESKTOP_MODELS_CHANGED_EVENT, changed);
    }
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
    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1), { timeout: RELOAD_AFTER_CLEAR_MS + 1000 });
  });

  // PR #140 review (FB140-011): a failed step no longer skips the rest — the
  // saved settings are still removed, so the page reloads after reporting.
  test('a failed step reports the error, still removes the saved settings, and reloads', async () => {
    H.reset({ mode: 'browser-local' });
    for (const key of USER_SETTING_KEYS) localStorage.setItem(key, 'x');
    deleteNamespaceMock.mockImplementation(() => Promise.reject(new Error('blocked')));
    const reloadPage = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SettingsPage reloadPage={reloadPage} />);
    const button = await screen.findByRole('button', { name: /clear cache/i });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/could not clear all data/i);
    for (const key of USER_SETTING_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(document.getElementById('clear-cache-status')?.textContent).toMatch(/saved settings were removed; reloading/i);
    // Visible, not screen-reader-only: sighted users see why the page reloads.
    const note = screen.getByText(/your saved settings were removed; reloading the page/i);
    // Lumen phase 4: screen-reader-only text is the ui-visually-hidden class, so
    // assert the class (an inline-style check would now pass vacuously).
    expect(note).not.toHaveClass('ui-visually-hidden');
    expect(note.closest('.ui-visually-hidden')).toBeNull();
    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1), { timeout: RELOAD_AFTER_CLEAR_MS + 1000 });
  });

  const clearCopy = () => document.getElementById('clear-cache-desc')?.textContent ?? '';

  test('browser app: idle and confirming copy name what is removed and that chat history is kept (final-critic F1)', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    const button = await screen.findByRole('button', { name: /clear cache/i });
    expect(clearCopy()).toMatch(/chat history is kept/i);
    fireEvent.click(button);
    const confirming = clearCopy();
    expect(confirming).toMatch(/documents and keyword\/vector indexes stored in this browser/i);
    // FB140-014: the model files named are WebLLM's (wllama stores none).
    expect(confirming).toMatch(/downloaded WebLLM model files \(the default wllama engine stores none\)/i);
    expect(confirming).toMatch(/your chat history \(conversations\) is kept/i);
    // browser-training-parity: the browser app's installed packs are removed too.
    expect(confirming).toMatch(/installed training and knowledge packs/i);
    // AC5: the removed settings are enumerated.
    expect(confirming).toMatch(
      /inference mode, browser engine and response-quality choices, theme, external model connection and API key, sidebar state, last-opened course and the pack update setting/i,
    );
  });

  test('desktop app: copy names the browser-side data removed and keeps chat history and backend documents/settings (final-critic F1)', async () => {
    H.reset({ mode: 'api' });
    const { session } = makeSession(backend([], {}));
    renderElectron(session);
    const button = await screen.findByRole('button', { name: /clear cache/i });
    expect(clearCopy()).toMatch(/chat history and documents in the desktop library are kept/i);
    expect(clearCopy()).not.toMatch(/local caches/i);
    fireEvent.click(button);
    const confirming = clearCopy();
    expect(confirming).toMatch(/browser-side document and keyword\/vector index databases/i);
    // FB140-014: only WebLLM files downloaded in this window are deleted.
    expect(confirming).toMatch(/any WebLLM model files downloaded in this window/i);
    expect(confirming).not.toMatch(/browser-model/i);
    expect(confirming).toMatch(
      /inference mode, browser engine and response-quality choices, theme, external model connection and API key, sidebar state, last-opened course and the pack update setting/i,
    );
    expect(confirming).toMatch(/kept: your chat history \(conversations\), and the documents and settings stored by the desktop backend/i);
    expect(confirming).not.toMatch(/local caches/i);
  });
});

describe('overlay destination (AC10)', () => {
  test('initialSection="model-connection" scrolls to the external-model section and focuses its heading', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage initialSection="model-connection" />);
    // Lumen phase 4: the id is the "Model & connection" section (spec section 5),
    // which hosts the generator source and the external-model controls.
    const heading = await screen.findByRole('heading', { level: 2, name: /^model & connection$/i });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.getElementById('model-connection')).toContainElement(
      screen.getByRole('radio', { name: /^local or network server$/i }),
    );
  });

  test('Electron app (desktop overlay destination): initialSection="model-connection" focuses the External model heading', async () => {
    // universal-provider-settings-overhaul: DesktopModelBlockedOverlay's
    // "Use a local server or cloud model" calls onOpenSettings('model-connection');
    // inside Electron (api mode, desktop bridge + session) that lands here.
    H.reset({ mode: 'api' });
    const { session } = makeSession(backend([], {}));
    renderElectron(session, { initialSection: 'model-connection' });
    const heading = await screen.findByRole('heading', { level: 2, name: /^model & connection$/i });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.getElementById('model-connection')).toContainElement(
      screen.getByRole('radio', { name: /^cloud provider$/i }),
    );
  });

  test('without initialSection nothing in the page takes focus', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await screen.findByRole('heading', { level: 2, name: /^model & connection$/i });
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Lumen phase 4: six sections + section nav (design-language.md section 5)', () => {
  const SECTIONS: Array<[string, RegExp]> = [
    ['model-connection', /^model & connection$/i],
    ['answers', /^answers$/i],
    ['appearance', /^appearance$/i],
    ['storage-privacy', /^storage & privacy$/i],
    ['updates', /^updates$/i],
    ['about', /^about$/i],
  ];

  test('the nav lists exactly the six sections in page order, each a region with a stable id', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await settle();
    const nav = screen.getByRole('navigation', { name: /^settings sections$/i });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(SECTIONS.map(([id]) => `#${id}`));
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2s).toEqual(['Model & connection', 'Answers', 'Appearance', 'Storage & privacy', 'Updates', 'About']);
    for (const [id, name] of SECTIONS) {
      const region = screen.getByRole('region', { name });
      expect(region.id).toBe(id);
    }
    // The compact "Jump to section" select offers the same targets.
    const select = within(nav).getByLabelText(/^jump to section$/i);
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(SECTIONS.map(([id]) => id));
  });

  test('a nav link moves focus to that section heading and marks it current; the select does the same', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await settle();
    const nav = screen.getByRole('navigation', { name: /^settings sections$/i });
    const link = within(nav).getByRole('link', { name: 'Storage & privacy' });
    fireEvent.click(link);
    expect(screen.getByRole('heading', { level: 2, name: /^storage & privacy$/i })).toHaveFocus();
    expect(link).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('link', { name: 'Answers' })).not.toHaveAttribute('aria-current');
    // M1 (WCAG 3.2.2): changing the select only scrolls; focus stays on the select.
    const select = within(nav).getByLabelText(/^jump to section$/i) as HTMLSelectElement;
    select.focus();
    fireEvent.change(select, { target: { value: 'updates' } });
    fireEvent.change(select, { target: { value: 'about' } });
    expect(select).toHaveFocus();
    expect(select.value).toBe('about');
    // Explicit activation moves focus: Enter on the select (read one frame later, after
    // a Firefox open-dropdown commit has fired change; review L-d) ...
    fireEvent.keyDown(select, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /^about$/i })).toHaveFocus());
    // ... or the adjacent Go button ("Go to section"), which reads the select's actual value.
    select.focus();
    fireEvent.change(select, { target: { value: 'updates' } });
    expect(select).toHaveFocus();
    fireEvent.click(within(nav).getByRole('button', { name: /^go to section$/i, hidden: true }));
    expect(screen.getByRole('heading', { level: 2, name: /^updates$/i })).toHaveFocus();
  });

  // M1 with REAL arrow keys (which change a select's value only in a real browser) is
  // pinned in e2e/visual/lumen-axe-settings-full.spec.ts; jsdom/user-event does not
  // move a <select> on ArrowDown, so a unit test here would pass vacuously.

  test('M2: a server source with egress OFF keeps every built-in control (browser app)', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await settle();
    const model = within(screen.getByRole('region', { name: /^model & connection$/i }));
    fireEvent.click(model.getByRole('radio', { name: /^local or network server$/i }));
    expect(model.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
    expect(model.getByTestId('builtin-still-answering')).toBeInTheDocument();
    expect(model.getByRole('radio', { name: /wllama \(cpu/i })).toBeInTheDocument();
    expect(model.getByRole('group', { name: /^browser engine$/i })).toBeInTheDocument();
    expect(model.getByRole('group', { name: /^hardware capability$/i })).toBeInTheDocument();
    expect(model.getByText(/^Status:/)).toBeInTheDocument();
  });

  test('M2: a server source with egress OFF keeps the desktop run location, profile and backend status', async () => {
    H.reset({ mode: 'api' });
    const { session } = makeSession(backend([], {}));
    renderElectron(session);
    await settle();
    const model = within(screen.getByRole('region', { name: /^model & connection$/i }));
    fireEvent.click(model.getByRole('radio', { name: /^cloud provider$/i }));
    expect(model.getByRole('switch', { name: /^use external model$/i })).not.toBeChecked();
    expect(model.getByRole('radio', { name: /^desktop backend$/i })).toBeChecked();
    expect(model.getByRole('radio', { name: /^in this window$/i })).toBeInTheDocument();
    expect(model.getByRole('group', { name: /^desktop backend$/i })).toBeInTheDocument();
    expect(model.getByRole('group', { name: /^inference profile$/i })).toBeInTheDocument();
  });

  test('every control lives in its section (nothing lost in the regroup)', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await settle();
    const region = (name: RegExp) => within(screen.getByRole('region', { name }));
    const model = region(/^model & connection$/i);
    expect(model.getByRole('radio', { name: /^built-in model$/i })).toBeInTheDocument();
    expect(model.getByRole('radio', { name: /wllama \(cpu/i })).toBeInTheDocument();
    expect(model.getByRole('group', { name: /^hardware capability$/i })).toBeInTheDocument();
    expect(region(/^answers$/i).getByRole('radio', { name: /^balanced$/i })).toBeInTheDocument();
    expect(region(/^appearance$/i).getByRole('radio', { name: /^dark$/i })).toBeInTheDocument();
    const storage = region(/^storage & privacy$/i);
    expect(storage.getByRole('button', { name: /clear cache/i })).toBeInTheDocument();
    expect(storage.getByRole('progressbar', { name: /memory used/i })).toBeInTheDocument();
    expect(storage.getByTestId('privacy-note')).toHaveTextContent(/leave this device only when an external model is switched on/i);
    expect(region(/^updates$/i).getByTestId('updates-opt-in')).toBeInTheDocument();
    expect(region(/^about$/i).getByText(/^Version:/)).toBeInTheDocument();
  });

  test('desktop app: the built-in model runs "In this window" or in the "Desktop backend" (renamed from Browser-local / API Server)', async () => {
    H.reset({ mode: 'api' });
    const { session } = makeSession(backend([], {}));
    const { container } = renderElectron(session);
    await settle();
    const model = within(screen.getByRole('region', { name: /^model & connection$/i }));
    expect(model.getByRole('radio', { name: /^desktop backend$/i })).toBeChecked();
    expect(model.getByRole('radio', { name: /^in this window$/i })).not.toBeChecked();
    expect(container.querySelectorAll('input[name="inference-mode"]')).toHaveLength(2);
    expect(screen.queryByText(/api server/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /browser-local/i })).not.toBeInTheDocument();
    // First-run setup lives in About (desktop only).
    expect(within(screen.getByRole('region', { name: /^about$/i })).getByTestId('first-run-rerun')).toBeInTheDocument();
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

  // universal-provider-settings-overhaul: the provider MODE is retired; the
  // browser-local credit names the external model option instead.
  test('browser-local credits the external model option', async () => {
    H.reset({ mode: 'browser-local' });
    render(<SettingsPage />);
    await settle();
    expect(aboutText()).toMatch(/external model you configured/i);
  });
});
