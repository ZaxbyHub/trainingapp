// In-memory Electron stub for the issue #59/#60 acceptance checks.
// desktop/vitest.config.ts aliases the bare specifier 'electron' to this file,
// so neither the specs nor the production seams under test need the real
// Electron binary. The stub mirrors the small surface the seams are allowed to
// touch: app, BrowserWindow, protocol, contextBridge, ipcRenderer, ipcMain,
// shell.
//
// Test-driving notes:
// - `app.on` both records the call (vi.fn) and really registers on an internal
//   EventEmitter, so specs can fire events with `app.emit('second-instance')`.
// - `BrowserWindow` records the constructor's `webPreferences` and tracks all
//   live instances via the static `getAllWindows()`.
// - `BrowserWindow.prototype.isMinimized` returns true so implementations that
//   restore only when minimized still call `restore()` in the AC4 spec.
// - `app.isPackaged` is a PLAIN MUTABLE BOOLEAN like the real Electron property
//   (issue #60 / AC8 specs assign `app.isPackaged = true` directly); a vi.fn
//   would read truthy-by-default and mislead production `if (app.isPackaged)`
//   checks.
// - `ipcMain.handle` is a vi.fn so the token-IPC registration test can assert
//   what channel got registered and rewire it.
// - `BrowserWindow.setWindowOpenHandler` is a vi.fn capturing the handler so
//   navigation-lockdown specs can invoke it and check the deny decision.
// - Call `__resetElectronStub()` from beforeEach in every spec.
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

const emitter = new EventEmitter();

export const app = {
  requestSingleInstanceLock: vi.fn((): boolean => true),
  quit: vi.fn(),
  on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    emitter.on(event, listener);
  }),
  once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    emitter.once(event, listener);
  }),
  // Real dispatch (not a spy): emitting reaches handlers registered via on().
  emit: (event: string, ...args: unknown[]): boolean => emitter.emit(event, ...args),
  whenReady: vi.fn((): Promise<void> => Promise.resolve()),
  isReady: vi.fn((): boolean => true),
  getPath: vi.fn((_name: string): string => process.cwd()),
  getAppPath: vi.fn((): string => process.cwd()),
  // Plain boolean, NOT a vi.fn (see file header). Mutate directly in specs.
  isPackaged: false as boolean,
};

export class BrowserWindow {
  static readonly windows: BrowserWindow[] = [];
  readonly webPreferences: Record<string, unknown> | undefined;
  // Real Electron loadURL/loadFile return promises; the production seam
  // attaches a .catch to surface failures via did-fail-load, so the stub
  // must return a resolved promise (PRR95-003 stub-fidelity AMEND).
  loadURL = vi.fn((): Promise<void> => Promise.resolve());
  loadFile = vi.fn((): Promise<void> => Promise.resolve());
  on = vi.fn();
  once = vi.fn();
  focus = vi.fn();
  blur = vi.fn();
  restore = vi.fn();
  maximize = vi.fn();
  minimize = vi.fn();
  // true so a conditionally-restoring implementation still calls restore()
  isMinimized = vi.fn((): boolean => true);
  isMaximized = vi.fn((): boolean => false);
  show = vi.fn();
  hide = vi.fn();
  close = vi.fn();
  // Captures the window.open policy handler (issue #60 / AC4): specs invoke
  // the captured fn with mock details and assert the deny decision. KEPT for
  // stub-shape compat; the REAL Electron surface is webContents-level (below)
  // — win.setWindowOpenHandler is undefined at runtime in Electron 44
  // (probe-verified 2026-09-08; CHECK_WRONG amendment on b2-navigation-lockdown).
  setWindowOpenHandler = vi.fn();
  destroy = vi.fn(() => {
    const i = BrowserWindow.windows.indexOf(this);
    if (i >= 0) BrowserWindow.windows.splice(i, 1);
  });
  webContents = {
    on: vi.fn(),
    send: vi.fn(),
    // The REAL surface for the window-open policy handler (Electron >= 12,
    // incl. 44): production code registers it here, and the
    // b2-navigation-lockdown spec extracts it from this mock.
    setWindowOpenHandler: vi.fn(),
  };
  constructor(opts?: { webPreferences?: Record<string, unknown> }) {
    this.webPreferences = opts?.webPreferences;
    BrowserWindow.windows.push(this);
  }
  static getAllWindows(): BrowserWindow[] {
    return [...BrowserWindow.windows];
  }
}

export const protocol = {
  handle: vi.fn(),
  unhandle: vi.fn(),
  registerSchemesAsPrivileged: vi.fn(),
};

export const contextBridge = {
  exposeInMainWorld: vi.fn(),
};

export const ipcRenderer = {
  on: vi.fn(),
  once: vi.fn(),
  send: vi.fn(),
  invoke: vi.fn(),
  removeListener: vi.fn(),
};

export const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  removeHandler: vi.fn(),
};

export const shell = {
  openExternal: vi.fn(),
};

export const dialog = {
  showErrorBox: vi.fn(),
};

/** Reset all stub state; call from beforeEach in every spec. */
export function __resetElectronStub(): void {
  app.requestSingleInstanceLock.mockClear();
  app.requestSingleInstanceLock.mockReturnValue(true);
  app.quit.mockClear();
  app.on.mockClear();
  app.once.mockClear();
  app.isPackaged = false;
  emitter.removeAllListeners();
  BrowserWindow.windows.length = 0;
  protocol.handle.mockClear();
  protocol.registerSchemesAsPrivileged.mockClear();
  contextBridge.exposeInMainWorld.mockClear();
  ipcRenderer.on.mockClear();
  ipcRenderer.once.mockClear();
  ipcRenderer.send.mockClear();
  ipcRenderer.invoke.mockClear();
  ipcRenderer.removeListener.mockClear();
  ipcMain.handle.mockClear();
  ipcMain.on.mockClear();
  ipcMain.once.mockClear();
  ipcMain.removeHandler.mockClear();
  dialog.showErrorBox.mockClear();
}
