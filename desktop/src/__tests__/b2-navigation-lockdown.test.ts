// C3 / AC4 (issue #60, Workstream B2): navigation lockdown — the main window
// must deny will-navigate to any non-app:// target and deny every window.open.
//
// Seam contract (frozen; desktop/main/index.ts createMainWindow — EXISTS at
// base but registers no navigation policy, so these fail at base for the right
// reason: no handler registered):
//   win.webContents.on('will-navigate', (event, url) => {...})
//     - real Electron signature: url is a plain STRING (not a details object)
//     - non-app:// url => event.preventDefault() (navigation denied)
//     - app:// url     => no preventDefault()   (navigation allowed)
//   win.setWindowOpenHandler((details) => ({ action: 'deny' }))
//     - deny for EVERY url (no window.open / target=_blank surfaces at all)
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias); the
// stub's webContents.on / setWindowOpenHandler are vi.fn captures, so the spec
// extracts the registered listener(s) and invokes them with mock events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, __resetElectronStub } from '../../test/electron-stub';
import { createMainWindow } from '../../main/index';

type WillNavigateListener = (event: { preventDefault: () => void }, url: string) => void;
type WindowOpenHandler = (details: {
  url: string;
  frameName?: string;
  features?: string;
}) => { action: 'deny' | 'allow' };

let savedArgv: string[];
let savedEnvUrl: string | undefined;

beforeEach(() => {
  __resetElectronStub();
  savedArgv = process.argv;
  savedEnvUrl = process.env.ELECTRON_START_URL;
  delete process.env.ELECTRON_START_URL;
  // Force production mode so createMainWindow loads app:// (dev signals off).
  process.argv = savedArgv.filter((a) => a !== '--dev');
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedEnvUrl === undefined) delete process.env.ELECTRON_START_URL;
  else process.env.ELECTRON_START_URL = savedEnvUrl;
});

function willNavigateListeners(win: BrowserWindow): WillNavigateListener[] {
  return win.webContents.on.mock.calls
    .filter(([event]) => event === 'will-navigate')
    .map(([, listener]) => listener as WillNavigateListener);
}

function windowOpenHandler(win: BrowserWindow): WindowOpenHandler | undefined {
  // Real Electron surface: the window-open handler lives on webContents
  // (win.setWindowOpenHandler is undefined at runtime in Electron 44 —
  // CHECK_WRONG amendment, probe-verified 2026-09-08).
  const call = win.webContents.setWindowOpenHandler.mock.calls[0] as [WindowOpenHandler] | undefined;
  return call?.[0];
}

describe('C3 navigation lockdown: will-navigate (AC4)', () => {
  it("createMainWindow registers a webContents 'will-navigate' handler", () => {
    const win = createMainWindow();
    expect(
      willNavigateListeners(win).length,
      'a will-navigate handler must be registered on webContents',
    ).toBeGreaterThan(0);
  });

  it('will-navigate DENIES non-app:// targets (preventDefault called)', () => {
    const win = createMainWindow();
    const listeners = willNavigateListeners(win);
    expect(listeners.length, 'a will-navigate handler must be registered on webContents').toBeGreaterThan(0);
    for (const url of [
      'https://evil.example/phish',
      'http://127.0.0.1:9222/x', // even loopback http is not an app:// target
      'file:///C:/Windows/win.ini',
    ]) {
      for (const listener of listeners) {
        const event = { preventDefault: vi.fn() };
        listener(event, url);
        expect(event.preventDefault, `will-navigate must preventDefault() for ${url}`).toHaveBeenCalled();
      }
    }
  });

  it('will-navigate ALLOWS app:// targets (no preventDefault)', () => {
    const win = createMainWindow();
    const listeners = willNavigateListeners(win);
    expect(listeners.length, 'a will-navigate handler must be registered on webContents').toBeGreaterThan(0);
    for (const url of ['app://index.html', 'app://settings.html']) {
      for (const listener of listeners) {
        const event = { preventDefault: vi.fn() };
        listener(event, url);
        expect(event.preventDefault, `will-navigate must NOT preventDefault() for ${url}`).not.toHaveBeenCalled();
      }
    }
  });
});

describe('C3 navigation lockdown: window.open (AC4)', () => {
  it("setWindowOpenHandler is registered and returns { action: 'deny' } for EVERY url", () => {
    const win = createMainWindow();
    expect(
      win.webContents.setWindowOpenHandler,
      'webContents.setWindowOpenHandler must be registered exactly once',
    ).toHaveBeenCalledTimes(1);
    const handler = windowOpenHandler(win);
    expect(handler, 'a window-open handler must be captured').toBeDefined();
    if (!handler) return;
    for (const url of [
      'https://evil.example/popup',
      'http://127.0.0.1:9222/popup',
      'app://index.html', // even same-scheme popups are denied: no new windows at all
    ]) {
      expect(handler({ url, frameName: 'x', features: '' }), `window.open of ${url} must be denied`).toEqual({
        action: 'deny',
      });
    }
  });
});
