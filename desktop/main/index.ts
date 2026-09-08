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
import { app, BrowserWindow } from 'electron';
import { registerAppProtocol, registerAppSchemePrivileges } from './protocol.js';

const DEV_URL = 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function isDevArgv(): boolean {
  return process.argv.includes('--dev');
}

function devStartUrl(): string | undefined {
  const envUrl = process.env.ELECTRON_START_URL;
  return envUrl !== undefined && envUrl.length > 0 ? envUrl : isDevArgv() ? DEV_URL : undefined;
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
      preload: path.join(moduleDir(), '..', 'preload', 'index.js'),
    },
  });
  win.once('ready-to-show', () => win.show());
  const url = devStartUrl() ?? 'app://index.html';
  void win.loadURL(url);
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

  app.whenReady().then(() => {
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
