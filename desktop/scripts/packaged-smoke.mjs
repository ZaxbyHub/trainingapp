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
// Two drivers over the SAME ladder run bodies:
//   - playwright (DEFAULT, local): windowed _electron.launch + firstWindow.
//   - cdp (CI: `--driver cdp`): spawn the exe with an OS-assigned debug port
//     (--remote-debugging-port=0), discover the port from the process's own
//     DevTools line, connect chromium.connectOverCDP to that parsed endpoint,
//     and drive the identical steps through one bounded evaluate helper. This
//     bypasses the Playwright electron launch handshake that never completes
//     on GitHub windows runners (#135: both websockets connect, then
//     electron.launch times out — app healthy, harness broken).
//
// First-boot attach wedge (issue #177 investigation note): CI run 38474570960
// showed attach attempt 1 timing out at 60s on the FIRST boot after "ws
// connected", with the relaunch attaching first try — a first-boot stall the
// single-instance story does not cover. Cause remains INFERENCE: first-boot
// contention (freshly built exe under antivirus/cold cache) is the leading
// candidate, renderer preparation (#135 class) the alternative. The driver
// bounds the class instead of claiming a cause: the attach binds to this
// child's own parsed DevTools endpoint, every timed-out attempt is counted
// and printed on every exit path (SMOKE: attach attempts timed out: N), the
// run watchdog bounds any wedge below the job wall, and per-boot captures
// with both-boots dumps preserve the evidence.
//
// Flags/env (contracts pinned by the frozen C2/C3 checks of trace
// 131-e1-followups and by the packaged-smoke-cdp batch checks):
//   --driver <playwright|cdp>   transport selection (default playwright)
//   --driver-selftest           parse the captured DevTools stderr sample
//                               through the REAL selection/parsing paths,
//                               assert the driver-value parses for both
//                               drivers, and exit — runs BEFORE the exe
//                               guard, spawns nothing
//   TRAININGAPP_SMOKE_EXE       explicit packaged-exe path; when set, the
//                               stale-build guard is skipped (operator
//                               assertion) and the resolved path is logged
//   TRAININGAPP_SMOKE_WATCHDOG_MS  watchdog budget override (probes/tests)
//
// Exit 0 all-pass / 1 any assertion failed / 2 harness infra failure. Every
// boot-run exit path prints `SMOKE: attach attempts timed out: N` before its
// verdict line so attach-timeout counts survive wedged runs.
//
// Import-safe module: nothing runs at import; `main` owns every side effect
// behind an entry guard. The exported seams (log, exit, taskkill runner,
// clock, sleep) are function parameters so
// desktop/src/__tests__/packaged-smoke-contract.test.ts can drive real
// behavior with injected dependencies.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
// Namespace import: the worktree check harness stubs only _electron, and the
// base-leg runs must keep resolving. chromium is only ACCESSED on the cdp path,
// which runs where the real package is installed.
import * as playwright from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..');

// ---- frozen contract values -------------------------------------------------
// Captured from CI run 38405484055's failing step — the DevTools browser
// endpoint Playwright itself connected to before its handshake hung.
const DEVTOOLS_STDERR_SAMPLE =
  'DevTools listening on ws://127.0.0.1:56438/devtools/browser/e177c158-0222-4e2d-b629-812b9bc06ddd';

/** Run-level watchdog budget. Derived from the stacked phase budgets (two
 *  boots of 120s page-target + 3x60s attach + 120s renderer wait + ~45s
 *  close; 120s ladder status poll + four 120s ladder evaluate bounds; 90s
 *  relaunch poll ≈ 25.5 min worst case) and kept below the workflow's
 *  35-minute job wall (issues #177 AC3, plan contract 2). */
export const WATCHDOG_DEFAULT_MS = 30 * 60_000;
/** Graceful-close wait for full main-process exit before forced kill (AC10). */
export const GRACEFUL_EXIT_MS = 20_000;
/** Console capture ring size in lines (AC14). */
export const BUFFER_MAX_LINES = 2000;
const EVAL_BOUND_PROBE_MS = 10_000;
const EVAL_BOUND_CLOSE_MS = 5_000;
const EVAL_BOUND_LADDER_MS = 120_000;
const BROWSER_CLOSE_MS = 10_000;

// ---- driver selection + DevTools endpoint parsing (shared code paths) ------

export function parseDriver(args) {
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
export function parseDevToolsEndpoint(stderrText) {
  const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrText);
  return match === null ? null : match[1];
}

/** AC12: the attach target must be the parsed endpoint's own port. */
export function verifyEndpointPort(endpoint, port) {
  const parsed = Number(new URL(endpoint).port);
  if (parsed !== port) {
    throw new Error(`DevTools endpoint port ${parsed} does not match the polled port ${port}; refusing the attach`);
  }
  return parsed;
}

// ---- bounded awaits (AC2) ---------------------------------------------------

/** Bound an await so a wedged renderer/transport resolves into a loud INFRA
 *  verdict instead of eating the whole CI job wall (PRR-025). */
export const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** The ONLY site that touches a playwright evaluate handle (AC2): the bound
 *  carries its own timeout on this line. */
export const boundEvaluate = (inner, fn, label, ms) => withTimeout(inner.evaluate(fn), ms, label);

// ---- run state + summary (AC4) ---------------------------------------------

export function createRunState() {
  return { attachTimeouts: 0, failures: [], closeAttempted: false, activeChild: null };
}

export function recordAttachTimeout(state) {
  state.attachTimeouts += 1;
}

/** Printed on every boot-run exit path (final, watchdog, signals). */
export function emitAttachSummary(log, state) {
  log(`SMOKE: attach attempts timed out: ${state.attachTimeouts}`);
}

/** Failures out-rank INFRA: a recorded assertion failure keeps exit 1 even
 *  when a later infra error or the watchdog fires (AC9, plan R6/R16). */
export const verdictCode = (failures) => (failures.length > 0 ? 1 : 2);

// ---- console capture (AC13/AC14) -------------------------------------------

export function createConsoleCapture(maxLines = BUFFER_MAX_LINES) {
  const lines = [];
  let pending = '';
  return {
    append(d) {
      pending += d.toString();
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const line of parts) {
        if (line.length === 0) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
      }
    },
    dump(log, prefix) {
      const all = pending.length > 0 ? [...lines, pending] : [...lines];
      const out = all
        // Redact the DevTools attach URL's instance id before it reaches a
        // retained CI log (PRR-039); the endpoint is dead with the job's VM,
        // but the log surface stays minimal.
        .map((l) => l.replace(/devtools\/browser\/[0-9a-f-]+/gi, 'devtools/browser/<redacted>'))
        .filter((l) => l.length > 0);
      log(`${prefix} — app process output (last 30 lines):`);
      for (const line of out.slice(-30)) log(`  ${line}`);
      if (out.length === 0) log('  (no output captured — the app died before any stream write)');
    },
    get size() { return lines.length; },
  };
}

/** Dump every boot's capture with its own label (AC13; R7 — the relaunch
 *  failure and the watchdog fire need BOTH boots' tails). */
export function dumpAllCaptures(log, captures, prefix) {
  for (const [boot, capture] of captures) capture.dump(log, `${prefix} [${boot}]`);
}

// ---- process-tree lifecycle (AC6/AC7) --------------------------------------

/** The one real taskkill invocation site (AC6/AC7): every tree kill routes
 *  through taskkillTree with this runner so the status is always checked. */
export function makeTaskkillRunner() {
  return (args) => spawnSync('taskkill', args, { stdio: 'ignore', timeout: 15_000 });
}

/** taskkill with a checked, logged status — never silent. */
export function taskkillTree(pid, { runTaskkill, log }) {
  let res;
  try {
    res = runTaskkill(['/PID', String(pid), '/T', '/F']);
  } catch (err) {
    log(`SMOKE: taskkill failed (${err instanceof Error ? err.message : String(err)})`);
    return { status: null, error: err };
  }
  if (res.error) {
    log(`SMOKE: taskkill failed (${res.error instanceof Error ? res.error.message : String(res.error)})`);
  } else if (res.status !== 0) {
    log(`SMOKE: taskkill failed (status=${String(res.status)})`);
  }
  return res;
}

/** Kill a child's process tree ONLY while it has not exited (AC6): the
 *  liveness predicate lives in the wrapper so every call site is safe. */
export function killTree(child, deps) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  taskkillTree(child.pid, deps);
  return true;
}

/** Signal reaping (AC8): registered on SIGINT/SIGTERM so a harness Ctrl-C or
 *  a CI cancel never orphans the packaged exe. Returns the registered
 *  handlers so probes can invoke the real listener entries. */
export function registerSignalHandlers(io, state, deps) {
  const reap = () => {
    if (state.activeChild !== null) killTree(state.activeChild, deps);
    emitAttachSummary(io.log, state);
    io.removeWs();
    // Failures out-rank INFRA on the signal path too (plan contract 8).
    io.exit(verdictCode(state.failures));
  };
  process.on('SIGINT', reap);
  process.on('SIGTERM', reap);
  return {
    handlers: { SIGINT: reap, SIGTERM: reap },
    dispose() {
      process.removeListener('SIGINT', reap);
      process.removeListener('SIGTERM', reap);
    },
  };
}

// ---- watchdog (AC3) --------------------------------------------------------

/** Arm the run-level watchdog. `suspend()` covers the close window and
 *  `resume()` restores the ORIGINAL deadline (never a fresh budget) — the
 *  disarm window itself carries only bounded awaits (plan R13/R21). */
export function armWatchdog(ms, hooks) {
  const now = hooks.now ?? (() => Date.now());
  const deadline = now() + ms;
  let timer = null;
  const arm = (remaining) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; hooks.fire(); }, Math.max(0, remaining));
  };
  arm(ms);
  return {
    suspend() { if (timer !== null) { clearTimeout(timer); timer = null; } },
    resume() { arm(deadline - now()); },
    disarm() { if (timer !== null) { clearTimeout(timer); timer = null; } },
  };
}

/** The watchdog exit path: dump every capture with its label, kill the tree,
 *  emit the attach summary, then the verdict (failures out-rank INFRA). */
export function watchdogExit({ captures, child, kill, log, exit, state, ms }) {
  log(`SMOKE: watchdog fired after ${ms}ms`);
  dumpAllCaptures(log, captures, 'SMOKE: watchdog fired');
  if (child) kill(child);
  emitAttachSummary(log, state);
  log(`SMOKE: INFRA - watchdog budget exceeded (${ms}ms)`);
  exit(verdictCode(state.failures));
}

// ---- session close (AC9/AC10) ----------------------------------------------

/** Idempotent close with a bounded graceful window: close the window, wait up
 *  to `gracefulMs` for full main-process exit, only then escalate. Every await
 *  here carries an explicit bound (plan R13). */
export async function closeCdpSession(opts) {
  const {
    state, child, alive, browser, page, kill, sleep, now, log, watchdog,
    gracefulMs = GRACEFUL_EXIT_MS, closeEvalMs = EVAL_BOUND_CLOSE_MS,
    browserCloseMs = BROWSER_CLOSE_MS, settleMs = 5_000,
  } = opts;
  if (state.closeAttempted) return;
  state.closeAttempted = true;
  if (watchdog) watchdog.suspend();
  try {
    await boundEvaluate(page, () => window.close(), 'window close', closeEvalMs).catch(() => {});
  } catch { /* window already gone */ }
  const gracefulDeadline = now() + gracefulMs;
  while (alive() && now() < gracefulDeadline) {
    await sleep(250);
  }
  if (alive()) kill(child);
  try {
    await withTimeout(browser.close(), browserCloseMs, 'browser close').catch(() => {});
  } catch { /* disconnect only */ }
  log(`SMOKE: child exit at close: ${alive() ? 'still alive' : `code=${String(child.exitCode)} signal=${String(child.signalCode)}`}`);
  if (alive()) {
    kill(child);
    await sleep(settleMs);
    if (alive()) {
      throw new Error(`packaged exe pid ${String(child.pid)} survived close (exitCode still null after tree kill)`);
    }
  }
  if (watchdog) watchdog.resume();
}

// ---- app environment -------------------------------------------------------

const appEnv = (storePath, packsDir) => ({
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
// Both return a session with the SAME run surface (run(fn) drives one bounded
// evaluate); the ladder below is transport-agnostic.

async function bootPlaywright(ctx) {
  const { exe, userDataDir, storePath, packsDir, capture, log } = ctx;
  const app = await playwright._electron.launch({
    executablePath: exe,
    // --disable-gpu: GitHub windows runners have no usable GPU; Chromium
    // compositing can stall ready-to-show without it (harmless locally).
    // Longer timeout: the first window on a cold runner is slow.
    // --user-data-dir: isolate the profile so local runs never touch the
    // operator's real %APPDATA%/TrainingApp userData (PRR-013).
    args: ['--disable-gpu', `--user-data-dir=${userDataDir}`],
    timeout: 300_000,
    env: appEnv(storePath, packsDir),
  });
  app.process().stdout?.on('data', (d) => capture.append(d));
  app.process().stderr?.on('data', (d) => capture.append(d));
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return {
    run: (fn) => boundEvaluate(win, fn, 'ladder evaluate', EVAL_BOUND_LADDER_MS),
    close: async () => { await closeElectronApp(app, log); },
  };
}

async function bootCdp(ctx) {
  const { exe, userDataDir, storePath, packsDir, capture, state, io, watchdog, log } = ctx;
  const killDeps = { runTaskkill: makeTaskkillRunner(), log };

  const failSpawn = (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`SMOKE: INFRA - packaged exe failed to spawn: ${msg}`);
    emitAttachSummary(log, state);
    io.removeWs();
    // The dedicated spawn verdict exits 2 with no recorded failures (AC5/C5);
    // if a boot's steps already failed, failures out-rank INFRA (verdictCode).
    io.exit(verdictCode(state.failures));
  };

  let child;
  try {
    // OS-assigned debug port (AC11): the port is discovered from the child's
    // own DevTools line, never guessed, so the attach is bound to this child's
    // endpoint.
    child = spawn(exe, ['--remote-debugging-port=0', '--disable-gpu', `--user-data-dir=${userDataDir}`], {
      env: appEnv(storePath, packsDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    failSpawn(err);
    return null;
  }
  state.activeChild = child;
  child.on('exit', () => { if (state.activeChild === child) state.activeChild = null; });
  // A failed spawn (EACCES, locked exe, AV quarantine) emits 'error'; without
  // a listener Node exits 1 with a raw stack — the assertion-failure code —
  // violating the documented 1-vs-2 contract (PRR-010). The synchronous
  // failure class routes to the same dedicated verdict above (AC5).
  child.on('error', (err) => failSpawn(err));
  child.stdout.on('data', (d) => capture.append(d));
  child.stderr.on('data', (d) => capture.append(d));
  let stderrBuf = '';
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 100_000) stderrBuf = stderrBuf.slice(-50_000);
  });

  // signal-aware liveness: a signal-terminated child keeps exitCode null
  // (PRR-022); the sibling e2e helper pins the same predicate.
  const alive = () => child.exitCode === null && child.signalCode === null;
  const deadExit = () => (child.exitCode !== null ? child.exitCode : `signal ${String(child.signalCode)}`);
  const kill = () => killTree(child, killDeps);

  try {
    // Wait for the child's OWN DevTools line (OS-assigned port, AC11), then
    // wait for BOTH the CDP HTTP endpoint and a PAGE target before connecting
    // a client. Attaching connectOverCDP while the app is still booting breaks
    // Electron 44's sandboxed-renderer startup handshake ("Cannot destructure
    // property 'preloadScripts' of 'binding.startupData' as it is null" —
    // observed and bisected locally on the fixture build; the same spawn with
    // /json/list polling and a LATE connect boots the renderer cleanly). The
    // windowed driver never attaches mid-boot, which is why it was unaffected.
    const devtoolsDeadline = Date.now() + 120_000;
    let endpoint = null;
    while (Date.now() < devtoolsDeadline) {
      if (!alive()) {
        throw new Error(`packaged exe exited early with code ${deadExit()} (no DevTools line)`);
      }
      endpoint = parseDevToolsEndpoint(stderrBuf);
      if (endpoint !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (endpoint === null) {
      throw new Error('DevTools stderr line never appeared within 120s (endpoint parser found nothing)');
    }
    const port = verifyEndpointPort(endpoint, Number(new URL(endpoint).port));

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

    // CDP attach retry: a loaded CI runner wedged the relaunch attach once
    // (PR #172 round 1: steps 1-5 green on the runner, connectOverCDP timed
    // out at 60s on the SECOND boot). Attaching is idempotent to retry while
    // the browser endpoint still answers. Every timed-out attempt is counted
    // (AC4) and the count is printed on every exit path.
    let browser = null;
    let attachError = null;
    for (let attempt = 1; attempt <= 3 && browser === null; attempt++) {
      try {
        browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: 60_000 });
      } catch (err) {
        attachError = err;
        recordAttachTimeout(state);
        if (!alive()) {
          throw new Error(`packaged exe exited early with code ${deadExit()} during CDP attach (attempt ${attempt})`);
        }
        if (attempt < 3) {
          log(`SMOKE: CDP attach attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying`);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    if (browser === null) {
      throw new Error(`CDP attach failed after 3 attempts: ${attachError instanceof Error ? attachError.message : String(attachError)}`);
    }
    const ctxs = browser.contexts()[0];
    if (ctxs === undefined) {
      throw new Error('CDP attach returned no browser context');
    }
    let page = null;
    const pageDeadline = Date.now() + 120_000;
    while (Date.now() < pageDeadline) {
      if (!alive()) {
        throw new Error(`packaged exe exited early with code ${deadExit()} while waiting for the renderer`);
      }
      for (const p of ctxs.pages()) {
        // Bounded probe: a wedged page evaluate must not hang the poll
        // (AC2); a failed probe means "not this page, keep polling".
        const has = await boundEvaluate(p, () => typeof window.desktopApi !== 'undefined', 'desktopApi probe', EVAL_BOUND_PROBE_MS).catch(() => false);
        if (has) { page = p; break; }
      }
      if (page !== null) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (page === null) {
      throw new Error(`no page exposing window.desktopApi within 120s (pages=${ctxs.pages().length})`);
    }
    await page.waitForLoadState('domcontentloaded');
    return {
      run: (fn) => boundEvaluate(page, fn, 'ladder evaluate', EVAL_BOUND_LADDER_MS),
      close: () => closeCdpSession({
        state, child, alive, browser, page, kill,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(), log, watchdog,
      }),
    };
  } catch (err) {
    kill();
    throw err;
  }
}

async function closeElectronApp(app, log) {
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
    killTree(proc, { runTaskkill: makeTaskkillRunner(), log });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } catch {
    /* already gone */
  }
  log(`SMOKE: child exit at close: ${proc.exitCode === null ? (proc.signalCode === null ? 'still alive' : `signal ${String(proc.signalCode)}`) : `code=${String(proc.exitCode)}`}`);
}

// ---- main (entry-guarded; every seam injectable) ---------------------------

export async function main(argv, env, io) {
  const log = io.log;
  const driver = parseDriver(argv);
  if (driver !== 'playwright' && driver !== 'cdp') {
    log(`SMOKE: INFRA - unknown driver '${driver}' (expected playwright or cdp)`);
    io.exit(2);
    return;
  }

  // ---- selftest: BEFORE the exe guard, spawns nothing (frozen C2) ----------
  if (argv.includes('--driver-selftest')) {
    const endpoint = parseDevToolsEndpoint(DEVTOOLS_STDERR_SAMPLE);
    const ok = endpoint !== null && endpoint.startsWith('ws://127.0.0.1:56438/devtools/browser/');
    log(`SMOKE: SELFTEST driver=${driver} endpoint=${endpoint ?? 'none'}`);
    // Derived parse assertions (AC16): the ok/FAIL values below come from the
    // REAL parseDriver results, and a mismatch exits 1 — the literal line
    // reads `playwright=ok cdp=ok` only when every parse really passes.
    const r1 = parseDriver(['--driver', 'playwright']) === 'playwright' && parseDriver([]) === 'playwright' ? 'ok' : 'FAIL';
    const r2 = parseDriver(['--driver', 'cdp']) === 'cdp' ? 'ok' : 'FAIL';
    log(`SMOKE: SELFTEST parse playwright=${r1} cdp=${r2}`);
    io.exit(ok && r1 === 'ok' && r2 === 'ok' ? 0 : 1);
    return;
  }

  // ---- packaged exe resolution --------------------------------------------
  const exeEnv = env.TRAININGAPP_SMOKE_EXE;
  const explicitExe = exeEnv !== undefined && exeEnv.length > 0;
  const exe = explicitExe ? path.resolve(exeEnv) : path.join(desktopDir, 'desktop-release', 'win-unpacked', 'TrainingApp.exe');

  const state = createRunState();
  const boot1 = createConsoleCapture();
  const boot2 = createConsoleCapture();
  const captures = new Map([['boot-1', boot1], ['boot-2', boot2]]);
  let currentCapture = boot1;
  let watchdog = null;

  const final = (code, line) => {
    if (watchdog) watchdog.disarm();
    emitAttachSummary(log, state);
    log(line);
    io.removeWs();
    io.exit(code);
  };

  if (!fs.existsSync(exe)) {
    final(2, `SMOKE: INFRA - packaged exe missing: ${exe} (run the fixture desktop:build first)`);
    return;
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
      return;
    }
    if (newer !== undefined || builderNewer) {
      final(2, `SMOKE: STALE BUILD - ${exe} predates the current sources${newer !== undefined ? ` (newest: ${newer})` : ' (electron-builder.yml)'}; rebuild before probing`);
      return;
    }
  } else {
    // AC17: name the resolved exe and the skipped guard in the boot log.
    log(`SMOKE: stale-build guard skipped (TRAININGAPP_SMOKE_EXE set — operator assertion, exe ${exe})`);
  }

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'trainingapp-smoke-'));
  const storePath = path.join(ws, 'store', 'store.sqlite');
  const packsDir = path.join(ws, 'packs');
  // Isolated Electron profile: without this the packaged exe boots against the
  // machine's REAL %APPDATA%/TrainingApp userData (single-instance lock with a
  // locally-running app, legacy store migration, real model hashes) (PRR-013).
  const userDataDir = path.join(ws, 'user-data');

  /** Best-effort temp cleanup on every exit path (PRR-023). */
  const removeWs = () => {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  const step = (n, name, ok, detail = '') => {
    log(`step ${n}: ${ok ? 'OK' : 'FAIL'} - ${name}${detail.length > 0 ? ` (${detail})` : ''}`);
    return ok;
  };
  const check = (n, name, ok, detail) => {
    if (!step(n, name, ok, detail)) state.failures.push(name);
  };

  // Run-level watchdog (AC3): armed once at run start, suspended only across
  // the bounded close window, disarmed by final().
  const watchdogMs = Number(env.TRAININGAPP_SMOKE_WATCHDOG_MS) > 0 ? Number(env.TRAININGAPP_SMOKE_WATCHDOG_MS) : WATCHDOG_DEFAULT_MS;
  const killDepsForWatchdog = { runTaskkill: makeTaskkillRunner(), log };
  watchdog = armWatchdog(watchdogMs, {
    now: () => Date.now(),
    fire: () => watchdogExit({ captures, child: state.activeChild, kill: (c) => killTree(c, killDepsForWatchdog), log, exit: io.exit, state, ms: watchdogMs }),
  });

  registerSignalHandlers({ log, removeWs, exit: io.exit }, state, killDepsForWatchdog);

  const boot = async (capture) => {
    currentCapture = capture;
    log(`SMOKE: booting packaged exe (driver=${driver}, exe ${exe}, hash embedder, isolated store ${storePath})`);
    return driver === 'cdp'
      ? bootCdp({ exe, userDataDir, storePath, packsDir, capture, state, io, watchdog, log })
      : bootPlaywright({ exe, userDataDir, storePath, packsDir, capture, log });
  };

  let session;
  try {
    session = await boot(boot1);
  } catch (err) {
    boot1.dump(log, 'SMOKE: launch failed');
    final(2, `SMOKE: INFRA - packaged launch failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const evaluate = (fn) => session.run(fn);

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
      relaunch = await boot(boot2);
      let next = null;
      const relaunchDeadline = Date.now() + 90_000;
      while (Date.now() < relaunchDeadline) {
        next = await relaunch.run(() => window.desktopApi?.getFirstRunStatus?.());
        if (next?.needed === false) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      check(6, 'completion persists across relaunch (needed === false)', next?.needed === false, `needed=${String(next?.needed)}`);
      await relaunch.close();
    } catch (err) {
      await relaunch?.close().catch(() => {});
      // Round-1 gap: the relaunch catch dumped nothing, so the runner log for
      // the wedged second attach had zero app-side context. Both boots' tails
      // are dumped with labels (R7).
      dumpAllCaptures(log, captures, 'SMOKE: relaunch failed');
      // Recorded assertion failures outrank a later close/relaunch infra
      // error: a genuine step FAIL must not be re-labeled INFRA (PRR-015).
      if (state.failures.length > 0) {
        final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${state.failures.join('; ')} (relaunch/close also errored: ${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      final(2, `SMOKE: INFRA - relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  } catch (err) {
    await session.close().catch(() => {});
    currentCapture.dump(log, 'SMOKE: ladder failed');
    if (state.failures.length > 0) {
      final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${state.failures.join('; ')} (ladder also errored: ${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    final(2, `SMOKE: INFRA - ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (state.failures.length > 0) {
    final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${state.failures.join('; ')}`);
    return;
  }
  final(0, 'SMOKE: PASS - packaged first-run ladder complete (manifest clean, tools available, packs active, wizard completed+persisted, /packs 200)');
}

// Entry guard: importing this module runs nothing (the contract spec imports
// it under vitest); only direct execution drives the CLI. The undefined guard
// keeps `node -e` style imports from throwing (plan R18).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main(process.argv.slice(2), process.env, {
      log: (line) => console.log(line),
      exit: (code) => process.exit(code),
      removeWs: () => {},
    });
  } catch (err) {
    console.log(`SMOKE: INFRA - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
