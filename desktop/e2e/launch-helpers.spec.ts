/**
 * launch-helpers.spec.ts: the shared launch's failure cleanup (critic-final-2,
 * desktop-model-gate launchApp LOW). If the first window or its load fails
 * after Electron started, launchElectron must close THAT Electron before it
 * rethrows: otherwise the process outlives the spec holding its temp profile
 * (and the single-instance lock), and the workspace cannot be deleted.
 *
 * Each probe forces the failure deterministically by replacing, on the one
 * launched instance only, the method the helper awaits, then checks that the
 * launched PID is gone and its temp profile can be deleted. Stub engine, hash
 * embedder, temp store: the same recipe as renderer-smoke.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { closeAllApps, isProcessAlive, launchElectron, makeTempDir, makeUserDataDir, removeTempDir } from './launch-helpers.js';

const roots: string[] = [];

test.afterAll(async () => {
  await closeAllApps();
  for (const root of roots) removeTempDir(root);
});

function stubEnv(root: string): Record<string, string | undefined> {
  const storePath = path.join(root, 'store', 'profiles', 'default', 'store.sqlite');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  return {
    ...process.env,
    ELECTRON_START_URL: 'http://127.0.0.1:4173',
    TRAININGAPP_DESKTOP_DEV_ORIGINS: 'http://127.0.0.1:4173',
    TRAININGAPP_DESKTOP_ENGINE: 'stub',
    TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
    TRAININGAPP_DESKTOP_STORE_PATH: storePath,
  };
}

/** Run a launch whose given step fails; return the launched PID (read at launch: the
 *  Playwright handle is disposed once the helper has closed the app). */
async function failingLaunch(step: 'firstWindow' | 'waitForLoadState'): Promise<{ pid: number; root: string }> {
  const root = makeTempDir(`launch-helpers-${step}-`);
  roots.push(root);
  let pid: number | undefined;
  const forced = `forced ${step} failure (probe)`;
  await expect(
    launchElectron({
      userDataDir: makeUserDataDir(root),
      env: stubEnv(root),
      onLaunched: (app) => {
        pid = app.process().pid;
        if (step === 'firstWindow') app.firstWindow = () => Promise.reject(new Error(forced));
      },
      onWindow: (page) => {
        if (step === 'waitForLoadState') page.waitForLoadState = () => Promise.reject(new Error(forced));
      },
    })
  ).rejects.toThrow(forced);
  expect(pid, 'the probe must have started Electron').toBeDefined();
  return { pid: pid as number, root };
}

// critic-final-2 D2: no spec may launch Electron itself (that would run on the developer's real
// profile); every launch goes through launchElectron, which always passes a temp --user-data-dir.
test('every desktop e2e spec launches Electron through launch-helpers (never _electron.launch directly)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const specs = fs.readdirSync(dir).filter((name) => name.endsWith('.spec.ts'));
  expect(specs.length).toBeGreaterThanOrEqual(7);
  // Built at runtime so this file's own source does not contain the needle.
  const needle = ['_electron', 'launch('].join('.');
  const direct = specs.filter((name) => fs.readFileSync(path.join(dir, name), 'utf8').includes(needle));
  expect(direct, 'these specs bypass the temp-profile launch helper').toEqual([]);
  const viaHelper = specs.filter((name) => fs.readFileSync(path.join(dir, name), 'utf8').includes('launchElectron('));
  expect(viaHelper.sort()).toEqual(specs.sort());
});

for (const step of ['firstWindow', 'waitForLoadState'] as const) {
  test(`a launch whose ${step} fails closes its Electron and frees the temp profile`, async () => {
    const { pid, root } = await failingLaunch(step);
    try {
      // The launched process (tree root) is gone, by its own PID.
      expect(isProcessAlive(pid), `Electron PID ${pid} is still running after the failed launch`).toBe(false);
      // Nothing holds the temp profile any more: the workspace can be deleted.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      // Never leak from the probe itself, whatever the helper did (this PID only).
      if (isProcessAlive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    }
  });
}
