// AC3: BrowserWindow must be created with the four secure webPreferences flags
// locked down from commit one (contextIsolation/sandbox ON, nodeIntegration/
// webviewTag OFF), and must load the app:// renderer in production mode. This
// spec also pins the preload seam (contextBridge called exactly once with the
// single namespace `trainingapp` exposing a stub API object).
//
// Seam contract (desktop/main/index.ts, desktop/preload/index.ts):
//   export function createMainWindow(): BrowserWindow
//     - creates THE window; production mode (no `--dev` in process.argv and no
//       ELECTRON_START_URL in the env) loads 'app://index.html'; dev mode loads
//       the dev URL (checked structurally by the dev-wiring check).
//   desktop/preload/index.ts side-effect module calls
//     contextBridge.exposeInMainWorld('trainingapp', <plain object>) exactly once.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserWindow, contextBridge, __resetElectronStub } from '../../test/electron-stub';
import { createMainWindow } from '../../main/index';

let savedArgv: string[];

beforeEach(() => {
  __resetElectronStub();
  delete process.env.ELECTRON_START_URL;
  // Force production mode regardless of how vitest itself was invoked.
  savedArgv = process.argv;
  process.argv = savedArgv.filter((a) => a !== '--dev');
});

afterEach(() => {
  process.argv = savedArgv;
});

const SECURE_FLAGS = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
} as const;

describe('AC3 secure defaults', () => {
  it('creates the window with all four security flags at their exact values', () => {
    const win = createMainWindow();
    expect(win).toBeInstanceOf(BrowserWindow);
    const wp: Record<string, unknown> = win.webPreferences ?? {};
    // Exact toEqual on the security-relevant subset — not loose truthiness.
    expect({
      contextIsolation: wp.contextIsolation,
      sandbox: wp.sandbox,
      nodeIntegration: wp.nodeIntegration,
      webviewTag: wp.webviewTag,
    }).toEqual(SECURE_FLAGS);
  });

  it('negative control: the exact-match comparator rejects mutated webPreferences', () => {
    // Proof that the assertion above is discriminative: flipping any one flag
    // (e.g. nodeIntegration:true or sandbox:false) makes toEqual fail, so a
    // regression cannot pass by truthiness luck.
    const mutatedNode = { ...SECURE_FLAGS, nodeIntegration: true };
    const mutatedSandbox = { ...SECURE_FLAGS, sandbox: false };
    const mutatedIsolation = { ...SECURE_FLAGS, contextIsolation: false };
    const mutatedWebview = { ...SECURE_FLAGS, webviewTag: true };
    expect(mutatedNode).not.toEqual(SECURE_FLAGS);
    expect(mutatedSandbox).not.toEqual(SECURE_FLAGS);
    expect(mutatedIsolation).not.toEqual(SECURE_FLAGS);
    expect(mutatedWebview).not.toEqual(SECURE_FLAGS);
  });

  it('production mode loads the app:// renderer entry, not a file:// or remote URL', () => {
    const win = createMainWindow();
    expect(win.loadURL).toHaveBeenCalledWith('app://index.html');
    expect(win.loadFile).not.toHaveBeenCalled();
  });

  it('preload exposes exactly one namespace, `trainingapp`, with a plain-object API', async () => {
    // Imported dynamically here so the module's contextBridge side effect runs
    // AFTER the beforeEach stub reset (the ESM registry caches it; vitest
    // isolates registries per test file, so it fires exactly once for this spec).
    await import('../../preload/index');
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [name, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [
      string,
      unknown,
    ];
    expect(name).toBe('trainingapp');
    expect(api).toBeTypeOf('object');
    expect(api).not.toBeNull();
  });
});
