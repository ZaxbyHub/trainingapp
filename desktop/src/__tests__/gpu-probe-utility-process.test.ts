// Issue #276 (Workstream G, unit G3b): the GPU probe runs as an Electron
// utilityProcess, not as the Electron binary under ELECTRON_RUN_AS_NODE (the
// packaged runAsNode fuse disables that). These legs pin the three halves of
// the migration that the t155 suite (node-fork legs) cannot see:
//   1. bootstrap() registers the utilityProcess launcher, and a probe without
//      an explicit launcher goes through electron's utilityProcess.fork with
//      the compiled child, no environment override, and a structured report
//      over the message channel;
//   2. the child, when it IS a utility process (process.parentPort present),
//      reports over parentPort.postMessage — including when argv carries no
//      script entry (the utility-process argv shape);
//   3. the packaged-smoke evidence leg records the transport observation and
//      the smoke's evaluator tells a REAL child report from the parent's
//      no-report / process-error fallback.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, utilityProcess, FakeUtilityProcess, __resetElectronStub } from 'electron';
import { bootstrap } from '../../main/index';
import { __resetTransportSecurityForTests } from '../../main/security/index';
import {
  GPU_PROBE_SMOKE_ENV,
  GPU_PROBE_SMOKE_RECORD,
  gpuProbeChildPath,
  resolveGpuProbeForkFn,
  runGpuDeviceQuery,
  runGpuProbeSmokeLeg,
  setGpuProbeForkFn,
  type GpuProbeRunOptions,
} from '../../main/backend/inference/gpu-probe.js';
// @ts-expect-error -- plain .mjs script without declarations (import-safe by contract)
import { evaluateGpuProbeSmokeRecord } from '../../scripts/packaged-smoke.mjs';

const forkMock = utilityProcess.fork as unknown as ReturnType<typeof vi.fn>;
const hermeticUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-utility-userdata-'));

async function waitFor<T>(fn: () => T | undefined | null | false, description: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null && value !== false) return value as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A utility child that posts `report` (when given) then exits `code`. */
function scriptedFork(report: Record<string, unknown> | undefined, code = 0) {
  return (modulePath: string, args?: string[], options?: Record<string, unknown>) => {
    const child = new FakeUtilityProcess(modulePath, args ?? [], options);
    setImmediate(() => {
      if (report !== undefined) child.emit('message', report);
      child.emit('exit', code);
    });
    return child;
  };
}

beforeEach(() => {
  __resetElectronStub();
  app.getPath.mockImplementation((name: string) => (name === 'userData' ? hermeticUserData : process.cwd()));
  __resetTransportSecurityForTests();
  setGpuProbeForkFn(null);
  delete process.env[GPU_PROBE_SMOKE_ENV];
});

afterEach(async () => {
  app.emit('will-quit');
  await new Promise((resolve) => setTimeout(resolve, 50));
  setGpuProbeForkFn(null);
  delete process.env[GPU_PROBE_SMOKE_ENV];
});

afterAll(() => {
  fs.rmSync(hermeticUserData, { recursive: true, force: true });
});

describe('bootstrap registers the utilityProcess launcher (issue #276 G3b)', () => {
  it('a probe without an explicit launcher forks the compiled child through electron utilityProcess and adopts its report', async () => {
    expect(resolveGpuProbeForkFn(true), 'nothing registered before bootstrap').toBeNull();
    bootstrap();
    await waitFor(() => resolveGpuProbeForkFn(true) !== null, 'launcher registration');

    forkMock.mockImplementation(scriptedFork({ ok: true, backend: 'vulkan', device: 'Arc Pro B50' }));
    forkMock.mockClear();
    const result = await runGpuDeviceQuery();
    expect(result).toEqual({ status: 'device', device: 'Arc Pro B50' });

    expect(forkMock).toHaveBeenCalledTimes(1);
    const [modulePath, args, options] = forkMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(modulePath).toBe(gpuProbeChildPath());
    expect(args).toEqual(['--device-only']);
    // The report rides parentPort: stdout is discarded, stderr piped for detail.
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    // No environment override at all — in particular no ELECTRON_RUN_AS_NODE.
    expect(options).not.toHaveProperty('env');
    expect(JSON.stringify(options)).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('a utility child that exits without posting a report is the parent fallback, not a device', async () => {
    bootstrap();
    await waitFor(() => resolveGpuProbeForkFn(true) !== null, 'launcher registration');
    forkMock.mockImplementation(scriptedFork(undefined, 0));
    await expect(runGpuDeviceQuery()).resolves.toEqual({ status: 'unknown' });
  });

  it('TRAININGAPP_SMOKE_GPU_PROBE=1 makes bootstrap record a real report + observed exit under userData', async () => {
    process.env[GPU_PROBE_SMOKE_ENV] = '1';
    // Only the smoke leg's device-only child answers; any other probe the
    // host starts gets the default fail-to-load child.
    forkMock.mockImplementation((modulePath: string, args?: string[], options?: Record<string, unknown>) =>
      (args ?? []).includes('--device-only')
        ? scriptedFork({ ok: false, backend: 'cpu', reason: 'no vulkan on this runner', device: null })(modulePath, args, options)
        : scriptedFork(undefined, 1)(modulePath, args, options),
    );
    bootstrap();
    const recordPath = path.join(hermeticUserData, GPU_PROBE_SMOKE_RECORD);
    const record = await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }, 'smoke record');
    expect(record.transport).toMatchObject({ reportReceived: true, exited: true, exitCode: 0 });
    expect(evaluateGpuProbeSmokeRecord(record).ok).toBe(true);
    fs.rmSync(recordPath, { force: true });
  });
});

describe('the probe child reports over process.parentPort inside a utility process (issue #276 G3b)', () => {
  const childSource = fileURLToPath(new URL('../../main/backend/inference/gpu-probe-child.ts', import.meta.url));
  const savedArgv = process.argv;

  afterEach(() => {
    process.argv = savedArgv;
    delete (process as unknown as { parentPort?: unknown }).parentPort;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function runChildAsUtility(argv: string[]): Promise<Record<string, unknown>> {
    const postMessage = vi.fn();
    (process as unknown as { parentPort?: unknown }).parentPort = { postMessage };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.argv = argv;
    vi.resetModules();
    await import('../../main/backend/inference/gpu-probe-child.ts');
    await waitFor(() => postMessage.mock.calls.length > 0, 'parentPort report');
    expect(postMessage, 'exactly one report').toHaveBeenCalledTimes(1);
    await waitFor(() => exitSpy.mock.calls.length > 0, 'child exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    return postMessage.mock.calls[0][0] as Record<string, unknown>;
  }

  it('argv with the script entry ([execPath, child, model]): the missing-model report goes to parentPort', async () => {
    const missing = path.join(os.tmpdir(), 'g3b-no-such-model.gguf');
    const report = await runChildAsUtility([process.execPath, childSource, missing]);
    expect(report).toMatchObject({ ok: false, backend: 'cpu' });
    expect(String(report.reason)).toContain('not staged');
    expect(String(report.reason)).toContain(missing);
  });

  it('argv WITHOUT a script entry ([execPath, model]): the model path is still the last argument', async () => {
    const missing = path.join(os.tmpdir(), 'g3b-no-such-model-2.gguf');
    const report = await runChildAsUtility([process.execPath, missing]);
    expect(String(report.reason)).toContain(missing);
  });
});

describe('packaged-smoke evidence: a REAL child report vs the parent fallback (issue #276 G3b)', () => {
  function forkReplying(report: unknown, code = 0): NonNullable<GpuProbeRunOptions['forkFn']> {
    return ((modulePath: string, args: string[]) =>
      scriptedFork(report as Record<string, unknown> | undefined, code)(modulePath, args)) as unknown as NonNullable<
      GpuProbeRunOptions['forkFn']
    >;
  }

  function leg(forkFn: NonNullable<GpuProbeRunOptions['forkFn']>): Promise<Record<string, unknown>> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-smoke-leg-'));
    return runGpuProbeSmokeLeg(dir, { forkFn }).then(() => {
      const record = JSON.parse(fs.readFileSync(path.join(dir, GPU_PROBE_SMOKE_RECORD), 'utf8')) as Record<string, unknown>;
      fs.rmSync(dir, { recursive: true, force: true });
      return record;
    });
  }

  it('a child report + exit 0 passes, on a GPU-less host too (the leg proves transport, not hardware)', async () => {
    const record = await leg(forkReplying({ ok: false, backend: 'cpu', reason: 'GPU probe: no usable GPU backend (x).', device: null }));
    expect(record.transport).toMatchObject({ reportReceived: true, exited: true, exitCode: 0 });
    expect(evaluateGpuProbeSmokeRecord(record)).toMatchObject({ ok: true });
  });

  it('a clean exit with NO report fails the smoke (the silent no-op the leg exists to catch)', async () => {
    const record = await leg(forkReplying(undefined, 0));
    expect(record.transport).toMatchObject({ reportReceived: false, exited: true, exitCode: 0 });
    const judged = evaluateGpuProbeSmokeRecord(record);
    expect(judged.ok).toBe(false);
    expect(judged.detail).toContain('no structured child report');
  });

  it('a launch failure fails the smoke (process-error fallback)', async () => {
    const throwing = (() => {
      throw new Error('utility process failed to launch');
    }) as unknown as NonNullable<GpuProbeRunOptions['forkFn']>;
    const record = await leg(throwing);
    expect(evaluateGpuProbeSmokeRecord(record).ok).toBe(false);
  });

  it('a non-zero exit fails the smoke even when a report arrived', async () => {
    const record = await leg(forkReplying({ ok: true, backend: 'vulkan', device: 'd' }, 134));
    const judged = evaluateGpuProbeSmokeRecord(record);
    expect(judged.ok).toBe(false);
    expect(judged.detail).toContain('exit');
  });

  it('a missing or malformed record fails the smoke', () => {
    expect(evaluateGpuProbeSmokeRecord(null).ok).toBe(false);
    expect(evaluateGpuProbeSmokeRecord({ error: 'boom' }).ok).toBe(false);
    expect(evaluateGpuProbeSmokeRecord({ verdict: {} }).ok).toBe(false);
  });
});
