// issue #155: permanent regression tests for the GPU backend selection.
//
// These do NOT need a GPU, staged weights, or a network. They use the same
// injection seams the frozen acceptance checks use, plus a plain Node child
// script. They exist because the frozen checks create TEMPORARY files that
// delete themselves: nothing they assert survives as a guard.
//
// Plan-critic Round 1 (CRITICAL): every frozen probe check injects an explicit
// `command`, so the PRODUCTION default spawn was never executed by any check.
// A packaged app that could not spawn its probe would silently always fall back
// to CPU while all fourteen checks stayed green. `default spawn` below is the
// test that closes that hole.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GPU_PROBE_SIDECAR,
  terminateProbeChild,
  activeGpuVerdict,
  gpuProbeChildPath,
  probeOutputIsSane,
  readGpuProbeVerdict,
  runGpuProbe,
  setActiveGpuVerdict,
  writeGpuProbeVerdict,
  type GpuProbeRunOptions,
} from '../../main/backend/inference/gpu-probe.js';
import { LlamaEngine, type LlamaEngineBackend } from '../../main/backend/inference/llama-engine.js';

const GB = 1024 ** 3;

/** A spawn stand-in that records how it was called and can be made to answer. */
function fakeSpawn(reply?: Record<string, unknown>, exitCode = 0) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const spawnFn = ((file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ file, args, env: opts?.env });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter | null;
      stderr: EventEmitter | null;
      kill: (signal?: string) => boolean;
      killed: boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    setImmediate(() => {
      if (reply !== undefined) child.stdout?.emit('data', Buffer.from(JSON.stringify(reply)));
      child.emit('close', exitCode, null);
    });
    return child;
  }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
  return { calls, spawnFn };
}

function stageModels(): { quality: string; fast: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-perm-'));
  const quality = path.join(dir, 'quality.gguf');
  const fast = path.join(dir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast, dir };
}

const GPU_OK = { backend: 'vulkan' as const, ok: true, reason: 'stub probe: gpu usable', device: 'stub-gpu-0' };
const CPU_FAIL = { backend: 'cpu' as const, ok: false, reason: 'stub probe: no usable gpu on this host', device: null };

afterEach(() => {
  setActiveGpuVerdict(null);
});

describe('issue #155: the PRODUCTION probe spawn (what the frozen checks never execute)', () => {
  it('the default command is this process executable plus the compiled child module', () => {
    // The frozen checks always inject `command`, so nothing else proves the
    // packaged-app default. In a packaged Electron app the only Node runtime
    // present is the Electron binary: hardcoding `node` passes in dev and
    // fails in production.
    const { calls, spawnFn } = fakeSpawn({ ok: true, backend: 'vulkan', device: 'd', sample: 'OK' });
    return runGpuProbe({ spawnFn, args: ['/models/fast.gguf'] }).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe(process.execPath);
      const childPath = gpuProbeChildPath();
      expect(calls[0]?.args[0]).toBe(childPath);
      // The model path is handed to the child, which loads the FAST profile's
      // GGUF rather than the 2.6 GB quality one.
      expect(calls[0]?.args).toContain('/models/fast.gguf');
    });
  });

  it('the child env carries ELECTRON_RUN_AS_NODE, without which the child is a browser process', async () => {
    const { calls, spawnFn } = fakeSpawn({ ok: false, backend: 'cpu', reason: 'no device' });
    await runGpuProbe({ spawnFn });
    expect(calls[0]?.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('the resolved child module path exists next to the compiled probe module', () => {
    // desktop/tsconfig.json sets rootDir "." and outDir "dist", so the sibling
    // .js must exist beside this compiled module or the packaged app can never
    // spawn its probe. Under vitest this runs from source, so assert the SOURCE
    // sibling exists and that the resolved path is derived from this module.
    const resolved = gpuProbeChildPath();
    expect(path.basename(resolved)).toBe('gpu-probe-child.js');
    // Compare through path.normalize so the assertion is about the DIRECTORY,
    // not about whether this host spells separators with / or \.
    // gpuProbeChildPath() resolves from the PROBE module's own location, so
    // the assertion below is about that directory - not this test's.
    const probeDir = path.dirname(resolved);
    expect(probeDir.endsWith(path.join('main', 'backend', 'inference'))).toBe(true);
    // The compiled child must ship beside the compiled probe: the path is
    // derived from the probe module's own directory, so a sibling that is not
    // there is a missing file at spawn time in the packaged app - exactly the
    // failure mode the plan critic Round 1 raised. Under vitest the probe runs
    // from source, so assert the SOURCE sibling is in that same directory.
    const sourceSibling = path.join(probeDir, 'gpu-probe-child.ts');
    expect(
      fs.existsSync(sourceSibling),
      `the probe child module must ship beside the probe module; missing: ${sourceSibling}`,
    ).toBe(true);
  });

  it('a probe child that never answers is terminated and resolves to CPU, never a throw', async () => {
    // The hang case: no close event ever arrives.
    const spawnFn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      return child;
    }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
    const verdict = await runGpuProbe({ spawnFn, timeoutMs: 60 });
    expect(verdict.backend).toBe('cpu');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toBe('');
  });
});

describe('issue #155: the probe judges output, and never trusts the child', () => {
  it('a child claiming success with garbage output is rejected by the PARENT', async () => {
    const { spawnFn } = fakeSpawn({ ok: true, backend: 'vulkan', device: 'd', sample: ' \u0001\u0002\u0003 zz' });
    const verdict = await runGpuProbe({ spawnFn });
    expect(verdict.ok).toBe(false);
    expect(verdict.backend).toBe('cpu');
    expect(verdict.reason).not.toBe('');
  });

  it('probeOutputIsSane separates an answer from a mis-decode', () => {
    expect(probeOutputIsSane(' The capital of France is Paris.')).toBe(true);
    expect(probeOutputIsSane('OK')).toBe(true);
    expect(probeOutputIsSane('')).toBe(false);
    expect(probeOutputIsSane('   \n\t ')).toBe(false);
    expect(probeOutputIsSane('\u0000\u0001\u0002')).toBe(false);
    expect(probeOutputIsSane('...,,,;;;')).toBe(false);
  });

  it('a child that never exits cleanly is reported with its exit state', async () => {
    const { spawnFn } = fakeSpawn(undefined, 134);
    const verdict = await runGpuProbe({ spawnFn });
    expect(verdict.backend).toBe('cpu');
    expect(verdict.reason).toContain('134');
  });
});

describe('issue #155: the verdict sidecar', () => {
  it('round-trips, and reads missing and corrupt files as null without throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-sidecar-'));
    expect(readGpuProbeVerdict(dir)).toBeNull();
    writeGpuProbeVerdict(dir, CPU_FAIL);
    expect(fs.existsSync(path.join(dir, GPU_PROBE_SIDECAR))).toBe(true);
    const reloaded = readGpuProbeVerdict(dir);
    expect(reloaded?.backend).toBe('cpu');
    expect(reloaded?.reason).toBe(CPU_FAIL.reason);
    fs.writeFileSync(path.join(dir, GPU_PROBE_SIDECAR), '{ not json', 'utf8');
    expect(readGpuProbeVerdict(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the process-wide holder is the seam the engine reads', () => {
    expect(activeGpuVerdict()).toBeNull();
    setActiveGpuVerdict(GPU_OK);
    expect(activeGpuVerdict()?.backend).toBe('vulkan');
  });
});

describe('issue #155: forced GPU never silently degrades', () => {
  it('an explicit GPU whose factory throws surfaces the error and does NOT retry on CPU', async () => {
    const models = stageModels();
    let attempts = 0;
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      vulkan: true,
      gpuVerdict: () => CPU_FAIL,
      llamaFactory: async () => {
        attempts += 1;
        throw new Error('stub: the GPU could not load the model');
      },
    });
    await expect(engine.query('q')).rejects.toThrow(/could not load/i);
    // Exactly ONE attempt: a forced GPU that quietly retries on CPU is not
    // "force", and a silent degrade is the failure mode this pins.
    expect(attempts).toBe(1);
    const status = engine.modelStatus() as unknown as { gpu?: { ok?: boolean; reason?: string } };
    expect(status.gpu?.ok).toBe(false);
    expect(String(status.gpu?.reason ?? '')).not.toBe('');
    fs.rmSync(models.dir, { recursive: true, force: true });
  });
});

describe('issue #155: the automatic path falls back and records why', () => {
  it('a GPU load failure on auto retries once on CPU and downgrades the verdict', async () => {
    const models = stageModels();
    const backends: Array<{ backend: string; disposed: boolean }> = [];
    const downgrades: Array<{ backend: string; ok: boolean; reason: string }> = [];
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdict: () => GPU_OK,
      onGpuLoadFailure: (v) => {
        downgrades.push(v);
      },
      llamaFactory: async (opts) => {
        if (opts.backend === 'vulkan') throw new Error('stub: out of device memory on the GPU');
        const entry = { backend: opts.backend, disposed: false };
        backends.push(entry);
        return {
          async generate() {
            return { answer: 'cpu answer', cancelled: false };
          },
          async dispose() {
            entry.disposed = true;
          },
        } as LlamaEngineBackend;
      },
    });
    const result = await engine.query('q');
    expect(result.answer).toBe('cpu answer');
    expect(backends).toHaveLength(1);
    expect(backends[0]?.backend).toBe('cpu');
    // The host is told, so its in-memory holder and sidecar stop re-attempting
    // a failing GPU on every later request.
    expect(downgrades).toHaveLength(1);
    expect(downgrades[0]?.backend).toBe('cpu');
    expect(String(downgrades[0]?.reason ?? '')).toContain('CPU');
    fs.rmSync(models.dir, { recursive: true, force: true });
  });

  it('an unprobed host resolves to CPU, exactly as before the feature existed', async () => {
    const models = stageModels();
    const seen: string[] = [];
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdict: () => null,
      llamaFactory: async (opts) => {
        seen.push(opts.backend);
        return {
          async generate() {
            return { answer: 'ok', cancelled: false };
          },
          async dispose() {
            return undefined;
          },
        } as LlamaEngineBackend;
      },
    });
    await engine.query('q');
    expect(seen).toEqual(['cpu']);
    fs.rmSync(models.dir, { recursive: true, force: true });
  });
});

describe('issue #155: the resident reuse key honours backend identity', () => {
  it('changing only the thread count reloads the model', async () => {
    // The same class of bug as the GPU selection: anything the backend is BUILT
    // from must be part of the reuse key, or a settings switch moves without
    // changing anything.
    const models = stageModels();
    let loads = 0;
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      threads: 4,
      models: { quality: models.quality, fast: models.fast },
      llamaFactory: async () => {
        loads += 1;
        return {
          async generate() {
            return { answer: 'ok', cancelled: false };
          },
          async dispose() {
            return undefined;
          },
        } as LlamaEngineBackend;
      },
    });
    await engine.query('q');
    expect(loads).toBe(1);
    expect(engine.applySettingsPatch({ 'inference.threads': 6 }).ok).toBe(true);
    await engine.query('q');
    expect(loads).toBe(2);
    fs.rmSync(models.dir, { recursive: true, force: true });
  });

  it('an unprobed status still explains itself rather than reporting nothing', () => {
    const models = stageModels();
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdict: () => null,
    });
    const status = engine.modelStatus() as unknown as { gpu?: { backend?: string; ok?: boolean; reason?: string } };
    expect(status.gpu?.backend).toBe('cpu');
    expect(status.gpu?.ok).toBe(false);
    expect(String(status.gpu?.reason ?? '').length).toBeGreaterThan(0);
    fs.rmSync(models.dir, { recursive: true, force: true });
  });
});

describe('issue #155: the settings domain is closed', () => {
  it("accepts 'auto' and booleans, rejects everything else without coercing", () => {
    const models = stageModels();
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
    });
    expect(engine.applySettingsPatch({ 'inference.vulkan': 'auto' }).ok).toBe(true);
    expect(engine.applySettingsPatch({ 'inference.vulkan': true }).ok).toBe(true);
    expect(engine.applySettingsPatch({ 'inference.vulkan': false }).ok).toBe(true);
    for (const bad of ['yes', 1, 'off', null, 'true', 0]) {
      const result = engine.applySettingsPatch({ 'inference.vulkan': bad });
      expect(result.ok, `${JSON.stringify(bad)} must be rejected, not coerced`).toBe(false);
    }
    fs.rmSync(models.dir, { recursive: true, force: true });
  });

  it('a rejected patch leaves the previous selection in force', () => {
    const models = stageModels();
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
    });
    expect(engine.applySettingsPatch({ 'inference.vulkan': true }).ok).toBe(true);
    expect(engine.applySettingsPatch({ 'inference.vulkan': 'yes' }).ok).toBe(false);
    expect(engine.responseSettings()['inference.vulkan']).toBe(true);
    fs.rmSync(models.dir, { recursive: true, force: true });
  });
});

// Keep the import used even if a future edit drops the fake spawn's typing.
void vi;
// ---------------------------------------------------------------------------
// Phase 4.5 review findings. Each of these closes a defect the reviewer proved
// by execution, and each one failed BEFORE the fix - the reviewer recorded the
// concrete wrong-behaviour (a probe that never spawns, a child killed at 2 s
// under a documented 60 s deadline, a downgrade that never reaches the holder).
// ---------------------------------------------------------------------------

describe('issue #155 Phase 4.5: the production seams the frozen checks never execute', () => {
  it('a child alive well past the 2 s grace window still succeeds under the default timeout', async () => {
    // Before the fix the SIGKILL escalation was armed at t=0 with KILL_GRACE_MS
    // (2000), so the EFFECTIVE timeout was 2 s despite
    // DEFAULT_PROBE_TIMEOUT_MS = 60000. A real probe must survive a GGUF load
    // longer than that.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-slow-'));
    try {
      // A real child process, not a fake emitter: this is the only test that
      // exercises the actual spawn path and the actual timers.
      const slow = path.join(dir, 'slow.mjs');
      fs.writeFileSync(
        slow,
        `setTimeout(() => { process.stdout.write(JSON.stringify({ ok: true, backend: 'vulkan', device: 'd', sample: 'OK' })); process.exit(0); }, 4000);\n`,
      );
      const verdict = await runGpuProbe({ command: [process.execPath, slow] });
      expect(verdict.ok, 'a probe that answers after ~4 s must succeed, not be SIGKILLed at 2 s').toBe(true);
      expect(verdict.backend).toBe('vulkan');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('a deadline that really expires still SIGTERMs and reports the timeout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-hang-'));
    try {
      const hang = path.join(dir, 'hang.mjs');
      fs.writeFileSync(hang, `setTimeout(() => {}, 60000);\n`);
      const verdict = await runGpuProbe({ command: [process.execPath, hang], timeoutMs: 700 });
      expect(verdict.ok).toBe(false);
      expect(verdict.backend).toBe('cpu');
      expect(verdict.reason).toContain('timed out');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('the child handle is handed to the caller so a shutdown can reap it', async () => {
    // Before the fix `child` lived only inside runGpuProbe's closure, so the
    // host's stop() had nothing to kill and the plan-promised
    // t155-probe-child-cleanup test could not exist.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-handle-'));
    try {
      const hang = path.join(dir, 'hang.mjs');
      fs.writeFileSync(hang, `setTimeout(() => {}, 60000);\n`);
      let seen: { kill: (signal?: NodeJS.Signals) => unknown } | null = null;
      const promise = runGpuProbe({
        command: [process.execPath, hang],
        timeoutMs: 900,
        onChild: (child) => {
          seen = child;
        },
      });
      await promise;
      expect(seen, 'runGpuProbe must hand the live child to its caller').not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('terminateProbeChild does not throw on a live or already-dead handle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-term-'));
    try {
      const hang = path.join(dir, 'hang.mjs');
      fs.writeFileSync(hang, `setTimeout(() => {}, 60000);\n`);
      let pid = 0;
      const promise = runGpuProbe({
        command: [process.execPath, hang],
        timeoutMs: 600,
        onChild: (child) => {
          pid = child.pid ?? 0;
        },
      });
      await promise;
      expect(pid).toBeGreaterThan(0);
      // The child may already be gone (the deadline reaped it); what matters is
      // that the terminator does not throw on a dead or live handle.
      expect(() => terminateProbeChild({ kill: () => true })).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('the engine downgrades the SHARED holder on an automatic GPU load failure', async () => {
    // Before the fix the downgrade only fired through an optional
    // onGpuLoadFailure hook that no production construction supplies, so the
    // holder kept saying "vulkan ok" while every load re-attempted the GPU.
    const models = stageModels();
    setActiveGpuVerdict(GPU_OK);
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      llamaFactory: async (opts) => {
        if (opts.backend === 'vulkan') throw new Error('stub: GPU load failed');
        return {
          async generate() {
            return { answer: 'cpu', cancelled: false };
          },
          async dispose() {
            return undefined;
          },
        } as LlamaEngineBackend;
      },
    });
    await engine.query('q');
    expect(activeGpuVerdict()?.backend, 'a failed automatic GPU load must downgrade the shared holder').toBe('cpu');
    expect(activeGpuVerdict()?.ok).toBe(false);
    fs.rmSync(models.dir, { recursive: true, force: true });
  });
});


// ---------------------------------------------------------------------------
// Round 2 review: these three exist because the round-2 mutation run proved the
// earlier claims FALSE. Re-introducing each bug leaves the WHOLE suite green,
// which means a test that passes both before and after proves nothing.
// ---------------------------------------------------------------------------

describe('issue #155 Round 2: the fixes that had no guard now have one', () => {
  it('F1 - the host resolves the probe model from a seam the engine really has', async () => {
    // The round-1 test only constructed an LlamaEngine and read modelStatus(),
    // which was ALREADY true before the fix, so it passed with the bug back in
    // place. This one drives the host's own probeModelPath through a real
    // NodeBackendHost, so the F1 mutation (reading a non-existent `models`
    // property off config.engine) actually changes the result.
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const models = stageModels();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-f1-'));
    try {
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
      });
      const host = new NodeBackendHost({
        engine,
        token: 't',
        storePath: path.join(dir, 'profiles', 'default', 'store.sqlite'),
      } as never);
      const resolved = (host as unknown as { probeModelPath: () => string | null }).probeModelPath();
      expect(
        resolved,
        'the host must resolve the fast model path through modelStatus; with the F1 bug it returns null and the probe skips itself forever',
      ).toBe(models.fast);
    } finally {
      fs.rmSync(models.dir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('F5 - a verdict that changes DURING a load forces the next query to reload', async () => {
    // With the F5 bug the identity is recomputed from live state AFTER the
    // load, so the key matches and the stale resident is reused forever while
    // the status reports something else.
    const models = stageModels();
    const loads: string[] = [];
    let flip = false;
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdict: () => (flip ? GPU_OK : CPU_FAIL),
      llamaFactory: async (opts) => {
        loads.push(opts.backend);
        // Flip the verdict while this load is in flight - exactly the race the
        // Phase 3 critic said was safe and the round-2 review proved was not.
        flip = true;
        return {
          async generate() {
            return { answer: 'ok', cancelled: false };
          },
          async dispose() {
            return undefined;
          },
        } as LlamaEngineBackend;
      },
    });
    await engine.query('q1');
    expect(loads).toEqual(['cpu']);
    await engine.query('q2');
    expect(
      loads,
      'the verdict changed mid-load, so the resident must be rebuilt rather than reused',
    ).toEqual(['cpu', 'vulkan']);
    fs.rmSync(models.dir, { recursive: true, force: true });
  });

  it('F7 - the host adopts a persisted verdict at start and skips the boot re-probe', async () => {
    // With the F7 bug the stored verdict is read into a field nothing consults
    // and an unconditional boot probe clobbers it, so this fails.
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const { GPU_PROBE_SIDECAR: NAME } = await import('../../main/backend/inference/gpu-probe.js');
    const models = stageModels();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-f7-'));
    try {
      fs.mkdirSync(path.join(dir, 'profiles', 'default'), { recursive: true });
      const store = path.join(dir, 'profiles', 'default', 'store.sqlite');
      fs.writeFileSync(path.join(dir, 'profiles', 'default', NAME), JSON.stringify(GPU_OK), 'utf8');
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
      });
      const host = new NodeBackendHost({ engine, token: 't', storePath: store } as never);
      // Drive the store-gated adoption block the way start() does.
      await (host as unknown as { start: () => Promise<void> }).start().catch(() => undefined);
      const adopted = activeGpuVerdict();
      expect(adopted, 'a persisted verdict must be adopted, not discarded').not.toBeNull();
      expect(adopted?.backend).toBe('vulkan');
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
    } finally {
      fs.rmSync(models.dir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      setActiveGpuVerdict(null);
    }
  }, 30000);

  it('shutdown never overwrites the stored verdict with the kill verdict', async () => {
    // The previous version of this test was un-failable: it never armed
    // gpuProbeDir (assigned only in start()), so the sidecar never existed, the
    // assertion sat behind `if (fs.existsSync(...))`, and removing the D1 fix
    // entirely left all 111 test files green. This one pre-seeds a SENTINEL
    // verdict so the write path is armed, asserts UNCONDITIONALLY, and injects a
    // spawn so the kill verdict is producible under vitest.
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const { GPU_PROBE_SIDECAR: NAME } = await import('../../main/backend/inference/gpu-probe.js');
    const models = stageModels();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-quit2-'));
    try {
      const profileDir = path.join(dir, 'profiles', 'default');
      fs.mkdirSync(profileDir, { recursive: true });
      const sentinel = { backend: 'vulkan', ok: true, reason: 'SENTINEL-PREEXISTING', device: 'd' };
      fs.writeFileSync(path.join(profileDir, NAME), JSON.stringify(sentinel), 'utf8');

      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
      });
      const host = new NodeBackendHost({ engine, token: 't', storePath: path.join(profileDir, 'store.sqlite') } as never);
      // Arm the host so gpuProbeDir is set, then take ownership of the probe so
      // it runs against a child we control and a deadline we control.
      await (host as unknown as { start: () => Promise<void> }).start().catch(() => undefined);
      const h = host as unknown as {
        startGpuProbe: () => Promise<GpuProbeVerdict>;
        stop: () => Promise<void>;
      };
      // Inject the RUNNER, not startGpuProbe: the real startGpuProbe logic
      // (registration, abandonment, pruning) is what is under test.
      (host as unknown as { probeRun: unknown }).probeRun = (opts: {
        args?: string[];
        onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
        onSettled?: () => void;
        timeoutMs?: number;
      }) => runGpuProbe({ ...opts, command: [process.execPath, '-e', 'setTimeout(()=>{},60000)'] });
      const inFlight = h.startGpuProbe();
      const stopped = h.stop();
      await Promise.allSettled([inFlight, stopped]);
      await new Promise((r) => setTimeout(r, 150));

      const written = JSON.parse(fs.readFileSync(path.join(profileDir, NAME), 'utf8')) as { reason?: string; backend?: string };
      expect(
        String(written.reason ?? ''),
        'a verdict produced by our own shutdown kill must never overwrite the stored one',
      ).not.toContain('SIGTERM');
      expect(written.reason).toBe('SENTINEL-PREEXISTING');
      setActiveGpuVerdict(null);
    } finally {
      fs.rmSync(models.dir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('F7-skip - an adopted persisted verdict means the boot probe never spawns', async () => {
    // The adoption half and the SKIP half are independent. Removing only the
    // `if (this.gpuVerdict === null)` gate re-arms the clobber the whole F7 fix
    // exists to stop, so the skip itself needs its own guard.
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const { GPU_PROBE_SIDECAR: NAME } = await import('../../main/backend/inference/gpu-probe.js');
    const models = stageModels();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-skip-'));
    try {
      const profileDir = path.join(dir, 'profiles', 'default');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, NAME),
        JSON.stringify({ backend: 'vulkan', ok: true, reason: 'PRE-EXISTING', device: 'd' }),
        'utf8',
      );
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
      });
      const host = new NodeBackendHost({ engine, token: 't', storePath: path.join(profileDir, 'store.sqlite') } as never);
      let spawns = 0;
      (host as unknown as { startGpuProbe: () => Promise<GpuProbeVerdict> }).startGpuProbe = async () => {
        spawns += 1;
        return { backend: 'cpu', ok: false, reason: 'should not have run', device: null };
      };
      await (host as unknown as { start: () => Promise<void> }).start().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      expect(spawns, 'a persisted verdict must be reused, not re-probed at every boot').toBe(0);
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
      setActiveGpuVerdict(null);
    } finally {
      fs.rmSync(models.dir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('the in-flight child set is empty once probes settle', async () => {
    // The Set tracks IN-FLIGHT children. Leaving settled handles behind grows it
    // monotonically for the host's lifetime, and a stale handle would let a
    // later stop() arm the abandonment flag off a dead probe.
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const models = stageModels();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-set-'));
    try {
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
      });
      const host = new NodeBackendHost({
        engine,
        token: 't',
        storePath: path.join(dir, 'profiles', 'default', 'store.sqlite'),
      } as never);
      const h = host as unknown as {
        startGpuProbe: () => Promise<GpuProbeVerdict>;
        probeChildren: Set<unknown>;
        stop: () => Promise<void>;
      };
      (host as unknown as { probeRun: unknown }).probeRun = (opts: {
        args?: string[];
        onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
        onSettled?: () => void;
        timeoutMs?: number;
      }) => runGpuProbe({ ...opts, command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ok:true,backend:"vulkan",sample:"OK"}))'] });
      await h.startGpuProbe();
      await h.startGpuProbe();
      expect(
        h.probeChildren.size,
        'settled probes must drop their child handle, or the set grows for the host lifetime',
      ).toBe(0);
      await h.stop().catch(() => undefined);
      setActiveGpuVerdict(null);
    } finally {
      fs.rmSync(models.dir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Scenario tests. Every prior review round re-verified the DIFF; none walked
// the timeline. These two walk it: a first run where models are staged after
// the host starts (the exact scenario issue #155 names), and two probes in
// flight when the host shuts down.
// ---------------------------------------------------------------------------

describe('issue #155 scenarios: the timeline, not the diff', () => {
  it('first run — no model staged yet must NOT write a verdict that pins the machine to CPU', async () => {
    // The host starts BEFORE models are staged (wizard/download come later).
    // With the defect, that produced a synthesised "no probe model" verdict,
    // which was persisted; and because a persisted verdict suppresses the next
    // boot's probe, a perfectly capable GPU stayed on CPU forever.
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const { GPU_PROBE_SIDECAR: NAME } = await import('../../main/backend/inference/gpu-probe.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-firstrun-'));
    try {
      const profileDir = path.join(dir, 'profiles', 'default');
      fs.mkdirSync(profileDir, { recursive: true });
      // NO models staged: engine.modelStatus().models.fast.path is absent.
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: path.join(profileDir, 'missing-q.gguf'), fast: path.join(profileDir, 'missing-f.gguf') },
      });
      const host = new NodeBackendHost({ engine, token: 't', storePath: path.join(profileDir, 'store.sqlite') } as never);
      let spawns = 0;
      (host as unknown as { probeRun: unknown }).probeRun = () => {
        spawns += 1;
        return Promise.resolve({ backend: 'vulkan', ok: true, reason: 'should not run yet', device: 'd' });
      };
      await (host as unknown as { start: () => Promise<void> }).start().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 150));

      const sidecar = path.join(profileDir, NAME);
      expect(
        fs.existsSync(sidecar),
        'a verdict produced WITHOUT running a probe must never be persisted, or it suppresses the next boot probe forever',
      ).toBe(false);
      expect(spawns).toBe(0);
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
      setActiveGpuVerdict(null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('first run — once models exist, the NEXT boot probes and persists a real verdict', async () => {
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const { GPU_PROBE_SIDECAR: NAME } = await import('../../main/backend/inference/gpu-probe.js');
    const models = stageModels();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-firstrun2-'));
    try {
      const profileDir = path.join(dir, 'profiles', 'default');
      fs.mkdirSync(profileDir, { recursive: true });
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
      });
      const host = new NodeBackendHost({ engine, token: 't', storePath: path.join(profileDir, 'store.sqlite') } as never);
      let spawns = 0;
      (host as unknown as { probeRun: unknown }).probeRun = (opts: {
        onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
        onSettled?: () => void;
      }) => {
        spawns += 1;
        opts.onChild?.({ kill: () => true });
        opts.onSettled?.();
        return Promise.resolve({ backend: 'vulkan', ok: true, reason: 'real verdict', device: 'Arc Pro B50' });
      };
      await (host as unknown as { start: () => Promise<void> }).start().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 150));
      expect(spawns, 'with a model staged the boot probe must actually run').toBe(1);
      const written = JSON.parse(fs.readFileSync(path.join(profileDir, NAME), 'utf8')) as { reason?: string; device?: string };
      expect(written.reason).toBe('real verdict');
      expect(written.device).toBe('Arc Pro B50');
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
      setActiveGpuVerdict(null);
    } finally {
      fs.rmSync(models.dir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('shutdown — with TWO probes in flight, neither kill verdict is persisted', async () => {
    // The abandonment record was a single host-global latch consumed by whichever
    // probe settled first, so the second adopted and persisted a SIGTERM verdict
    // anyway — the same defect one probe had.
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const { GPU_PROBE_SIDECAR: NAME } = await import('../../main/backend/inference/gpu-probe.js');
    const models = stageModels();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't155-two-'));
    try {
      const profileDir = path.join(dir, 'profiles', 'default');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, NAME),
        JSON.stringify({ backend: 'vulkan', ok: true, reason: 'SENTINEL', device: 'd' }),
        'utf8',
      );
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
      });
      const host = new NodeBackendHost({ engine, token: 't', storePath: path.join(profileDir, 'store.sqlite') } as never);
      await (host as unknown as { start: () => Promise<void> }).start().catch(() => undefined);
      const h = host as unknown as {
        startGpuProbe: () => Promise<GpuProbeVerdict>;
        stop: () => Promise<void>;
      };
      (host as unknown as { probeRun: unknown }).probeRun = (opts: {
        onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
        onSettled?: () => void;
      }) => runGpuProbe({ ...opts, command: [process.execPath, '-e', 'setTimeout(()=>{},60000)'] });
      const both = Promise.allSettled([h.startGpuProbe(), h.startGpuProbe()]);
      await new Promise((r) => setTimeout(r, 120));
      await h.stop();
      await both;
      await new Promise((r) => setTimeout(r, 150));
      const written = JSON.parse(fs.readFileSync(path.join(profileDir, NAME), 'utf8')) as { reason?: string };
      expect(String(written.reason ?? '')).not.toContain('SIGTERM');
      expect(written.reason).toBe('SENTINEL');
      setActiveGpuVerdict(null);
    } finally {
      fs.rmSync(models.dir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
