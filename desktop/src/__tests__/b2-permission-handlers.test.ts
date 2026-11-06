// C4 / AC4 (issue #276, Workstream G): the shell denies renderer permission
// requests by default. bootstrap() must register BOTH Electron permission
// handlers on session.defaultSession before any window exists; the request
// handler must deny everything except clipboard-sanitized-write and
// persistent-storage (the two permission-governed APIs the app's own renderer
// uses), and the check handler must give the same answers.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, BrowserWindow, session, __resetElectronStub } from 'electron';
import { bootstrap } from '../../main/index';
import { __resetTransportSecurityForTests } from '../../main/security/index';

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: unknown,
) => void;
type CheckHandler = (webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean;

const DENIED = ['media', 'geolocation', 'notifications', 'fullscreen', 'midi', 'midiSysex', 'openExternal'];
const ALLOWED = ['clipboard-sanitized-write', 'persistent-storage'];

const hermeticUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-permission-userdata-'));

async function waitFor<T>(fn: () => T | undefined | null, description: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const requestRecorder = session.defaultSession.setPermissionRequestHandler as ReturnType<typeof vi.fn>;
const checkRecorder = session.defaultSession.setPermissionCheckHandler as ReturnType<typeof vi.fn>;

let windowsAtRequestRegistration: number | null = null;
let windowsAtCheckRegistration: number | null = null;

beforeEach(() => {
  __resetElectronStub();
  app.getPath.mockImplementation((name: string) => (name === 'userData' ? hermeticUserData : process.cwd()));
  __resetTransportSecurityForTests();
  windowsAtRequestRegistration = null;
  windowsAtCheckRegistration = null;
  // Record how many windows exist at the moment each handler is registered.
  requestRecorder.mockImplementation(() => {
    windowsAtRequestRegistration = BrowserWindow.getAllWindows().length;
  });
  checkRecorder.mockImplementation(() => {
    windowsAtCheckRegistration = BrowserWindow.getAllWindows().length;
  });
});

afterEach(async () => {
  app.emit('will-quit');
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  app.emit('will-quit');
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(hermeticUserData, { recursive: true, force: true });
});

async function bootAndCaptureHandlers(): Promise<{ request: RequestHandler; check: CheckHandler }> {
  bootstrap();
  const request = await waitFor(
    () => requestRecorder.mock.calls[0]?.[0] as RequestHandler | undefined,
    'setPermissionRequestHandler registration',
  );
  const check = await waitFor(
    () => checkRecorder.mock.calls[0]?.[0] as CheckHandler | undefined,
    'setPermissionCheckHandler registration',
  );
  return { request, check };
}

function requestDecision(handler: RequestHandler, permission: string): boolean {
  const callback = vi.fn();
  handler({}, permission, callback, { requestingUrl: 'app://trainingapp/' });
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0][0] as boolean;
}

describe('b2-permission-handlers: deny-by-default default-session policy (issue #276 AC4)', () => {
  it('bootstrap() registers BOTH handlers on session.defaultSession exactly once, before any window exists', async () => {
    const { request, check } = await bootAndCaptureHandlers();
    expect(typeof request).toBe('function');
    expect(typeof check).toBe('function');
    expect(requestRecorder).toHaveBeenCalledTimes(1);
    expect(checkRecorder).toHaveBeenCalledTimes(1);
    // A null handler would restore Electron's grant-most default.
    expect(requestRecorder.mock.calls[0][0]).not.toBeNull();
    expect(checkRecorder.mock.calls[0][0]).not.toBeNull();
    expect(windowsAtRequestRegistration).toBe(0);
    expect(windowsAtCheckRegistration).toBe(0);
  });

  it.each(DENIED)('request handler DENIES %s', async (permission) => {
    const { request } = await bootAndCaptureHandlers();
    expect(requestDecision(request, permission)).toBe(false);
  });

  it.each(DENIED)('check handler answers false for %s', async (permission) => {
    const { check } = await bootAndCaptureHandlers();
    expect(check(null, permission, 'app://trainingapp', {})).toBe(false);
  });

  it.each(ALLOWED)('request handler ALLOWS %s', async (permission) => {
    const { request } = await bootAndCaptureHandlers();
    expect(requestDecision(request, permission)).toBe(true);
  });

  it.each(ALLOWED)('check handler answers true for %s', async (permission) => {
    const { check } = await bootAndCaptureHandlers();
    expect(check(null, permission, 'app://trainingapp', {})).toBe(true);
  });

  it('an unknown permission name is denied by both handlers', async () => {
    const { request, check } = await bootAndCaptureHandlers();
    expect(requestDecision(request, 'unknown')).toBe(false);
    expect(check(null, 'unknown', 'app://trainingapp', {})).toBe(false);
  });
});
