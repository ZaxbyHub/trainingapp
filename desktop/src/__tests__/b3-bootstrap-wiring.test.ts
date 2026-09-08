// B3 spec (issue #61): the REAL runtime wiring the headless checks cannot
// see — bootstrap() must start the backend host behind the B2 guard, expose
// the desktop:get-backend IPC (port discovery for B9), and stop the host on
// will-quit (no orphan listener). Runs against the electron stub.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, ipcMain, __resetElectronStub } from 'electron';
import { bootstrap } from '../../main/index';
import { __resetTransportSecurityForTests } from '../../main/security/index';

async function waitFor<T>(fn: () => T | undefined | null, description: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function getRegisteredHandler(channel: string): Promise<(...args: unknown[]) => unknown> {
  return waitFor(() => {
    const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === channel);
    return call ? (call[1] as (...args: unknown[]) => unknown) : undefined;
  }, `ipc handler ${channel}`);
}

beforeEach(() => {
  __resetElectronStub();
  __resetTransportSecurityForTests();
});

afterEach(async () => {
  // Stop THIS test's host: the next beforeEach wipes the will-quit listener
  // (stub emitter reset) WITHOUT firing it, so an un-stopped host here would
  // hold its port until process exit — previously only the LAST host in the
  // file was ever stopped (afterAll).
  app.emit('will-quit');
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  // Stop any host left running by a failed assertion.
  app.emit('will-quit');
  await new Promise((resolve) => setTimeout(resolve, 50));
});

describe('b3-bootstrap-wiring: the real runtime path (issue #61)', () => {
  it('bootstrap() starts the guarded backend host and registers desktop:get-backend returning the live handle', async () => {
    bootstrap();
    const getBackend = await getRegisteredHandler('desktop:get-backend');
    const handle = (await getBackend()) as { mode: string; port: number; url: string };
    expect(handle.mode).toBe('node');
    expect(Number.isInteger(handle.port)).toBe(true);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);

    // The guard is live: the launch token from desktop:get-token is required,
    // and the guarded /health answers 200 with it.
    const getToken = await getRegisteredHandler('desktop:get-token');
    const token = (await getToken()) as string;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`, {
      headers: { 'X-Desktop-Token': token },
    });
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; engine_ready: boolean };
    expect(body.status).toBe('ok');
    expect(typeof body.engine_ready).toBe('boolean');
  });

  it('the unguarded path stays closed: requests without the transport token get 401', async () => {
    bootstrap();
    const getBackend = await getRegisteredHandler('desktop:get-backend');
    const handle = (await getBackend()) as { port: number };
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(health.status).toBe(401);
  });

  it('will-quit stops the backend host (no orphan listener)', async () => {
    bootstrap();
    const getBackend = await getRegisteredHandler('desktop:get-backend');
    const handle = (await getBackend()) as { port: number };
    app.emit('will-quit');
    // AWAIT the probe inside the loop and ASSERT the terminal state: the
    // port must actually close. (Final-critic fix: the previous version
    // returned a Promise object — always non-null — from the waitFor
    // callback, so the boolean was never awaited or asserted and the test
    // passed even with the will-quit handler removed.)
    const deadline = Date.now() + 5000;
    let closed = false;
    while (Date.now() < deadline) {
      if (await netProbeClosed(handle.port)) {
        closed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(closed).toBe(true);
  });
});

/** Resolve true when nothing accepts connections on the port any more. */
async function netProbeClosed(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.default.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(true);
    });
  });
}
