/**
 * packaged-smoke-contract.test.ts — the executable pin for the packaged-boot
 * smoke driver's hardened seams (issues #177/#178/#179/#180/#182, collated
 * batch trace packaged-smoke-cdp).
 *
 * Every test drives the REAL exported seams of desktop/scripts/packaged-smoke.mjs
 * with injected dependencies (child states, taskkill runner, clock, sleep,
 * exit) — no mocks of the code under test — so the named mutants in the
 * batch's acceptance table each kill exactly their check. The test names are a
 * frozen contract: the batch's check-unit.sh probes address them by -t filter.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WATCHDOG_DEFAULT_MS,
  BUFFER_MAX_LINES,
  parseDriver,
  parseDevToolsEndpoint,
  boundEvaluate,
  createConsoleCapture,
  dumpAllCaptures,
  makeTaskkillRunner,
  taskkillTree,
  killTree,
  armWatchdog,
  watchdogExit,
  verdictCode,
  verifyEndpointPort,
  registerSignalHandlers,
  emitAttachSummary,
  createRunState,
  recordAttachTimeout,
  closeCdpSession,
} from '../../scripts/packaged-smoke.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root discovery via the established contracts marker (b4/b5 convention). */
function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const SMOKE_PATH = path.join(REPO_ROOT, 'desktop', 'scripts', 'packaged-smoke.mjs');

describe('packaged-smoke driver contract (batch packaged-smoke-cdp)', () => {
  it('watchdog-exit2: dumps all captures, kills the tree, and exits 2 (1 when failures are recorded)', () => {
    // The calibrated constant stays below the workflow's 35-minute job wall.
    expect(WATCHDOG_DEFAULT_MS).toBe(30 * 60_000);

    const logs: string[] = [];
    const exits: number[] = [];
    const kills: unknown[] = [];
    const capA = createConsoleCapture(10);
    capA.append('boot1 tail line\n');
    const capB = createConsoleCapture(10);
    capB.append('boot2 tail line\n');
    const state = createRunState();
    watchdogExit({
      captures: new Map([['boot-1', capA], ['boot-2', capB]]),
      child: { pid: 11, exitCode: null, signalCode: null },
      kill: (c) => kills.push(c),
      log: (l) => logs.push(l),
      exit: (c) => exits.push(c),
      state,
      ms: 1234,
    });
    expect(exits).toEqual([2]);
    expect(kills.length).toBe(1);
    expect(logs.some((l) => l.includes('SMOKE: watchdog fired after 1234ms'))).toBe(true);
    // BOTH boots' tails are dumped with labels (the relaunch wedge evidence).
    expect(logs.some((l) => l.includes('boot1 tail line'))).toBe(true);
    expect(logs.some((l) => l.includes('boot2 tail line'))).toBe(true);
    expect(logs.some((l) => l.includes('[boot-1]'))).toBe(true);
    expect(logs.some((l) => l.includes('[boot-2]'))).toBe(true);
    // The attach summary reaches the wedged-run exit path too.
    expect(logs.some((l) => l.includes('SMOKE: attach attempts timed out: 0'))).toBe(true);

    // Failures out-rank INFRA (AC3/AC9 carve-out).
    const exits2: number[] = [];
    watchdogExit({
      captures: new Map(),
      child: null,
      kill: () => {},
      log: () => {},
      exit: (c) => exits2.push(c),
      state: { ...createRunState(), failures: ['step 1'] },
      ms: 5,
    });
    expect(exits2).toEqual([1]);
  });

  it('watchdog-exit2 arm semantics: fires when armed, stays off while suspended', async () => {
    // Armed and NOT suspended: the watchdog must actually fire (M-C3 kills).
    let fired = 0;
    const wd = armWatchdog(20, { fire: () => { fired += 1; } });
    await new Promise((r) => setTimeout(r, 90));
    expect(fired).toBe(1);
    wd.disarm();
    // Suspended across the (bounded) close window: no fire.
    let fired2 = 0;
    const wd2 = armWatchdog(60, { fire: () => { fired2 += 1; } });
    wd2.suspend();
    await new Promise((r) => setTimeout(r, 90));
    expect(fired2).toBe(0);
    wd2.disarm();
  });

  it('attach-timeout-count: records timed-out attach attempts and reports them in the summary', () => {
    const state = createRunState();
    recordAttachTimeout(state);
    recordAttachTimeout(state);
    recordAttachTimeout(state);
    const logs: string[] = [];
    emitAttachSummary((l) => logs.push(l), state);
    expect(logs).toEqual(['SMOKE: attach attempts timed out: 3']);
  });

  it('kill-guard: kills only a live child and keeps the wrapper as the single taskkill site', () => {
    const calls: string[][] = [];
    const deps = {
      runTaskkill: (args: string[]) => { calls.push(args); return { status: 0, error: null }; },
      log: () => {},
    };
    // Exited child: never killed (PID-reuse guard).
    expect(killTree({ pid: 42, exitCode: 0, signalCode: null }, deps)).toBe(false);
    expect(calls.length).toBe(0);
    // Signal-terminated child: exitCode stays null but signalCode is set.
    expect(killTree({ pid: 42, exitCode: null, signalCode: 'SIGTERM' }, deps)).toBe(false);
    expect(calls.length).toBe(0);
    // Live child: killed through the wrapper.
    expect(killTree({ pid: 42, exitCode: null, signalCode: null }, deps)).toBe(true);
    expect(calls).toEqual([['/PID', '42', '/T', '/F']]);

    // Source census (M-C6: removing the wrapper's liveness predicate, or
    // adding a raw taskkill bypass, kills this check).
    const src = fs.readFileSync(SMOKE_PATH, 'utf8');
    const rawSites = src.split('\n').filter((l) => l.includes("spawnSync('taskkill'"));
    expect(rawSites.length).toBe(1);
  });

  it('taskkill-status: checks and logs taskkill results', () => {
    const logs: string[] = [];
    // Non-zero status is logged.
    taskkillTree(1, { runTaskkill: () => ({ status: 1, error: null }), log: (l) => logs.push(l) });
    expect(logs.some((l) => l.includes('SMOKE: taskkill failed (status=1)'))).toBe(true);
    // Zero status is silent.
    logs.length = 0;
    taskkillTree(1, { runTaskkill: () => ({ status: 0, error: null }), log: (l) => logs.push(l) });
    expect(logs.length).toBe(0);
    // A thrown runner is logged too.
    logs.length = 0;
    taskkillTree(1, { runTaskkill: () => { throw new Error('boom'); }, log: (l) => logs.push(l) });
    expect(logs.some((l) => l.includes('SMOKE: taskkill failed (boom)'))).toBe(true);
    // The real runner exists and is the single site.
    expect(typeof makeTaskkillRunner()).toBe('function');
  });

  it('signal-reap: the registered SIGINT and SIGTERM listeners reap the spawned tree', () => {
    const sigintBefore = process.listeners('SIGINT').length;
    const sigtermBefore = process.listeners('SIGTERM').length;
    const calls: string[][] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    const state = createRunState();
    const child = { pid: 99, exitCode: null, signalCode: null };
    state.activeChild = child;
    const reg = registerSignalHandlers(
      { log: (l) => logs.push(l), removeWs: () => {}, exit: (c) => exits.push(c) },
      state,
      { runTaskkill: (args: string[]) => { calls.push(args); return { status: 0, error: null }; }, log: (l) => logs.push(l) },
    );
    try {
      const sigints = process.listeners('SIGINT').slice(sigintBefore);
      const sigterms = process.listeners('SIGTERM').slice(sigtermBefore);
      expect(sigints.length).toBe(1);
      expect(sigterms.length).toBe(1);
      // Invoke the ACTUAL registered listeners (not the reap helper).
      (sigints[0] as () => void)();
      expect(calls).toEqual([['/PID', '99', '/T', '/F']]);
      expect(exits).toEqual([2]);
      expect(logs.some((l) => l.includes('SMOKE: attach attempts timed out: 0'))).toBe(true);

      calls.length = 0;
      exits.length = 0;
      state.activeChild = { pid: 100, exitCode: null, signalCode: null };
      (sigterms[0] as () => void)();
      expect(calls).toEqual([['/PID', '100', '/T', '/F']]);
      expect(exits).toEqual([2]);
    } finally {
      reg.dispose();
    }
    expect(process.listeners('SIGINT').length).toBe(sigintBefore);
    expect(process.listeners('SIGTERM').length).toBe(sigtermBefore);
  });

  it('close-idempotent: the second close is a no-op and a survived close keeps the assertion-failure verdict', async () => {
    const kills: unknown[] = [];
    const child = { pid: 5, exitCode: null, signalCode: null }; // never dies
    const state = createRunState();
    const opts = {
      state, child,
      alive: () => child.exitCode === null && child.signalCode === null,
      browser: { close: () => Promise.resolve() },
      page: { evaluate: () => Promise.resolve() },
      kill: (c: unknown) => kills.push(c),
      sleep: () => Promise.resolve(),
      now: () => Date.now(),
      log: () => {},
      watchdog: null,
      gracefulMs: 1, settleMs: 1,
    };
    await expect(closeCdpSession(opts)).rejects.toThrow(/survived close/);
    const killsAfterFirst = kills.length;
    expect(killsAfterFirst).toBeGreaterThanOrEqual(2);
    // Second close: strict no-op (no extra escalation).
    await closeCdpSession(opts);
    expect(kills.length).toBe(killsAfterFirst);
    // A recorded assertion failure keeps exit 1 (failures out-rank INFRA).
    expect(verdictCode(['step 1'])).toBe(1);
    expect(verdictCode([])).toBe(2);
  });

  it('graceful-window: waits for child exit before the forced kill and logs the exit code', async () => {
    const kills: unknown[] = [];
    const logs: string[] = [];
    const child = { pid: 6, exitCode: null, signalCode: null };
    let ticks = 0;
    const state = createRunState();
    await closeCdpSession({
      state, child,
      alive: () => child.exitCode === null && child.signalCode === null,
      browser: { close: () => Promise.resolve() },
      page: { evaluate: () => Promise.resolve() },
      kill: (c: unknown) => kills.push(c),
      sleep: () => { ticks += 1; if (ticks >= 3) child.exitCode = 0; return Promise.resolve(); },
      now: () => Date.now(),
      log: (l: string) => logs.push(l),
      watchdog: { suspend: () => {}, resume: () => {} },
      gracefulMs: 2000, settleMs: 1,
    });
    // The child exited inside the graceful window: never force-killed.
    expect(kills.length).toBe(0);
    expect(logs.some((l) => l.includes('SMOKE: child exit at close: code=0'))).toBe(true);
    expect(state.closeAttempted).toBe(true);
  });

  it('endpoint-bind: refuses to attach when the endpoint port disagrees', () => {
    expect(verifyEndpointPort('ws://127.0.0.1:9300/devtools/browser/abc', 9300)).toBe(9300);
    expect(() => verifyEndpointPort('ws://127.0.0.1:9300/devtools/browser/abc', 8888))
      .toThrow(/does not match the polled port 8888/);
  });

  it('per-boot-buffers: each boot captures its own output', () => {
    const boot1 = createConsoleCapture(10);
    const boot2 = createConsoleCapture(10);
    boot1.append('first boot marker\n');
    boot2.append('second boot marker\n');
    const l1: string[] = [];
    const l2: string[] = [];
    boot1.dump((l) => l1.push(l), 'boot-1 dump');
    boot2.dump((l) => l2.push(l), 'boot-2 dump');
    expect(l1.some((l) => l.includes('first boot marker'))).toBe(true);
    expect(l1.some((l) => l.includes('second boot marker'))).toBe(false);
    expect(l2.some((l) => l.includes('second boot marker'))).toBe(true);
    expect(l2.some((l) => l.includes('first boot marker'))).toBe(false);
    // The shared dump helper labels each boot.
    const all: string[] = [];
    dumpAllCaptures((l) => all.push(l), new Map([['boot-1', boot1], ['boot-2', boot2]]), 'relaunch failed');
    expect(all.some((l) => l.includes('relaunch failed [boot-1]'))).toBe(true);
    expect(all.some((l) => l.includes('relaunch failed [boot-2]'))).toBe(true);
    // Wiring census (M-C13 kills): main must create TWO captures and boot each
    // run into its own — re-sharing one buffer across boots is the base defect.
    const src = fs.readFileSync(SMOKE_PATH, 'utf8');
    expect(src.split('createConsoleCapture()').length - 1).toBe(2);
    expect(src.includes("new Map([['boot-1', boot1], ['boot-2', boot2]])")).toBe(true);
  });

  it('buffer-cap: the capture keeps only the bounded tail', () => {
    expect(BUFFER_MAX_LINES).toBe(2000);
    const capture = createConsoleCapture(5);
    for (let i = 1; i <= 10; i += 1) capture.append(`line ${i}\n`);
    const out: string[] = [];
    capture.dump((l) => out.push(l), 'cap dump');
    expect(out.some((l) => l.includes('line 10'))).toBe(true);
    expect(out.some((l) => l.includes('line 6'))).toBe(true);
    expect(out.some((l) => l.includes('line 5'))).toBe(false); // trimmed past the cap
    expect(capture.size).toBe(5);
  });

  it('bound-evaluate-rejects: the bound fires when the inner evaluate hangs', async () => {
    const hung = { evaluate: () => new Promise(() => {}) };
    await expect(boundEvaluate(hung, () => undefined, 'hung probe', 20))
      .rejects.toThrow(/hung probe timed out after 20ms/);
    // And the bound passes results through when the inner resolves.
    const ok = { evaluate: () => Promise.resolve(7) };
    await expect(boundEvaluate(ok, () => undefined, 'ok probe', 1000)).resolves.toBe(7);
  });

  it('parse seams stay pinned (parseDriver / parseDevToolsEndpoint)', () => {
    expect(parseDriver([])).toBe('playwright');
    expect(parseDriver(['--driver', 'cdp'])).toBe('cdp');
    expect(parseDriver(['--driver=cdp'])).toBe('cdp');
    expect(parseDriver(['--driver'])).toBe(''); // whitelist rejects it (exit 2)
    expect(parseDevToolsEndpoint('DevTools listening on ws://127.0.0.1:56438/devtools/browser/x'))
      .toBe('ws://127.0.0.1:56438/devtools/browser/x');
    expect(parseDevToolsEndpoint('nothing here')).toBe(null);
  });
});
