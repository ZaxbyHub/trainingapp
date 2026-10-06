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
import { closeAllApps, closeApp, isProcessAlive, launchElectron, makeTempDir, makeUserDataDir, removeTempDir } from './launch-helpers.js';

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

// critic-final-2 D2 / critic-final-3 L2: no file may launch Electron itself (that would run on the
// developer's real profile); every launch goes through launchElectron, which always passes a temp
// --user-data-dir. The guard looks for ANY way to reach the launcher (named or aliased import,
// default or namespace import, require/dynamic-import destructuring), not the `.launch(` call text.
// The identifier is assembled at runtime, so this file never contains it and scans itself too.
const LAUNCHER = ['_elec', 'tron'].join('');
const MODULES = String.raw`(?:@playwright\/test|playwright)`;
const BYPASS_PATTERNS: readonly RegExp[] = [
  // import { _x }, import { _x as y }, import { a, _x as b, type C } from the Playwright package
  new RegExp(String.raw`import\s*(?:type\s*)?\{[^}]*\b${LAUNCHER}\b[^}]*\}\s*from\s*['"]${MODULES}['"]`),
  // default / namespace import, then pw._x.launch(...), or require('playwright')._x
  new RegExp(String.raw`\.${LAUNCHER}\b`),
  // const { _x } = require(...) / await import(...)
  new RegExp(String.raw`\{[^}]*\b${LAUNCHER}\b[^}]*\}\s*=`),
];

/** True when the source reaches the Playwright Electron launcher by any of the known routes. */
function bypassesLaunchHelper(source: string): boolean {
  return BYPASS_PATTERNS.some((pattern) => pattern.test(source));
}

test('the bypass detector flags the aliased, default, namespace and require forms (and nothing else)', () => {
  const pkg = "'@playwright/test'";
  const flagged = [
    `import { ${LAUNCHER} as electron } from ${pkg};\nawait electron.launch({ args: ['.'] });`,
    `import { test, ${LAUNCHER} } from "playwright";`,
    `import { type Page, ${LAUNCHER} as e } from ${pkg};`,
    `import pw from 'playwright';\nawait pw.${LAUNCHER}.launch({});`,
    `import * as pw from ${pkg};\nawait pw.${LAUNCHER}.launch({});`,
    `const { ${LAUNCHER}: electron } = require('playwright');`,
    `const { ${LAUNCHER} } = await import(${pkg});`,
  ];
  for (const source of flagged) expect(bypassesLaunchHelper(source), source).toBe(true);
  const clean = [
    `import { test, expect, type Page } from ${pkg};`,
    `import type { ElectronApplication } from 'playwright';`,
    `import { launchElectron } from './launch-helpers.js';`,
  ];
  for (const source of clean) expect(bypassesLaunchHelper(source), source).toBe(false);
});

test('every desktop e2e file launches Electron through launch-helpers (never the Playwright launcher directly)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts'));
  const specs = files.filter((name) => name.endsWith('.spec.ts'));
  expect(specs.length).toBeGreaterThanOrEqual(7);
  // launch-helpers.ts is the one place allowed to import the launcher.
  const direct = files.filter(
    (name) => name !== 'launch-helpers.ts' && bypassesLaunchHelper(fs.readFileSync(path.join(dir, name), 'utf8')),
  );
  expect(direct, 'these files bypass the temp-profile launch helper').toEqual([]);
  const viaHelper = specs.filter((name) => fs.readFileSync(path.join(dir, name), 'utf8').includes('launchElectron('));
  expect(viaHelper.sort()).toEqual(specs.sort());
});

test('closeApp still kills the Electron tree when close() fails and disposes the handle', async () => {
  // critic-final-3 L1: the child must be captured BEFORE close(); once Playwright disposes the
  // handle, process() throws. Forced here: close() rejects at once WITHOUT closing Electron and
  // flips the handle to disposed, so only a pre-captured child can still be killed.
  const root = makeTempDir('launch-helpers-closeapp-');
  roots.push(root);
  const { app } = await launchElectron({ userDataDir: makeUserDataDir(root), env: stubEnv(root) });
  const pid = app.process().pid as number;
  expect(pid).toBeDefined();
  const realProcess = app.process.bind(app);
  let disposed = false;
  app.close = () => {
    disposed = true;
    return Promise.reject(new Error('forced close failure (probe)'));
  };
  app.process = () => {
    if (disposed) throw new Error('ElectronApplication has been disposed (probe)');
    return realProcess();
  };
  try {
    await closeApp(app);
    expect(isProcessAlive(pid), `Electron PID ${pid} survived closeApp after a failed close()`).toBe(false);
  } finally {
    if (isProcessAlive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  }
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
