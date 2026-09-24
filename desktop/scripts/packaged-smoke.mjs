#!/usr/bin/env node
// packaged-smoke.mjs — packaged-boot CI smoke (issue #133 AC7, cf. #131 item 2).
//
// Boots the PACKAGED app (desktop-release/win-unpacked/TrainingApp.exe —
// produced moments earlier by the fixture build in the same job) under
// Playwright _electron with:
//   - TRAININGAPP_DESKTOP_EMBEDDER=hash (the sanctioned deterministic test
//     seam — fixture-mode weights cannot arm the ONNX embedder)
//   - an ISOLATED TRAININGAPP_DESKTOP_STORE_PATH / TRAININGAPP_DESKTOP_PACKS_DIR
//     so the runner's real profile store is never touched
// and asserts the first-run ladder end to end:
//   1. manifest staged with zero verify failures (the packaged integrity gate)
//   2. packs.toolsAvailable === true          (store init + embedder + PackManager)
//   3. activateFirstRunPacks → ok && every manifest-required pack active
//   4. completeFirstRun({selectedProfile:'fast', acknowledgedLicenses:true}) → ok
//   5. GET /packs → 200 (not the 503 'not wired on this host')
//   6. relaunch fresh (same store) → getFirstRunStatus().needed === false
//
// Exit 0 all-pass / 1 any assertion failed / 2 harness infra failure.
// This is the only committed gate that executes app.isPackaged=true paths.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { _electron } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const exe = path.join(desktopDir, 'desktop-release', 'win-unpacked', 'TrainingApp.exe');

const final = (code, line) => {
  console.log(line);
  process.exit(code);
};

if (!fs.existsSync(exe)) {
  final(2, `SMOKE: INFRA - packaged exe missing: ${exe} (run the fixture desktop:build first)`);
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'trainingapp-smoke-'));
const storePath = path.join(ws, 'store', 'store.sqlite');
const packsDir = path.join(ws, 'packs');

const step = (n, name, ok, detail = '') => {
  console.log(`step ${n}: ${ok ? 'OK' : 'FAIL'} - ${name}${detail.length > 0 ? ` (${detail})` : ''}`);
  return ok;
};

async function boot() {
  const app = await _electron.launch({
    executablePath: exe,
    env: {
      ...process.env,
      TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
      TRAININGAPP_DESKTOP_STORE_PATH: storePath,
      TRAININGAPP_DESKTOP_PACKS_DIR: packsDir,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

async function closeApp(app) {
  try {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  } catch {
    /* already closing */
  }
  try {
    if (app.process().exitCode === null) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    /* already gone */
  }
}

const failures = [];
const check = (n, name, ok, detail) => {
  if (!step(n, name, ok, detail)) failures.push(name);
};

let app;
let win;
try {
  console.log(`SMOKE: booting packaged exe (hash embedder, isolated store ${storePath})`);
  ({ app, win } = await boot());
} catch (err) {
  final(2, `SMOKE: INFRA - packaged launch failed: ${err instanceof Error ? err.message : String(err)}`);
}

try {
  // 1. wait for the integrity manifest verify pass to settle.
  let status = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    status = await win.evaluate(() => window.desktopApi?.getFirstRunStatus?.());
    if (status === null || status === undefined) throw new Error('getFirstRunStatus unavailable in the packaged renderer');
    if ((status.manifest?.verifiedCount ?? 0) > 0 || (status.manifest?.failures?.length ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const requiredIds = (status.packs?.required ?? []).map((entry) => entry.id);
  check(
    1,
    'manifest staged with zero failures',
    status.manifest?.staged === true && (status.manifest?.failures?.length ?? 0) === 0,
    `staged=${String(status.manifest?.staged)} verified=${String(status.manifest?.verifiedCount)} required=[${requiredIds.join(',')}]`,
  );
  check(2, 'packs toolsAvailable === true', status.packs?.toolsAvailable === true, `toolsAvailable=${String(status.packs?.toolsAvailable)} reason=${status.packs?.unavailableReason ?? 'n/a'}`);

  // 3. activate every manifest-required pack from the packaged resources.
  const activation = await win.evaluate(() => window.desktopApi?.activateFirstRunPacks?.());
  const installedNow = activation?.results ?? [];
  const activationOk =
    activation?.ok === true &&
    installedNow.length === requiredIds.length &&
    installedNow.every((result) => result.ok);
  check(3, 'all required packs installed and active', activationOk, JSON.stringify(installedNow));

  // 4. complete the wizard (profile fast + license acknowledgment).
  const completion = await win.evaluate(() =>
    window.desktopApi?.completeFirstRun?.({ selectedProfile: 'fast', acknowledgedLicenses: true }),
  );
  check(4, 'wizard completes', completion?.ok === true, completion?.detail ?? '');

  // 5. /packs must answer 200 through the loopback token gate.
  const packsProbe = await win.evaluate(async () => {
    try {
      const info = await window.desktopApi.getBackendInfo();
      const token = await window.desktopApi.getAuthToken();
      const res = await fetch(`${info.url}/packs`, { headers: { 'X-Desktop-Token': token } });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      return { status: 0, body: String(err) };
    }
  });
  check(5, '/packs answers 200', packsProbe.status === 200, `${String(packsProbe.status)} ${packsProbe.body.slice(0, 120)}`);

  await closeApp(app);

  // 6. relaunch fresh on the SAME store: the wizard must stay completed.
  let relaunch;
  try {
    ({ app: relaunch } = await boot());
    const win2 = await relaunch.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    await win2.waitForTimeout(8_000);
    const next = await win2.evaluate(() => window.desktopApi?.getFirstRunStatus?.());
    check(6, 'completion persists across relaunch (needed === false)', next?.needed === false, `needed=${String(next?.needed)}`);
    await closeApp(relaunch);
  } catch (err) {
    await closeApp(relaunch ?? app).catch(() => {});
    final(2, `SMOKE: INFRA - relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} catch (err) {
  await closeApp(app).catch(() => {});
  final(2, `SMOKE: INFRA - ${err instanceof Error ? err.message : String(err)}`);
}

if (failures.length > 0) {
  final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${failures.join('; ')}`);
}
final(0, 'SMOKE: PASS - packaged first-run ladder complete (manifest clean, tools available, packs active, wizard completed+persisted, /packs 200)');
