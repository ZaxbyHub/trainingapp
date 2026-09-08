// Review-hardening coverage added after the PR #95 swarm review
// (PRR95-011/012/015): dev-mode URL selection (--dev argv and
// ELECTRON_START_URL precedence), the app:// scheme-privilege registration
// contract, bootstrap wiring order, and double-encoded traversal safety.
// Lives in its own file so the checkpoint-frozen specs stay untouched.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  BrowserWindow,
  protocol,
  __resetElectronStub,
} from '../../test/electron-stub';
import {
  bootstrap,
  createMainWindow,
} from '../../main/index';
import {
  createAppFileHandler,
  registerAppSchemePrivileges,
} from '../../main/protocol';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let savedArgv: string[];
let savedEnvUrl: string | undefined;

beforeEach(() => {
  __resetElectronStub();
  savedArgv = process.argv;
  savedEnvUrl = process.env.ELECTRON_START_URL;
  delete process.env.ELECTRON_START_URL;
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedEnvUrl === undefined) delete process.env.ELECTRON_START_URL;
  else process.env.ELECTRON_START_URL = savedEnvUrl;
});

describe('PRR95-011: dev-mode URL selection', () => {
  it('loads the dev server URL when --dev is in argv', () => {
    process.argv = [...savedArgv, '--dev'];
    const win = createMainWindow();
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('ELECTRON_START_URL takes precedence over --dev', () => {
    process.env.ELECTRON_START_URL = 'http://localhost:9999';
    process.argv = [...savedArgv, '--dev'];
    const win = createMainWindow();
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:9999');
  });

  it('production mode (no dev signals) loads app://index.html', () => {
    process.argv = savedArgv.filter((a) => a !== '--dev');
    const win = createMainWindow();
    expect(win.loadURL).toHaveBeenCalledWith('app://index.html');
  });
});

describe('PRR95-011: app:// scheme privileges', () => {
  it('registers app as a standard, secure, fetch-capable scheme', () => {
    registerAppSchemePrivileges();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const [schemes] = protocol.registerSchemesAsPrivileged.mock
      .calls[0] as [{ scheme: string; privileges: Record<string, unknown> }[][]];
    expect(schemes).toHaveLength(1);
    expect(schemes[0].scheme).toBe('app');
    expect(schemes[0].privileges).toMatchObject({
      standard: true,
      secure: true,
      supportFetchAPI: true,
    });
  });
});

describe('PRR95-011: bootstrap wiring order', () => {
  it('registers privileges before consulting the lock and skips startup entirely when the lock is denied', () => {
    app.requestSingleInstanceLock.mockReturnValue(false);
    bootstrap();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // Denied lock must short-circuit: no ready subscription, no handlers,
    // no window.
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.on).not.toHaveBeenCalledWith('window-all-closed', expect.anything());
    expect(app.on).not.toHaveBeenCalledWith('second-instance', expect.anything());
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
  });

  it('on a granted lock, subscribes to ready/second-instance/window-all-closed without quitting', () => {
    // Never-resolving ready keeps the async whenReady path out of this
    // synchronous wiring test (the full ready path is exercised by the
    // real-runtime smoke, not by the stub suite).
    app.whenReady.mockReturnValue(new Promise<void>(() => {}));
    app.requestSingleInstanceLock.mockReturnValue(true);
    bootstrap();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.whenReady).toHaveBeenCalledTimes(1);
    expect(app.on).toHaveBeenCalledWith('second-instance', expect.anything());
    expect(app.on).toHaveBeenCalledWith('window-all-closed', expect.anything());
    expect(protocol.handle).not.toHaveBeenCalled(); // registered on ready, not before
  });
});

describe('PRR95-012: double-encoded traversal is safe by construction', () => {
  it('never resolves double-encoded parent sequences to a parent directory', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'app-proto-hard-'));
    const root = path.join(base, 'root');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<html>ok</html>');
    writeFileSync(path.join(base, 'secret.txt'), 'TOP-SECRET-HARDENING');
    try {
      const handler = createAppFileHandler({ root });
      // Single decode turns %252f into a literal '%2f' inside one segment —
      // never a real separator, so the result is a contained miss (404).
      const res = await handler({ url: 'app://..%252fsecret.txt' } as Request);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('TOP-SECRET-HARDENING');

      const res2 = await handler({ url: 'app://%252e%252e%252fsecret.txt' } as Request);
      expect([403, 404]).toContain(res2.status);
      expect(await res2.text()).not.toContain('TOP-SECRET-HARDENING');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
