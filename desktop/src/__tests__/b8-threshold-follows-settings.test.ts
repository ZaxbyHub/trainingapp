// b8-threshold-follows-settings.test.ts — issue #280 (C4 / check C18): the
// memory-pressure threshold follows an accepted inference.profileThresholdGb
// settings change through the host seam, with the env override still
// authoritative.
//
// RED at base, GREEN after the fix: at the base revision the pressure
// threshold was a construction-time constant — a settings PUT that moved
// inference.profileThresholdGb changed the ENGINE's profile selection
// boundary but left the monitor judging free RAM against the stale
// threshold, so the two knobs the budget.ts cross-reference declares "the
// SAME threshold by construction" drifted apart until the next restart.
// After the fix createPressureMonitor exposes setThreshold(gb), the server
// gains an optional onSettingsApplied observer (invoked after
// commitSettingsChange returns ok, before the response), and the host wires
// it — plus the first-run wizard's applyEngineSettings seam — to
// monitor.setThreshold, gated on the env override being unset.
//
// Legs: (a) the monitor directly (the verdict flip + validation), (b) the
// server seam in isolation, (c) the full host wiring through PUT /settings,
// (d) the applyEngineSettings parity seam, (e) the env-override refusal.
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server.js';
import { createLoopbackGuard } from '../../main/security/loopback-guard.js';
import { StubEngine } from '../../main/backend/engine.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import { NodeBackendHost } from '../../main/backend/index.js';
import { createPressureMonitor, type PressureMonitor } from '../../main/backend/memory/budget.js';
import { saveSettingsSnapshot } from '../../main/backend/settings-store.js';

const GIB = 1024 ** 3;
const TOKEN = 'b8-threshold-follows-settings-token';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function stageModels(): { quality: string; fast: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-threshold-'));
  tmpDirs.push(dir);
  const quality = path.join(dir, 'q.gguf');
  const fast = path.join(dir, 'f.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return { quality, fast };
}

/** A quiet CI-safe local engine that ACCEPTS inference.* settings patches. */
function makeLlamaEngine(): LlamaEngine {
  return new LlamaEngine({
    profile: 'fast',
    freeMemBytes: () => 8 * GIB,
    cpuCount: () => 8,
    vulkan: false,
    models: stageModels(),
    llamaFactory: async () => ({
      generate: async () => ({ answer: 'unused', cancelled: false }),
      dispose: async () => {},
    }),
  });
}

describe('C18 leg a: createPressureMonitor.setThreshold flips the verdict at the new boundary', () => {
  it('sustained 5 GiB free latches pressure at threshold 6; setThreshold(4) + recovery + host ack flips it to no-pressure', () => {
    let clock = 0;
    const monitor = createPressureMonitor({
      pressureThresholdGb: 6,
      pressureSustainedMs: 1000,
      recoverySustainedMs: 1000,
      nowMs: () => clock,
    });

    // Phase A: 5 GiB free is below the 6 GiB threshold -> sustained pressure.
    monitor.observe(5 * GIB, clock);
    clock = 1001;
    const pressured = monitor.evaluate();
    expect(pressured.downgraded, '5 GiB free under a 6 GiB threshold is sustained pressure').toBe(true);
    expect(pressured.effectiveProfile).toBe('fast');

    // Phase B: the settings change moves the threshold BELOW the free RAM.
    monitor.setThreshold(4);
    monitor.observe(5 * GIB, clock); // now above the 4 GiB boundary: recovery window starts
    clock += 1001;
    const recovered = monitor.evaluate();
    expect(recovered.recoveryEligible, 'the same 5 GiB is above the NEW boundary: recovery matures').toBe(true);
    // The host acknowledges (its upgrade predicate) and the verdict flips.
    monitor.resetAfterUpgrade();
    expect(monitor.evaluate()).toMatchObject({ downgraded: false, effectiveProfile: 'quality' });
  });

  it('setThreshold below the sustained window PREVENTS the latch entirely (a broken streak never matures)', () => {
    let clock = 0;
    const monitor = createPressureMonitor({
      pressureThresholdGb: 6,
      pressureSustainedMs: 1000,
      nowMs: () => clock,
    });
    monitor.observe(5 * GIB, clock); // pressure streak starts at threshold 6
    monitor.setThreshold(4);
    monitor.observe(5 * GIB, 500); // above the new boundary: the streak breaks
    expect(monitor.evaluate(5000), 'no pressure streak survives the threshold move, so nothing latches').toMatchObject({
      downgraded: false,
      effectiveProfile: 'quality',
    });
  });

  it('setThreshold validates like the settings gate: non-positive / non-finite values leave the threshold unchanged', () => {
    let clock = 0;
    const monitor = createPressureMonitor({
      pressureThresholdGb: 6,
      pressureSustainedMs: 1000,
      nowMs: () => clock,
    });
    for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) monitor.setThreshold(junk);
    monitor.observe(5 * GIB, clock); // still below the ORIGINAL 6 GiB threshold
    expect(monitor.evaluate(1001).downgraded, 'junk thresholds never moved the 6 GiB boundary').toBe(true);
  });
});

describe('C18 leg b: the server seam — onSettingsApplied fires after the commit', () => {
  it('a PATCH the engine accepted invokes the observer with the ORIGINAL patch object', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine: makeLlamaEngine(),
      onSettingsApplied: (patch) => observed.push(patch),
    });
    const port = await listenOnRandomPort(server);
    try {
      const patch = { 'inference.profileThresholdGb': 4 };
      const res = await fetch(`http://127.0.0.1:${port}/settings`, {
        method: 'PUT',
        headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(200);
      expect(observed).toEqual([patch]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a REJECTED patch never invokes the observer; a reset-shaped payload does', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine: new StubEngine(),
      onSettingsApplied: (patch) => observed.push(patch),
    });
    const port = await listenOnRandomPort(server);
    const put = async (body: unknown): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/settings`, {
        method: 'PUT',
        headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.status;
    };
    try {
      expect(await put({ totally_unknown_key: 1 })).toBe(422);
      expect(observed).toEqual([]);
      const reset = { reset: ['rag_n_results'] };
      expect(await put(reset)).toBe(200);
      expect(observed).toEqual([reset]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('C18 legs c-e: the host wiring (PUT /settings -> monitor.setThreshold; env precedence; wizard parity)', () => {
  const stoppedHosts: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const stop of stoppedHosts.splice(0)) await stop().catch(() => undefined);
    for (const dir of tmpDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  /** Storeless host with the telemetry ticker stretched to infinity (no ambient samples race the synthetic clock). */
  async function startHost(env: Record<string, string | undefined>): Promise<{
    host: NodeBackendHost;
    handle: { port: number; url: string };
    monitor: PressureMonitor;
    stop: () => Promise<void>;
  }> {
    const host = new NodeBackendHost({
      token: TOKEN,
      tokenHeaderName: 'X-Desktop-Token',
      engine: makeLlamaEngine(),
      env: { TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS: '3600000', ...env },
    });
    // Boot-admission isolation: the storeless boot flight would resolve a
    // session-scoped verdict only after touching the model dir; pin it to an
    // immediate CPU verdict instead (the gpu-test-coordination probeRun
    // override idiom — no child process, no native code).
    (host as unknown as { probeRun: unknown }).probeRun = () =>
      Promise.resolve({ backend: 'cpu', ok: false, reason: 'spec stub verdict', device: null });
    const handle = (await host.start()) as unknown as { port: number; url: string };
    const monitor = (host as unknown as { monitor: PressureMonitor | null }).monitor;
    expect(monitor).not.toBeNull();
    const stop = async (): Promise<void> => {
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
    };
    stoppedHosts.push(stop);
    return { host, handle, monitor: monitor!, stop };
  }

  it('leg c: an accepted PUT moves the host monitor threshold (spy + behavioral flip)', async () => {
    const { handle, monitor } = await startHost({});
    const spy = vi.spyOn(monitor, 'setThreshold');
    const res = await fetch(`${handle.url}/settings`, {
      method: 'PUT',
      headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ 'inference.profileThresholdGb': 4 }),
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(4);
    // Behavioral: 5 GiB free — pressure under the default 6 GiB threshold,
    // above the settings-moved 4 GiB boundary.
    monitor.observe(5 * GIB, 0);
    expect(monitor.evaluate(10_001).downgraded, '5 GiB is above the moved threshold: no pressure latches').toBe(false);
    spy.mockRestore();
  });

  it('leg d: the first-run wizard seam (applyEngineSettings) moves the monitor the same way', async () => {
    const { host, monitor } = await startHost({});
    const spy = vi.spyOn(monitor, 'setThreshold');
    const apply = host.applyEngineSettings;
    expect(apply).toBeTypeOf('function');
    const result = apply!({ 'inference.profileThresholdGb': 3.5 });
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(3.5);
    // A FAILED wizard patch must not move the threshold.
    spy.mockClear();
    const rejected = apply!({ 'inference.profileThresholdGb': 0 });
    expect(rejected.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('leg e: TRAININGAPP_MEMORY_PRESSURE_THRESHOLD_GB set -> the host seam never calls setThreshold (env precedence)', async () => {
    const { handle, monitor } = await startHost({ TRAININGAPP_MEMORY_PRESSURE_THRESHOLD_GB: '8' });
    const spy = vi.spyOn(monitor, 'setThreshold');
    const res = await fetch(`${handle.url}/settings`, {
      method: 'PUT',
      headers: { 'x-desktop-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ 'inference.profileThresholdGb': 4 }),
    });
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    // The monitor keeps the env-configured 8 GiB boundary: 5 GiB is pressure.
    monitor.observe(5 * GIB, 0);
    expect(monitor.evaluate(10_001).downgraded, 'the env-pinned 8 GiB threshold still governs').toBe(true);
    spy.mockRestore();
  });

  it('leg f: the boot replay of a persisted inference.profileThresholdGb moves the monitor before any PUT', async () => {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b8-threshold-boot-')), 'store.sqlite');
    tmpDirs.push(path.dirname(storePath));
    saveSettingsSnapshot(storePath, { 'inference.profileThresholdGb': 4 });
    const host = new NodeBackendHost({
      token: TOKEN,
      tokenHeaderName: 'X-Desktop-Token',
      engine: makeLlamaEngine(),
      storePath,
      env: { TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS: '3600000' },
    });
    (host as unknown as { probeRun: unknown }).probeRun = () =>
      Promise.resolve({ backend: 'cpu', ok: false, reason: 'spec stub verdict', device: null });
    const handle = (await host.start()) as unknown as { port: number; url: string };
    stoppedHosts.push(async () => {
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
    });
    const monitor = (host as unknown as { monitor: PressureMonitor | null }).monitor;
    expect(monitor).not.toBeNull();
    // Behavioral: 5 GiB free is above the persisted 4 GiB boundary (no
    // pressure) but below the 6 GiB default the boot would otherwise keep.
    monitor!.observe(5 * GIB, 0);
    expect(
      monitor!.evaluate(10_001).downgraded,
      'the boot replay aligned the monitor with the persisted threshold',
    ).toBe(false);
  });
});
