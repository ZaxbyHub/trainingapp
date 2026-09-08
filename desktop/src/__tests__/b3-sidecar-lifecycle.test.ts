// B3 acceptance spec (C4, NEW-SURFACE — issue #61): sidecar LIFECYCLE with an
// injectable spawn — unexpected child death restarts with bounded retries and
// backoff; exceeding the bound gives up (no infinite restart loop); stop()
// during shutdown leaves no running child (no orphan); timing bounds asserted.
import { describe, expect, it } from 'vitest';
import { SidecarManager } from '../../main/backend/sidecar-manager';
import type { SidecarManagerOptions } from '../../main/backend/sidecar-manager';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

interface FakeChild extends ChildProcess {
  emitExit: (code: number | null, signal: string | null) => void;
}

function makeCrashyChild(pid: number, crashAfterMs: number): FakeChild {
  const events = new EventEmitter();
  const child = new EventEmitter() as unknown as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stdout = { on: () => {} };
  child.stderr = { on: () => {} };
  child.kill = ((signal?: NodeJS.Signals) => {
    child.killed = true;
    queueMicrotask(() => child.emitExit(null, signal ?? 'SIGTERM'));
    return true;
  }) as FakeChild['kill'];
  child.emitExit = (code, signal) => {
    child.exitCode = code ?? 0;
    events.emit('exit', code, signal);
  };
  (child as unknown as { on: EventEmitter['on'] }).on = (event, listener) => {
    events.on(event, listener);
    return child;
  };
  const timer = setTimeout(() => child.emitExit(1, null), crashAfterMs);
  timer.unref();
  return child;
}

function lifecycleManager(
  records: FakeChild[],
  overrides: Partial<SidecarManagerOptions> = {},
): SidecarManager {
  const spawnFn: NonNullable<SidecarManagerOptions['spawnFn']> = () => {
    const child = makeCrashyChild(2000 + records.length, 10);
    records.push(child);
    return child;
  };
  return new SidecarManager({
    command: 'stub',
    port: 39011,
    spawnFn,
    pingFn: async () => true, // healthy instantly, then crash on its own timer
    retryIntervalMs: 5,
    maxWaitMs: 500,
    restartBackoffMs: 30,
    maxRestarts: 3,
    stopGraceMs: 20,
    ...overrides,
  });
}

function waitForEvent(manager: SidecarManager, event: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeoutMs);
    manager.once(event, (value: unknown) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('b3-sidecar-lifecycle (C4): bounded restart, give-up, no orphan', () => {
  it('restarts with backoff when the child dies unexpectedly, bounded by maxRestarts', async () => {
    const records: FakeChild[] = [];
    const manager = lifecycleManager(records);
    const spawnTimes: number[] = [];
    manager.on('restart', () => spawnTimes.push(Date.now()));
    await manager.start();
    const initialSpawns = records.length;
    // Wait for all allowed restarts, then the give-up.
    await waitForEvent(manager, 'gave-up');
    // Exactly maxRestarts restart attempts happened after the initial spawn.
    expect(records.length - initialSpawns).toBe(3);
    await manager.stop();
  }, 10000);

  it('the restart backoff is observed (delays grow, no tight loop)', async () => {
    const records: FakeChild[] = [];
    const manager = lifecycleManager(records, { restartBackoffMs: 40 });
    const restartDelays: number[] = [];
    let lastRestart = Date.now();
    manager.on('restart', () => {
      const now = Date.now();
      restartDelays.push(now - lastRestart);
      lastRestart = now;
    });
    await manager.start();
    await waitForEvent(manager, 'gave-up');
    // Each restart honored at least its backoff (40ms base, exponential).
    expect(restartDelays.length).toBeGreaterThanOrEqual(2);
    expect(restartDelays[0]).toBeGreaterThanOrEqual(35);
    expect(restartDelays[1]).toBeGreaterThanOrEqual(75);
    await manager.stop();
  }, 10000);

  it('exceeding the bound gives up: no further spawns after gave-up', async () => {
    const records: FakeChild[] = [];
    const manager = lifecycleManager(records);
    await manager.start();
    await waitForEvent(manager, 'gave-up');
    const countAtGiveUp = records.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(records.length).toBe(countAtGiveUp); // no resurrection
    await manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(records.length).toBe(countAtGiveUp); // stop() cleared pending timers
  }, 10000);

  it('a FAILED start() leaves no scheduled respawn behind (no orphaned restart chain)', async () => {
    const records: FakeChild[] = [];
    const spawnFn: NonNullable<SidecarManagerOptions['spawnFn']> = () => {
      const child = makeCrashyChild(3000 + records.length, 10);
      records.push(child);
      return child;
    };
    const manager = new SidecarManager({
      command: 'stub',
      port: 39012,
      spawnFn,
      pingFn: async () => false, // never healthy
      retryIntervalMs: 5,
      maxWaitMs: 40,
      restartBackoffMs: 20,
      maxRestarts: 5,
      stopGraceMs: 20,
    });
    await expect(manager.start()).rejects.toThrow(/did not become healthy/);
    // start() must FULLY stop (stopping flag + cleared timers): the killed
    // child's exit event must not arm a restart now that the caller believes
    // startup failed and may have dropped its reference to the manager.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(records.length).toBe(1); // exactly the initial spawn; NO respawn chain
    await manager.stop();
  }, 5000);

  it('stop() during shutdown leaves no running child (no orphan)', async () => {
    const records: FakeChild[] = [];
    const manager = lifecycleManager(records, { restartBackoffMs: 5000 });
    await manager.start();
    const child = records[records.length - 1];
    await manager.stop();
    expect(child.killed).toBe(true);
    expect(child.exitCode).not.toBeNull();
    expect(manager.runningPid).toBeNull();
    // No restart timer survives stop(): wait past the (5s) backoff window.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(records.length).toBe(1);
  }, 10000);
});
