/**
 * settings-style-composition.test.tsx — AC8 (issue #41 D1, PRESERVING): the
 * FULL SettingsPage (through the settings-wiring-honesty harness seams, real
 * Settings components) renders and re-renders through EVERY current radio
 * family flipped BOTH directions without any React style warning — the
 * defect class the frozen C8 spec guards on the component level, pinned here
 * at the page-composition level the original D1 report described.
 *
 * Families covered (both directions / every option): Inference Mode
 * (inference-mode), Browser Engine (browser-engine), Response Quality
 * (rag-preset), desktop-inference-profile, desktop-gpu-acceleration, the
 * Theme SegmentedControl, and ExternalModelSection's generator-source group.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

// Stateful inference-mode store so radio flips re-render (settings-wiring-honesty harness).
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

import { SettingsPage } from '../SettingsPage';
import { DesktopSessionProvider, type DesktopSession } from '../../lib/desktop-session';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../../test/desktop-bridge-stub';
import type { ApiClient } from '../../lib/api';

const STYLE_WARNING_PATTERN = /Removing a style property|a style property during rerender|can lead to styling bugs/;

function spyOnStyleWarnings() {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return {
    styleWarnings(): string[] {
      const calls = [...errorSpy.mock.calls, ...warnSpy.mock.calls];
      return calls.map((args) => args.map((arg) => String(arg)).join(' ')).filter((text) => STYLE_WARNING_PATTERN.test(text));
    },
    restore() {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

function makeSession(getSettingsResult: Record<string, unknown>, put?: (patch: Record<string, unknown>) => Promise<unknown>) {
  const updateSettings = vi.fn(put ?? (async (_patch: Record<string, unknown>) => ({ status: 'ok' })));
  const apiClient = {
    getSettings: vi.fn(async () => getSettingsResult as never),
    updateSettings,
    getModelStatus: vi.fn(
      async () =>
        ({ engine: 'stub', profile: 'auto', models: { quality: { present: false }, fast: { present: false } } }) as never,
    ),
  } as unknown as ApiClient;
  const session: DesktopSession = {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'test-token',
    mode: 'node',
    apiClient,
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  };
  return { session, updateSettings };
}

function backend() {
  return {
    n_results: 4,
    explicit_keys: [] as string[],
    requested: { n_results: null, reranking_enabled: null, max_tokens: null, temperature: null },
    reranking_available: true,
  };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

function clickRadio(container: HTMLElement, name: string, value: string): void {
  const radio = container.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null;
  if (radio === null) throw new Error(`radio ${name}[${value}] not found`);
  act(() => {
    fireEvent.click(radio);
  });
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
});

describe('SettingsPage style composition (AC8: every radio family, both directions, zero style warnings)', () => {
  test('browser app: generator source, browser engine, response quality and theme flip without style warnings', async () => {
    H.reset({ mode: 'browser-local' });
    const spy = spyOnStyleWarnings();
    try {
      const { container } = render(<SettingsPage />);
      await waitFor(() => screen.getByRole('heading', { level: 2, name: /^model & connection$/i }));
      await settle();

      // Generator source (ExternalModelSection): every option, both directions.
      clickRadio(container, 'generator-source', 'builtin');
      clickRadio(container, 'generator-source', 'local');
      clickRadio(container, 'generator-source', 'cloud');
      clickRadio(container, 'generator-source', 'builtin');

      // Browser engine both directions.
      clickRadio(container, 'browser-engine', 'wllama');
      clickRadio(container, 'browser-engine', 'webllm');
      clickRadio(container, 'browser-engine', 'wllama');

      // Response quality: every option, then back.
      for (const value of ['fast', 'quality', 'balanced']) clickRadio(container, 'rag-preset', value);

      // Theme SegmentedControl (radios inside the Appearance group).
      const appearance = screen.getByRole('region', { name: /^appearance$/i });
      for (const label of ['Dark', 'Light', 'System']) {
        const radio = within(appearance).getByRole('radio', { name: new RegExp(`^${label}$`, 'i') });
        act(() => {
          fireEvent.click(radio);
        });
      }

      const warnings = spy.styleWarnings();
      expect(warnings, `AC8 violation: ${warnings.join(' | ')}`).toEqual([]);
    } finally {
      spy.restore();
    }
  });

  test('electron api mode: inference mode, inference profile and GPU acceleration flip without style warnings', async () => {
    H.reset({ mode: 'api' });
    const spy = spyOnStyleWarnings();
    try {
      installDesktopBridgeStub();
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
      const { session } = makeSession(backend());
      const { container } = render(
        <DesktopSessionProvider value={{ session, models: null, loading: false, error: null }}>
          <SettingsPage />
        </DesktopSessionProvider>,
      );
      await waitFor(() => screen.getByRole('heading', { level: 2, name: /^model & connection$/i }));
      await settle();

      // Inference Mode (run location) both directions.
      clickRadio(container, 'inference-mode', 'api');
      clickRadio(container, 'inference-mode', 'browser-local');
      clickRadio(container, 'inference-mode', 'api');

      // Inference profile: every option.
      for (const value of ['quality', 'fast', 'auto']) clickRadio(container, 'desktop-inference-profile', value);

      // GPU acceleration (the issue #155 GPU override): every option.
      for (const value of ['auto', 'gpu', 'cpu']) clickRadio(container, 'desktop-gpu-acceleration', value);

      const warnings = spy.styleWarnings();
      expect(warnings, `AC8 violation: ${warnings.join(' | ')}`).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});
