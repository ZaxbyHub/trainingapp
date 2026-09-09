// Electron main-process bootstrap for the TrainingApp desktop shell (issue #59).
//
// Scope guard (Workstream B1): this module is ONLY the window shell — single
// instance, secure defaults, app:// renderer hosting. Backend hosting arrives
// with Workstream B3 (#61) and MUST live in its own module (the ADR-0003
// decision, issue #57, renames/replaces that file mechanically without
// touching this bootstrap). Baseline transport hardening beyond the flags
// below is Workstream B2 / issue #60.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { registerAppProtocol, registerAppSchemePrivileges } from './protocol.js';
import { createBackendHost, resolveBackendMode, resolveNodeEngine, type BackendHandle, type BackendHost } from './backend/index.js';
import {
  getLoopbackGuard,
  getLaunchToken,
  initializeLaunchToken,
  initializeTransportSecurity,
  resolveSecurityConfig,
} from './security/index.js';

const DEV_URL = 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function isDevArgv(): boolean {
  return process.argv.includes('--dev');
}

function devStartUrl(): string | undefined {
  const envUrl = process.env.ELECTRON_START_URL;
  return envUrl !== undefined && envUrl.length > 0 ? envUrl : isDevArgv() ? DEV_URL : undefined;
}

/**
 * Navigation allow-list (issue #60): the renderer may only navigate itself to
 * app:// targets; in dev mode the dev server origin is additionally allowed
 * so vite's full-page reloads keep working. Everything else — remote http(s),
 * file://, even loopback http in production — is denied.
 */
function isAllowedNavigationTarget(url: string): boolean {
  if (url.startsWith('app://')) return true;
  const dev = devStartUrl();
  if (dev === undefined) return false;
  try {
    return new URL(url).origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

/** Directory of the compiled module (dist/main), valid under ESM. */
function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Renderer root packaged by electron-builder extraResources (renderer -> web_ui). */
function resolveRendererRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web_ui');
  }
  // Unpackaged run (electron . without packaging): the desktop:build staging
  // dir, two levels above the compiled dist/main module.
  return path.join(moduleDir(), '..', '..', 'renderer');
}

/**
 * Create the one and only application window.
 *
 * Secure defaults are contractual (frozen spec, AC3):
 * contextIsolation/sandbox on, nodeIntegration/webviewTag off. Production
 * loads the packaged renderer via app://; dev mode (--dev argv or
 * ELECTRON_START_URL) loads the vite dev server instead.
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      // .cjs: sandboxed renderers only load CommonJS preloads (ESM preloads
      // require sandbox:false), and the .cjs extension is unambiguous under
      // this package's "type": "module".
      preload: path.join(moduleDir(), '..', 'preload', 'index.cjs'),
    },
  });
  win.once('ready-to-show', () => win.show());
  // Navigation lockdown (issue #60, AC4): the only renderer-initiated
  // navigations are app:// targets (plus the dev server origin in dev mode);
  // window.open is denied outright — no popups, no new windows, ever.
  // NOTE: the window-open handler lives on webContents (the only surface that
  // exists in Electron >= 44 typings AND at runtime — verified by probe:
  // win.setWindowOpenHandler is undefined); will-navigate is webContents-native.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationTarget(url)) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler((): { action: 'deny' } => ({ action: 'deny' }));
  // Surface load failures instead of leaving a silent blank/hidden window
  // (e.g. dev server down, renderer resources incomplete).
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[trainingapp-desktop] failed to load ${validatedURL || '(no url)'}: ${errorDescription} (${errorCode})`);
    win.show();
  });
  const url = devStartUrl() ?? 'app://index.html';
  win.loadURL(url).catch(() => { /* failure surfaced via did-fail-load above */ });
  mainWindow = win;
  return win;
}

/**
 * Claim the single-instance lock. Returns false when another instance owns
 * it; that other instance is already focused by its second-instance handler,
 * so this process quits immediately.
 */
export function acquireSingleInstanceLock(): boolean {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    app.quit();
  }
  return acquired;
}

/** Focus/restore the existing window when a second launch is attempted. */
export function registerSecondInstanceHandler(): void {
  app.on('second-instance', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) {
      win.restore();
    }
    win.focus();
  });
}

/** Application entry point. Idempotent per process. */
export function bootstrap(): void {
  // Must precede the ready event.
  registerAppSchemePrivileges();
  if (!acquireSingleInstanceLock()) return;
  registerSecondInstanceHandler();

  app.whenReady().then(async () => {
    // Transport security (issue #60, B2): resolve config, mint the per-launch
    // token (main-process memory only), serve it to the renderer ONLY through
    // this IPC handler, and construct the loopback gate that B3's backend
    // host MUST mount in front of every route (docs/security/desktop.md).
    const securityConfig = resolveSecurityConfig();
    initializeLaunchToken();
    ipcMain.handle('desktop:get-token', () => getLaunchToken());
    initializeTransportSecurity({
      token: getLaunchToken(),
      tokenHeaderName: securityConfig.tokenHeaderName,
      allowedOrigins: securityConfig.allowedOrigins,
    });
    if (getLoopbackGuard() === null) {
      // Fail fast and audibly rather than booting an unguarded transport.
      console.error('[trainingapp-desktop] transport security failed to initialize; refusing to start');
      app.quit();
      return;
    }
    // Backend host (issue #61, B3): start the guarded loopback listener behind
    // the B2 guard, selected by backend.mode (node default; ADR-0003 #57).
    // B4-B9 import ONLY desktop/main/backend/index.js — never this wiring.
    let backendHost: BackendHost | null = null;
    let backendHandle: BackendHandle | null = null;
    try {
      backendHost = createBackendHost({
        token: getLaunchToken(),
        tokenHeaderName: securityConfig.tokenHeaderName,
        allowedOrigins: securityConfig.allowedOrigins,
        mode: resolveBackendMode({ env: process.env }),
        // B4 (issue #62): when backend.mode is "node", serve real llama.cpp
        // inference with the model dir defaulting to <userData>/models.
        engine: resolveNodeEngine(process.env, { userDataPath: app.getPath('userData') }),
        // B5 (issue #63): open the per-profile SQLite store under userData on
        // the production start path (failure-isolated in the host).
        storePath: path.join(app.getPath('userData'), 'store', 'store.db'),
        // Fail-loud surfacing when the sidecar exhausts its restart budget
        // (console.error alone is invisible in a packaged Electron app).
        onGiveUp: (attempts) => {
          console.error(`[trainingapp-desktop] backend sidecar exhausted its restart budget (${attempts}); requests will fail until restart`);
          dialog.showErrorBox(
            'TrainingApp backend stopped',
            `The local answer engine exited repeatedly (${attempts} restarts) and gave up. Restart the app to try again.`,
          );
        },
      });
      backendHandle = await backendHost.start();
    } catch (err) {
      console.error('[trainingapp-desktop] backend host failed to start:', err instanceof Error ? err.message : err);
      app.quit();
      return;
    }
    // Port discovery for B9 (renderer integration): the ONLY channel the
    // backend address takes to the renderer — never web storage, never a URL.
    ipcMain.handle('desktop:get-backend', () => backendHandle);
    let quitting = false;
    app.on('will-quit', (event) => {
      if (quitting || backendHost === null) return;
      // HOLD the quit until backend shutdown completes: stop() runs the
      // sidecar graceful-then-kill sequence (grace windows are real time),
      // and an unawaited stop let Electron exit mid-cleanup, orphaning the
      // child. preventDefault + app.quit() after stop() resumes the quit;
      // the re-entrant will-quit passes through via `quitting`.
      quitting = true;
      event?.preventDefault();
      void backendHost.stop().finally(() => app.quit());
    });
    // NOTE: in dev mode the app:// handler is intentionally NOT registered
    // (the vite dev server serves the renderer), so an app:// target allowed
    // by the navigation policy below would fail to load in dev. Production
    // mode registers both, so policy and handler are always consistent there.
    // Dev mode loads the vite dev server and needs no packaged renderer.
    if (devStartUrl() === undefined) {
      const root = resolveRendererRoot();
      if (!existsSync(root)) {
        // Fail fast and audibly rather than booting a half-broken window.
        console.error(`[trainingapp-desktop] renderer resources missing at ${root}; reinstall the app`);
        app.quit();
        return;
      }
      registerAppProtocol({ root });
    }
    createMainWindow();
  }).catch((err: unknown) => {
    console.error('[trainingapp-desktop] startup failure:', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// Self-start only inside a real Electron main process ("browser"). Under
// vitest (node) or ELECTRON_RUN_AS_NODE, process.type is undefined and
// importing this module stays side-effect free for the specs.
if (process.type === 'browser') {
  bootstrap();
}
