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
//     DevTools line, cross-check it against the /json/version response, and
//     connect chromium.connectOverCDP to that parsed endpoint. This bypasses
//     the Playwright electron launch handshake that never completes on GitHub
//     windows runners (#135). The windowed driver's own Playwright exit
//     killer reaps its tree on harness exit; the CDP path reaps explicitly.
//
// First-boot attach wedge (issue #177 investigation note): CI run 38474570960
// showed attach attempt 1 timing out at 60s on the FIRST boot after the
// WebSocket connected, with the relaunch attaching first try — a first-boot
// stall the single-instance story does not cover. Cause remains INFERENCE:
// first-boot contention (freshly built exe under antivirus/cold cache) is the
// leading candidate, renderer preparation (#135 class) the alternative. The
// driver bounds the class instead of claiming a cause: the attach binds to
// this child's own parsed, loopback-verified, identity-cross-checked DevTools
// endpoint; every attach outcome is counted per boot and printed on every
// exit path; the run watchdog bounds any wedge below the step and job walls;
// and per-boot captures with both-boots dumps preserve the evidence.
//
// Flags/env (contracts pinned by the frozen C2/C3 checks of trace
// 131-e1-followups and by the packaged-smoke-cdp batch checks):
//   --driver <playwright|cdp>   transport selection (default playwright)
//   --driver-selftest           parse the captured DevTools stderr sample
//                               through the REAL selection/parsing paths,
//                               assert the driver-value parses for both
//                               drivers plus the run's own selection, and
//                               exit — runs AFTER the driver whitelist and
//                               BEFORE the exe guard, spawns nothing
//   TRAININGAPP_SMOKE_EXE       explicit packaged-exe path; when set, the
//                               stale-build guard is skipped (operator
//                               assertion) and the resolved path is logged
//   TRAININGAPP_SMOKE_WATCHDOG_MS  watchdog budget override (probes/tests);
//                               clamped to [1min, 60min], else the default
//
// Exit 0 all-pass / 1 any assertion failed / 2 harness infra failure.
// Failures out-rank INFRA everywhere: any recorded assertion failure keeps
// exit 1 even when a later spawn error, watchdog fire, or signal arrives
// (verdictCode is shared by final(), the spawn path, the watchdog, and the
// signal path). Every boot-run exit path prints
// `SMOKE: attach attempts timed out: N (boot-1: a, boot-2: b, other failures: m)`
// before its verdict line so attach outcomes survive wedged runs.
//
// Import-safe module: nothing runs at import; `main` owns every side effect
// behind an entry guard. The exported seams (log, exit, taskkill runner,
// clock, sleep) are function parameters so
// desktop/src/__tests__/packaged-smoke-contract.test.ts can drive real
// behavior with injected dependencies.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// Namespace import: the worktree check harness stubs only _electron, and the
// base-leg runs must keep resolving. chromium is only ACCESSED on the cdp path,
// which runs where the real package is installed.
import * as playwright from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..');

// ---- frozen contract values -------------------------------------------------
// Captured from CI run 38405484055's failing step — the DevTools browser
// endpoint Playwright itself connected to before its handshake hung. The
// instance id is a placeholder: the real per-run value is dead with the job's
// VM and deliberately kept out of the repo (review finding PRR-011).
const DEVTOOLS_STDERR_SAMPLE =
  'DevTools listening on ws://127.0.0.1:56438/devtools/browser/00000000-0000-4000-8000-000000000000';

/**
 * Run-level watchdog budget (issues #177 AC3). The watchdog is the LAST
 * resort bound, not the primary one: each phase below carries its own bound
 * (120s DevTools-line wait + 120s server/page wait + 3x60s attach retries +
 * 120s renderer wait per boot, x2 boots; 120s ladder status poll + four 120s
 * ladder evaluate bounds; 90s relaunch poll; ~45s close per boot) and that
 * stack is ~30-31 min in the pathological all-phases-at-their-bound case, so
 * the watchdog sits AT the stack ceiling (30 min) rather than below it — a
 * healthy run reaches its bounds rarely, and a wedged run usually trips a
 * per-phase bound first. The walls around it are sized so a verdict always
 * lands inside them: the smoke step carries timeout-minutes 32 and the job
 * 45 (review finding PRR-007 — the previous 30-min watchdog could never fire
 * before the old 35-min job wall, which counts from job start ~8 min earlier;
 * the job wall was raised 40 -> 45 in 1f4850f0 — issue #177 AC9 keeps this
 * docblock tied to the real values).
 */
export const WATCHDOG_DEFAULT_MS = 30 * 60_000;
export const WATCHDOG_MIN_MS = 60_000;
export const WATCHDOG_MAX_MS = 60 * 60_000;
/** Graceful-close wait for full main-process exit before forced kill (AC10). */
export const GRACEFUL_EXIT_MS = 20_000;
/** Console capture ring size in lines (AC14) and the per-line byte cap. */
export const BUFFER_MAX_LINES = 2000;
export const BUFFER_LINE_MAX_CHARS = 2_000;
/** How many retained lines a dump surfaces per boot (review PRR-015). */
export const DUMP_TAIL_LINES = 200;
const EVAL_BOUND_PROBE_MS = 10_000;
const EVAL_BOUND_CLOSE_MS = 5_000;
const EVAL_BOUND_LADDER_MS = 120_000;
const EVAL_BOUND_PACKS_MS = 10_000;
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

/**
 * AC12 (review PRR-004): the attach target must be a LOOPBACK endpoint whose
 * port is real (non-zero) and agrees with the independently discovered port —
 * the port the /json/version readiness probe actually answered on, taken from
 * its `webSocketDebuggerUrl`, not re-derived from the endpoint string.
 * Returns the verified port; throws (refusing the attach) otherwise.
 */
export function verifyEndpointPort(endpoint, discoveredPort) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('DevTools endpoint is not a parseable URL; refusing the attach');
  }
  if (url.protocol !== 'ws:') {
    throw new Error(`DevTools endpoint is not a ws:// URL (${url.protocol}); refusing the attach`);
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
    throw new Error(`DevTools endpoint host ${url.hostname} is not loopback; refusing the attach`);
  }
  const parsed = Number(url.port);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`DevTools endpoint carries no usable port (${url.port}); refusing the attach`);
  }
  const discovered = Number(discoveredPort);
  if (!Number.isInteger(discovered) || discovered <= 0) {
    throw new Error(`discovered port ${String(discoveredPort)} is not usable; refusing the attach`);
  }
  if (parsed !== discovered) {
    throw new Error(`DevTools endpoint port ${parsed} does not match the polled port ${discovered}; refusing the attach`);
  }
  return parsed;
}

/** Redaction for every retained log surface (review PRR-011): the DevTools
 *  attach URL's instance id is dead with the job's VM but stays out of logs. */
export function redact(text) {
  return String(text).replace(/devtools\/browser\/[0-9a-f-]+/gi, 'devtools/browser/<redacted>');
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
  return {
    attachTimeouts: { 'boot-1': 0, 'boot-2': 0 },
    attachFailures: 0,
    failures: [],
    activeChild: null,
    bootTag: 'boot-1',
  };
}

/** Count an attach outcome per boot (review PRR-010): only genuine timeouts
 *  count as "timed out"; every other rejection is counted separately so the
 *  #177 triage signal means what it says. */
export function recordAttachOutcome(state, err) {
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout = /timeout|timed out/i.test(message) || (err instanceof Error && err.name === 'TimeoutError');
  if (isTimeout) {
    state.attachTimeouts[state.bootTag] += 1;
  } else {
    state.attachFailures += 1;
  }
  return isTimeout;
}

/** Printed on every boot-run exit path (final, watchdog, signals, spawn). */
export function emitAttachSummary(log, state) {
  const total = state.attachTimeouts['boot-1'] + state.attachTimeouts['boot-2'];
  log(
    `SMOKE: attach attempts timed out: ${total} ` +
      `(boot-1: ${state.attachTimeouts['boot-1']}, boot-2: ${state.attachTimeouts['boot-2']}, other failures: ${state.attachFailures})`,
  );
}

/** Failures out-rank INFRA: a recorded assertion failure keeps exit 1 even
 *  when a later spawn error, watchdog fire, or signal arrives (AC9, plan
 *  R6/R16; review PRR-003/PRR-019). */
export const verdictCode = (failures) => (failures.length > 0 ? 1 : 2);

// ---- console capture (AC13/AC14) -------------------------------------------

export function createConsoleCapture(maxLines = BUFFER_MAX_LINES) {
  const lines = [];
  let pending = '';
  const push = (line) => {
    if (line.length === 0) return;
    lines.push(line.length > BUFFER_LINE_MAX_CHARS ? `${line.slice(0, BUFFER_LINE_MAX_CHARS)}…[truncated]` : line);
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  };
  return {
    append(d) {
      pending += d.toString();
      if (pending.length > BUFFER_LINE_MAX_CHARS * 4) pending = pending.slice(-BUFFER_LINE_MAX_CHARS * 2);
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const line of parts) push(line);
    },
    dump(log, prefix) {
      const all = pending.length > 0 ? [...lines, pending] : [...lines];
      const out = all.map(redact).filter((l) => l.length > 0);
      log(`${prefix} — app process output (last ${DUMP_TAIL_LINES} lines):`);
      for (const line of out.slice(-DUMP_TAIL_LINES)) log(`  ${line}`);
      if (out.length === 0) log('  (no output captured — the app died before any stream write)');
    },
    get size() { return lines.length; },
  };
}

/** Per-boot captures (AC13; review PRR-017 wires this through main so a
 *  boot(boot1) reuse cannot silently merge the boots' evidence). */
export function createBootCaptures() {
  const boot1 = createConsoleCapture();
  const boot2 = createConsoleCapture();
  return { boot1, boot2, captures: new Map([['boot-1', boot1], ['boot-2', boot2]]) };
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
    log(`SMOKE: taskkill failed (${redact(err instanceof Error ? err.message : String(err))})`);
    return { status: null, error: err };
  }
  if (res.error) {
    log(`SMOKE: taskkill failed (${redact(res.error instanceof Error ? res.error.message : String(res.error))})`);
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

/** Signal + exit reaping (AC8, review PRR-019): registered on SIGINT,
 *  SIGTERM and process exit so a harness Ctrl-C, a CI cancel, or any normal
 *  termination never orphans the packaged exe. Returns the registered
 *  handlers plus a dispose() for the success path (PRR-024). */
export function registerSignalHandlers(io, state, deps) {
  const reap = () => {
    if (state.activeChild !== null) killTree(state.activeChild, deps);
    // Evidence preservation on cancellation (review PRR-007): the wedged-run
    // diagnostics must survive a Ctrl-C / graceful cancel, not only the
    // watchdog path.
    if (io.dump) io.dump();
    emitAttachSummary(io.log, state);
    io.removeWs();
    // Failures out-rank INFRA on the signal path too (plan contract 8).
    io.exit(verdictCode(state.failures));
  };
  // The 'exit' listener is synchronous-only: reap the tree without the
  // summary/exit ceremony (the process is already exiting).
  const exitReap = () => {
    if (state.activeChild !== null) killTree(state.activeChild, deps);
  };
  process.on('SIGINT', reap);
  process.on('SIGTERM', reap);
  process.on('exit', exitReap);
  return {
    handlers: { SIGINT: reap, SIGTERM: reap, exit: exitReap },
    dispose() {
      process.removeListener('SIGINT', reap);
      process.removeListener('SIGTERM', reap);
      process.removeListener('exit', exitReap);
    },
  };
}

// ---- watchdog (AC3) --------------------------------------------------------

/** Arm the run-level watchdog. `suspend()` covers the close window and
 *  `resume()` restores the ORIGINAL deadline (never a fresh budget) — the
 *  disarm window itself carries only bounded awaits (plan R13/R21). The
 *  handle latches: once fired or disarmed, resume() cannot re-arm (review
 *  PRR-009 hardening). */
export function armWatchdog(ms, hooks) {
  const now = hooks.now ?? (() => Date.now());
  const deadline = now() + ms;
  let timer = null;
  let done = false;
  const arm = (remaining) => {
    if (done) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; done = true; hooks.fire(); }, Math.max(0, remaining));
  };
  arm(ms);
  return {
    suspend() { if (!done && timer !== null) { clearTimeout(timer); timer = null; } },
    resume() { if (!done && timer === null) arm(deadline - now()); },
    disarm() { done = true; if (timer !== null) { clearTimeout(timer); timer = null; } },
  };
}

/** The watchdog exit path: dump every capture with its label, kill the tree,
 *  clean the workspace, emit the attach summary, then the verdict (failures
 *  out-rank INFRA) — the same exit contract as final() (review PRR-003). */
export function watchdogExit({ captures, child, kill, log, exit, state, ms, cleanup, watchdog, signals }) {
  log(`SMOKE: watchdog fired after ${ms}ms`);
  dumpAllCaptures(log, captures, 'SMOKE: watchdog fired');
  if (child) kill(child);
  emitAttachSummary(log, state);
  log(`SMOKE: INFRA - watchdog budget exceeded (${ms}ms)`);
  if (watchdog) watchdog.disarm();
  if (signals) signals.dispose();
  if (cleanup) cleanup();
  exit(verdictCode(state.failures));
}

/** The dedicated spawn-failure exit (AC5, review PRR-003/TC-04): shared by
 *  the synchronous throw and the async 'error' event; both poles of the
 *  failures-out-rank rule are pinned by the spec. */
export function emitSpawnFailure({ log, state, cleanup, exit, watchdog, signals, captures }, err) {
  const msg = err instanceof Error ? err.message : String(err);
  log(`SMOKE: INFRA - packaged exe failed to spawn: ${redact(msg)}`);
  // Exit parity with final() (review PRR-003): dump the evidence, disarm the
  // watchdog, dispose the listeners, then clean up and exit.
  if (captures) dumpAllCaptures(log, captures, 'SMOKE: spawn failed');
  emitAttachSummary(log, state);
  if (watchdog) watchdog.disarm();
  if (signals) signals.dispose();
  if (cleanup) cleanup();
  // The dedicated spawn verdict exits 2 with no recorded failures (AC5/C5);
  // if a boot's steps already failed, failures out-rank INFRA (verdictCode).
  exit(verdictCode(state.failures));
}

// ---- session close (AC9/AC10) ----------------------------------------------

/** Idempotent close with a bounded graceful window: close the window, wait up
 *  to `gracefulMs` for full main-process exit, only then escalate. Every await
 *  here carries an explicit bound (plan R13). Idempotence is per SESSION
 *  (review PRR-001): each boot owns its guard, so a relaunch closes its own
 *  exe while a second close of the same boot stays a no-op. */
export async function closeCdpSession(opts) {
  const {
    session, child, alive, browser, page, kill, sleep, now, log, watchdog,
    gracefulMs = GRACEFUL_EXIT_MS, closeEvalMs = EVAL_BOUND_CLOSE_MS,
    browserCloseMs = BROWSER_CLOSE_MS, settleMs = 5_000,
  } = opts;
  if (session.closeAttempted) return;
  session.closeAttempted = true;
  if (watchdog) watchdog.suspend();
  try {
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
  } finally {
    // A survived-close throw must not leave the watchdog suspended for the
    // rest of the run (review PRR-009).
    if (watchdog) watchdog.resume();
  }
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
  const { exe, userDataDir, storePath, packsDir, capture, log, state } = ctx;
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
  // Register for reaping too (review PRR-005 note: Playwright's own exit
  // killer already reaps on harness exit; this keeps watchdog/signal parity).
  state.activeChild = app.process();
  app.process().stdout?.on('data', (d) => capture.append(d));
  app.process().stderr?.on('data', (d) => capture.append(d));
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const session = { closeAttempted: false };
  return {
    run: (fn) => boundEvaluate(win, fn, 'ladder evaluate', EVAL_BOUND_LADDER_MS),
    close: async () => {
      if (session.closeAttempted) return;
      session.closeAttempted = true;
      await closeElectronApp(app, log);
    },
  };
}

async function bootCdp(ctx) {
  const { exe, userDataDir, storePath, packsDir, capture, captures, state, io, watchdog, signals, log, cleanup } = ctx;
  const killDeps = { runTaskkill: makeTaskkillRunner(), log };
  const failSpawn = (err) => emitSpawnFailure({ log, state, cleanup, exit: io.exit, watchdog, signals, captures }, err);

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
  let endpoint = null;
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 100_000) stderrBuf = stderrBuf.slice(-50_000);
    // Eager parse per chunk (review PRR-022): a stderr flood must not evict
    // the DevTools line from the ring before we ever read it.
    if (endpoint === null) endpoint = parseDevToolsEndpoint(stderrBuf);
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
    // Electron 44's sandboxed-renderer startup handshake (the #135 class);
    // late connect after /json/list reports a page boots the renderer cleanly.
    const devtoolsDeadline = Date.now() + 120_000;
    while (endpoint === null && Date.now() < devtoolsDeadline) {
      if (!alive()) {
        throw new Error(`packaged exe exited early with code ${deadExit()} (no DevTools line)`);
      }
      endpoint = parseDevToolsEndpoint(stderrBuf);
      if (endpoint === null) await new Promise((r) => setTimeout(r, 500));
    }
    if (endpoint === null) {
      throw new Error('DevTools stderr line never appeared within 120s (endpoint parser found nothing)');
    }

    // Structural verification FIRST (review PRR-004): a portless, non-ws, or
    // non-loopback endpoint must be refused immediately — no 120s burn — and
    // the refusal must surface as a loud error, not vanish into the poll.
    verifyEndpointPort(endpoint, Number(new URL(endpoint).port));

    const deadline = Date.now() + 120_000;
    let serverUp = false;
    let pageReady = false;
    let discoveredPort = null;
    while (Date.now() < deadline) {
      if (!alive()) {
        throw new Error(`packaged exe exited early with code ${deadExit()} (endpoint ${redact(endpoint)})`);
      }
      try {
        if (!serverUp) {
          // Bounded fetches: the loop deadline cannot interrupt an in-flight
          // request, so each fetch carries its own signal (PRR-009).
          const res = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/version`, { signal: AbortSignal.timeout(2_000) });
          if (res.ok) {
            const version = await res.json();
            // Identity cross-check (review PRR-004): the HTTP responder's own
            // webSocketDebuggerUrl must agree with the parsed endpoint — two
            // independent sources (child stderr vs the answering server).
            const discovered = typeof version?.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : null;
            if (discovered === null) {
              throw new Error('/json/version carried no webSocketDebuggerUrl; refusing the attach');
            }
            // The agreement check sits OUTSIDE the swallow-catch below: a
            // real mismatch is a refusal, not a "not up yet" condition.
            discoveredPort = Number(new URL(discovered).port);
            verifyEndpointPort(endpoint, discoveredPort);
            serverUp = true;
          }
        }
        if (serverUp) {
          const list = await fetch(`http://127.0.0.1:${String(discoveredPort)}/json/list`, { signal: AbortSignal.timeout(2_000) });
          if (list.ok) {
            const targets = await list.json();
            if (Array.isArray(targets) && targets.some((t) => t !== null && typeof t === 'object' && t.type === 'page')) {
              pageReady = true;
              break;
            }
          }
        }
      } catch (err) {
        // Structural refusals must surface loudly (review PRR-004): only
        // connection noise is "not up yet".
        if (err instanceof Error && /refusing the attach/.test(err.message)) throw err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!pageReady) {
      throw new Error(
        `no CDP page target within 120s (server=${String(serverUp)}, devtools line: ${redact(String(parseDevToolsEndpoint(stderrBuf)))})`,
      );
    }

    // CDP attach retry: a loaded CI runner wedged the relaunch attach once
    // (PR #172 round 1). Attaching is idempotent to retry while the browser
    // endpoint still answers. Every attempt outcome is counted per boot
    // (AC4) and the counts are printed on every exit path.
    let browser = null;
    let attachError = null;
    for (let attempt = 1; attempt <= 3 && browser === null; attempt++) {
      try {
        browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: 60_000 });
      } catch (err) {
        attachError = err;
        recordAttachOutcome(state, err);
        if (!alive()) {
          throw new Error(`packaged exe exited early with code ${deadExit()} during CDP attach (attempt ${attempt})`);
        }
        if (attempt < 3) {
          log(`SMOKE: CDP attach attempt ${attempt} failed (${redact(err instanceof Error ? err.message : String(err))}); retrying`);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    if (browser === null) {
      throw new Error(`CDP attach failed after 3 attempts: ${redact(attachError instanceof Error ? attachError.message : String(attachError))}`);
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
        // Bounded probe: a wedged page probe must not hang the poll (AC2);
        // a failed probe means "not this page, keep polling".
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
    const session = { closeAttempted: false };
    return {
      run: (fn) => boundEvaluate(page, fn, 'ladder evaluate', EVAL_BOUND_LADDER_MS),
      close: () => closeCdpSession({
        session, child, alive, browser, page, kill,
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
  // Captured INSIDE the try (review PRR-025): Playwright disposes the handle
  // during close, after which process() throws and the kill fallback below
  // would be skipped for a lingering tree (the e2e/launch-helpers defect).
  let proc = null;
  try {
    proc = app.process();
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  } catch {
    /* already closing */
  }
  try {
    if (proc !== null) {
      killTree(proc, { runTaskkill: makeTaskkillRunner(), log });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    /* already gone */
  }
  if (proc !== null) {
    log(`SMOKE: child exit at close: ${proc.exitCode === null ? (proc.signalCode === null ? 'still alive' : `signal ${String(proc.signalCode)}`) : `code=${String(proc.exitCode)}`}`);
  }
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

  // ---- selftest: AFTER the whitelist, BEFORE the exe guard, spawns nothing -
  if (argv.includes('--driver-selftest')) {
    const endpoint = parseDevToolsEndpoint(DEVTOOLS_STDERR_SAMPLE);
    const ok = endpoint !== null && endpoint.startsWith('ws://127.0.0.1:56438/devtools/browser/');
    log(`SMOKE: SELFTEST driver=${driver} endpoint=${endpoint ?? 'none'}`);
    // Derived parse assertions (AC16, review PRR-028): the ok/FAIL values
    // below come from the REAL parseDriver results — the run's own selection
    // is asserted too — and any mismatch exits 1. The literal line reads
    // `playwright=ok cdp=ok` only when every parse really passes.
    const r1 = parseDriver(['--driver', 'playwright']) === 'playwright' && parseDriver([]) === 'playwright' ? 'ok' : 'FAIL';
    const r2 = parseDriver(['--driver', 'cdp']) === 'cdp' ? 'ok' : 'FAIL';
    const rSelected = parseDriver(['--driver', driver]) === driver ? 'ok' : 'FAIL';
    log(`SMOKE: SELFTEST parse playwright=${r1} cdp=${r2}`);
    io.exit(ok && r1 === 'ok' && r2 === 'ok' && rSelected === 'ok' ? 0 : 1);
    return;
  }

  // ---- packaged exe resolution --------------------------------------------
  const exeEnv = env.TRAININGAPP_SMOKE_EXE;
  const explicitExe = exeEnv !== undefined && exeEnv.length > 0;
  const exe = explicitExe ? path.resolve(exeEnv) : path.join(desktopDir, 'desktop-release', 'win-unpacked', 'TrainingApp.exe');

  const state = createRunState();
  const { boot1, boot2, captures } = createBootCaptures();

  // Workspace ownership lives HERE (review PRR-002): every run-path exit —
  // final, spawn failure, watchdog, signals — reaches this real cleanup,
  // never a stub. TDZ-safe: declared before any final() can run and a no-op
  // until the workspace exists (pre-workspace exits have nothing to clean).
  let wsDir = null;
  const removeWs = () => {
    if (wsDir === null) return;
    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch { /* best effort */ }
    wsDir = null;
  };

  let watchdog = null;
  let signals = null;

  const final = (code, line) => {
    if (watchdog) watchdog.disarm();
    if (signals) signals.dispose();
    emitAttachSummary(log, state);
    log(line);
    removeWs();
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

  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainingapp-smoke-'));
  const storePath = path.join(wsDir, 'store', 'store.sqlite');
  const packsDir = path.join(wsDir, 'packs');
  // Isolated Electron profile: without this the packaged exe boots against the
  // machine's real %APPDATA%/TrainingApp userData (single-instance lock with a
  // locally-running app, legacy store migration, real model hashes) (PRR-013).
  const userDataDir = path.join(wsDir, 'user-data');

  const step = (n, name, ok, detail = '') => {
    log(`step ${n}: ${ok ? 'OK' : 'FAIL'} - ${name}${detail.length > 0 ? ` (${detail})` : ''}`);
    return ok;
  };
  const check = (n, name, ok, detail) => {
    if (!step(n, name, ok, detail)) state.failures.push(name);
  };

  // Run-level watchdog (AC3): armed once at run start, suspended only across
  // the bounded close window, disarmed by final(). Budget override clamped
  // (review PRR-008) — an Infinity/huge probe value used to overflow
  // setTimeout into an instant bogus kill.
  const rawWatchdog = Number(env.TRAININGAPP_SMOKE_WATCHDOG_MS);
  const watchdogOverrideValid = Number.isFinite(rawWatchdog) && rawWatchdog >= WATCHDOG_MIN_MS && rawWatchdog <= WATCHDOG_MAX_MS;
  if (env.TRAININGAPP_SMOKE_WATCHDOG_MS !== undefined && env.TRAININGAPP_SMOKE_WATCHDOG_MS !== '' && !watchdogOverrideValid) {
    log(`SMOKE: watchdog override rejected (TRAININGAPP_SMOKE_WATCHDOG_MS=${String(env.TRAININGAPP_SMOKE_WATCHDOG_MS)} outside [${WATCHDOG_MIN_MS}, ${WATCHDOG_MAX_MS}]); using the default`);
  }
  const watchdogMs = watchdogOverrideValid ? rawWatchdog : WATCHDOG_DEFAULT_MS;
  const killDeps = { runTaskkill: makeTaskkillRunner(), log };
  watchdog = armWatchdog(watchdogMs, {
    now: () => Date.now(),
    fire: () => watchdogExit({
      captures, child: state.activeChild, kill: (c) => killTree(c, killDeps),
      log, exit: io.exit, state, ms: watchdogMs, cleanup: removeWs,
      watchdog: null, signals: null,
    }),
  });

  signals = registerSignalHandlers(
    { log, removeWs, exit: io.exit, dump: () => dumpAllCaptures(log, captures, 'SMOKE: signal exit') },
    state,
    killDeps,
  );

  const boot = async (capture, bootTag) => {
    state.bootTag = bootTag;
    log(`SMOKE: booting packaged exe (driver=${driver}, exe ${exe}, hash embedder, isolated store ${storePath})`);
    return driver === 'cdp'
      ? bootCdp({ exe, userDataDir, storePath, packsDir, capture, captures, state, io, watchdog, signals, log, cleanup: removeWs })
      : bootPlaywright({ exe, userDataDir, storePath, packsDir, capture, log, state });
  };

  let session;
  try {
    session = await boot(boot1, 'boot-1');
  } catch (err) {
    boot1.dump(log, 'SMOKE: launch failed');
    final(2, `SMOKE: INFRA - packaged launch failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    return;
  }
  if (!session) return; // failSpawn already emitted the dedicated verdict

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
    check(3, 'all required packs installed and active', activationOk, JSON.stringify(installedNow).slice(0, 500));

    // 4. complete the wizard (profile fast + license acknowledgment).
    const completion = await evaluate(() =>
      window.desktopApi?.completeFirstRun?.({ selectedProfile: 'fast', acknowledgedLicenses: true }),
    );
    check(4, 'wizard completes', completion?.ok === true, completion?.detail ?? '');

    // 5. /packs must answer 200 through the loopback token gate. Issue #177
    // AC-b hardening (deliberate smoke-policy tightening): the in-page fetch
    // carries its own abort so a wedged renderer fetch cannot outlive the
    // evaluate race unnoticed. Verdict-class note: an aborted fetch lands as a
    // recorded step FAILURE (exit 1), not INFRA - the probe answered, the
    // payload was wrong.
    // evaluate race unnoticed.
    const packsProbe = await evaluate(async () => {
      try {
        const info = await window.desktopApi.getBackendInfo();
        const token = await window.desktopApi.getAuthToken();
        const res = await fetch(`${info.url}/packs`, {
          headers: { 'X-Desktop-Token': token },
          signal: AbortSignal.timeout(EVAL_BOUND_PACKS_MS),
        });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        return { status: 0, body: String(err) };
      }
    });
    check(5, '/packs answers 200', packsProbe?.status === 200, `${String(packsProbe?.status)} ${String(packsProbe?.body ?? '').slice(0, 120)}`);

    await session.close();

    // 6. relaunch fresh on the SAME store: the wizard must stay completed.
    //    Poll like step 1 — a fixed sleep misreports slow store restores as
    //    persistence regressions on loaded runners (PRR-014).
    let relaunch;
    try {
      relaunch = await boot(boot2, 'boot-2');
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
        final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${state.failures.join('; ')} (relaunch/close also errored: ${redact(err instanceof Error ? err.message : String(err))})`);
        return;
      }
      final(2, `SMOKE: INFRA - relaunch failed: ${redact(err instanceof Error ? err.message : String(err))}`);
      return;
    }
  } catch (err) {
    await session.close().catch(() => {});
    dumpAllCaptures(log, captures, 'SMOKE: ladder failed');
    if (state.failures.length > 0) {
      final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${state.failures.join('; ')} (ladder also errored: ${redact(err instanceof Error ? err.message : String(err))})`);
      return;
    }
    final(2, `SMOKE: INFRA - ${redact(err instanceof Error ? err.message : String(err))}`);
    return;
  }

  if (state.failures.length > 0) {
    final(1, `SMOKE: FAIL - packaged first-run ladder failed at: ${state.failures.join('; ')}`);
    return;
  }
  final(0, 'SMOKE: PASS - packaged first-run ladder complete (manifest clean, tools available, packs active, wizard completed+persisted, /packs 200)');
}

// Entry guard: importing this module runs nothing (the contract spec imports
// it under vitest); only direct execution drives the CLI. argv[1] is
// realpath-normalized so a symlinked/junctioned invocation cannot silently
// skip the ladder (review PRR-020), and the undefined guard keeps `node -e`
// style imports from throwing (plan R18).
function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectInvocation()) {
  try {
    await main(process.argv.slice(2), process.env, {
      log: (line) => console.log(line),
      exit: (code) => process.exit(code),
    });
  } catch (err) {
    console.log(`SMOKE: INFRA - ${redact(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
}
