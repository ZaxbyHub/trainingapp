/**
 * settings-new-sections (issue #34 items 6p+7; plan R2 "Evidence beyond the
 * frozen checks"): the three new surfaces render inside the REAL SettingsPage
 * with functional controls — the storage-pressure section (values + persist
 * button), the profile surface (registry list, switch affordances, corrupt
 * reset), and the inactivity control (disclosure copy, 0-disable, default-15
 * semantics). Heavy SettingsPage dependencies are stubbed with the same
 * conventions as settings-wiring-honesty.test.tsx; the profile/storage
 * libraries under test are REAL.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    reset() {
      h.state = {
        mode: 'browser-local',
        browserEngine: 'wllama',
        ragPreset: 'balanced',
        isServerConnected: false,
        isModelReady: true,
        modelLoadingProgress: 100,
        modeError: null,
        serverUrl: '',
      };
      h.snapshot = null;
    },
    actions: {
      setMode: () => undefined,
      setRagPreset: () => undefined,
      setServerUrl: () => undefined,
      setBrowserEngine: () => undefined,
      checkServerConnectivity: () => Promise.resolve(false),
      setModelReady: () => undefined,
      setModelLoadingProgress: () => undefined,
    },
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
vi.mock('../../lib/llm/model-download', () => ({
  ModelDownloadManager: vi.fn().mockImplementation(() => ({ downloadModel: vi.fn(), cancelDownload: vi.fn() })),
}));
vi.mock('../../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn().mockImplementation(() => ({ checkModelCached: vi.fn(() => Promise.resolve(true)) })),
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
vi.mock('../../lib/rag/rag-presets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/rag/rag-presets')>();
  return actual;
});
vi.mock('../../components/ModelDownloadProgress', () => ({ ModelDownloadProgress: () => null }));
vi.mock('../../lib/first-run', () => ({
  fetchFirstRunStatus: vi.fn(async () => null),
  resetFirstRun: vi.fn(async () => undefined),
  emitFirstRunReopen: vi.fn(),
}));
vi.mock('../../lib/packs/browser-pack-manager', () => ({
  getBrowserPackManager: () => ({}),
}));
vi.mock('../../lib/packs/browser-training', () => ({
  releaseBrowserTrainingIfEmpty: vi.fn(async () => undefined),
}));

import { SettingsPage } from '../SettingsPage';
import { INACTIVITY_DISCLOSURE_COPY } from '../SettingsPage';
import {
  INACTIVITY_TIMEOUT_KEY,
  PROFILE_KEY,
  REGISTERED_PROFILES_KEY,
} from '../../lib/storage/persisted-keys';

const CURRENT = 'settest';
const OTHER = 'otherp1';

const realLocation = window.location;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, CURRENT);
  localStorage.setItem(REGISTERED_PROFILES_KEY, JSON.stringify([CURRENT, OTHER]));
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...realLocation, protocol: 'http:', origin: 'http://localhost', reload },
  });
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      estimate: async () => ({ usage: 512 * 1024 ** 2, quota: 10 * 1024 ** 3 }),
      persisted: async () => false,
      persist: vi.fn(async () => true),
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  localStorage.clear();
  // NOTE: no vi.restoreAllMocks here — it would wipe the mock-factory
  // implementations (ModelReadinessGate et al.) the whole suite relies on.
});

describe('the three new Settings surfaces inside the REAL SettingsPage', () => {
  it('the storage-pressure section renders live values and the persist control works', async () => {
    render(<SettingsPage />);
    const status = await screen.findByTestId('settings-storage-section');
    expect(status).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-status').textContent).toContain('512.0 MB');
    });
    expect(screen.getByTestId('settings-storage-persisted').textContent).toContain('not persistent');
    fireEvent.click(screen.getByTestId('settings-storage-persist-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persisted').textContent).toContain('persistent (protected');
    });
  });

  it('the profile surface lists registered profiles and Switch works (confirm + reload)', async () => {
    render(<SettingsPage />);
    expect(await screen.findByTestId('profile-data-section')).toBeTruthy();
    expect(screen.getByTestId('active-profile-value').textContent).toBe(CURRENT);
    // One masked value cell per registered profile (visual-baseline profileValueMasks).
    expect(screen.getAllByTestId('profile-registry-name').map((el) => el.textContent)).toEqual([CURRENT, OTHER]);
    expect(screen.getByTestId('profile-row-otherp1')).toBeTruthy();
    expect(screen.getByTestId('profile-row-settest')).toBeTruthy(); // (active)
    const switchButton = screen.getByTestId('profile-switch-otherp1');
    fireEvent.click(switchButton); // arm the confirm
    fireEvent.click(screen.getByTestId('profile-switch-otherp1')); // confirm
    expect(localStorage.getItem(PROFILE_KEY)).toBe(OTHER);
  });

  it('the create-new profile affordance mints and switches', async () => {
    render(<SettingsPage />);
    expect(await screen.findByTestId('profile-create')).toBeTruthy();
    fireEvent.click(screen.getByTestId('profile-create'));
    const next = localStorage.getItem(PROFILE_KEY);
    expect(typeof next).toBe('string');
    expect(next).not.toBe(CURRENT);
    const registered = JSON.parse(localStorage.getItem(REGISTERED_PROFILES_KEY) ?? '[]') as string[];
    expect(registered).toContain(next);
  });

  it('the corrupt-registry reset surface is reachable and heals the registry', async () => {
    localStorage.setItem(REGISTERED_PROFILES_KEY, 'corrupted{');
    render(<SettingsPage />);
    const well = await screen.findByTestId('profile-registry-corrupt');
    expect(well.textContent).toContain('Profile registry is unreadable');
    // While unhealthy, the registered-profile list is NOT offered.
    expect(screen.queryByTestId('profile-list')).toBeNull();
    fireEvent.click(screen.getByTestId('profile-registry-reset')); // arm
    fireEvent.click(screen.getByTestId('profile-registry-reset')); // confirm
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(REGISTERED_PROFILES_KEY) ?? '[]')).toEqual([CURRENT]);
    });
  });

  it('the inactivity control shows the disclosure copy and the default 15', async () => {
    render(<SettingsPage />);
    const control = await screen.findByTestId('inactivity-control');
    expect(control).toBeTruthy();
    expect(screen.getByTestId('inactivity-disclosure').textContent).toBe(INACTIVITY_DISCLOSURE_COPY);
    expect(screen.getByTestId('inactivity-threshold-input').getAttribute('value')).toBe('15');
  });

  it('the inactivity control persists the threshold and 0 disables', async () => {
    render(<SettingsPage />);
    await screen.findByTestId('inactivity-control');
    await act(async () => {
      fireEvent.change(screen.getByTestId('inactivity-threshold-input'), { target: { value: '0' } });
    });
    await waitFor(() => {
      expect(localStorage.getItem(INACTIVITY_TIMEOUT_KEY)).toBe('0');
    });
    expect(screen.getByTestId('inactivity-saved-note').textContent).toContain('disabled');
    await act(async () => {
      fireEvent.change(screen.getByTestId('inactivity-threshold-input'), { target: { value: '30' } });
    });
    await waitFor(() => {
      expect(localStorage.getItem(INACTIVITY_TIMEOUT_KEY)).toBe('30');
    });
    expect(screen.getByTestId('inactivity-saved-note').textContent).toContain('30 minutes');
  });

  it('a stored threshold is shown instead of the default', async () => {
    localStorage.setItem(INACTIVITY_TIMEOUT_KEY, '45');
    render(<SettingsPage />);
    await screen.findByTestId('inactivity-control');
    expect(screen.getByTestId('inactivity-threshold-input').getAttribute('value')).toBe('45');
  });
});
