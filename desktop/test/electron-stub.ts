// In-memory Electron stub for the issue #59/#60 acceptance checks.
// desktop/vitest.config.ts aliases the bare specifier 'electron' to this file,
// so neither the specs nor the production seams under test need the real
// Electron binary. The stub mirrors the small surface the seams are allowed to
// touch: app, BrowserWindow, protocol, contextBridge, ipcRenderer, ipcMain, session,
// utilityProcess,
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
// - `session.defaultSession.setPermissionRequestHandler` /
//   `setPermissionCheckHandler` are vi.fn recorders (issue #276 AC4): the
//   b2-permission-handlers spec extracts the registered handlers from their
//   mock calls and invokes them per permission.
// - `utilityProcess.fork` (issue #276 G3b) is a vi.fn returning a
//   FakeUtilityProcess (an EventEmitter with kill/pid/stderr/postMessage);
//   specs drive it with `child.emit('message', report)` / `emit('exit', 0)`.
//   The default child posts nothing and exits 1 — override per spec.
// - Call `__resetElectronStub()` from beforeEach in every spec.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

const emitter = new EventEmitter();

// issue #248: `userData` answers a per-process TEMP dir, never the cwd —
// specs that drive the real bootstrap activate the diagnostics file sink
// under <userData>/logs, and that must never write into the checkout.
// Review PRR-022 (pr255): the memo is cleared by __resetElectronStub (which
// also removes the directory, best effort), so every test starts from a
// fresh dir instead of sharing one per FILE that nothing ever deleted.
let stubUserData: string | null = null;

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
  getPath: vi.fn((name: string): string => {
    if (name === 'userData') {
      stubUserData ??= fs.mkdtempSync(path.join(os.tmpdir(), 'electron-stub-userdata-'));
      return stubUserData;
    }
    return process.cwd();
  }),
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
  // issue #248: the diagnostics export's native save dialog. Defaults to
  // cancelled; specs override the resolved value per case.
  showSaveDialog: vi.fn((): Promise<{ canceled: boolean; filePath?: string }> =>
    Promise.resolve({ canceled: true }),
  ),
};

// issue #276 AC4: the default session's permission-handler surface. The
// recorders keep every registered handler in mock.calls; production code
// registers each exactly once per bootstrap.
export const session = {
  defaultSession: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  },
};

// issue #276 G3b: Electron utilityProcess stand-in for the GPU probe launcher.
export class FakeUtilityProcess extends EventEmitter {
  readonly modulePath: string;
  readonly args: string[];
  readonly options: Record<string, unknown> | undefined;
  pid: number | undefined = 4242;
  stdout: EventEmitter | null = null;
  stderr: EventEmitter | null = new EventEmitter();
  killed = false;
  kill = vi.fn((): boolean => {
    this.killed = true;
    return true;
  });
  postMessage = vi.fn();
  constructor(modulePath: string, args: string[] = [], options?: Record<string, unknown>) {
    super();
    this.modulePath = modulePath;
    this.args = args;
    this.options = options;
  }
}

/** Default fork: a child that posts nothing and exits 1 on the next tick (a
 *  module that failed to load) — so a bootstrap-driven probe in an unrelated
 *  spec settles to its CPU fallback promptly instead of hanging to its
 *  deadline. Specs that drive the probe override the implementation. */
function defaultFork(modulePath: string, args?: string[], options?: Record<string, unknown>): FakeUtilityProcess {
  const child = new FakeUtilityProcess(modulePath, args ?? [], options);
  setImmediate(() => child.emit('exit', 1));
  return child;
}

export const utilityProcess = {
  fork: vi.fn(defaultFork),
};

/** universal-provider-settings-overhaul: no OS encryption in tests (keys stay session-only). */
export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((plain: string) => {
    throw new Error(`safeStorage stub cannot encrypt (${plain.length} chars)`);
  }),
  decryptString: vi.fn(() => {
    throw new Error('safeStorage stub cannot decrypt');
  }),
};

/** Reset all stub state; call from beforeEach in every spec. */
export function __resetElectronStub(): void {
  // PRR-022 (pr255 review): release the userData temp dir FIRST — specs that
  // re-derive paths after the reset must get a FRESH dir, and the old one is
  // removed best-effort (a handle still open from a leaked sink only delays
  // the deletion to OS temp cleanup, it never fails the reset).
  if (stubUserData !== null) {
    try {
      fs.rmSync(stubUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort only */
    }
    stubUserData = null;
  }
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
  utilityProcess.fork.mockReset();
  utilityProcess.fork.mockImplementation(defaultFork);
  session.defaultSession.setPermissionRequestHandler.mockReset();
  session.defaultSession.setPermissionCheckHandler.mockReset();
  dialog.showErrorBox.mockClear();
  dialog.showSaveDialog.mockClear();
  dialog.showSaveDialog.mockReturnValue(Promise.resolve({ canceled: true }));
}
