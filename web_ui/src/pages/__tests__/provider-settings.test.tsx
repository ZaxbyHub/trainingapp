/**
 * Permanent regression tests for the provider-mode settings surface (trace
 * external-llm-provider-settings):
 *   - the frozen C1 label queries (/base url/i, /model/i, /api key/i) each
 *     resolve to EXACTLY ONE input — the label-collision guard;
 *   - every RAG preset PUT is bounded (1..10), DISTINCT per preset, and
 *     carries no `rag_reranking_enabled` (the AC4 permanent companion);
 *   - the Response Quality group is disabled in provider mode (AC5);
 *   - InferenceModeToggle renders null in provider mode even with a
 *     non-empty serverUrl.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

import * as inferenceModule from '../../lib/inference';
import * as themeModule from '../../lib/theme';

vi.mock('../../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../../lib/theme', () => ({
  useTheme: vi.fn(),
}));

vi.mock('../../lib/storage/profile', () => ({
  getProfilePrefix: vi.fn(() => 'testprfx'),
  deleteNamespace: vi.fn(() => Promise.resolve()),
  listStalePrefixes: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../lib/llm/model-download', () => ({
  ModelDownloadManager: vi.fn().mockImplementation(() => ({
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
  })),
}));

vi.mock('../../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn().mockImplementation(() => ({
    checkModelCached: vi.fn(() => Promise.resolve(false)),
  })),
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

vi.mock('../../components/ModelDownloadProgress', () => ({
  ModelDownloadProgress: () => null,
}));

vi.mock('../../lib/first-run', () => ({
  fetchFirstRunStatus: vi.fn(async () => null),
  resetFirstRun: vi.fn(async () => undefined),
  emitFirstRunReopen: vi.fn(),
}));

import { SettingsPage } from '../SettingsPage';
import { DesktopSessionProvider, type DesktopSession } from '../../lib/desktop-session';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../../test/desktop-bridge-stub';
import { InferenceModeToggle } from '../../components/InferenceModeToggle';
import type { ApiClient } from '../../lib/api';

// F-001 (PR #138 CI red): the mock MUST declare its parameter type — a
// zero-arg vi.fn types mock.calls as [] tuples, and the `call[0]` access in
// the RAG-preset census below then fails TS2352/TS2493 under
// tsconfig.test.json (the main typecheck does not see test files).
const updateSettingsMock = vi.fn(async (_patch: Record<string, unknown>) => ({ status: 'ok' }));

function makeSession(): DesktopSession {
  const apiClient = {
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: updateSettingsMock,
    getModelStatus: vi.fn(async () => ({ profile: 'stub', models: {} }) as never),
  } as unknown as ApiClient;
  return {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'trace-token',
    mode: 'node',
    apiClient,
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  };
}

function mockContext(overrides: Record<string, unknown>): void {
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
    ...overrides,
  } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);

  vi.mocked(themeModule.useTheme).mockReturnValue({
    theme: 'light',
    themePreference: 'system',
    setTheme: vi.fn(),
    isDark: false,
  } as unknown as ReturnType<typeof themeModule.useTheme>);
}

describe('provider-mode settings surface', () => {
  beforeEach(() => {
    localStorage.clear();
    mockContext({ mode: 'provider' });
  });

  afterEach(() => {
    cleanup();
    removeDesktopBridgeStub();
  });

  test('provider section renders and the frozen label queries are each unique', async () => {
    render(<SettingsPage />);
    expect(await screen.findByText('Provider connection')).toBeInTheDocument();
    for (const query of [/base url/i, /model/i, /api key/i]) {
      const matches = screen.getAllByLabelText(query);
      const inputs = matches.filter((el): el is HTMLInputElement => el.tagName === 'INPUT');
      expect(
        inputs.length,
        `query ${String(query)} must match exactly one INPUT (got ${inputs.length})`
      ).toBe(1);
    }
    // The provider section discloses that context leaves the machine and that
    // answers are ungrounded (privacy + honesty copy).
    expect(screen.getByText(/conversation context is sent to that server/i)).toBeInTheDocument();
    expect(screen.getByText(/not grounded in your documents/i)).toBeInTheDocument();
  });

  test('Response Quality group is disabled in provider mode with the only-browser-local caption', async () => {
    const { container } = render(<SettingsPage />);
    // Sections mount after the settingsLoaded effect — await the section first.
    await screen.findByText('Response Quality');
    // Query by the frozen input selector (a11y-role visibility of disabled
    // fieldsets varies by environment; the C4 frozen check uses the same
    // selector).
    const quality = container.querySelector(
      'input[name="rag-preset"][value="quality"]'
    ) as HTMLInputElement | null;
    expect(quality, 'rag-preset quality input must render').not.toBeNull();
    // jsdom does not propagate <fieldset disabled> to descendants; assert the
    // fieldset's own disabled property (browsers propagate it natively).
    expect(quality?.closest('fieldset')?.disabled).toBe(true);
    expect(screen.getByText(/Applies to browser-local inference only/i)).toBeInTheDocument();
  });
});

describe('RAG preset mirror (Electron api mode)', () => {
  beforeEach(() => {
    installDesktopBridgeStub();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
    mockContext({ mode: 'api' });
  });

  afterEach(() => {
    cleanup();
    removeDesktopBridgeStub();
    vi.unstubAllGlobals();
    updateSettingsMock.mockClear();
  });

  // settings-wiring-honesty (user decision 2026-09-30, reversing PR #138's
  // rag_n_results-only mirror): presets control reranking, max tokens and
  // temperature too, so each PUT carries the preset's full desktop patch.
  test('presets PUT the full desktop patch with distinct in-bounds rag_n_results', async () => {
    const session = makeSession();
    const ui = () => (
      <DesktopSessionProvider value={{ session, models: null, loading: false, error: null }}>
        <SettingsPage />
      </DesktopSessionProvider>
    );
    const utils = render(ui());
    expect(await screen.findByText('Response Quality')).toBeInTheDocument();

    const clickPreset = async (preset: string, wantCalls: number) => {
      const radio = utils.container.querySelector(`input[name="rag-preset"][value="${preset}"]`);
      expect(radio, `rag-preset input for ${preset} must render`).not.toBeNull();
      fireEvent.click(radio as HTMLInputElement);
      await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledTimes(wantCalls));
    };

    await clickPreset('quality', 1);
    await clickPreset('fast', 2);

    mockContext({ mode: 'api', ragPreset: 'quality' });
    utils.rerender(ui());
    await clickPreset('balanced', 3);

    const patches = updateSettingsMock.mock.calls.map((call) => call[0]);
    const relevant = patches.filter((p) => 'rag_n_results' in p);
    expect(relevant).toHaveLength(3);
    for (const patch of relevant) {
      expect(Number.isInteger(patch.rag_n_results)).toBe(true);
      expect(patch.rag_n_results as number).toBeGreaterThanOrEqual(1);
      expect(patch.rag_n_results as number).toBeLessThanOrEqual(10);
      expect(Object.keys(patch).sort()).toEqual(
        ['rag_max_tokens', 'rag_n_results', 'rag_reranking_enabled', 'rag_temperature'],
      );
      expect(patch.rag_max_tokens as number).toBeGreaterThanOrEqual(256);
      expect(patch.rag_max_tokens as number).toBeLessThanOrEqual(4096);
    }
    // Fast promises "no reranking, shorter answers"; Quality reranks longer.
    expect(relevant[0]).toEqual({ rag_n_results: 10, rag_reranking_enabled: true, rag_max_tokens: 1024, rag_temperature: 0.2 });
    expect(relevant[1]).toEqual({ rag_n_results: 5, rag_reranking_enabled: false, rag_max_tokens: 384, rag_temperature: 0.3 });
    expect(relevant[2]).toEqual({ rag_n_results: 8, rag_reranking_enabled: true, rag_max_tokens: 512, rag_temperature: 0.3 });
    // DISTINCT per preset: Quality must not collapse into Balanced in
    // GET /settings (the AC4 observability clause).
    const values = new Set(relevant.map((p) => p.rag_n_results));
    expect(values.size).toBe(3);
  });
});

describe('InferenceModeToggle', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders null in provider mode even with a non-empty serverUrl', () => {
    mockContext({ mode: 'provider', serverUrl: 'http://127.0.0.1:4567' });
    const { container } = render(<InferenceModeToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  test('still renders for api mode with a serverUrl inside the desktop app (existing behavior)', () => {
    installDesktopBridgeStub();
    mockContext({ mode: 'api', serverUrl: 'http://127.0.0.1:4567' });
    const { container } = render(<InferenceModeToggle />);
    expect(container).not.toBeEmptyDOMElement();
    removeDesktopBridgeStub();
  });

  test('settings-wiring-honesty (AC4): renders null outside the desktop app (no browser API-server mode)', () => {
    mockContext({ mode: 'api', serverUrl: 'http://127.0.0.1:4567' });
    const { container } = render(<InferenceModeToggle />);
    expect(container).toBeEmptyDOMElement();
  });
});
