#!/usr/bin/env node
// packaged-smoke.mjs — packaged-boot CI smoke (issue #133 AC7, cf. #131 item 2;
// CDP driver closes the #135 Playwright-launch handshake flake).
//
// Boots the PACKAGED app (desktop-release/win-unpacked/TrainingApp.exe —
// produced moments earlier by the fixture build in the same job, or passed
// explicitly via TRAININGAPP_SMOKE_EXE) and asserts the first-run ladder
// end to end:
//   1. manifest staged with zero verify failures (the packaged integrity gate)
//   2. packs.toolsAvailable === true          (store init + embedder + PackManager)
//   3. activateFirstRunPacks → ok && every manifest-required pack active
//   4. completeFirstRun({selectedProfile:'fast', acknowledgedLicenses:true}) → ok
//   5. GET /packs → 200 (not the 503 'not wired on this host')
//   6. relaunch fresh (same store) → getFirstRunStatus().needed === false
//
// Two drivers over the SAME ladder evaluate bodies:
//   - playwright (DEFAULT, local): windowed _electron.launch + firstWindow.
//   - cdp (CI: `--driver cdp`): spawn the exe with --remote-debugging-port,
//     connect chromium.connectOverCDP, drive the identical steps via
//     page.evaluate. This bypasses the Playwright electron launch handshake
//     that never completes on GitHub windows runners (#135: both websockets
//     connect, then electron.launch times out — app healthy, harness broken).
//
// Flags/env (contracts pinned by the frozen C2/C3 checks):
//   --driver <playwright|cdp>   transport selection (default playwright)
//   --driver-selftest           parse the captured DevTools stderr sample
//                               through the REAL selection/parsing paths and
//                               exit — runs BEFORE the exe guard, spawns nothing
//   TRAININGAPP_SMOKE_EXE       explicit packaged-exe path; when set, the
//                               stale-build guard is skipped (operator assertion)
//
// Exit 0 all-pass / 1 any assertion failed / 2 harness infra failure.
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
// Namespace import: the worktree check harness stubs only _electron, and the
// base-leg runs must keep resolving. chromium is only ACCESSED on the cdp path,
// which runs where the real package is installed.
import * as playwright from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..');

// ---- driver selection + DevTools endpoint parsing (shared code paths) ------
// Captured from CI run 38405484055's failing step — the DevTools browser
// endpoint Playwright itself connected to before its handshake hung.
const DEVTOOLS_STDERR_SAMPLE =
  'DevTools listening on ws://127.0.0.1:56438/devtools/browser/e177c158-0222-4e2d-b629-812b9bc06ddd';

function parseDriver(args) {
  const idx = args.indexOf('--driver');
  // A bare `--driver` (missing value) must NOT silently fall back to the
  // windowed driver — that is the transport #135 proved hangs on runners;
  // return a value that fails the whitelist below and exits 2 (PRR-019).
  if (idx !== -1) return idx + 1 < args.length ? args[idx + 1] : '';
  const eq = args.find((a) => a.startsWith('--driver='));
  if (eq !== undefined) return eq.slice('--driver='.length);
  return 'playwright';
}

/** The one parser the CDP boot and the selftest both run. */
function parseDevToolsEndpoint(stderrText) {
  const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrText);
  return match === null ? null : match[1];
}

const argv = process.argv.slice(2);
const driver = parseDriver(argv);
if (driver !== 'playwright' && driver !== 'cdp') {
  console.log(`SMOKE: INFRA - unknown driver '${driver}' (expected playwright or cdp)`);
  process.exit(2);
}

// ---- selftest: BEFORE the exe guard, spawns nothing ------------------------
if (argv.includes('--driver-selftest')) {
  const endpoint = parseDevToolsEndpoint(DEVTOOLS_STDERR_SAMPLE);
  const ok = endpoint !== null && endpoint.startsWith('ws://127.0.0.1:56438/devtools/browser/');
  console.log(`SMOKE: SELFTEST driver=${driver} endpoint=${endpoint ?? 'none'}`);
  process.exit(ok ? 0 : 1);
}

// ---- packaged exe resolution ----------------------------------------------
const exeEnv = process.env.TRAININGAPP_SMOKE_EXE;
const explicitExe = exeEnv !== undefined && exeEnv.length > 0;
const exe = explicitExe ? path.resolve(exeEnv) : path.join(desktopDir, 'desktop-release', 'win-unpacked', 'TrainingApp.exe');

const final = (code, line) => {
  console.log(line);
  removeWs();
  process.exit(code);
};

if (!fs.existsSync(exe)) {
  final(2, `SMOKE: INFRA - packaged exe missing: ${exe} (run the fixture desktop:build first)`);
}

// Stale-build guard (plan F6): never silently probe an exe built before the
// current sources — a stale exe would fake a green (or red) verdict. In CI
// the exe is built minutes earlier in this same job, so this only bites
// local reuse of an old win-unpacked. SKIPPED when TRAININGAPP_SMOKE_EXE is
// set explicitly: the operator asserts the path (and the check harness may
// point a worktree-executed script at an exe built in another checkout).
if (!explicitExe) {
  const newestSource = (dirs) => {
    let newest = null;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (newest === null || fs.statSync(full).mtimeMs > fs.statSync(newest).mtimeMs) {
          newest = full;
        }
      }
    };
    for (const dir of dirs) walk(dir);
    return newest;
  };
  let exeMtime = null;
  let newer = undefined;
  let builderNewer = false;
  try {
    exeMtime = fs.statSync(exe).mtimeMs;
    // Every source root whose contents ship inside the exe or the staged
    // resources the ladder asserts over (PRR-017): main, scripts, the
    // renderer sources, preload (compiled into dist/preload), and the
    // knowledge-pack sources staged into installer-resources/packs.
    newer = [
      path.join(repoRoot, 'desktop', 'main'),
      path.join(repoRoot, 'desktop', 'preload'),
      path.join(repoRoot, 'desktop', 'scripts'),
      path.join(repoRoot, 'desktop', 'knowledge-pack-src'),
      path.join(repoRoot, 'web_ui', 'src'),
    ].filter(fs.existsSync)
      .map((dir) => newestSource([dir]))
      .find((file) => file !== null && fs.statSync(file).mtimeMs > exeMtime);
    const builderYml = path.join(desktopDir, 'electron-builder.yml');
    builderNewer = fs.existsSync(builderYml) && fs.statSync(builderYml).mtimeMs > exeMtime;
  } catch (err) {
    // A file disappearing mid-walk (concurrent build, editor atomic save) is
    // a harness precondition failure, not an assertion failure (PRR-018).
    final(2, `SMOKE: INFRA - stale-build guard could not read the source trees: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (newer !== undefined || builderNewer) {
    final(2, `SMOKE: STALE BUILD - ${exe} predates the current sources${newer !== undefined ? ` (newest: ${newer})` : ' (electron-builder.yml)'}; rebuild before probing`);
  }
} else {
  console.log('SMOKE: stale-build guard skipped (TRAININGAPP_SMOKE_EXE set — operator assertion)');
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'trainingapp-smoke-'));
const storePath = path.join(ws, 'store', 'store.sqlite');
const packsDir = path.join(ws, 'packs');
// Isolated Electron profile: without this the packaged exe boots against the
// machine's REAL %APPDATA%/TrainingApp userData (single-instance lock with a
// locally-running app, legacy store migration, real model hashes) (PRR-013).
const userDataDir = path.join(ws, 'user-data');

/** Best-effort temp cleanup on every exit path (PRR-023). */
function removeWs() {
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
}

const step = (n, name, ok, detail = '') => {
  console.log(`step ${n}: ${ok ? 'OK' : 'FAIL'} - ${name}${detail.length > 0 ? ` (${detail})` : ''}`);
  return ok;
};

/** Launch output capture, dumped when a launch or ladder step fails (a
 *  packaged GUI app that dies before its window is otherwise silent).
 *  Capped ring-style buffer: only the tail is ever printed, so retention
 *  beyond the cap serves nothing (PRR-020). */
let consoleBuf = '';
const CONSOLE_BUF_MAX = 200_000;
const appendOut = (d) => {
  consoleBuf += d.toString();
  if (consoleBuf.length > CONSOLE_BUF_MAX) consoleBuf = consoleBuf.slice(-Math.floor(CONSOLE_BUF_MAX / 2));
};
const dumpConsole = (prefix) => {
  const lines = consoleBuf.split(/\r?\n/)
    // Redact the DevTools attach URL's instance id before it reaches a
    // retained CI log (PRR-039); the endpoint is dead with the job's VM,
    // but the log surface stays minimal.
    .map((l) => l.replace(/devtools\/browser\/[0-9a-f-]+/gi, 'devtools/browser/<redacted>'))
    .filter((l) => l.length > 0);
  console.log(`${prefix} — app process output (last 30 lines):`);
  for (const line of lines.slice(-30)) console.log(`  ${line}`);
  if (lines.length === 0) console.log('  (no output captured — the app died before any stream write)');
};

/** Bound an await so a wedged renderer/transport resolves into a loud INFRA
 *  verdict instead of eating the whole CI job wall (PRR-025). */
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const appEnv = () => ({
  ...process.env,
  // Route the main process's console (degradation lines etc.) to stderr —
  // a packaged GUI app otherwise has NO stdout and CI-only stalls are
  // invisible. Proven safe for firstWindow locally.
  ELECTRON_ENABLE_LOGGING: '1',
  TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
  TRAININGAPP_DESKTOP_STORE_PATH: storePath,
  TRAININGAPP_DESKTOP_PACKS_DIR: packsDir,
});

// ---- drivers ---------------------------------------------------------------
// Both return a session with the SAME evaluate surface; the ladder below is
// transport-agnostic.

// The live CDP child (if any) for signal hygiene: a harness Ctrl-C/CI cancel
// must not orphan a packaged exe still holding an unauthenticated debug port
// (PRR-027).
let activeChild = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      if (activeChild !== null && activeChild.exitCode === null && activeChild.signalCode === null) {
        spawnSync('taskkill', ['/PID', String(activeChild.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    } catch { /* best effort */ }
    removeWs();
    process.exit(2);
  });
}

async function bootPlaywright() {
  const app = await playwright._electron.launch({
    executablePath: exe,
    // --disable-gpu: GitHub windows runners have no usable GPU; Chromium
    // compositing can stall ready-to-show without it (harmless locally).
    // Longer timeout: the first window on a cold runner is slow.
    // --user-data-dir: isolate the profile so local runs never touch the
    // operator's real %APPDATA%/TrainingApp userData (PRR-013).
    args: ['--disable-gpu', `--user-data-dir=${userDataDir}`],
    timeout: 300_000,
    env: appEnv(),
  });
  app.process().stdout?.on('data', appendOut);
  app.process().stderr?.on('data', appendOut);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return {
    evaluate: (fn) => withTimeout(win.evaluate(fn), 120_000, 'ladder evaluate'),
    close: async () => { await closeApp(app); },
  };
}

async function bootCdp() {
  const port = randomInt(9300, 9900);
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--disable-gpu', `--user-data-dir=${userDataDir}`], {
    env: appEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChild = child;
  child.on('exit', () => { if (activeChild === child) activeChild = null; });
  // A failed spawn (EACCES, locked exe, AV quarantine) emits 'error'; without
  // a listener Node exits 1 with a raw stack — the assertion-failure code —
  // violating the documented 1-vs-2 contract (PRR-010).
  child.on('error', (err) => {
    console.log(`SMOKE: INFRA - packaged exe failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
    removeWs();
    process.exit(2);
  });
  child.stdout.on('data', appendOut);
  child.stderr.on('data', appendOut);
  let stderrBuf = '';
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 100_000) stderrBuf = stderrBuf.slice(-50_000);
  });

  // signal-aware liveness: a signal-terminated child keeps exitCode null
  // (PRR-022); the sibling e2e helper pins the same predicate.
  const alive = () => child.exitCode === null && child.signalCode === null;
  const deadExit = () => (child.exitCode !== null ? child.exitCode : `signal ${String(child.signalCode)}`);

  const killTree = () => {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  };

  let closeAttempted = false;

  try {
    // Wait for BOTH the CDP HTTP endpoint and a PAGE target before
    // connecting a client. Attaching connectOverCDP while the app is still
    // booting breaks Electron 44's sandboxed-renderer startup handshake
    // ("Cannot destructure property 'preloadScripts' of 'binding.startupData'
    // as it is null" — observed and bisected locally on the fixture build;
    // the same spawn with /json/list polling and a LATE connect boots the
    // renderer cleanly). The windowed driver never attaches mid-boot, which
    // is why it was unaffected.
    const deadline = Date.now() + 120_000;
    let serverUp = false;
    let pageReady = false;
    while (Date.now() < deadline) {
      if (!alive()) {
        throw new Error(`packaged exe exited early with code ${deadExit()} (port ${port})`);
      }
      try {
        if (!serverUp) {
          // Bounded fetches: the loop deadline cannot interrupt an in-flight
          // request, so each fetch carries its own signal (PRR-009).
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
          if (res.ok) { serverUp = true; }
        }
        if (serverUp) {
          const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
          if (list.ok) {
            const targets = await list.json();
            if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) { pageReady = true; break; }
          }
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!pageReady) {
      // Exercise the shared parser on the real stderr before giving up.
      throw new Error(
        `no CDP page target within 120s (server=${String(serverUp)}, devtools line: ${String(parseDevToolsEndpoint(stderrBuf)).replace(/devtools\/browser\/[0-9a-f-]+/i, 'devtools/browser/<redacted>')})`,
      );
    }
    // Same parser as the selftest, against live process output.
    const endpoint = parseDevToolsEndpoint(stderrBuf);
    if (endpoint === null) {
      throw new Error('DevTools stderr line never appeared (endpoint parser found nothing)');
    }

    // CDP attach retry: a loaded CI runner wedged the relaunch attach once
    // (PR #172 round 1: steps 1-5 green on the runner, connectOverCDP timed
    // out at 60s on the SECOND boot). Attaching is idempotent to retry
    // while the browser endpoint still answers.
    let browser = null;
    let attachError = null;
    for (let attempt = 1; attempt <= 3 && browser === null; attempt++) {
      try {
        browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 60_000 });
      } catch (err) {
        attachError = err;
        if (!alive()) {
          throw new Error(`packaged exe exited early with code ${deadExit()} during CDP attach (attempt ${attempt})`);
        }
        if (attempt < 3) {
          console.log(`SMOKE: CDP attach attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying`);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    if (browser === null) {
      throw new Error(`CDP attach failed after 3 attempts: ${attachError instanceof Error ? attachError.message : String(attachError)}`);
    }
    const ctx = browser.contexts()[0];
    if (ctx === undefined) {
      throw new Error('CDP attach returned no browser context');
    }
    let page = null;
    const pageDeadline = Date.now() + 120_000;
    while (Date.now() < pageDeadline) {
      if (!alive()) {
        throw new Error(`packaged exe exited early with code ${deadExit()} while waiting for the renderer`);
      }
      for (const p of ctx.pages()) {
        const has = await p.evaluate(() => typeof window.desktopApi !== 'undefined').catch(() => false);
        if (has) { page = p; break; }
      }
      if (page !== null) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (page === null) {
      throw new Error(`no page exposing window.desktopApi within 120s (pages=${ctx.pages().length})`);
    }
    await page.waitForLoadState('domcontentloaded');
    return {
      evaluate: (fn) => withTimeout(page.evaluate(fn), 120_000, 'ladder evaluate'),
      close: async () => {
        // Idempotent: the relaunch catch re-invokes close() after a throw —
        // never pay the escalation ladder twice (PRR-016).
        if (closeAttempted) return;
        closeAttempted = true;
        // Graceful first (close the window; Electron quits on last window),
        // then the same forceful tree kill the windowed path uses. Wait for
        // FULL main-process exit before returning: the relaunch needs the
        // single-instance lock released, and a half-dead first instance
        // wedged the second instance's CDP attach on the CI runner.
        try {
          await page.evaluate(() => window.close()).catch(() => {});
          await new Promise((r) => setTimeout(r, 2_000));
        } catch { /* window already gone */ }
        if (alive()) killTree();
        try { await browser.close(); } catch { /* disconnect only */ }
        await new Promise((r) => setTimeout(r, 1_500));
        if (alive()) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        }
        const exitDeadline = Date.now() + 20_000;
        while (alive() && Date.now() < exitDeadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (alive()) {
          killTree();
          await new Promise((r) => setTimeout(r, 5_000));
          if (alive()) {
            throw new Error(`packaged exe pid ${child.pid} survived close (exitCode still null after tree kill)`);
          }
        }
      },
    };
  } catch (err) {
    killTree();
    throw err;
  }
}

async function boot() {
  console.log(`SMOKE: booting packaged exe (driver=${driver}, hash embedder, isolated store ${storePath})`);
  return driver === 'cdp' ? bootCdp() : bootPlaywright();
}

async function closeApp(app) {
  // Captured BEFORE close(): Playwright disposes the handle during close,
  // after which app.process() throws and the kill fallback below would be
  // skipped for a lingering tree (the exact defect e2e/launch-helpers.ts
  // documents; PRR-024).
  const proc = app.process();
  try {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  } catch {
    /* already closing */
  }
  try {
    if (proc.exitCode === null && proc.signalCode === null) {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
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

let session;
try {
  session = await boot();
} catch (err) {
  dumpConsole('SMOKE: launch failed');
  final(2, `SMOKE: INFRA - packaged launch failed: ${err instanceof Error ? err.message : String(err)}`);
}

const evaluate = (fn) => session.evaluate(fn);

try {
  // 1. wait for the integrity manifest verify pass to settle.
  let status = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    status = await evaluate(() => window.desktopApi?.getFirstRunStatus?.());
    if (status === null || status === undefined) throw new Error('getFirstRunStatus unavailable in the packaged renderer');
    if ((status.manifest?.verifiedCount ?? 0) > 0 || (status.manifest?.failures?.length ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const requiredIds = (status.packs?.required ?? []).map((entry) => entry.id);
  // A deadline exit with no observable status/manifest is a harness/infra
  // condition, not an assertion failure — the sibling bounded waits throw
  // INFRA for the same reason (PRR-021).
  if (status === null || status === undefined || status.manifest === undefined) {
    throw new Error('first-run status (or its manifest section) never became observable within 120s');
  }
  check(
    1,
    'manifest staged with zero failures',
    status.manifest?.staged === true && (status.manifest?.failures?.length ?? 0) === 0,
    `staged=${String(status.manifest?.staged)} verified=${String(status.manifest?.verifiedCount)} required=[${requiredIds.join(',')}]`,
  );
  check(2, 'packs toolsAvailable === true', status.packs?.toolsAvailable === true, `toolsAvailable=${String(status.packs?.toolsAvailable)} reason=${status.packs?.unavailableReason ?? 'n/a'}`);

  // 3. activate every manifest-required pack from the packaged resources.
  const activation = await evaluate(() => window.desktopApi?.activateFirstRunPacks?.());
  const installedNow = activation?.results ?? [];
  const activationOk =
    activation?.ok === true &&
    installedNow.length === requiredIds.length &&
    installedNow.every((result) => result.ok);
  check(3, 'all required packs installed and active', activationOk, JSON.stringify(installedNow));

  // 4. complete the wizard (profile fast + license acknowledgment).
  const completion = await evaluate(() =>
    window.desktopApi?.completeFirstRun?.({ selectedProfile: 'fast', acknowledgedLicenses: true }),
  );
  check(4, 'wizard completes', completion?.ok === true, completion?.detail ?? '');

  // 5. /packs must answer 200 through the loopback token gate.
  const packsProbe = await evaluate(async () => {
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

  await session.close();

  // 6. relaunch fresh on the SAME store: the wizard must stay completed.
  //    Poll like step 1 — a fixed sleep misreports slow store restores as
  //    persistence regressions on loaded runners (PRR-014).
  let relaunch;
  try {
    relaunch = await boot();
    let next = null;
    const relaunchDeadline = Date.now() + 90_000;
    while (Date.now() < relaunchDeadline) {
      next = await relaunch.evaluate(() => window.desktopApi?.getFirstRunStatus?.());
      if (next?.needed === false) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    check(6, 'completion persists across relaunch (needed === false)', next?.needed === false, `needed=${String(next?.needed)}`);
    await relaunch.close();
  } catch (err) {
    await relaunch?.close().catch(() => {});
    // Round-1 gap: the relaunch catch dumped nothing, so the runner log for
    // the wedged second attach had zero app-side context.
    dumpConsole('SMOKE: relaunch failed');
    // Recorded assertion failures outrank a later close/relaunch infra
    // error: a genuine step FAIL must not be re-labeled INFRA (PRR-015).
    if (failures.length > 0) {
      final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${failures.join('; ')} (relaunch/close also errored: ${err instanceof Error ? err.message : String(err)})`);
    }
    final(2, `SMOKE: INFRA - relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} catch (err) {
  await session.close().catch(() => {});
  dumpConsole('SMOKE: ladder failed');
  if (failures.length > 0) {
    final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${failures.join('; ')} (ladder also errored: ${err instanceof Error ? err.message : String(err)})`);
  }
  final(2, `SMOKE: INFRA - ${err instanceof Error ? err.message : String(err)}`);
}

if (failures.length > 0) {
  final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${failures.join('; ')}`);
}
final(0, 'SMOKE: PASS - packaged first-run ladder complete (manifest clean, tools available, packs active, wizard completed+persisted, /packs 200)');
