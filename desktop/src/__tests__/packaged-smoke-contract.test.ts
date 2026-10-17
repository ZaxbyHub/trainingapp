/**
 * packaged-smoke-contract.test.ts — the executable pin for the packaged-boot
 * smoke driver's hardened seams (issues #177/#178/#179/#180/#182, collated
 * batch trace packaged-smoke-cdp; strengthened by the PR #217 swarm review
 * findings PRR-001..PRR-029).
 *
 * Every test drives the REAL exported seams of desktop/scripts/packaged-smoke.mjs
 * with injected dependencies (child states, taskkill runner, clock, sleep,
 * exit, cleanup) — no mocks of the code under test — so the named mutants in
 * the batch's acceptance table each kill exactly their check. The test names
 * are a frozen contract: the batch's check-unit.sh probes address them by -t
 * filter.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WATCHDOG_DEFAULT_MS,
  WATCHDOG_MIN_MS,
  WATCHDOG_MAX_MS,
  BUFFER_MAX_LINES,
  BUFFER_LINE_MAX_CHARS,
  DUMP_TAIL_LINES,
  parseDriver,
  parseDevToolsEndpoint,
  verifyEndpointPort,
  redact,
  boundEvaluate,
  withTimeout,
  createConsoleCapture,
  createBootCaptures,
  dumpAllCaptures,
  makeTaskkillRunner,
  taskkillTree,
  killTree,
  armWatchdog,
  watchdogExit,
  emitSpawnFailure,
  verdictCode,
  registerSignalHandlers,
  emitAttachSummary,
  createRunState,
  recordAttachOutcome,
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

describe('packaged-smoke driver contract (batch packaged-smoke-cdp + PR217 review fixes)', () => {
  it('watchdog-exit2: dumps all captures, kills the tree, cleans the workspace, and exits 2 (1 when failures are recorded)', () => {
    // The calibrated constant sits at the stacked-phase ceiling and below the
    // step/job walls (PRR-007).
    expect(WATCHDOG_DEFAULT_MS).toBe(30 * 60_000);
    expect(WATCHDOG_MIN_MS).toBe(60_000);
    expect(WATCHDOG_MAX_MS).toBe(60 * 60_000);

    const logs: string[] = [];
    const exits: number[] = [];
    const kills: unknown[] = [];
    const cleanups: number[] = [];
    const { boot1, boot2, captures } = createBootCaptures();
    boot1.append('boot1 tail line\n');
    boot2.append('boot2 tail line\n');
    const state = createRunState();
    watchdogExit({
      captures,
      child: { pid: 11, exitCode: null, signalCode: null },
      kill: (c) => kills.push(c),
      log: (l) => logs.push(l),
      exit: (c) => exits.push(c),
      state,
      ms: 1234,
      cleanup: () => cleanups.push(1),
    });
    expect(exits).toEqual([2]);
    expect(kills.length).toBe(1);
    expect(cleanups.length).toBe(1); // PRR-003: watchdog exits clean up too
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
      captures: new Map(), child: null, kill: () => {},
      log: () => {}, exit: (c) => exits2.push(c),
      state: { ...createRunState(), failures: ['step 1'] }, ms: 5,
    });
    expect(exits2).toEqual([1]);
  });

  it('watchdog-exit2 arm semantics: fires when armed, stays off while suspended, and latches after firing', async () => {
    // Armed and NOT suspended: the watchdog must actually fire (M-C3 kills).
    let fired = 0;
    const wd = armWatchdog(20, { fire: () => { fired += 1; } });
    await new Promise((r) => setTimeout(r, 90));
    expect(fired).toBe(1);
    // Latch (PRR-009): resume after a fire must not re-arm a 0ms double-fire.
    wd.resume();
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
    wd.disarm();
    // Suspended across the (bounded) close window: no fire.
    let fired2 = 0;
    const wd2 = armWatchdog(200, { fire: () => { fired2 += 1; } });
    wd2.suspend();
    await new Promise((r) => setTimeout(r, 60));
    expect(fired2).toBe(0);
    // Resume restores the ORIGINAL deadline (never a fresh budget): 60ms of
    // the 200 already elapsed while suspended, so the fire lands ~140ms after
    // resume — not a fresh 200ms, and not immediately.
    wd2.resume();
    await new Promise((r) => setTimeout(r, 90));
    expect(fired2).toBe(0); // 150ms of the original 200ms budget: not yet
    await new Promise((r) => setTimeout(r, 120));
    expect(fired2).toBe(1); // original deadline reached
    // An EXPIRED budget must fire promptly on resume (total budget exhausted).
    let fired3 = 0;
    const wd3 = armWatchdog(30, { fire: () => { fired3 += 1; } });
    wd3.suspend();
    await new Promise((r) => setTimeout(r, 90));
    expect(fired3).toBe(0);
    wd3.resume();
    await new Promise((r) => setTimeout(r, 60));
    expect(fired3).toBe(1);
    wd3.disarm();
  });

  it('attach-timeout-count: records outcomes per boot and reports them in the summary', () => {
    const state = createRunState();
    // Timeouts count per boot; non-timeout failures are classified separately.
    state.bootTag = 'boot-1';
    expect(recordAttachOutcome(state, new Error('Timeout 60000ms exceeded.'))).toBe(true);
    expect(recordAttachOutcome(state, Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    state.bootTag = 'boot-2';
    expect(recordAttachOutcome(state, new Error('connect ECONNREFUSED'))).toBe(false);
    const logs: string[] = [];
    emitAttachSummary((l) => logs.push(l), state);
    expect(logs).toEqual(['SMOKE: attach attempts timed out: 2 (boot-1: 2, boot-2: 0, other failures: 1)']);
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

    // Source census (M-C6 / review PRR-017): every raw taskkill invocation —
    // spawnSync OR the exec family, either quote style — must live in the
    // single checked wrapper site.
    const src = fs.readFileSync(SMOKE_PATH, 'utf8');
    const rawSites = src.split('\n').filter((l) =>
      /(spawnSync|execSync|execFileSync)\(\s*['"`]taskkill['"`]/.test(l));
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
    // A thrown runner is logged.
    logs.length = 0;
    taskkillTree(1, { runTaskkill: () => { throw new Error('boom'); }, log: (l) => logs.push(l) });
    expect(logs.some((l) => l.includes('SMOKE: taskkill failed (boom)'))).toBe(true);
    // spawnSync's own error object (timeout/ENOENT) is logged too (PRR-029).
    logs.length = 0;
    taskkillTree(1, { runTaskkill: () => ({ status: null, error: new Error('spawnSync taskkill ETIMEDOUT') }), log: (l) => logs.push(l) });
    expect(logs.some((l) => l.includes('ETIMEDOUT'))).toBe(true);
    // The real runner exists and is the single site.
    expect(typeof makeTaskkillRunner()).toBe('function');
  });

  it('signal-reap: the registered SIGINT and SIGTERM listeners reap the spawned tree', () => {
    const sigintBefore = process.listeners('SIGINT').length;
    const sigtermBefore = process.listeners('SIGTERM').length;
    const exitBefore = process.listeners('exit').length;
    const calls: string[][] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    const cleanups: number[] = [];
    const state = createRunState();
    const child = { pid: 99, exitCode: null, signalCode: null };
    state.activeChild = child;
    const reg = registerSignalHandlers(
      { log: (l) => logs.push(l), removeWs: () => cleanups.push(1), exit: (c) => exits.push(c) },
      state,
      { runTaskkill: (args: string[]) => { calls.push(args); return { status: 0, error: null }; }, log: (l) => logs.push(l) },
    );
    try {
      const sigints = process.listeners('SIGINT').slice(sigintBefore);
      const sigterms = process.listeners('SIGTERM').slice(sigtermBefore);
      const exits0 = process.listeners('exit').slice(exitBefore);
      expect(sigints.length).toBe(1);
      expect(sigterms.length).toBe(1);
      expect(exits0.length).toBe(1); // PRR-019: process exit reaps too
      // Invoke the ACTUAL registered listeners (not the reap helper).
      (sigints[0] as () => void)();
      expect(calls).toEqual([['/PID', '99', '/T', '/F']]);
      expect(exits).toEqual([2]);
      expect(cleanups.length).toBe(1); // PRR-029: reap cleans the workspace
      expect(logs.some((l) => l.includes('SMOKE: attach attempts timed out: 0'))).toBe(true);

      calls.length = 0;
      exits.length = 0;
      state.activeChild = { pid: 100, exitCode: null, signalCode: null };
      (sigterms[0] as () => void)();
      expect(calls).toEqual([['/PID', '100', '/T', '/F']]);
      expect(exits).toEqual([2]);

      // No active child: the exit reap is a no-op (PRR-029).
      calls.length = 0;
      state.activeChild = null;
      (exits0[0] as () => void)();
      expect(calls.length).toBe(0);
    } finally {
      reg.dispose();
    }
    expect(process.listeners('SIGINT').length).toBe(sigintBefore);
    expect(process.listeners('SIGTERM').length).toBe(sigtermBefore);
    expect(process.listeners('exit').length).toBe(exitBefore);

    // Failures out-rank INFRA on the signal path too (plan contract 8).
    const sigintBefore2 = process.listeners('SIGINT').length;
    const exits3: number[] = [];
    const state3 = createRunState();
    state3.failures.push('step 1');
    state3.activeChild = { pid: 101, exitCode: 7, signalCode: null }; // exited: no kill
    const reg3 = registerSignalHandlers(
      { log: () => {}, removeWs: () => {}, exit: (c) => exits3.push(c) },
      state3,
      { runTaskkill: () => ({ status: 0, error: null }), log: () => {} },
    );
    try {
      (process.listeners('SIGINT').slice(sigintBefore2)[0] as () => void)();
      expect(exits3).toEqual([1]);
    } finally {
      reg3.dispose();
    }
  });

  it('close-idempotent: per-session guards make a second close a no-op while each boot closes its own child', async () => {
    const kills: unknown[] = [];
    const makeChild = (pid: number) => ({ pid, exitCode: null, signalCode: null });
    // Boot 1: a child that dies inside the graceful window.
    const session1 = { closeAttempted: false };
    const child1 = makeChild(5);
    let ticks1 = 0;
    const baseOpts = {
      browser: { close: () => Promise.resolve() },
      page: { evaluate: () => Promise.resolve() },
      kill: (c: unknown) => kills.push(c),
      now: () => Date.now(),
      log: () => {},
      watchdog: null,
      settleMs: 1,
    };
    await closeCdpSession({
      ...baseOpts,
      session: session1,
      child: child1,
      alive: () => child1.exitCode === null && child1.signalCode === null,
      sleep: () => { ticks1 += 1; if (ticks1 >= 2) child1.exitCode = 0; return Promise.resolve(); },
      gracefulMs: 2000,
    });
    expect(session1.closeAttempted).toBe(true);
    expect(kills.length).toBe(0);
    // Second close of the SAME session: strict no-op.
    await closeCdpSession({
      ...baseOpts,
      session: session1,
      child: child1,
      alive: () => false,
      sleep: () => Promise.resolve(),
      gracefulMs: 1,
    });
    expect(kills.length).toBe(0);

    // Cross-boot (PRR-001): a FRESH session must close ITS OWN child even
    // though boot 1 already closed. The fake kill marks the child dead, as a
    // real taskkill does.
    const session2 = { closeAttempted: false };
    const child2 = makeChild(6);
    await closeCdpSession({
      ...baseOpts,
      session: session2,
      child: child2,
      alive: () => child2.exitCode === null && child2.signalCode === null,
      kill: (c: unknown) => { kills.push(c); child2.exitCode = 0; },
      sleep: () => Promise.resolve(),
      gracefulMs: 1,
    });
    expect(session2.closeAttempted).toBe(true);
    expect(kills.some((k) => (k as { pid?: number })?.pid === 6)).toBe(true);

    // Failures out-rank INFRA at every exit class (verdictCode poles).
    expect(verdictCode(['step 1'])).toBe(1);
    expect(verdictCode([])).toBe(2);
  });

  it('close-idempotent: a survived close keeps the assertion-failure verdict and resumes the watchdog', async () => {
    const child = { pid: 7, exitCode: null, signalCode: null }; // never dies
    const resumeCalls: number[] = [];
    const session = { closeAttempted: false };
    await expect(closeCdpSession({
      session,
      child,
      alive: () => child.exitCode === null && child.signalCode === null,
      browser: { close: () => Promise.resolve() },
      page: { evaluate: () => Promise.resolve() },
      kill: () => {},
      sleep: () => Promise.resolve(),
      now: () => Date.now(),
      log: () => {},
      watchdog: { suspend: () => {}, resume: () => resumeCalls.push(1) },
      gracefulMs: 1, settleMs: 1,
    })).rejects.toThrow(/survived close/);
    // PRR-009: the throw path must still resume the watchdog (finally).
    expect(resumeCalls.length).toBe(1);
    expect(verdictCode(['step 1'])).toBe(1);
    expect(verdictCode([])).toBe(2);
  });

  it('graceful-window: waits for child exit before the forced kill, logs the exit code, and drives the watchdog window', async () => {
    const kills: unknown[] = [];
    const logs: string[] = [];
    const suspendResume: string[] = [];
    const child = { pid: 6, exitCode: null, signalCode: null };
    let ticks = 0;
    const session = { closeAttempted: false };
    await closeCdpSession({
      session, child,
      alive: () => child.exitCode === null && child.signalCode === null,
      browser: { close: () => Promise.resolve() },
      page: { evaluate: () => Promise.resolve() },
      kill: (c: unknown) => kills.push(c),
      sleep: () => { ticks += 1; if (ticks >= 3) child.exitCode = 0; return Promise.resolve(); },
      now: () => Date.now(),
      log: (l: string) => logs.push(l),
      watchdog: { suspend: () => suspendResume.push('suspend'), resume: () => suspendResume.push('resume') },
      gracefulMs: 2000, settleMs: 1,
    });
    // The child exited inside the graceful window: never force-killed.
    expect(kills.length).toBe(0);
    expect(logs.some((l) => l.includes('SMOKE: child exit at close: code=0'))).toBe(true);
    expect(session.closeAttempted).toBe(true);
    // PRR-016: the watchdog window wiring is asserted, not stubbed blindly.
    expect(suspendResume).toEqual(['suspend', 'resume']);
  });

  it('endpoint-bind: refuses non-loopback, portless, unparseable, and mismatched endpoints', () => {
    // Agreement case returns the verified port.
    expect(verifyEndpointPort('ws://127.0.0.1:9300/devtools/browser/abc', 9300)).toBe(9300);
    // Mismatch refuses (AC12).
    expect(() => verifyEndpointPort('ws://127.0.0.1:9300/devtools/browser/abc', 8888))
      .toThrow(/does not match the polled port 8888/);
    // Non-loopback host refuses (PRR-004).
    expect(() => verifyEndpointPort('ws://evil.example:9300/devtools/browser/abc', 9300))
      .toThrow(/is not loopback/);
    // Portless endpoint refuses fast (PRR-004: no 120s port-0 burn).
    expect(() => verifyEndpointPort('ws://127.0.0.1/devtools/browser/abc', 0))
      .toThrow(/no usable port|not usable/);
    // Unparseable endpoint refuses.
    expect(() => verifyEndpointPort('not a url', 9300)).toThrow(/not a parseable URL/);
    // Non-ws protocol refuses.
    expect(() => verifyEndpointPort('http://127.0.0.1:9300/devtools/browser/abc', 9300))
      .toThrow(/not a ws/);
  });

  it('per-boot-buffers: each boot captures its own output', () => {
    const { boot1, boot2, captures } = createBootCaptures();
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
    dumpAllCaptures((l) => all.push(l), captures, 'relaunch failed');
    expect(all.some((l) => l.includes('relaunch failed [boot-1]'))).toBe(true);
    expect(all.some((l) => l.includes('relaunch failed [boot-2]'))).toBe(true);
    // Factory wiring (PRR-017): the map keys route to the SAME objects main
    // passes to each boot — a boot(boot1) reuse cannot merge the evidence.
    expect(captures.get('boot-1')).toBe(boot1);
    expect(captures.get('boot-2')).toBe(boot2);
    expect(boot1).not.toBe(boot2);
  });

  it('buffer-cap: the capture keeps only the bounded tail and caps line size', () => {
    expect(BUFFER_MAX_LINES).toBe(2000);
    const capture = createConsoleCapture(5);
    for (let i = 1; i <= 10; i += 1) capture.append(`line ${i}\n`);
    const out: string[] = [];
    capture.dump((l) => out.push(l), 'cap dump');
    expect(out.some((l) => l.includes('line 10'))).toBe(true);
    expect(out.some((l) => l.includes('line 6'))).toBe(true);
    expect(out.some((l) => l.includes('line 5'))).toBe(false); // trimmed past the cap
    expect(capture.size).toBe(5);
    // Byte cap (PRR-015): one huge line cannot ride the ring verbatim.
    const big = createConsoleCapture(5);
    big.append(`${'x'.repeat(BUFFER_LINE_MAX_CHARS * 3)}\n`);
    const out2: string[] = [];
    big.dump((l) => out2.push(l), 'byte dump');
    expect(out2.some((l) => l.includes('[truncated]'))).toBe(true);
    expect(out2.every((l) => l.length <= BUFFER_LINE_MAX_CHARS + 20)).toBe(true);
    // Dump surface is the documented tail (PRR-015).
    expect(DUMP_TAIL_LINES).toBe(200);
  });

  it('bound-evaluate-rejects: the bound fires when the inner evaluate hangs', async () => {
    const hung = { evaluate: () => new Promise(() => {}) };
    await expect(boundEvaluate(hung, () => undefined, 'hung probe', 20))
      .rejects.toThrow(/hung probe timed out after 20ms/);
    // And the bound passes results through when the inner resolves.
    const ok = { evaluate: () => Promise.resolve(7) };
    await expect(boundEvaluate(ok, () => undefined, 'ok probe', 1000)).resolves.toBe(7);
    // withTimeout clears its timer on either outcome (PRR-029).
    await expect(withTimeout(Promise.reject(new Error('inner')), 1000, 'reject probe')).rejects.toThrow('inner');
  });

  it('parse seams stay pinned (parseDriver / parseDevToolsEndpoint / redact)', () => {
    expect(parseDriver([])).toBe('playwright');
    expect(parseDriver(['--driver', 'cdp'])).toBe('cdp');
    expect(parseDriver(['--driver=cdp'])).toBe('cdp');
    expect(parseDriver(['--driver'])).toBe(''); // whitelist rejects it (exit 2)
    expect(parseDevToolsEndpoint('DevTools listening on ws://127.0.0.1:56438/devtools/browser/x'))
      .toBe('ws://127.0.0.1:56438/devtools/browser/x');
    expect(parseDevToolsEndpoint('nothing here')).toBe(null);
    // PRR-011: redaction covers every retained log surface.
    expect(redact('err ws://127.0.0.1:56438/devtools/browser/e177c158-0222-4e2d-b629-812b9bc06ddd boom'))
      .toBe('err ws://127.0.0.1:56438/devtools/browser/<redacted> boom');
  });

  it('spawn-failure-verdict: the dedicated spawn exit honors both verdict poles and cleans up', () => {
    // No recorded failures: exit 2 (AC5/C5 pole).
    const exits: number[] = [];
    const logs: string[] = [];
    const cleanups: number[] = [];
    emitSpawnFailure(
      { log: (l) => logs.push(l), state: createRunState(), cleanup: () => cleanups.push(1), exit: (c) => exits.push(c) },
      new Error('spawn UNKNOWN'),
    );
    expect(exits).toEqual([2]);
    expect(cleanups.length).toBe(1);
    expect(logs.some((l) => l.includes('SMOKE: INFRA - packaged exe failed to spawn'))).toBe(true);
    expect(logs.some((l) => l.includes('SMOKE: attach attempts timed out: 0'))).toBe(true);
    // Recorded assertion failures out-rank (the 5fb05d2/PRR-016 pole).
    const exits2: number[] = [];
    const state2 = createRunState();
    state2.failures.push('step 1');
    emitSpawnFailure(
      { log: () => {}, state: state2, cleanup: () => {}, exit: (c) => exits2.push(c) },
      new Error('spawn UNKNOWN'),
    );
    expect(exits2).toEqual([1]);
  });
});
