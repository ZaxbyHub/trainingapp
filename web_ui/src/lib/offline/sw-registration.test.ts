/**
 * sw-registration (issue #34 item 7, AC1 / check C1): the app-shell
 * service-worker registration entry point and its guards. One behavior per
 * test so a mutation of any guard turns exactly that test red. The module
 * flag is once-per-document, so every test re-imports a FRESH module copy
 * (vi.resetModules + dynamic import) and re-stubs the environment:
 *   - navigator.serviceWorker mocked on the jsdom navigator;
 *   - location.protocol overridden via window.history/jsdom URL rewriting is
 *     unreliable, so the module reads are exercised through a stubbed
 *     window/location pair made available by delete+defineProperty on the
 *     jsdom window (protocol, href);
 *   - the Vitest guard (import.meta.env.VITEST) is stubbed OFF for tests
 *     that must reach the register call and left ON for the skip test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RegisterFn = (url: string, options?: RegistrationOptions) => Promise<ServiceWorkerRegistration>;

const originalServiceWorker = navigator.serviceWorker;

function stubServiceWorker(registerImpl: RegisterFn): { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: (url: string, options?: RegistrationOptions) => {
        calls.push(url);
        return registerImpl(url, options);
      },
    },
  });
  return { calls };
}

/** Re-import the module fresh (resets the once-per-document flag). */
async function freshModule(): Promise<typeof import('./sw-registration')> {
  vi.resetModules();
  return import('./sw-registration');
}

/** Override location.protocol for the current document. */
function stubProtocol(protocol: string, href: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...window.location, protocol, href },
  });
}

beforeEach(() => {
  vi.stubEnv('VITEST', '');
});

afterEach(() => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: originalServiceWorker,
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...window.location, protocol: 'http:', href: 'http://localhost/' },
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('maybeRegisterServiceWorker (AC1 guards)', () => {
  it('registers the app-shell SW URL when the protocol is http:', async () => {
    const { calls } = stubServiceWorker(async () => ({ scope: '/' }) as ServiceWorkerRegistration);
    stubProtocol('http:', 'http://127.0.0.1:4174/');
    const mod = await freshModule();
    mod.maybeRegisterServiceWorker();
    await vi.waitFor(() => expect(calls).toEqual(['sw.js']));
  });

  it('registers when the protocol is https:', async () => {
    const { calls } = stubServiceWorker(async () => ({ scope: '/' }) as ServiceWorkerRegistration);
    stubProtocol('https:', 'https://example.internal/');
    const mod = await freshModule();
    mod.maybeRegisterServiceWorker();
    await vi.waitFor(() => expect(calls).toEqual(['sw.js']));
  });

  it('does NOT register when the protocol is file: (Electron static loads)', async () => {
    const { calls } = stubServiceWorker(async () => ({ scope: '/' }) as ServiceWorkerRegistration);
    stubProtocol('file:', 'file:///C:/app/index.html');
    const mod = await freshModule();
    expect(() => mod.maybeRegisterServiceWorker()).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('does NOT register when the protocol is app: (Electron production)', async () => {
    const { calls } = stubServiceWorker(async () => ({ scope: '/' }) as ServiceWorkerRegistration);
    stubProtocol('app:', 'app://-/index.html');
    const mod = await freshModule();
    expect(() => mod.maybeRegisterServiceWorker()).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('does NOT register when navigator.serviceWorker is undefined', async () => {
    // A stub navigator WITHOUT the property at all: the `in` guard itself
    // must refuse (an own property holding undefined would slip past `in`).
    const { serviceWorker: _sw, ...withoutServiceWorker } = navigator;
    void _sw;
    vi.stubGlobal('navigator', withoutServiceWorker);
    stubProtocol('http:', 'http://127.0.0.1:4174/');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await freshModule();
    expect(() => mod.maybeRegisterServiceWorker()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT register under Vitest (import.meta.env.VITEST)', async () => {
    vi.stubEnv('VITEST', 'true');
    const { calls } = stubServiceWorker(async () => ({ scope: '/' }) as ServiceWorkerRegistration);
    stubProtocol('http:', 'http://127.0.0.1:4174/');
    const mod = await freshModule();
    mod.maybeRegisterServiceWorker();
    expect(calls).toEqual([]);
  });

  it('registers at most once (idempotent) across repeated calls', async () => {
    const { calls } = stubServiceWorker(async () => ({ scope: '/' }) as ServiceWorkerRegistration);
    stubProtocol('http:', 'http://127.0.0.1:4174/');
    const mod = await freshModule();
    mod.maybeRegisterServiceWorker();
    mod.maybeRegisterServiceWorker();
    mod.maybeRegisterServiceWorker();
    await vi.waitFor(() => expect(calls).toEqual(['sw.js']));
  });

  it('does not throw when register rejects (logged, app boot continues)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubServiceWorker(() => Promise.reject(new Error('registration failed')));
    stubProtocol('http:', 'http://127.0.0.1:4174/');
    const mod = await freshModule();
    expect(() => mod.maybeRegisterServiceWorker()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});
