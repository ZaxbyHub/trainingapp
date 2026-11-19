// updates-ipc-handler.test.ts - issue #366 (WI5): the REAL
// `desktop:updates:set-opt-in` IPC handler (registered by bootstrap(),
// driven through the same electron-stub harness as b3-bootstrap-wiring)
// carries the explicit `persisted:true` marker on EVERY successful
// post-persistence return path (both the check-failure return and the
// success return) and carries NO marker on the validation and
// persistence-failure returns. The renderer's audit producer emits
// settings_change ONLY on this marker - so a committed opt-in whose
// follow-up check FAILED still logs exactly one row, and a failed
// persistence logs none.
import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, ipcMain, __resetElectronStub } from 'electron';
import { bootstrap } from '../../main/index';

// Hermetic userData (b3 precedent): bootstrap activates the diagnostics file
// sink under <userData>/logs; the updates sidecar rides
// <userData>/store.sqlite-updates.json (updatesStatePathFor over
// dirname(storePath) — the profile dir is userData itself in this harness).
const hermeticUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-ipc-userdata-'));
// Pin the profile store path so updatesProfileDir (= dirname(storePath)) is
// deterministic: <pinned>/updates.json is the sidecar updatesStatePathFor.
const STORE_PATH = path.join(hermeticUserData, 'profiles', 'default', 'store.sqlite');
const UPDATES_SIDECAR = path.join(STORE_PATH, '..', 'updates.json');

type SetOptInResult = { ok: boolean; persisted?: true; detail?: string };

async function waitFor<T>(fn: () => T | undefined | null, description: string, timeoutMs = 8000): Promise<T> {
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

describe('updates IPC handler: persisted marker contract (issue #366)', () => {
  beforeEach(() => {
    __resetElectronStub();
    process.env.TRAININGAPP_DESKTOP_STORE_PATH = STORE_PATH;
    app.getPath.mockImplementation((name: string) =>
      name === 'userData' ? hermeticUserData : process.cwd(),
    );
    try {
      fs.rmSync(UPDATES_SIDECAR, { force: true });
    } catch {
      /* fresh per test */
    }
  });

  afterEach(async () => {
    app.emit('will-quit');
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterAll(() => {
    app.emit('will-quit');
    fs.rmSync(hermeticUserData, { recursive: true, force: true });
  });

  it('a persisted opt-in whose follow-up CHECK FAILS still returns persisted:true (updates-ipc)', async () => {
    // Deterministic failed check: the follow-up performUpdateCheck performs
    // networked steps (loopback pack listing + feed fetch); stubbing global
    // fetch to REJECT makes it throw, so the handler's catch arm returns
    // ok:false 'update check failed' on every host (review round 2: the
    // earlier shape could silently take the success path).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('hermetic: network disabled'));
    bootstrap();
    const handler = await getRegisteredHandler('desktop:updates:set-opt-in');
    try {
      const result = (await handler(null, true)) as SetOptInResult;
      expect(result.ok).toBe(false);
      // The handler's catch arm mirrors the thrown error message verbatim
      // (F-016 shape); the contract under test is the marker + commit, not
      // the detail wording.
      expect(typeof result.detail).toBe('string');
      // The PERSISTENCE committed before the check ran - the marker rides the
      // failed-check reply (the contract the renderer's audit producer keys on).
      expect(result.persisted).toBe(true);
      // The sidecar now carries the committed opt-in.
      const state = JSON.parse(fs.readFileSync(UPDATES_SIDECAR, 'utf8')) as { optIn: boolean };
      expect(state.optIn).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('the opt-out return (no follow-up check) carries persisted:true too (updates-ipc)', async () => {
    bootstrap();
    const handler = await getRegisteredHandler('desktop:updates:set-opt-in');
    const result = (await handler(null, false)) as SetOptInResult;
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(true);
  });

  it('a PERSISTENCE FAILURE returns ok:false with NO marker (updates-ipc)', async () => {
    // Force saveUpdatesState to throw: point the pinned store path INTO a
    // FILE path (mkdirSync over an existing file throws EEXIST/ENOTDIR - the
    // resolveProfileLayout env override TRAININGAPP_DESKTOP_STORE_PATH takes
    // precedence over userData, so this beats the harness default).
    const fileAsDir = path.join(hermeticUserData, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    const previousStorePath = process.env.TRAININGAPP_DESKTOP_STORE_PATH;
    process.env.TRAININGAPP_DESKTOP_STORE_PATH = path.join(fileAsDir, 'store.sqlite');
    try {
      bootstrap();
      const handler = await getRegisteredHandler('desktop:updates:set-opt-in');
      const result = (await handler(null, false)) as SetOptInResult;
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('could not persist the updates setting');
      expect(result.persisted).toBeUndefined();
    } finally {
      if (previousStorePath === undefined) {
        delete process.env.TRAININGAPP_DESKTOP_STORE_PATH;
      } else {
        process.env.TRAININGAPP_DESKTOP_STORE_PATH = previousStorePath;
      }
    }
  });

  it('validation failure carries NO marker and persists nothing (updates-ipc)', async () => {
    bootstrap();
    const handler = await getRegisteredHandler('desktop:updates:set-opt-in');
    const result = (await handler(null, 'not-a-boolean')) as SetOptInResult;
    expect(result.ok).toBe(false);
    expect(result.persisted).toBeUndefined();
    // The persisted sidecar still reflects the default (opt-in off) - nothing
    // was committed by this rejected call.
    if (fs.existsSync(UPDATES_SIDECAR)) {
      const state = JSON.parse(fs.readFileSync(UPDATES_SIDECAR, 'utf8')) as { optIn?: boolean };
      expect(state.optIn).toBe(false);
    }
  });
});
