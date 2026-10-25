// gpu-admission-recovery.test.ts — collated issues #246 + #247 (trace
// .agents/issue-traces/collated-246-247, approved plan B1/B2/B3/B7, rev 5).
//
// FROZEN ACCEPTANCE SURFACE, arm's-length authored against the plan's
// normative new-API contract BEFORE the implementation lands. Rows (the
// frozen drivers run `npm --prefix desktop test -- gpu-admission-recovery
// -t <row>`):
//   estimate-retry     (AC1) — class-aware estimate bypass retry through the
//                              PRODUCTION defaultLlamaFactory with a mocked
//                              node-llama-cpp (never the real native module).
//   probe-admission    (AC2) — the importable probe child's option builders
//                              carry the bypass; import is side-effect free.
//   verdict-persistence(AC3) — sidecar writes keyed by ORIGINAL failure
//                              class (estimate chains never persist; device
//                              preserved; write failure best-effort).
//   verdict-freshness  (AC4) — stale-aware reader fixtures, the REAL
//                              runGpuDeviceQuery parser over every report
//                              shape (host-kill -> CANCELLED), gate capture
//                              semantics, and the host boot-admission flight
//                              (mismatch re-probes; unknown fails open;
//                              CANCELLED adopts nothing).
//
// BINDING CONTRACT RESOLUTIONS (test-author decisions; both sides are bound):
//   R-A `defaultLlamaFactory` is IMPORTED directly (exported from
//       llama-engine.ts). Stage-precise failure injection and same-error
//       identity assertions are impossible through the engine wrapper (it
//       re-wraps into ModelNotConfiguredError), so the production factory is
//       driven directly for the construction/marking rows.
//   R-B runGpuDeviceQuery host-kill semantics: a child that dies BY SIGNAL
//       while the query is still unsettled resolves { status: 'cancelled' }.
//       The internal deadline SIGTERMs AND resolves the timeout-unknown
//       result in the same tick, so a signal-close reaching an unsettled
//       parser can only be an EXTERNAL (host stop) kill — the
//       abandonedChildren mechanism's observable signature.
//   R-C In entirely-estimate chains only the SIDECAR absence is pinned
//       (holder/hook treatment for those chains is not specified by the
//       plan and is deliberately not over-bound here).
//   R-D The host's boot-flight device leg is controllable for tests by
//       mocking ONLY `runGpuDeviceQuery` on the gpu-probe module (everything
//       else passes through to the real module, so holder/sidecar/gate state
//       is real). `probeRun` stays the injected full-probe seam (t155 idiom).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocked node-llama-cpp: NEVER the real native module. The estimate class is
// constructed FROM THIS MOCK (`new (await import('node-llama-cpp')).
// InsufficientMemoryError(...)`) so `err instanceof nlc.InsufficientMemoryError`
// in the production factory matches exactly the class it will see.
// ---------------------------------------------------------------------------
const nlc = vi.hoisted(() => {
  class InsufficientMemoryError extends Error {
    constructor(message: string) {
      super(message);
    }
  }
  const state = {
    getLlamaCalls: [] as Array<Record<string, unknown>>,
    loadModelCalls: [] as Array<Record<string, unknown>>,
    createContextCalls: [] as Array<Record<string, unknown>>,
    disposeOrder: [] as string[],
    getLlamaImpl: null as null | ((opts: Record<string, unknown>) => unknown),
    loadModelImpl: null as null | ((args: Record<string, unknown>, callIndex: number) => unknown),
    createContextImpl: null as null | ((args: Record<string, unknown>) => unknown),
  };
  return { InsufficientMemoryError, state };
});

vi.mock('node-llama-cpp', () => ({
  InsufficientMemoryError: nlc.InsufficientMemoryError,
  // Non-gemma metadata so resolveReasoningSuppressedWrapper returns undefined
  // (no chatWrapper pin) on every construction.
  readGgufFileInfo: async () => ({ metadata: { general: { architecture: 'lfm2', name: 'lfm2' } } }),
  Gemma4ChatWrapper: class {},
  LlamaChatSession: class {
    async prompt(): Promise<string> {
      return 'OK';
    }
    setChatHistory(): void {}
    resetChatHistory(): void {}
  },
  getLlama: async (opts: Record<string, unknown>) => {
    nlc.state.getLlamaCalls.push(opts);
    if (nlc.state.getLlamaImpl !== null) {
      const overridden = nlc.state.getLlamaImpl(opts);
      if (overridden !== undefined) return overridden;
    }
    return {
      gpu: 'vulkan',
      getGpuDeviceNames: async () => ['Arc Pro B50'],
      dispose: async () => {
        nlc.state.disposeOrder.push('llama');
      },
      loadModel: async (args: Record<string, unknown>) => {
        nlc.state.loadModelCalls.push(args);
        if (nlc.state.loadModelImpl !== null) {
          const overridden = nlc.state.loadModelImpl(args, nlc.state.loadModelCalls.length);
          if (overridden !== undefined) return overridden;
        }
        return {
          dispose: async () => {
            nlc.state.disposeOrder.push('model');
          },
          createContext: async (args: Record<string, unknown>) => {
            nlc.state.createContextCalls.push(args);
            if (nlc.state.createContextImpl !== null) {
              const overridden = nlc.state.createContextImpl(args);
              if (overridden !== undefined) return overridden;
            }
            return {
              dispose: async () => {
                nlc.state.disposeOrder.push('context');
              },
              getSequence: () => ({ id: 'seq' }),
            };
          },
        };
      },
    };
  },
}));

// ---------------------------------------------------------------------------
// gpu-probe: everything real EXCEPT runGpuDeviceQuery, which the host rows
// steer per test (resolution R-D). The REAL parser is reached via
// vi.importActual for the verdict-freshness parser rows.
// ---------------------------------------------------------------------------
const deviceQuery = vi.hoisted(() => ({
  impl: null as null | ((opts?: Record<string, unknown>) => Promise<{ status: 'device' | 'unknown' | 'cancelled'; device?: string }>),
  calls: [] as Array<Record<string, unknown> | undefined>,
}));
vi.mock('../../main/backend/inference/gpu-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/inference/gpu-probe.js')>();
  return {
    ...actual,
    runGpuDeviceQuery: (opts?: Record<string, unknown>) => {
      deviceQuery.calls.push(opts);
      if (deviceQuery.impl !== null) return deviceQuery.impl(opts);
      return (actual as unknown as { runGpuDeviceQuery?: unknown }).runGpuDeviceQuery?.(opts);
    },
  };
});

import {
  GPU_PROBE_SIDECAR,
  activeGpuVerdict,
  armGpuVerdictGate,
  gpuVerdictGate,
  readGpuProbeVerdict,
  resetGpuVerdictLifecycle,
  setActiveGpuVerdict,
  writeGpuProbeVerdict,
  type GpuProbeRunOptions,
  type GpuProbeVerdict,
} from '../../main/backend/inference/gpu-probe.js';
import {
  LlamaEngine,
  defaultLlamaFactory,
  type LlamaEngineBackend,
  type LlamaEngineFactoryOptions,
} from '../../main/backend/inference/llama-engine.js';
import { NodeBackendHost } from '../../main/backend/index.js';

const GB = 1024 ** 3;
const GPU_OK: GpuProbeVerdict = { backend: 'vulkan', ok: true, reason: 'stub probe: gpu usable', device: 'Arc Pro B50' };

/** Factory-option shape the fix adds (contract); cast because the production
 *  type does not carry the new fields until the implementation lands. */
type FactoryOpts = LlamaEngineFactoryOptions & {
  ignoreMemorySafetyChecks?: boolean;
  onGpuDevice?: (device: string | null) => void;
};
const productionFactory = defaultLlamaFactory as unknown as (opts: FactoryOpts) => Promise<LlamaEngineBackend>;

function stageModels(): { quality: string; fast: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-admission-models-'));
  const quality = path.join(dir, 'quality.gguf');
  const fast = path.join(dir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast, dir };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * RIG ISOLATION (PRR-001-corrected): rerank OFF + the deterministic HASH
 * embedder — the pattern 11 other desktop specs use. The first draft set an
 * EMPTY TRAININGAPP_EMBEDDING_MODEL_DIR believing resolveEmbedder degrades to
 * null; the explicit dir is actually resolveEmbedder's FALLBACK model dir
 * (embedder.ts), so on CI (LFS-pointer weights) the host bound a real
 * OnnxEmbedder to the empty dir and store-backed queries died on a missing
 * tokenizer.json — deterministic, machine-state-dependent, not timing.
 */
function rigEnv(): { TRAININGAPP_RETRIEVAL_RERANK: string; TRAININGAPP_DESKTOP_EMBEDDER: string } {
  // 4.5-review PRR-001: the hash embedder (the 11-other-specs pattern) is the
  // isolation that actually works. An EMPTY TRAININGAPP_EMBEDDING_MODEL_DIR is
  // NOT a disable — resolveEmbedder treats an explicit dir as its fallback
  // (embedder.ts), so on CI (LFS-pointer weights) the host bound a real
  // OnnxEmbedder to the empty dir and every store-backed query died on a
  // missing tokenizer.json. Deterministic, not timing.
  return { TRAININGAPP_RETRIEVAL_RERANK: 'false', TRAININGAPP_DESKTOP_EMBEDDER: 'hash' };
}

/** A spawn stand-in whose child answers a canned report on stdout. */
function fakeSpawn(reply?: string, exitCode = 0) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawnFn = ((file: string, args: string[], _opts: unknown) => {
    calls.push({ file, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter | null;
      stderr: EventEmitter | null;
      kill: (signal?: string) => boolean;
      killed: boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = (signal?: string) => {
      child.killed = true;
      // An external kill: the child dies by signal (resolution R-B).
      queueMicrotask(() => child.emit('close', null, signal ?? 'SIGTERM'));
      return true;
    };
    setImmediate(() => {
      if (reply !== undefined) child.stdout?.emit('data', Buffer.from(reply));
      child.emit('close', exitCode, null);
    });
    return child;
  }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
  return { calls, spawnFn };
}

async function until(cond: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for: ${what}`);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  setActiveGpuVerdict(null);
  // Drain any still-armed module gate (armed + immediately settled is the
  // safe idle state: no later default-awaiter engine in this file blocks).
  armGpuVerdictGate().resolve();
  deviceQuery.impl = null;
  deviceQuery.calls.length = 0;
  nlc.state.getLlamaCalls.length = 0;
  nlc.state.loadModelCalls.length = 0;
  nlc.state.createContextCalls.length = 0;
  nlc.state.disposeOrder.length = 0;
  nlc.state.getLlamaImpl = null;
  nlc.state.loadModelImpl = null;
  nlc.state.createContextImpl = null;
  vi.restoreAllMocks();
});

describe('estimate-retry (AC1: only an InsufficientMemoryError estimate earns exactly one bypass retry)', () => {
  it('the production factory marks a real mocked-library InsufficientMemoryError and rethrows the SAME object', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const thrown = new (await import('node-llama-cpp')).InsufficientMemoryError('the estimate says the model does not fit');
    nlc.state.loadModelImpl = () => {
      throw thrown;
    };
    const opts: FactoryOpts = { modelPath: models.fast, threads: 2, backend: 'vulkan', gpuLayers: 'max', profile: 'fast' };
    await expect(productionFactory(opts)).rejects.toBe(thrown);
    // The engine-owned estimate marker rides the SAME error object (the
    // installed class never assigns this.name; the engine reads the marker,
    // never a name).
    expect((thrown as Error & { gpuAdmissionEstimate?: boolean }).gpuAdmissionEstimate).toBe(true);
  });

  it('a plain error is rethrown unmarked and undisposed-of-estimate', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const thrown = new Error('driver fault, not an estimate');
    nlc.state.loadModelImpl = () => {
      throw thrown;
    };
    const opts: FactoryOpts = { modelPath: models.fast, threads: 2, backend: 'vulkan', gpuLayers: 'max', profile: 'fast' };
    await expect(productionFactory(opts)).rejects.toBe(thrown);
    expect((thrown as Error & { gpuAdmissionEstimate?: boolean }).gpuAdmissionEstimate).toBeUndefined();
  });

  it('exactly one bypass retry, flag on BOTH loadModel and createContext, never on the first attempt (loadModel-thrown estimate)', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.loadModelImpl = (_args, callIndex) => {
      if (callIndex === 1) {
        throw new (requireNlc().InsufficientMemoryError)('estimate: not enough VRAM');
      }
      return undefined; // bypass attempt succeeds
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
    });
    const result = await engine.query('q');
    expect(result.answer).toBe('OK');
    expect(nlc.state.loadModelCalls, 'exactly two loadModel calls: attempt + ONE bypass retry').toHaveLength(2);
    expect(nlc.state.loadModelCalls[0]?.ignoreMemorySafetyChecks, 'the first attempt never bypasses').toBeUndefined();
    expect(nlc.state.loadModelCalls[1]?.ignoreMemorySafetyChecks, 'the estimate retry bypasses loadModel checks').toBe(true);
    expect(nlc.state.createContextCalls, 'the successful retry constructs one context').toHaveLength(1);
    expect(nlc.state.createContextCalls[0]?.ignoreMemorySafetyChecks, 'the estimate retry bypasses createContext checks').toBe(true);
  });

  it('a createContext-thrown estimate also earns the single bypass on BOTH calls', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.createContextImpl = () => {
      if (nlc.state.createContextCalls.length === 1) {
        throw new (requireNlc().InsufficientMemoryError)('estimate: context will not fit');
      }
      return undefined;
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
    });
    await engine.query('q');
    expect(nlc.state.loadModelCalls).toHaveLength(2);
    expect(nlc.state.loadModelCalls[0]?.ignoreMemorySafetyChecks).toBeUndefined();
    expect(nlc.state.loadModelCalls[1]?.ignoreMemorySafetyChecks).toBe(true);
    expect(nlc.state.createContextCalls).toHaveLength(2);
    expect(nlc.state.createContextCalls[0]?.ignoreMemorySafetyChecks).toBeUndefined();
    expect(nlc.state.createContextCalls[1]?.ignoreMemorySafetyChecks).toBe(true);
  });

  it('bypass-retry success takes NO verdict action (no sidecar, no downgrade, no hook)', async () => {
    const models = stageModels();
    const verdictDir = tempDir('gpu-admission-noverdict-');
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(verdictDir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    const failures: GpuProbeVerdict[] = [];
    nlc.state.loadModelImpl = (_args, callIndex) => {
      if (callIndex === 1) throw new (requireNlc().InsufficientMemoryError)('estimate: tight');
      return undefined;
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdictDir: verdictDir,
      onGpuLoadFailure: (v) => failures.push(v),
    });
    await engine.query('q');
    expect(fs.existsSync(path.join(verdictDir, GPU_PROBE_SIDECAR)), 'bypass success must not persist anything').toBe(false);
    expect(activeGpuVerdict()?.backend, 'bypass success must not downgrade the holder').toBe('vulkan');
    expect(failures).toHaveLength(0);
  });

  it('a FORCED selection never bypasses: one attempt, no flag, error surfaces', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.loadModelImpl = () => {
      throw new (requireNlc().InsufficientMemoryError)('estimate: forced path');
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      vulkan: true,
    });
    await expect(engine.query('q')).rejects.toThrow(/does not fit|forced|load/i);
    expect(nlc.state.loadModelCalls, 'the forced path is unchanged: exactly one attempt').toHaveLength(1);
    for (const call of nlc.state.loadModelCalls) {
      expect(call.ignoreMemorySafetyChecks).toBeUndefined();
    }
    for (const call of nlc.state.createContextCalls) {
      expect(call.ignoreMemorySafetyChecks).toBeUndefined();
    }
  });

  it('the load-time CPU retry (non-estimate failure) never carries the bypass either', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.loadModelImpl = (_args, callIndex) => {
      if (callIndex === 1) throw new Error('plain GPU failure — not an estimate');
      return undefined;
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
    });
    await engine.query('q');
    // call 1: vulkan first attempt (no flag). call 2: the CPU retry — the
    // bypass belongs ONLY to the estimate-retry attempt, never here.
    expect(nlc.state.loadModelCalls).toHaveLength(2);
    expect(nlc.state.loadModelCalls[0]?.ignoreMemorySafetyChecks).toBeUndefined();
    expect(nlc.state.loadModelCalls[1]?.ignoreMemorySafetyChecks).toBeUndefined();
  });
});

/** Synchronous access to the mocked estimate class (the dynamic-import form is
 *  used where the plan's mocking rules demand it visibly). */
function requireNlc(): { InsufficientMemoryError: new (message: string) => Error } {
  // The vi.mock factory above is the ONLY node-llama-cpp in this file.
  return { InsufficientMemoryError: nlc.InsufficientMemoryError };
}

describe('probe-admission (AC2: the probe child loads with the memory-check bypass)', () => {
  const childSourcePath = fileURLToPath(
    new URL('../../main/backend/inference/gpu-probe-child.ts', import.meta.url),
  );

  it('exports the option seams and they carry ignoreMemorySafetyChecks: true', async () => {
    const child = await import('../../main/backend/inference/gpu-probe-child.js');
    const seam = child as unknown as {
      PROBE_LLAMA_OPTIONS?: Record<string, unknown>;
      probeModelLoadOptions?: (modelPath: string) => Record<string, unknown>;
      probeContextOptions?: () => Record<string, unknown>;
    };
    expect(typeof seam.PROBE_LLAMA_OPTIONS).toBe('object');
    expect(seam.PROBE_LLAMA_OPTIONS).toMatchObject({ build: 'never' });
    expect(
      ((seam.PROBE_LLAMA_OPTIONS?.gpu as Record<string, unknown> | undefined)?.exclude as unknown[] | undefined)?.includes('cuda'),
      'CUDA stays excluded (AC12): the installer does not ship it',
    ).toBe(true);

    expect(typeof seam.probeModelLoadOptions).toBe('function');
    expect(seam.probeModelLoadOptions?.('/models/fast/model.gguf')).toMatchObject({
      modelPath: '/models/fast/model.gguf',
      gpuLayers: 'max',
      ignoreMemorySafetyChecks: true,
    });

    expect(typeof seam.probeContextOptions).toBe('function');
    expect(seam.probeContextOptions?.()).toMatchObject({
      threads: 2,
      contextSize: 512,
      ignoreMemorySafetyChecks: true,
    });
  });

  it('importing the child module is side-effect free (main() runs only as process entry)', async () => {
    vi.resetModules();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await import('../../main/backend/inference/gpu-probe-child.js');
      expect(stdoutSpy, 'importing must not emit a report').not.toHaveBeenCalled();
      expect(exitSpy, 'importing must not exit').not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('the child source wires the exported builders into the real load path and handles --device-only', () => {
    // Sanctioned source pin (the plan's entry guard means main() cannot be
    // driven in-process): each builder must be REFERENCED beyond its
    // declaration, i.e. at a call site in the load path.
    const source = fs.readFileSync(childSourcePath, 'utf8');
    const countUses = (identifier: string): number =>
      source.split(new RegExp(`${identifier}\\s*\\(`, 'g')).length - 1;
    // declaration + >= 1 call site
    expect(countUses('probeModelLoadOptions'), 'loadModel must be fed by probeModelLoadOptions').toBeGreaterThanOrEqual(2);
    expect(countUses('probeContextOptions'), 'createContext must be fed by probeContextOptions').toBeGreaterThanOrEqual(2);
    expect(source).toContain('PROBE_LLAMA_OPTIONS');
    expect(source, 'the device-only leg is part of the child contract').toContain('--device-only');
  });
});

describe('verdict-persistence (AC3: persistence keyed by ORIGINAL failure class)', () => {
  const readRaw = (dir: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, GPU_PROBE_SIDECAR), 'utf8')) as Record<string, unknown>;

  it('estimate -> estimate -> CPU SUCCESS writes nothing (the estimate said nothing durable)', async () => {
    const models = stageModels();
    const verdictDir = tempDir('gpu-admission-est-est-ok-');
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(verdictDir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.loadModelImpl = (_args, callIndex) => {
      if (callIndex <= 2) throw new (requireNlc().InsufficientMemoryError)('estimate: does not fit');
      return undefined; // CPU retry succeeds
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdictDir: verdictDir,
    });
    const result = await engine.query('q');
    expect(result.answer).toBe('OK');
    expect(fs.existsSync(path.join(verdictDir, GPU_PROBE_SIDECAR))).toBe(false);
  });

  it('estimate -> estimate -> CPU FAILURE also writes nothing', async () => {
    const models = stageModels();
    const verdictDir = tempDir('gpu-admission-est-est-fail-');
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(verdictDir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.loadModelImpl = () => {
      const callIndex = nlc.state.loadModelCalls.length;
      if (callIndex <= 2) throw new (requireNlc().InsufficientMemoryError)('estimate: does not fit');
      throw new Error('cpu load also failed');
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdictDir: verdictDir,
    });
    await expect(engine.query('q')).rejects.toThrow(/cpu load also failed/);
    expect(fs.existsSync(path.join(verdictDir, GPU_PROBE_SIDECAR))).toBe(false);
  });

  it('non-estimate: session verdict published BEFORE the CPU retry, sidecar AFTER it settles (CPU success), device preserved', async () => {
    const models = stageModels();
    const verdictDir = tempDir('gpu-admission-none-ok-');
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(verdictDir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    const observed: Array<{ holderBackend: string | null; sidecarExists: boolean }> = [];
    nlc.state.loadModelImpl = (_args, callIndex) => {
      if (callIndex === 1) throw new Error('plain GPU failure');
      observed.push({
        holderBackend: activeGpuVerdict()?.backend ?? null,
        sidecarExists: fs.existsSync(path.join(verdictDir, GPU_PROBE_SIDECAR)),
      });
      return undefined;
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdictDir: verdictDir,
    });
    await engine.query('q');
    expect(observed, 'the CPU retry must actually run').toHaveLength(1);
    expect(observed[0]?.holderBackend, 'the session verdict is published BEFORE the CPU retry').toBe('cpu');
    expect(observed[0]?.sidecarExists, 'the sidecar is written only AFTER the retry settles').toBe(false);
    const written = readRaw(verdictDir);
    expect(written.backend).toBe('cpu');
    expect(written.ok).toBe(false);
    expect(written.device, 'the vulkan device captured at B2 is preserved across the retry').toBe('Arc Pro B50');
  });

  it('non-estimate: a FAILED CPU retry still writes the sidecar (device preserved)', async () => {
    const models = stageModels();
    const verdictDir = tempDir('gpu-admission-none-fail-');
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(verdictDir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.loadModelImpl = (_args, callIndex) => {
      if (callIndex === 1) throw new Error('plain GPU failure');
      throw new Error('cpu load failed too');
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdictDir: verdictDir,
    });
    await expect(engine.query('q')).rejects.toThrow(/cpu load failed too/);
    const written = readRaw(verdictDir);
    expect(written.backend).toBe('cpu');
    expect(written.device).toBe('Arc Pro B50');
  });

  it('device is null only when getLlama itself failed', async () => {
    const models = stageModels();
    const verdictDir = tempDir('gpu-admission-nogetllama-');
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(verdictDir, { recursive: true, force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.getLlamaImpl = (opts) => {
      const gpu = opts.gpu as Record<string, unknown> | boolean | undefined;
      const isVulkan = typeof gpu === 'object' && gpu !== null;
      if (isVulkan && nlc.state.getLlamaCalls.length === 1) throw new Error('getLlama exploded');
      return undefined;
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdictDir: verdictDir,
    });
    await engine.query('q');
    const written = readRaw(verdictDir);
    expect(written.device, 'no llama instance => no adapter identity => null device').toBeNull();
  });

  it('a failed sidecar write is best-effort: the in-memory downgrade survives', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    // A FILE where the sidecar directory should be: every write fails.
    const blockerDir = path.join(os.tmpdir(), `gpu-admission-blocker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(blockerDir, 'not a directory');
    cleanups.push(() => fs.rmSync(blockerDir, { force: true }));
    setActiveGpuVerdict(GPU_OK);
    nlc.state.loadModelImpl = (_args, callIndex) => {
      if (callIndex === 1) throw new Error('plain GPU failure');
      return undefined;
    };
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      gpuVerdictDir: blockerDir,
    });
    const result = await engine.query('q');
    expect(result.answer, 'the write failure must not lose the answer').toBe('OK');
    expect(activeGpuVerdict()?.backend, 'the write failure must not lose the in-memory downgrade').toBe('cpu');
  });
});

describe('verdict-freshness (AC4: stale readers, the device-query parser, boot admission)', () => {
  it('reader fixtures: no-device records and adapter mismatches read as never-probed', () => {
    const dir = tempDir('gpu-admission-reader-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeGpuProbeVerdict(dir, { backend: 'vulkan', ok: true, reason: 'r', device: 'gpu-a', measured: 12.5 });
    expect(readGpuProbeVerdict(dir)?.device).toBe('gpu-a');
    expect(readGpuProbeVerdict(dir, 'gpu-a'), 'matching adapter: adopt').not.toBeNull();
    expect(readGpuProbeVerdict(dir, 'gpu-b'), 'adapter mismatch: STALE').toBeNull();
    expect(readGpuProbeVerdict(dir, ''), 'an empty currentDevice carries no knowledge').not.toBeNull();
    expect(readGpuProbeVerdict(dir, null), 'a null currentDevice carries no knowledge').not.toBeNull();
    expect(readGpuProbeVerdict(dir)?.measured).toBe(12.5);
    // A no-device record cannot be bound to this machine's adapter.
    fs.writeFileSync(
      path.join(dir, GPU_PROBE_SIDECAR),
      JSON.stringify({ v: 1, backend: 'cpu', ok: false, reason: 'no device recorded', device: null }),
    );
    expect(readGpuProbeVerdict(dir), 'deviceless record: STALE (re-probe)').toBeNull();
    fs.writeFileSync(path.join(dir, GPU_PROBE_SIDECAR), JSON.stringify({ v: 1, backend: 'cpu', ok: false, reason: 'empty', device: '' }));
    expect(readGpuProbeVerdict(dir), 'empty-string device: STALE').toBeNull();
  });

  // The REAL parser (the module-level mock passes everything else through, so
  // importActual yields the true runGpuDeviceQuery).
  async function realDeviceQuery(opts: { spawnFn: NonNullable<GpuProbeRunOptions['spawnFn']>; timeoutMs?: number }): Promise<{ status: string; device?: string }> {
    const actual = await vi.importActual<typeof import('../../main/backend/inference/gpu-probe.js')>(
      '../../main/backend/inference/gpu-probe.js',
    );
    const run = (actual as unknown as { runGpuDeviceQuery: (o: Record<string, unknown>) => Promise<{ status: string; device?: string }> }).runGpuDeviceQuery;
    return run(opts);
  }

  it('REAL runGpuDeviceQuery parser: every report shape disposes to device | unknown', async () => {
    const deviceReport = JSON.stringify({ ok: true, device: 'Arc Pro B50', backend: 'vulkan' });
    await expect(realDeviceQuery({ spawnFn: fakeSpawn(deviceReport).spawnFn })).resolves.toEqual({
      status: 'device',
      device: 'Arc Pro B50',
    });
    // ok:false -> unknown (fail-open is the HOST's decision, not the parser's).
    await expect(realDeviceQuery({ spawnFn: fakeSpawn(JSON.stringify({ ok: false, reason: 'nope' })).spawnFn })).resolves.toEqual({ status: 'unknown' });
    // empty device -> unknown
    await expect(realDeviceQuery({ spawnFn: fakeSpawn(JSON.stringify({ ok: true, device: '', backend: 'vulkan' })).spawnFn })).resolves.toEqual({ status: 'unknown' });
    // non-vulkan backend -> unknown
    await expect(
      realDeviceQuery({ spawnFn: fakeSpawn(JSON.stringify({ ok: true, device: 'd', backend: 'cpu' })).spawnFn }),
    ).resolves.toEqual({ status: 'unknown' });
    // malformed stdout -> unknown
    await expect(realDeviceQuery({ spawnFn: fakeSpawn('not json at all').spawnFn })).resolves.toEqual({ status: 'unknown' });
    // native log noise before the report: the LAST non-empty line is the report
    await expect(
      realDeviceQuery({ spawnFn: fakeSpawn(`native noise\n${deviceReport}`).spawnFn }),
    ).resolves.toEqual({ status: 'device', device: 'Arc Pro B50' });
    // non-zero exit -> unknown
    await expect(realDeviceQuery({ spawnFn: fakeSpawn(deviceReport, 134).spawnFn })).resolves.toEqual({ status: 'unknown' });
    // spawn error -> unknown, never a throw
    const throwingSpawn = (() => {
      throw new Error('ENOENT');
    }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
    await expect(realDeviceQuery({ spawnFn: throwingSpawn })).resolves.toEqual({ status: 'unknown' });
    // deadline -> unknown (real timers, real escalation path)
    const hangSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter | null;
        stderr: EventEmitter | null;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      return child;
    }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
    await expect(realDeviceQuery({ spawnFn: hangSpawn, timeoutMs: 60 })).resolves.toEqual({ status: 'unknown' });
  }, 20_000);

  it('REAL runGpuDeviceQuery parser: a host-killed child resolves CANCELLED (resolution R-B)', async () => {
    let captured: { kill: (signal?: string) => boolean } | null = null;
    const spawnFn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter | null;
        stderr: EventEmitter | null;
        kill: (signal?: string) => boolean;
        killed: boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = (signal?: string) => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, signal ?? 'SIGTERM'));
        return true;
      };
      captured = child;
      return child;
    }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
    const pending = realDeviceQuery({
      spawnFn,
      timeoutMs: 60_000,
      onChild: (c) => {
        captured = c as { kill: (signal?: string) => boolean };
      },
    } as unknown as Parameters<typeof realDeviceQuery>[0]);
    await until(() => captured !== null, 2000, 'child registration');
    (captured as unknown as { kill: (s?: string) => boolean }).kill('SIGTERM');
    await expect(pending, 'host-kill must resolve the DISTINCT cancelled disposition, never fail-open').resolves.toEqual({
      status: 'cancelled',
    });
  }, 20_000);

  it('gate capture: a stale flight resolving its OWN object can never settle a newer generation (round-4 case)', async () => {
    resetGpuVerdictLifecycle();
    const gateA = armGpuVerdictGate();
    expect(gpuVerdictGate()).toBe(gateA.promise);
    resetGpuVerdictLifecycle(); // restart: fresh holder + fresh gate
    const gateBPromise = gpuVerdictGate();
    expect(gateBPromise).not.toBe(gateA.promise);
    let bSettled = false;
    void gateBPromise?.then(() => {
      bSettled = true;
    });
    gateA.resolve(); // the stale flight settles its own (already settled) object
    await new Promise((r) => setTimeout(r, 100));
    expect(bSettled, 'the NEW generation gate stays pending until its own validation finishes').toBe(false);
  });

  // ---- host boot-admission flight rows (probeRun injected, t155 idiom) ----
  interface HostRig {
    host: NodeBackendHost;
    engine: LlamaEngine;
    events: string[];
    probeCalls: number;
    profileDir: string;
    stop: () => Promise<void>;
  }

  async function startHostRig(opts: {
    storedVerdict?: GpuProbeVerdict | null;
    deviceQueryResult: { status: 'device' | 'unknown' | 'cancelled'; device?: string };
    freshProbeVerdict?: GpuProbeVerdict;
    stageFastOnly?: boolean;
  }): Promise<HostRig> {
    const { NodeBackendHost: Host } = await import('../../main/backend/index.js');
    const profileDir = tempDir('gpu-admission-host-');
    fs.mkdirSync(profileDir, { recursive: true });
    cleanups.push(() => fs.rmSync(profileDir, { recursive: true, force: true }));
    if (opts.storedVerdict !== null && opts.storedVerdict !== undefined) {
      writeGpuProbeVerdict(profileDir, opts.storedVerdict);
    }
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const events: string[] = [];
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: opts.stageFastOnly === true ? { fast: models.fast } : { quality: models.quality, fast: models.fast },
    });
    const rig: HostRig = {
      engine,
      events,
      probeCalls: 0,
      profileDir,
      host: null as unknown as NodeBackendHost,
      stop: () => Promise.resolve(),
    };
    const host = new Host({ engine, token: 'gpu-admission-token', env: rigEnv(), storePath: path.join(profileDir, 'store.sqlite') } as never);
    rig.host = host;
    rig.stop = async () => {
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
    };
    (host as unknown as { probeRun: unknown }).probeRun = (probeOpts: {
      onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
      onSettled?: () => void;
    }) => {
      rig.probeCalls += 1;
      events.push('probe-start');
      probeOpts.onChild?.({ kill: () => true });
      probeOpts.onSettled?.();
      events.push('probe-done');
      return Promise.resolve(opts.freshProbeVerdict ?? GPU_OK);
    };
    // nlc getLlama records when a construction actually happens.
    const baseGetLlama = nlc.state.getLlamaImpl;
    nlc.state.getLlamaImpl = (getOpts) => {
      events.push('getLlama');
      return baseGetLlama?.(getOpts);
    };
    deviceQuery.impl = () => {
      events.push('device-query');
      return Promise.resolve(opts.deviceQueryResult);
    };
    await (host as unknown as { start: () => Promise<unknown> }).start();
    return rig;
  }

  it('host boot flight: adapter MISMATCH re-probes and NEVER constructs from the stale verdict', async () => {
    const rig = await startHostRig({
      storedVerdict: { backend: 'vulkan', ok: true, reason: 'stale stored verdict', device: 'old-gpu' },
      deviceQueryResult: { status: 'device', device: 'new-gpu' },
      freshProbeVerdict: { backend: 'vulkan', ok: true, reason: 'fresh probe verdict', device: 'new-gpu' },
    });
    try {
      await until(() => rig.probeCalls > 0, 5000, 'the full boot re-probe');
      await until(() => activeGpuVerdict()?.reason === 'fresh probe verdict', 5000, 'fresh adoption');
      // The post-validation warmup must construct (bounded): if it never
      // does, THIS is the failure to report, not an ordering accident.
      await until(() => rig.events.includes('getLlama'), 5000, 'the post-verdict warmup construction');
      expect(rig.probeCalls, 'a mismatched record must trigger a FULL re-probe').toBe(1);
      const firstLoad = rig.events.indexOf('getLlama');
      const probeDone = rig.events.indexOf('probe-done');
      expect(firstLoad, 'warmup may construct only AFTER validation settles').toBeGreaterThan(probeDone);
      expect(activeGpuVerdict()?.device).toBe('new-gpu');
    } finally {
      await rig.stop();
      setActiveGpuVerdict(null);
    }
  }, 30_000);

  it('host boot flight: UNKNOWN device query fails OPEN (adopts the stored verdict, no full probe)', async () => {
    const rig = await startHostRig({
      storedVerdict: { backend: 'vulkan', ok: true, reason: 'stored ok', device: 'gpu-a' },
      deviceQueryResult: { status: 'unknown' },
    });
    try {
      await until(() => activeGpuVerdict()?.reason === 'stored ok', 5000, 'fail-open adoption');
      expect(rig.probeCalls, 'unknown must NOT spawn a full probe').toBe(0);
      expect(activeGpuVerdict()?.device).toBe('gpu-a');
    } finally {
      await rig.stop();
      setActiveGpuVerdict(null);
    }
  }, 30_000);

  it('host boot flight: device-EQUAL adopts the stored verdict without a probe', async () => {
    const rig = await startHostRig({
      storedVerdict: { backend: 'vulkan', ok: true, reason: 'stored ok equal', device: 'gpu-a' },
      deviceQueryResult: { status: 'device', device: 'gpu-a' },
    });
    try {
      await until(() => activeGpuVerdict()?.reason === 'stored ok equal', 5000, 'equal adoption');
      expect(rig.probeCalls).toBe(0);
    } finally {
      await rig.stop();
      setActiveGpuVerdict(null);
    }
  }, 30_000);

  it('host boot flight: CANCELLED adopts nothing, probes nothing, and settles the armed gate', async () => {
    const rig = await startHostRig({
      storedVerdict: { backend: 'vulkan', ok: true, reason: 'SENTINEL-CANCEL', device: 'gpu-a' },
      deviceQueryResult: { status: 'cancelled' },
    });
    try {
      await until(() => deviceQuery.calls.length > 0, 5000, 'the device query leg');
      // Resolving DE-ARMS the gate (documented module contract): the cancelled
      // terminal path settles it, so the oracle reads null. (Pre-de-arm this
      // row awaited the still-armed resolved promise; same settle evidence.)
      await until(() => gpuVerdictGate() === null, 5000, 'the gate to settle (de-arm) on the cancelled terminal path');
      expect(activeGpuVerdict(), 'a host-killed query must adopt NOTHING').toBeNull();
      expect(rig.probeCalls, 'a cancelled device query must not fall through to a full probe').toBe(0);
      const written = JSON.parse(fs.readFileSync(path.join(rig.profileDir, GPU_PROBE_SIDECAR), 'utf8')) as { reason?: string };
      expect(written.reason, 'no verdict write on the cancelled path').toBe('SENTINEL-CANCEL');
    } finally {
      await rig.stop();
      setActiveGpuVerdict(null);
    }
  }, 30_000);
});
