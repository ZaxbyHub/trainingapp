// In-memory Electron stub for the issue #59 acceptance checks.
// desktop/vitest.config.ts aliases the bare specifier 'electron' to this file,
// so neither the specs nor the production seams under test need the real
// Electron binary. The stub mirrors the small surface the seams are allowed to
// touch: app, BrowserWindow, protocol, contextBridge, ipcRenderer, shell.
//
// Test-driving notes:
// - `app.on` both records the call (vi.fn) and really registers on an internal
//   EventEmitter, so specs can fire events with `app.emit('second-instance')`.
// - `BrowserWindow` records the constructor's `webPreferences` and tracks all
//   live instances via the static `getAllWindows()`.
// - `BrowserWindow.prototype.isMinimized` returns true so implementations that
//   restore only when minimized still call `restore()` in the AC4 spec.
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
};

export class BrowserWindow {
  static readonly windows: BrowserWindow[] = [];
  readonly webPreferences: Record<string, unknown> | undefined;
  loadURL = vi.fn();
  loadFile = vi.fn();
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
  destroy = vi.fn(() => {
    const i = BrowserWindow.windows.indexOf(this);
    if (i >= 0) BrowserWindow.windows.splice(i, 1);
  });
  webContents = { on: vi.fn(), send: vi.fn() };
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

export const shell = {
  openExternal: vi.fn(),
};

/** Reset all stub state; call from beforeEach in every spec. */
export function __resetElectronStub(): void {
  app.requestSingleInstanceLock.mockClear();
  app.requestSingleInstanceLock.mockReturnValue(true);
  app.quit.mockClear();
  app.on.mockClear();
  app.once.mockClear();
  emitter.removeAllListeners();
  BrowserWindow.windows.length = 0;
  protocol.handle.mockClear();
  protocol.registerSchemesAsPrivileged.mockClear();
  contextBridge.exposeInMainWorld.mockClear();
}
