/**
 * B9 (issue #67) — AC6: Electron detection is TRUE only when
 * `window.desktopApi` is present, plus the desktop-session discovery
 * contract (token/header/base URL) and the first-run gate predicate.
 * Covers `isElectron`, `initDesktopSession`, and
 * `modelsAbsentForRealEngine` in one pinned suite (frozen acceptance check
 * C6 runs this file; C3 runs it together with the page-level suites).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopSessionError,
  initDesktopSession,
  isElectron,
  modelsAbsentForRealEngine,
  resetDesktopSessionForTests,
} from './desktop-session';
import type { DesktopApiBridge } from '../types/desktop';
import type { ModelStatus } from './api/types';

function stubBridge(overrides: Partial<DesktopApiBridge> = {}): DesktopApiBridge {
  return {
    getAuthToken: vi.fn(async () => 'launch-token-abc'),
    getBackendInfo: vi.fn(async () => ({ mode: 'node', port: 4567, url: 'http://127.0.0.1:4567' })),
    ...overrides,
  };
}

beforeEach(() => {
  resetDesktopSessionForTests();
});

afterEach(() => {
  resetDesktopSessionForTests();
  delete (window as { desktopApi?: DesktopApiBridge }).desktopApi;
  vi.restoreAllMocks();
});

describe('AC6: isElectron is true only when window.desktopApi is present', () => {
  it('is FALSE in a plain browser (no preload bridge)', () => {
    expect(window.desktopApi).toBeUndefined();
    expect(isElectron()).toBe(false);
  });

  it('is TRUE when the preload bridge is exposed', () => {
    (window as { desktopApi?: DesktopApiBridge }).desktopApi = stubBridge();
    expect(isElectron()).toBe(true);
  });

  it('does NOT rely on the app:// protocol (dev mode is http)', () => {
    // jsdom origin is http://localhost — isElectron must stay false here even
    // though packaged Electron uses app://; the bridge is the only signal.
    expect(window.location.protocol).toBe('http:');
    expect(isElectron()).toBe(false);
  });
});

describe('initDesktopSession discovery', () => {
  it('rejects with an informative error outside Electron', async () => {
    await expect(initDesktopSession()).rejects.toThrow(DesktopSessionError);
    await expect(initDesktopSession()).rejects.toThrow(/desktop bridge/i);
  });

  it('builds a session from the bridge with base URL, token and mode', async () => {
    const bridge = stubBridge();
    (window as { desktopApi?: DesktopApiBridge }).desktopApi = bridge;
    const session = await initDesktopSession();
    expect(session.baseUrl).toBe('http://127.0.0.1:4567');
    expect(session.token).toBe('launch-token-abc');
    expect(session.mode).toBe('node');
    expect(session.sseUrl()).toBe('http://127.0.0.1:4567/ask/stream');
    expect(bridge.getBackendInfo).toHaveBeenCalledOnce();
    expect(bridge.getAuthToken).toHaveBeenCalledOnce();
  });

  it('memoizes discovery per launch (one bridge round-trip)', async () => {
    (window as { desktopApi?: DesktopApiBridge }).desktopApi = stubBridge();
    const [a, b] = await Promise.all([initDesktopSession(), initDesktopSession()]);
    expect(a).toBe(b);
  });

  it('the session ApiClient carries X-Desktop-Token (not Authorization)', async () => {
    (window as { desktopApi?: DesktopApiBridge }).desktopApi = stubBridge();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const session = await initDesktopSession();
    await session.apiClient.listDocuments();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = new Headers((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get('X-Desktop-Token')).toBe('launch-token-abc');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('surfaces bridge failures as DesktopSessionError and allows retry', async () => {
    (window as { desktopApi?: DesktopApiBridge }).desktopApi = stubBridge({
      getBackendInfo: vi.fn(async () => {
        throw new Error('ipc rejected');
      }),
    });
    await expect(initDesktopSession()).rejects.toThrow(/could not reach the desktop backend/i);
    // Retry path: a healthy bridge now succeeds (sessionPromise was reset).
    (window as { desktopApi?: DesktopApiBridge }).desktopApi = stubBridge();
    await expect(initDesktopSession()).resolves.toMatchObject({ mode: 'node' });
  });
});

describe('AC5: modelsAbsentForRealEngine first-run gate predicate', () => {
  const status = (partial: Partial<ModelStatus>): ModelStatus =>
    ({
      engine: 'llama.cpp',
      profile: 'auto',
      models: { quality: { present: false }, fast: { present: false } },
      ...partial,
    }) as ModelStatus;

  it('does NOT block the CI/dev stub engine even with no weights', () => {
    expect(
      modelsAbsentForRealEngine(status({ engine: 'stub', profile: 'auto' })),
    ).toBe(false);
  });

  it('blocks a real engine when BOTH profiles are absent', () => {
    expect(modelsAbsentForRealEngine(status({}))).toBe(true);
  });

  it('does NOT block when either profile is present', () => {
    expect(
      modelsAbsentForRealEngine(
        status({ models: { quality: { present: true }, fast: { present: false } } }),
      ),
    ).toBe(false);
    expect(
      modelsAbsentForRealEngine(
        status({ models: { quality: { present: false }, fast: { present: true } } }),
      ),
    ).toBe(false);
  });

  it('does NOT block while the status is still loading (null)', () => {
    expect(modelsAbsentForRealEngine(null)).toBe(false);
  });
});
