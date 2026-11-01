/**
 * training-boot unregister scope (issue #34, plan finding 8 + R2 coexistence
 * evidence): executes public/training-boot.js in a vm with a stubbed
 * serviceWorker container and pins that the 'trainingapp-unregister' message
 * unregisters ONLY /training/-scoped registrations — the app-shell service
 * worker (scope '/') survives the course teardown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const BOOT_PATH = path.resolve(__dirname, '../../public/training-boot.js');
const APP_ORIGIN = 'http://127.0.0.1:4174';

interface FakeRegistration {
  scope: string;
  unregister: ReturnType<typeof vi.fn>;
}

function makeBootVm(): {
  registrations: FakeRegistration[];
  postMessage(data: unknown): void;
} {
  const registrations: FakeRegistration[] = [
    // The app-shell SW (registered at the origin root by sw-registration.ts)
    // and the course SW (scope /training/) are both live on this origin.
    { scope: `${APP_ORIGIN}/`, unregister: vi.fn(async () => true) },
    { scope: `${APP_ORIGIN}/training/`, unregister: vi.fn(async () => true) },
  ];

  const messageListeners: Array<(event: { source: unknown; origin: string; data: unknown }) => void> = [];
  // The boot frame is an IFRAME embedded directly under the top-level APP
  // page: parent === top === the app page window, NOT the boot frame itself.
  const appPage: Record<string, unknown> = { postMessage: vi.fn() };
  const windowStub: Record<string, unknown> = {
    parent: appPage,
    top: appPage,
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (type === 'message') messageListeners.push(handler as never);
    },
    removeEventListener() {},
    postMessage() {},
  };

  const navigatorStub = {
    serviceWorker: {
      getRegistration: async () => ({ active: {} }),
      register: async () => ({ active: {}, installing: null, waiting: null }),
      getRegistrations: async () => registrations,
      onmessage: null as unknown,
      addEventListener() {},
    },
  };

  const documentStub = { referrer: `${APP_ORIGIN}/` };

  const sandbox: Record<string, unknown> = {
    window: windowStub,
    navigator: navigatorStub,
    document: documentStub,
    location: {
      href: `${APP_ORIGIN}/training-boot.html`,
      ancestorOrigins: [APP_ORIGIN],
      origin: APP_ORIGIN,
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Math,
    Date,
    URL,
    encodeURIComponent,
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    clearTimeout,
  };
  windowStub.self = windowStub;
  sandbox.self = windowStub;
  sandbox.globalThis = sandbox;

  const source = readFileSync(BOOT_PATH, 'utf8');
  new vm.Script(source, { filename: BOOT_PATH }).runInContext(vm.createContext(sandbox));

  return {
    registrations,
    postMessage(data) {
      for (const handler of messageListeners) {
        handler({ source: appPage, origin: APP_ORIGIN, data });
      }
    },
  };
}

describe('training-boot.js unregister scope (app-shell SW coexistence)', () => {
  it("the unregister message unregisters ONLY '/training/'-scoped registrations", async () => {
    const boot = makeBootVm();
    boot.postMessage({ type: 'trainingapp-unregister' });
    // getRegistrations + unregister are async; let them settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const course = boot.registrations.find((r) => r.scope.endsWith('/training/'));
    const appShell = boot.registrations.find((r) => r.scope === `${APP_ORIGIN}/`);
    expect(course?.unregister).toHaveBeenCalledTimes(1);
    expect(appShell?.unregister).not.toHaveBeenCalled();
  });

  it('a second /training/ registration (nested scope) also goes', async () => {
    const boot = makeBootVm();
    boot.registrations.push({
      scope: `${APP_ORIGIN}/training/pack-a/`,
      unregister: vi.fn(async () => true),
    });
    boot.postMessage({ type: 'trainingapp-unregister' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(boot.registrations.find((r) => r.scope.endsWith('/training/'))?.unregister).toHaveBeenCalledTimes(1);
    expect(boot.registrations.find((r) => r.scope.endsWith('/training/pack-a/'))?.unregister).toHaveBeenCalledTimes(1);
    expect(boot.registrations.find((r) => r.scope === `${APP_ORIGIN}/`)?.unregister).not.toHaveBeenCalled();
  });

  it('other unrelated scopes are never unregistered', async () => {
    const boot = makeBootVm();
    boot.registrations.push({
      scope: `${APP_ORIGIN}/some-other-app/`,
      unregister: vi.fn(async () => true),
    });
    boot.postMessage({ type: 'trainingapp-unregister' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(boot.registrations.find((r) => r.scope.endsWith('/some-other-app/'))?.unregister).not.toHaveBeenCalled();
    expect(boot.registrations.find((r) => r.scope === `${APP_ORIGIN}/`)?.unregister).not.toHaveBeenCalled();
  });
});
