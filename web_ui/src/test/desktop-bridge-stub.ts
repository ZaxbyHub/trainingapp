// Shared DesktopApiBridge test stub (review F-022): one construction site for
// the suites that need a typed, inert bridge on window.desktopApi.
// Suites override individual methods via `overrides` and remove the stub with
// removeDesktopBridgeStub() in afterEach.
import { vi } from 'vitest';
import type { DesktopApiBridge, UpdateStatus } from '../types/desktop';

export const DEFAULT_UPDATE_STATUS: UpdateStatus = {
  optIn: false,
  feedUrl: '',
  checkedAt: null,
  candidates: [],
  refused: [],
  error: null,
  appUpdate: null,
  lastApply: null,
};

export function installDesktopBridgeStub(
  overrides: Partial<DesktopApiBridge> = {},
): DesktopApiBridge {
  const bridge: DesktopApiBridge = {
    getAuthToken: vi.fn(async () => 'test-token'),
    getBackendInfo: vi.fn(async () => ({ mode: 'node', port: 1, url: 'http://127.0.0.1:1' })),
    getFirstRunStatus: vi.fn(async () => {
      throw new Error('not used in this suite');
    }),
    activateFirstRunPacks: vi.fn(async () => ({ ok: true, results: [] })),
    completeFirstRun: vi.fn(async () => ({ ok: true })),
    resetFirstRun: vi.fn(async () => ({ ok: true })),
    onFirstRunRequired: vi.fn(() => () => undefined),
    getUpdateStatus: vi.fn(async () => DEFAULT_UPDATE_STATUS),
    setUpdateOptIn: vi.fn(async () => ({ ok: true })),
    checkForUpdates: vi.fn(async () => ({ ok: true })),
    applyPackUpdate: vi.fn(async () => ({ ok: true })),
    openUpdateExternal: vi.fn(async () => ({ ok: true })),
    onUpdateAvailable: vi.fn(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, 'desktopApi', {
    value: bridge,
    configurable: true,
    writable: true,
  });
  return bridge;
}

export function removeDesktopBridgeStub(): void {
  delete (window as { desktopApi?: unknown }).desktopApi;
}
