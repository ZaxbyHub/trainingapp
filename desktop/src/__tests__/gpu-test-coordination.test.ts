// gpu-test-coordination.test.ts — collated issues #246 + #247 (trace
// .agents/issue-traces/collated-246-247, approved plan B4/B5/B6, rev 5).
//
// FROZEN ACCEPTANCE SURFACE, arm's-length authored against the plan's
// normative new-API contract BEFORE the implementation lands. Rows (the
// frozen drivers run `npm --prefix desktop test -- gpu-test-coordination
// -t <row>`):
//   gpu-test-drain      (AC5) — the whole-operation gpuTest flight: response
//                               joining, drain/unload/probe ordering, the
//                               pre-SSE pause preflights, the six-member
//                               capability group, stop-during-test recovery.
//   probe-before-warmup (AC6) — the boot admission gate BEFORE profile
//                               selection / model identity (ask, stream
//                               preflight, warmup), including the RESTART
//                               retained-verdict case.
//   construction-cleanup(AC7) — the PRODUCTION factory's acquisition-stage
//                               cleanup and awaited backend disposal.
//   awaited-teardown    (AC8) — awaited, deferring, generation-safe engine +
//                               host teardown; the b4 recreation contract.
//
// BINDING CONTRACT RESOLUTIONS (test-author decisions; both sides are bound):
//   R-1 NodeBackendHost exposes `gpuTest` as an OWN PROPERTY (b3 duck-type
//       pin: prototypes stay start/stop only) — the coalesced whole-operation
//       flight the /gpu-test route delegates to. The spec drives it directly.
//   R-2 The "retryable 503 error" for paused/generation-mismatched queries is
//       ModelNotConfiguredError (the class the server maps to the contract's
//       503). Pinned by identity in the late-enrolled-query row.
//   R-3 The host boot-flight device leg is steered by mocking ONLY
//       runGpuDeviceQuery on the gpu-probe module (holder/sidecar/gate state
//       stays real); `probeRun` remains the injected full-probe seam (t155).
//   R-4 Engine capability observation wraps members as OWN PROPERTIES over
//       the prototype (so both prototype and own-property implementations
//       are observed); omissions shadow the member with undefined.
//   R-5 `defaultLlamaFactory` is imported directly from llama-engine.ts for
//       the stage-precise construction-cleanup rows (same resolution as the
//       gpu-admission-recovery spec).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocked node-llama-cpp (NEVER the real native module) for the rows that run
// the PRODUCTION defaultLlamaFactory.
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
    getSequenceImpl: null as null | (() => unknown),
  };
  return { InsufficientMemoryError, state };
});

vi.mock('node-llama-cpp', () => ({
  InsufficientMemoryError: nlc.InsufficientMemoryError,
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
              getSequence: () => {
                if (nlc.state.getSequenceImpl !== null) {
                  const overridden = nlc.state.getSequenceImpl();
                  if (overridden !== undefined) return overridden;
                }
                return { id: 'seq' };
              },
            };
          },
        };
      },
    };
  },
}));

// gpu-probe: everything real except runGpuDeviceQuery (resolution R-3).
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
  activeGpuVerdict,
  gpuVerdictGate,
  setActiveGpuVerdict,
  writeGpuProbeVerdict,
  type GpuProbeVerdict,
} from '../../main/backend/inference/gpu-probe.js';
import {
  LlamaEngine,
  defaultLlamaFactory,
  type LlamaEngineBackend,
  type LlamaEngineFactoryOptions,
  type LlamaEngineOptions,
} from '../../main/backend/inference/llama-engine.js';
import { NodeBackendHost } from '../../main/backend/index.js';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server.js';
import { createLoopbackGuard } from '../../main/security/loopback-guard.js';
import { ModelNotConfiguredError, type EngineSurface } from '../../main/backend/types.js';

const GB = 1024 ** 3;
const GPU_OK: GpuProbeVerdict = { backend: 'vulkan', ok: true, reason: 'stub probe: gpu usable', device: 'gpu-a' };
const CPU_FAIL: GpuProbeVerdict = { backend: 'cpu', ok: false, reason: 'stub probe: cpu only', device: 'gpu-a' };

/** Options type widened with the contract's new engine field (assignable to
 *  LlamaEngineOptions before AND after the implementation lands). */
type EngineOpts = LlamaEngineOptions & { gpuVerdictAwaiter?: () => Promise<void> | null };
type FactoryOpts = LlamaEngineFactoryOptions & { ignoreMemorySafetyChecks?: boolean; onGpuDevice?: (device: string | null) => void };
const productionFactory = defaultLlamaFactory as unknown as (opts: FactoryOpts) => Promise<LlamaEngineBackend>;

/** The /gpu-test route's response shape (server.ts gpuTest opt). */
interface GpuTestResponse {
  backend: 'vulkan' | 'cpu';
  ok: boolean;
  reason: string;
  device?: string | null;
}

function stageModels(): { quality: string; fast: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-coord-models-'));
  const quality = path.join(dir, 'quality.gguf');
  const fast = path.join(dir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast, dir };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function until(cond: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for: ${what}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    }),
  ]);
}

/** Record calls to (possibly prototype) engine members via own-property
 *  wrappers (resolution R-4). */
function recordMember(obj: object, member: string, events: string[]): void {
  const base = (obj as unknown as Record<string, unknown>)[member] as ((...args: unknown[]) => unknown) | undefined;
  if (typeof base !== 'function') return;
  Object.defineProperty(obj, member, {
    value: (...args: unknown[]) => {
      events.push(member);
      return (base as (...a: unknown[]) => unknown).apply(obj, args);
    },
    configurable: true,
    writable: true,
  });
}

const SWAP_MEMBERS = ['pauseQueries', 'resumeQueries', 'queriesPaused', 'joinLoadAndQueue', 'dispose', 'resetLifecycle', 'shutdown', 'warmup'] as const;

function recordSwapMembers(engine: LlamaEngine, events: string[]): void {
  for (const member of SWAP_MEMBERS) recordMember(engine, member, events);
}

/** A double that omits ONE swap-capability member (resolution R-4). */
function omitCapability(engine: LlamaEngine, member: string): LlamaEngine {
  const shadow = Object.create(engine) as LlamaEngine;
  Object.defineProperty(shadow, member, { value: undefined, configurable: true });
  return shadow;
}

/** Injectable factory backend with deferred generation + recorded disposal. */
function fakeFactory(events: string[], deferGenerate?: () => Promise<void>) {
  const backends: Array<{ disposed: boolean }> = [];
  const calls: Array<{ profile: string; modelPath: string; backend: string }> = [];
  const fn = async (o: LlamaEngineFactoryOptions): Promise<LlamaEngineBackend> => {
    calls.push({ profile: o.profile, modelPath: o.modelPath, backend: o.backend });
    const entry = { disposed: false };
    backends.push(entry);
    return {
      // streamCallback is invoked so HTTP SSE rows can observe the generated
      // answer (runAskStream delivers the answer ONLY via token frames — the
      // terminal done event never repeats it).
      async generate(_question: string, genOpts: { streamCallback?: (token: string) => void }) {
        events.push('generate-start');
        genOpts.streamCallback?.('OK');
        await deferGenerate?.();
        events.push('generate-done');
        return { answer: 'OK', cancelled: false };
      },
      async dispose() {
        await new Promise((r) => setTimeout(r, 5));
        entry.disposed = true;
        events.push('backend-disposed');
      },
    };
  };
  return { fn, calls, backends };
}

/**
 * RIG ISOLATION (implementer-agreed): rerank OFF + an explicit EMPTY
 * embedding-model dir, so resolveEmbedder degrades to null (the pinned B5
 * contract — retrieval surface detached, engine keeps stub retrieval) and no
 * ONNX/worker_thread is ever wired from ambient staged weights. Without this,
 * host rows are machine-dependent: a machine with real weights stages an
 * OnnxEmbedder + reranker worker whose worker_thread dies under vitest and
 * failAll() rejects the retrieval leg of every query.
 */
function rigEnv(): { TRAININGAPP_RETRIEVAL_RERANK: string; TRAININGAPP_EMBEDDING_MODEL_DIR: string } {
  const dir = tempDir('gpu-spec-noembedder-');
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { TRAININGAPP_RETRIEVAL_RERANK: 'false', TRAININGAPP_EMBEDDING_MODEL_DIR: dir };
}

interface HostRig {
  host: NodeBackendHost;
  engine: LlamaEngine;
  handle: { port: number; url: string };
  events: string[];
  probeCalls: number;
  profileDir: string;
  probe: Promise<GpuProbeVerdict>;
  resolveProbe: (verdict: GpuProbeVerdict) => void;
  stop: () => Promise<void>;
}

const TOKEN = 'gpu-coordination-token';

async function startHostRig(opts: {
  storedVerdict?: GpuProbeVerdict;
  deviceQueryResult?: { status: 'device' | 'unknown' | 'cancelled'; device?: string };
  engineOverrides?: Partial<EngineOpts>;
  stageFastOnly?: boolean;
}): Promise<HostRig> {
  const profileDir = tempDir('gpu-coord-host-');
  cleanups.push(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  if (opts.storedVerdict !== undefined) writeGpuProbeVerdict(profileDir, opts.storedVerdict);
  const models = stageModels();
  cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
  const events: string[] = [];
  const factory = fakeFactory(events);
  const engine = new LlamaEngine({
    profile: 'fast',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: opts.stageFastOnly === true ? { fast: models.fast } : { quality: models.quality, fast: models.fast },
    llamaFactory: factory.fn,
    ...opts.engineOverrides,
  } as EngineOpts);
  const host = new NodeBackendHost({ engine, token: TOKEN, env: rigEnv(), storePath: path.join(profileDir, 'store.sqlite') } as never);
  let resolveProbe!: (verdict: GpuProbeVerdict) => void;
  const probe = new Promise<GpuProbeVerdict>((resolve) => {
    resolveProbe = resolve;
  });
  const rig: HostRig = {
    host,
    engine,
    handle: { port: 0, url: '' },
    events,
    probeCalls: 0,
    profileDir,
    probe,
    resolveProbe,
    stop: async () => {
      await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
    },
  };
  (host as unknown as { probeRun: unknown }).probeRun = (probeOpts: {
    onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
    onSettled?: () => void;
  }) => {
    rig.probeCalls += 1;
    events.push('probe-start');
    probeOpts.onChild?.({ kill: () => true });
    probeOpts.onSettled?.();
    return probe.then((verdict) => {
      events.push('probe-done');
      return verdict;
    });
  };
  if (opts.deviceQueryResult !== undefined) {
    deviceQuery.impl = () => Promise.resolve(opts.deviceQueryResult as { status: 'device' | 'unknown' | 'cancelled'; device?: string });
  }
  const handle = (await (host as unknown as { start: () => Promise<{ port: number; url: string }> }).start()) as {
    port: number;
    url: string;
  };
  rig.handle = handle;
  return rig;
}

const cleanups: Array<() => void> = [];
const activeHosts: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of activeHosts.splice(0)) await stop().catch(() => undefined);
  while (cleanups.length > 0) cleanups.pop()?.();
  setActiveGpuVerdict(null);
  // Drain any still-armed module gate (armed + immediately settled is the
  // safe idle state: no later default-awaiter engine in this file blocks).
  (await import('../../main/backend/inference/gpu-probe.js')).armGpuVerdictGate().resolve();
  deviceQuery.impl = null;
  deviceQuery.calls.length = 0;
  nlc.state.getLlamaCalls.length = 0;
  nlc.state.loadModelCalls.length = 0;
  nlc.state.createContextCalls.length = 0;
  nlc.state.disposeOrder.length = 0;
  nlc.state.getLlamaImpl = null;
  nlc.state.loadModelImpl = null;
  nlc.state.createContextImpl = null;
  nlc.state.getSequenceImpl = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('gpu-test-drain (AC5: the whole-operation gpuTest swap flight)', () => {
  function hostGpuTest(host: NodeBackendHost): Promise<GpuTestResponse> {
    return (host as unknown as { gpuTest: () => Promise<GpuTestResponse> }).gpuTest();
  }

  it('concurrent callers JOIN one flight: one fresh probe, one shared response', async () => {
    const rig = await startHostRig({ storedVerdict: GPU_OK, deviceQueryResult: { status: 'device', device: 'gpu-a' } });
    activeHosts.push(rig.stop);
    recordSwapMembers(rig.engine, rig.events);
    const first = hostGpuTest(rig.host);
    await until(() => rig.probeCalls > 0, 5000, 'the first flight to reach its probe');
    const second = hostGpuTest(rig.host);
    rig.resolveProbe({ backend: 'vulkan', ok: true, reason: 'fresh shared verdict', device: 'gpu-a' });
    const [a, b] = await Promise.all([first, second]);
    expect(rig.probeCalls, 'the whole operation coalesces: exactly ONE fresh probe').toBe(1);
    expect(a).toEqual(b);
    expect(a.reason).toBe('fresh shared verdict');
  }, 30_000);

  it('staggered overlap: pause -> drain -> unload -> FRESH probe -> warmup -> resume, and no premature resume', async () => {
    const rig = await startHostRig({ storedVerdict: GPU_OK, deviceQueryResult: { status: 'device', device: 'gpu-a' } });
    activeHosts.push(rig.stop);
    recordSwapMembers(rig.engine, rig.events);
    const flight = hostGpuTest(rig.host);
    await until(() => rig.events.includes('probe-start'), 5000, 'the flight to reach its fresh probe');
    // While the fresh probe is pending the engine stays PAUSED...
    expect((rig.engine as unknown as { queriesPaused: () => string | null }).queriesPaused()).not.toBeNull();
    // ...and the unload happened BEFORE the probe spawned.
    expect(rig.events.indexOf('pauseQueries')).toBeLessThan(rig.events.indexOf('joinLoadAndQueue'));
    expect(rig.events.indexOf('joinLoadAndQueue')).toBeLessThan(rig.events.indexOf('dispose'));
    expect(rig.events.indexOf('dispose')).toBeLessThan(rig.events.indexOf('probe-start'));
    expect(rig.events).not.toContain('resumeQueries');
    rig.resolveProbe({ backend: 'vulkan', ok: true, reason: 'fresh verdict', device: 'gpu-a' });
    await flight;
    // lastIndexOf: host start ALSO warms up (before the flight); the swap's
    // own warmup is the one that must follow the fresh probe.
    expect(rig.events.lastIndexOf('warmup')).toBeGreaterThan(rig.events.indexOf('probe-done'));
    expect(rig.events.lastIndexOf('resumeQueries')).toBeGreaterThan(rig.events.lastIndexOf('warmup'));
    expect((rig.engine as unknown as { queriesPaused: () => string | null }).queriesPaused()).toBeNull();
  }, 30_000);

  it('a late-enrolled query while paused rejects with the retryable 503 error (resolution R-2)', async () => {
    const rig = await startHostRig({ storedVerdict: GPU_OK, deviceQueryResult: { status: 'device', device: 'gpu-a' } });
    activeHosts.push(rig.stop);
    const flight = hostGpuTest(rig.host);
    await until(
      () => (rig.engine as unknown as { queriesPaused: () => string | null }).queriesPaused() !== null,
      5000,
      'the pause to latch',
    );
    const late = rig.engine.query('late');
    await expect(late).rejects.toBeInstanceOf(ModelNotConfiguredError);
    rig.resolveProbe({ backend: 'cpu', ok: false, reason: 'fresh cpu verdict', device: 'gpu-a' });
    await flight;
  }, 30_000);

  it('BOTH route preflights answer 503 BEFORE any SSE byte while paused', async () => {
    const double = {
      queriesPaused: () => 'GPU test in progress',
      query: async () => {
        throw new Error('the engine must never be reached');
      },
      preflight: async () => undefined,
      applySettingsPatch: () => ({ ok: true as const }),
      responseSettings: () => ({}),
      search: async () => [],
      listDocuments: async () => ({ documents: [], total: 0 }),
      clearDocuments: async () => undefined,
      getStats: async () => ({}) as never,
      ingestDirectory: async () => ({ success: true, documents: 0, chunks_added: 0, message: null }),
      ingestFile: async () => ({ success: true, documents: 0, chunks_added: 0, message: null }),
      ingestBatch: async () => ({ total_files: 0, successful: 0, failed: 0, results: [] }),
    } as unknown as EngineSurface;
    const server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine: double,
    });
    const port = await listenOnRandomPort(server);
    try {
      const ask = await fetch(`http://127.0.0.1:${port}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
        body: JSON.stringify({ question: 'blocked' }),
      });
      expect(ask.status).toBe(503);
      await ask.arrayBuffer();

      const stream = await fetch(`http://127.0.0.1:${port}/ask/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
        body: JSON.stringify({ question: 'blocked' }),
      });
      expect(stream.status).toBe(503);
      const body = await stream.text();
      expect(body.startsWith('data:'), 'the 503 must precede ANY SSE byte').toBe(false);
      expect(body).toContain('detail');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('the flight resume is idempotent-safe: a failing unload still resumes in the finally', async () => {
    const rig = await startHostRig({ storedVerdict: GPU_OK, deviceQueryResult: { status: 'device', device: 'gpu-a' } });
    activeHosts.push(rig.stop);
    recordSwapMembers(rig.engine, rig.events);
    // Make the UNLOAD stage throw so the flight reaches its finally via a
    // thrown path (the probe wrapper itself never throws).
    const baseDispose = (rig.engine as unknown as { dispose: () => Promise<void> }).dispose.bind(rig.engine);
    Object.defineProperty(rig.engine, 'dispose', {
      value: () => {
        rig.events.push('dispose-throws');
        return Promise.reject(new Error('unload exploded'));
      },
      configurable: true,
      writable: true,
    });
    const flight = hostGpuTest(rig.host);
    await flight.then(
      () => undefined,
      () => undefined,
    );
    expect(
      (rig.engine as unknown as { queriesPaused: () => string | null }).queriesPaused(),
      'the finally must clear the pause even when the swap throws',
    ).toBeNull();
    // Restore the real dispose so host stop teardown is clean.
    Object.defineProperty(rig.engine, 'dispose', {
      value: baseDispose,
      configurable: true,
      writable: true,
    });
  }, 30_000);

  it.each(SWAP_MEMBERS.slice(0, 6))(
    'a capability double missing %s takes PROBE-ONLY (no pause, no unload)',
    async (member) => {
      const base = await startHostRig({ storedVerdict: GPU_OK, deviceQueryResult: { status: 'device', device: 'gpu-a' } });
      activeHosts.push(base.stop);
      // Tear the started rig down; this row needs its own host whose engine
      // omits the member from construction time.
      await base.stop();
      const profileDir = tempDir('gpu-coord-cap-');
      cleanups.push(() => fs.rmSync(profileDir, { recursive: true, force: true }));
      writeGpuProbeVerdict(profileDir, GPU_OK);
      const models = stageModels();
      cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
      const events: string[] = [];
      const factory = fakeFactory(events);
      const realEngine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
        llamaFactory: factory.fn,
      });
      recordSwapMembers(realEngine, events);
      const engine = omitCapability(realEngine, member) as LlamaEngine;
      const host = new NodeBackendHost({ engine, token: TOKEN, env: rigEnv(), storePath: path.join(profileDir, 'store.sqlite') } as never);
      const stop = async () => {
        await (host as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
      };
      activeHosts.push(stop);
      let probeCalls = 0;
      (host as unknown as { probeRun: unknown }).probeRun = (probeOpts: {
        onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
        onSettled?: () => void;
      }) => {
        probeCalls += 1;
        probeOpts.onChild?.({ kill: () => true });
        probeOpts.onSettled?.();
        return Promise.resolve({ backend: 'cpu', ok: false, reason: 'probe-only verdict', device: 'gpu-a' });
      };
      await (host as unknown as { start: () => Promise<unknown> }).start();
      await hostGpuTest(host);
      expect(probeCalls, 'probe-only: the fresh probe still runs').toBe(1);
      expect(events, 'a partial engine NEVER takes a partial swap: no pause, no drain, no unload').not.toContain('pauseQueries');
      expect(events).not.toContain('joinLoadAndQueue');
      expect(events).not.toContain('dispose');
      expect(typeof (engine as unknown as Record<string, unknown>)[member]).not.toBe('function');
    },
    30_000,
  );

  it('stop during the in-flight test -> restart -> the next query succeeds', async () => {
    const rig = await startHostRig({ storedVerdict: GPU_OK, deviceQueryResult: { status: 'device', device: 'gpu-a' } });
    activeHosts.push(rig.stop);
    const flight = hostGpuTest(rig.host);
    await until(() => rig.probeCalls > 0, 5000, 'the flight to reach its probe');
    await rig.stop();
    // The killed probe settles AFTER the stop: its verdict must never adopt.
    rig.resolveProbe({ backend: 'vulkan', ok: true, reason: 'KILLED-PROBE-VERDICT', device: 'gpu-b' });
    await flight.then(
      () => undefined,
      () => undefined,
    );
    await until(() => true, 100, 'settle');
    expect(
      activeGpuVerdict()?.reason === 'KILLED-PROBE-VERDICT' ? 'adopted a killed probe' : 'ok',
      'a host-killed probe verdict must not be adopted',
    ).toBe('ok');
    // Restart on the SAME host + engine instances.
    const handle = await (rig.host as unknown as { start: () => Promise<{ port: number; url: string }> }).start();
    rig.handle = handle;
    await until(() => activeGpuVerdict()?.reason === 'stub probe: gpu usable', 5000, 'the restarted boot flight to re-adopt the stored verdict');
    const result = await rig.engine.query('after restart');
    expect(result.answer).toBe('OK');
    expect((rig.engine as unknown as { queriesPaused: () => string | null }).queriesPaused()).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe('probe-before-warmup (AC6: the admission gate precedes profile selection)', () => {
  it('gate BEFORE profile selection: early ask on high RAM + null verdict -> ONE post-verdict construction with the correct profile', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const events: string[] = [];
    const factory = fakeFactory(events);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    setActiveGpuVerdict(null);
    const engine = new LlamaEngine({
      profile: 'auto',
      freeMemBytes: () => 32 * GB, // high RAM: the RAM rule alone would say quality
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      llamaFactory: factory.fn,
      gpuVerdictAwaiter: () => gate,
    } as EngineOpts);
    const early = engine.query('early ask');
    await new Promise((r) => setTimeout(r, 150));
    expect(factory.calls, 'nothing constructs while admission is pending').toHaveLength(0);
    // Validation settles with a CPU-only verdict: the profile resolves ONCE,
    // post-validation, and the CPU rule forces fast.
    setActiveGpuVerdict({ ...CPU_FAIL });
    releaseGate();
    const result = await early;
    expect(result.answer).toBe('OK');
    expect(factory.calls, 'exactly ONE post-verdict construction').toHaveLength(1);
    expect(factory.calls[0]?.profile).toBe('fast');
    expect(factory.calls[0]?.modelPath).toBe(models.fast);
  }, 20_000);

  it('the gpuVerdictAwaiter DEFAULTS to the module gate (production wiring)', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const events: string[] = [];
    const factory = fakeFactory(events);
    setActiveGpuVerdict(null);
    // Arm the gate the way host start() does, capturing the OBJECT so the
    // test can settle exactly the gate the engine awaits.
    const gate = (await import('../../main/backend/inference/gpu-probe.js')).armGpuVerdictGate();
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      llamaFactory: factory.fn,
    });
    expect(gpuVerdictGate(), 'sanity: the module gate is armed').toBe(gate.promise);
    const early = engine.query('early ask');
    await new Promise((r) => setTimeout(r, 150));
    expect(factory.calls, 'the default awaiter blocks on the armed gate').toHaveLength(0);
    setActiveGpuVerdict(GPU_OK);
    gate.resolve();
    const result = await early;
    expect(result.answer).toBe('OK');
    expect(factory.calls).toHaveLength(1);
  }, 20_000);

  it('early /ask/stream with quality-absent/fast-present + eventual cpu verdict answers post-verdict (not a quality 503)', async () => {
    const rig = await startHostRig({
      // No stored verdict: the boot flight runs the FULL probe (deferred).
      // AUTO profile + 8 GiB free RAM would resolve quality (absent) — only
      // the admission gate ordering turns this into a fast answer.
      stageFastOnly: true,
      engineOverrides: { profile: 'auto' },
    });
    activeHosts.push(rig.stop);
    const streamP = fetch(`http://127.0.0.1:${rig.handle.port}/ask/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
      body: JSON.stringify({ question: 'early stream' }),
    });
    await new Promise((r) => setTimeout(r, 300));
    rig.resolveProbe({ backend: 'cpu', ok: false, reason: 'stub probe: cpu only', device: 'gpu-a' });
    const response = await withTimeout(streamP, 10_000, 'the early stream to answer');
    expect(response.status, 'the cpu verdict lands BEFORE the model-identity check: fast answers, no quality 503').toBe(200);
    const body = await withTimeout(response.text(), 10_000, 'the SSE body');
    // runAskStream delivers the answer ONLY via token frames (the terminal
    // done event never repeats it), so the streamed token + the well-formed
    // terminal together prove a real post-verdict generation reached the client.
    expect(body).toContain('"token":"OK"');
    expect(body).toContain('"done":true');
  }, 30_000);

  it('RESTART: a retained holder verdict with a CHANGED adapter never constructs from the old verdict, and /status/models reports pending', async () => {
    // Boot 1: the stored verdict validates (device equal) and is adopted.
    const rig = await startHostRig({ storedVerdict: GPU_OK, deviceQueryResult: { status: 'device', device: 'gpu-a' } });
    activeHosts.push(rig.stop);
    const status1 = await fetch(`http://127.0.0.1:${rig.handle.port}/status/models`, {
      headers: { 'x-desktop-token': TOKEN },
    });
    const body1 = (await status1.json()) as { gpu?: { ok?: boolean } };
    expect(body1.gpu?.ok, 'boot 1: the validated verdict is current').toBe(true);
    await rig.stop();

    // Boot 2 (same host + engine): the adapter CHANGED -> mismatch -> the
    // holder is reset and a full re-probe revalidates; until it settles the
    // old verdict must not leak into either status or construction.
    deviceQuery.impl = () => Promise.resolve({ status: 'device', device: 'gpu-b' });
    const events: string[] = [];
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const observeFactory = fakeFactory(events);
    const engine = new LlamaEngine({
      profile: 'auto',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      llamaFactory: observeFactory.fn,
    });
    const host2 = new NodeBackendHost({ engine, token: TOKEN, env: rigEnv(), storePath: path.join(rig.profileDir, 'store.sqlite') } as never);
    const stop2 = async () => {
      await (host2 as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
    };
    activeHosts.push(stop2);
    let resolveProbe2!: (verdict: GpuProbeVerdict) => void;
    const probe2 = new Promise<GpuProbeVerdict>((resolve) => {
      resolveProbe2 = resolve;
    });
    (host2 as unknown as { probeRun: unknown }).probeRun = (probeOpts: {
      onChild?: (c: { kill: (s?: NodeJS.Signals) => unknown }) => void;
      onSettled?: () => void;
    }) => {
      events.push('probe-start');
      probeOpts.onChild?.({ kill: () => true });
      probeOpts.onSettled?.();
      return probe2;
    };
    const handle2 = (await (host2 as unknown as { start: () => Promise<{ port: number; url: string }> }).start()) as {
      port: number;
      url: string;
    };
    await until(() => events.includes('probe-start'), 5000, 'the revalidation full probe');
    const status2 = await fetch(`http://127.0.0.1:${handle2.port}/status/models`, {
      headers: { 'x-desktop-token': TOKEN },
    });
    const body2 = (await status2.json()) as { gpu?: { ok?: boolean; reason?: string } };
    expect(body2.gpu?.ok, 'during validation the PREVIOUS lifecycle verdict is never reported as current').toBe(false);
    const early = engine.query('early ask after restart');
    await new Promise((r) => setTimeout(r, 200));
    expect(observeFactory.calls, 'an early ask must NOT construct from the old verdict').toHaveLength(0);
    resolveProbe2({ backend: 'cpu', ok: false, reason: 'post-restart cpu verdict', device: 'gpu-b' });
    const result = await early;
    expect(result.answer).toBe('OK');
    expect(observeFactory.calls).toHaveLength(1);
    expect(observeFactory.calls[0]?.profile, 'post-validation the cpu rule forces fast').toBe('fast');
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe('construction-cleanup (AC7: every acquisition stage guarded, awaited)', () => {
  const opts = (models: { fast: string }): FactoryOpts => ({
    modelPath: models.fast,
    threads: 2,
    backend: 'vulkan',
    gpuLayers: 'max',
    profile: 'fast',
  });

  it('a loadModel throw disposes the llama instance and rethrows the SAME error', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const thrown = new Error('loadModel failed');
    nlc.state.loadModelImpl = () => {
      throw thrown;
    };
    await expect(productionFactory(opts(models))).rejects.toBe(thrown);
    expect(nlc.state.disposeOrder).toEqual(['llama']);
  });

  it('a createContext throw disposes model THEN llama and rethrows the SAME error', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const thrown = new Error('createContext failed');
    nlc.state.createContextImpl = () => {
      throw thrown;
    };
    await expect(productionFactory(opts(models))).rejects.toBe(thrown);
    expect(nlc.state.disposeOrder).toEqual(['model', 'llama']);
  });

  it('a getSequence throw disposes context THEN model THEN llama (EVERY acquired native, AC7) and rethrows the SAME error', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const thrown = new Error('sequence pool exhausted');
    nlc.state.getSequenceImpl = () => {
      throw thrown;
    };
    await expect(productionFactory(opts(models))).rejects.toBe(thrown);
    // The CONTEXT was successfully created before getSequence threw, so it is
    // an acquired native resource: context -> model -> llama.
    expect(nlc.state.disposeOrder).toEqual(['context', 'model', 'llama']);
  });

  it('a REJECTING cleanup never masks the original error', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const thrown = new Error('original construction failure');
    nlc.state.loadModelImpl = () => {
      throw thrown;
    };
    nlc.state.getLlamaImpl = () => ({
      gpu: 'vulkan',
      getGpuDeviceNames: async () => ['Arc Pro B50'],
      dispose: async () => {
        nlc.state.disposeOrder.push('llama');
        throw new Error('cleanup dispose rejected');
      },
      loadModel: async () => {
        throw thrown;
      },
    });
    await expect(productionFactory(opts(models))).rejects.toBe(thrown);
  });

  it('backend dispose() AWAITS context -> model -> llama in order', async () => {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const backend = await productionFactory(opts(models));
    await backend.dispose();
    expect(nlc.state.disposeOrder).toEqual(['context', 'model', 'llama']);
  });
});

// ---------------------------------------------------------------------------

describe('awaited-teardown (AC8: awaited, deferring, generation-safe)', () => {
  function makeEngine(events: string[], extra: Partial<EngineOpts> = {}, deferGenerate?: () => Promise<void>) {
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const factory = fakeFactory(events, deferGenerate);
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { quality: models.quality, fast: models.fast },
      llamaFactory: factory.fn,
      ...extra,
    } as EngineOpts);
    return { engine, factory, models };
  }

  it('dispose() during an ENROLLED generation defers the resident disposal until the generation completes', async () => {
    const events: string[] = [];
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const { engine, factory } = makeEngine(events, {}, () => gate);
    const query = engine.query('long generation');
    await until(() => events.includes('generate-start'), 5000, 'the generation to start');
    const disposing = engine.dispose();
    await new Promise((r) => setTimeout(r, 150));
    expect(factory.backends[0]?.disposed, 'the resident is NOT disposed mid-generation').toBe(false);
    releaseGenerate();
    await query;
    await disposing;
    expect(factory.backends[0]?.disposed).toBe(true);
    expect(events.indexOf('backend-disposed')).toBeGreaterThan(events.indexOf('generate-done'));
  }, 20_000);

  it('dispose() during a SUSPENDED (pre-enqueue) generation returns promptly and the generation later constructs fresh', async () => {
    const events: string[] = [];
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    setActiveGpuVerdict(null);
    const { engine, factory } = makeEngine(events, { gpuVerdictAwaiter: () => gate });
    const suspended = engine.query('suspended at the gate');
    await new Promise((r) => setTimeout(r, 100));
    // The reusable unload must NOT wait on a query that is not yet enrolled.
    await withTimeout(engine.dispose(), 1000, 'dispose during a suspended generation');
    setActiveGpuVerdict(GPU_OK);
    releaseGate();
    const result = await suspended;
    expect(result.answer).toBe('OK');
    expect(factory.calls, 'the suspended query constructs a FRESH backend after the unload').toHaveLength(1);
  }, 20_000);

  it('external-switch deadlock regression: the deferred release settles behind the generation, and local->external->local keeps working', async () => {
    const events: string[] = [];
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const { engine, factory } = makeEngine(events, {}, () => gate);
    const local1 = engine.query('local generation');
    await until(() => events.includes('generate-start'), 5000, 'the local generation to start');
    // Switch to an external endpoint mid-generation: the resident release is
    // deferred behind the queue tail; the old call site could deadlock here.
    expect(
      engine.applySettingsPatch({
        'external.enabled': true,
        'external.baseUrl': 'http://127.0.0.1:9/v1',
        'external.model': 'stub-model',
      }).ok,
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(factory.backends[0]?.disposed, 'the release waits for the in-flight local generation').toBe(false);
    releaseGenerate();
    await local1;
    await until(() => factory.backends[0]?.disposed === true, 5000, 'the deferred release to dispose the resident');
    // ...and back: local inference reconstructs without a lifecycle reset.
    expect(engine.applySettingsPatch({ 'external.enabled': false }).ok).toBe(true);
    const local2 = await engine.query('local again');
    expect(local2.answer).toBe('OK');
    expect(factory.calls).toHaveLength(2);
  }, 20_000);

  it('the b4 recreation contract: query after dispose() RECREATES the backend', async () => {
    const events: string[] = [];
    const { engine, factory } = makeEngine(events);
    await engine.query('before');
    await engine.dispose();
    const result = await engine.query('after');
    expect(result.answer).toBe('OK');
    expect(engine.getLoadCount()).toBe(2);
    expect(factory.backends).toHaveLength(2);
    expect(factory.backends[0]?.disposed).toBe(true);
    expect(factory.backends[1]?.disposed).toBe(false);
  }, 20_000);

  it('shutdown() is terminal and awaited; resetLifecycle() revives the engine', async () => {
    const events: string[] = [];
    const { engine, factory } = makeEngine(events);
    await engine.query('first');
    await withTimeout((engine as unknown as { shutdown: () => Promise<void> }).shutdown(), 5000, 'shutdown');
    expect(factory.backends[0]?.disposed, 'shutdown disposes the resident AWAITED').toBe(true);
    await expect(engine.query('post shutdown')).rejects.toThrow();
    // Host start(): resetLifecycle clears the terminal flag.
    (engine as unknown as { resetLifecycle: () => void }).resetLifecycle();
    const result = await engine.query('revived');
    expect(result.answer).toBe('OK');
    expect(factory.calls).toHaveLength(2);
  }, 20_000);

  it('host stop(): neither a gate-blocked query nor a pre-enqueue-suspended one constructs after disposal; the captured gate settles', async () => {
    // No stored verdict: the boot flight's full probe stays deferred, so the
    // boot gate stays armed and queries suspend on it.
    const rig = await startHostRig({});
    activeHosts.push(rig.stop);
    const gatePromise = gpuVerdictGate();
    expect(gatePromise, 'sanity: the boot gate is armed while the probe is pending').not.toBeNull();
    const q1 = rig.engine.query('blocked on the gate');
    const q2 = rig.engine.query('also blocked');
    await new Promise((r) => setTimeout(r, 200));
    await rig.stop();
    const outcomes = await Promise.allSettled([q1, q2]);
    expect(outcomes[0]?.status).toBe('rejected');
    expect(outcomes[1]?.status).toBe('rejected');
    // THE discriminating assertion: neither suspended query constructed.
    expect(rig.events.filter((e) => e === 'generate-start')).toHaveLength(0);
    // The stop resolved the flight's CAPTURED gate.
    await withTimeout(gatePromise as Promise<void>, 2000, 'the captured gate to settle at stop');
    // Post-stop construction is impossible (terminal shutdown).
    await expect(rig.engine.query('post stop')).rejects.toThrow();
  }, 30_000);
});
