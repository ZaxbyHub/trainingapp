// B3 acceptance spec (C7, NEW-SURFACE — issue #61): SidecarManager contract
// with a fake spawn: loopback bind args/env, GET /health readiness polled
// with retry/backoff under a BOUNDED timeout, and graceful-then-kill
// shutdown. Windows note: both signals map to TerminateProcess there — the
// graceful-then-kill SEQUENCE is what this spec pins, at the injectable
// abstraction (see docs/security/desktop.md).
import { afterEach, describe, expect, it } from 'vitest';
import { SidecarManager } from '../../main/backend/sidecar-manager';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

interface FakeChild extends ChildProcess {
  emitExit: (code: number | null, signal: string | null) => void;
  killCalls: Array<string | undefined>;
}

function makeFakeChild(pid: number): FakeChild {
  const events = new EventEmitter();
  const child = new EventEmitter() as unknown as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stdout = { on: () => {} };
  child.stderr = { on: () => {} };
  child.killCalls = [];
  child.kill = ((signal?: NodeJS.Signals) => {
    child.killCalls.push(signal);
    child.killed = true;
    // Real node emits 'exit' after a signal on the next tick at the earliest.
    queueMicrotask(() => child.emitExit(null, signal ?? 'SIGTERM'));
    return true;
  }) as FakeChild['kill'];
  child.emitExit = (code, signal) => {
    child.exitCode = code ?? 0;
    events.emit('exit', code, signal);
  };
  // Route manager-registered listeners through our event emitter.
  (child as unknown as { on: EventEmitter['on'] }).on = (event, listener) => {
    events.on(event, listener);
    return child;
  };
  return child;
}

interface SpawnRecord {
  command: string;
  args: string[];
  options: { cwd?: string; env: NodeJS.ProcessEnv };
  child: FakeChild;
}

function makeSpawnRecorder(): { records: SpawnRecord[]; spawnFn: NonNullable<SidecarManagerOptionsShape['spawnFn']> } {
  const records: SpawnRecord[] = [];
  const spawnFn: NonNullable<SidecarManagerOptionsShape['spawnFn']> = (command, args, options) => {
    const child = makeFakeChild(1000 + records.length);
    records.push({ command, args, options, child });
    return child;
  };
  return { records, spawnFn };
}

// Structural type mirror avoiding an import cycle in the test.
type SidecarManagerOptionsShape = ConstructorParameters<typeof SidecarManager>[0];

const port = 39001;

afterEach(() => {
  // No shared state; managers under test are stopped within each case.
});

describe('b3-sidecar-manager (C7): spawn, readiness, shutdown', () => {
  it('spawns the configured command with loopback bind env and working directory', async () => {
    const { records, spawnFn } = makeSpawnRecorder();
    const manager = new SidecarManager({
      command: 'trainingapp-backend-stub.exe',
      args: ['--serve'],
      cwd: 'C:/program-data/trainingapp',
      env: { EXTRA_FLAG: '1' },
      port,
      spawnFn,
      pingFn: async () => true,
      maxWaitMs: 500,
    });
    await manager.start();
    expect(records).toHaveLength(1);
    expect(records[0].command).toBe('trainingapp-backend-stub.exe');
    expect(records[0].args).toEqual(['--serve']);
    expect(records[0].options.cwd).toBe('C:/program-data/trainingapp');
    expect(records[0].options.env.API_HOST).toBe('127.0.0.1');
    expect(records[0].options.env.API_PORT).toBe(String(port));
    expect(records[0].options.env.EXTRA_FLAG).toBe('1');
    await manager.stop();
  });

  it('polls GET /health with retry/backoff until ready', async () => {
    const { records, spawnFn } = makeSpawnRecorder();
    const pingedUrls: string[] = [];
    let attempts = 0;
    const manager = new SidecarManager({
      command: 'stub',
      port,
      spawnFn,
      pingFn: async (url) => {
        pingedUrls.push(url);
        attempts += 1;
        return attempts >= 3; // healthy on the third probe
      },
      retryIntervalMs: 5,
      maxWaitMs: 2000,
    });
    await manager.start();
    expect(pingedUrls).toEqual([`http://127.0.0.1:${port}/health`, `http://127.0.0.1:${port}/health`, `http://127.0.0.1:${port}/health`]);
    expect(records).toHaveLength(1);
    await manager.stop();
  });

  it('readiness is BOUNDED: start() rejects within maxWaitMs when /health never answers', async () => {
    const { spawnFn } = makeSpawnRecorder();
    const manager = new SidecarManager({
      command: 'stub',
      port,
      spawnFn,
      pingFn: async () => false,
      retryIntervalMs: 5,
      maxWaitMs: 60,
    });
    const t0 = Date.now();
    await expect(manager.start()).rejects.toThrow(/did not become healthy/);
    expect(Date.now() - t0).toBeLessThan(2000);
    await manager.stop();
  });

  it('stop() is graceful-then-kill: SIGTERM first, SIGKILL only after the grace window', async () => {
    // A child that IGNORES the graceful signal until the kill.
    const stubbornChild = makeFakeChild(4711);
    stubbornChild.kill = ((signal?: NodeJS.Signals) => {
      stubbornChild.killCalls.push(signal);
      stubbornChild.killed = true;
      if (signal === 'SIGKILL') queueMicrotask(() => stubbornChild.emitExit(null, 'SIGKILL'));
      return true;
    }) as FakeChild['kill'];
    const manager = new SidecarManager({
      command: 'stub',
      port,
      spawnFn: (() => stubbornChild) as unknown as NonNullable<SidecarManagerOptionsShape['spawnFn']>,
      pingFn: async () => true,
      stopGraceMs: 30,
      maxWaitMs: 500,
    });
    await manager.start();
    await manager.stop();
    expect(manager.killSignalsForTest[0]).toBe('SIGTERM');
    expect(manager.killSignalsForTest).toContain('SIGKILL');
    const termIndex = manager.killSignalsForTest.indexOf('SIGTERM');
    const killIndex = manager.killSignalsForTest.indexOf('SIGKILL');
    expect(killIndex).toBeGreaterThan(termIndex);
    expect(stubbornChild.killCalls.length).toBeGreaterThan(0);
  });

  it('stop() with no child is a no-op (idempotent)', async () => {
    const { spawnFn } = makeSpawnRecorder();
    const manager = new SidecarManager({ command: 'stub', port, spawnFn, pingFn: async () => true, maxWaitMs: 200 });
    await expect(manager.stop()).resolves.toBeUndefined();
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
