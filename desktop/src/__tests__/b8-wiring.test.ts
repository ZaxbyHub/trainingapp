// b8-wiring.test.ts — FROZEN ACCEPTANCE SPEC (issue #66 trace, host-integration layer, check C9).
//
// NEW-SURFACE: statically imports desktop/main/backend/memory/{budget,telemetry,
// scheduler,idle-unload}.js — none exist at the base revision — so the whole
// file fails collection with a module-not-found error, which IS the acceptance
// evidence. Where a round-1 spec pinned the UNIT contracts, this file pins how
// the HOST composes them (NodeBackendHost wiring) plus the additive engine/
// retrieval surfaces the composition requires.
//
// FROZEN CONTRACTS PINNED HERE (the implementer builds to these exactly):
//
// 1. memory/budget.ts MUST import DEFAULT_PROFILE_THRESHOLD_GB from
//    ../inference/profile-select.js (single source of truth, not a restated 6):
//    resolveMemoryConfig({}).pressureThresholdGb === DEFAULT_PROFILE_THRESHOLD_GB.
//
// 2. MemoryBudgetConfig gains recoverySustainedMs: default 60000, env
//    TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS overrides (positive ints only;
//    junk/zero fall back).
//
// 3. BackendServerOptions gains telemetry?: MemoryTelemetry. WITHOUT it, the
//    route GET /telemetry/memory is a KNOWN path that answers 503 (JSON body
//    with a non-empty `detail` string) — degraded, never 404-absent; WITH it
//    the route answers 200 with the C1 shape. (Known-path 405 for non-GET
//    applies either way.)
//
// 4. LlamaEngine additive override (the downgrade actuator):
//      setProfileOverride(profile: 'quality' | 'fast' | null): void
//      effectiveProfile(): 'quality' | 'fast'   // becomes PUBLIC (today private)
//    Precedence: override > explicit inference.profile setting > auto-by-free-RAM
//    (selectProfile semantics unchanged when the override is null, the default).
//
// 5. ConcurrencyScheduler observability triple — the host's upgrade predicate:
//    (generationInFlight, queueDepth, activeGenerations) reads (true,1,1)
//    while one generation runs and one queues, and (false,0,0) when drained.
//
// 6. retrieval/reranker.ts gains ResumableReranker — same options as
//    WorkerReranker plus onReload?: (ms: number) => void:
//      score(query, candidates): Promise<number[]>   // spawns/rebuilds transparently
//      embed(texts): Promise<number[][]>
//      unload(): Promise<void>      // terminates the worker WITHOUT disposing;
//                                    // the NEXT score()/embed() rebuilds it and
//                                    // reports the measured reload latency via
//                                    // onReload (finite, > 0)
//      dispose(): Promise<void>     // permanent; idempotent; safe after unload()
//
// 7. WorkerReranker.reportMemory(): Promise<{ rss: number; external: number;
//    arrayBuffers: number } | null> — resolves the worker's memory numbers, or
//    null when the worker was never started (it must NOT spawn just to ask).
//    Wire protocol: main -> worker { kind: 'memory', jobId }
//                   worker -> main { kind: 'memory:result', jobId,
//                                     memory: { rss, external, arrayBuffers } }
//
// 8. Host downgrade wiring: createMemoryTelemetry (seams) -> sample() ->
//    createPressureMonitor.observe(systemFreeMb MB, atMs) -> evaluate():
//    sustained sub-threshold => { downgraded: true, effectiveProfile: 'fast' };
//    then sustained above-threshold => recoveryEligible true while
//    effectiveProfile STAYS 'fast' (no silent auto-upgrade; AC3 hysteresis).
//
// 9. createMemoryTelemetry with DEFAULT providers (no seams) still yields all
//    seven numeric non-negative finite fields; with an rssProvider the
//    bytes -> MB conversion is exact (bytes / 1024 / 1024).
//
// 10. memory/budget.ts gains the worker-pool resolver (S4 — explicit, never
//     os.cpus()-derived):
//       export interface WorkerPoolConfig { embeddingWorkerPoolSize: number; rerankerWorkerPoolSize: number; }
//       export function resolveWorkerPoolConfig(env?): WorkerPoolConfig;
//     Env: TRAININGAPP_EMBEDDING_WORKER_POOL_SIZE / TRAININGAPP_RERANKER_WORKER_POOL_SIZE
//     (integers >= 1 only; junk/zero fall back to the default 1). The resolver
//     is HONEST — it reports the configured value (e.g. 3); the >1 REJECTION
//     (B7 single ORT-owner guardrail) happens at the CONSUMPTION site in the
//     host, deliberately not in the parser.
//
// 11. contracts/api.openapi.yaml drift: the frozen contract doc must contain
//     the path '/telemetry/memory:' and the schema names MemorySnapshot and
//     DowngradeState, and must not still carry info.version 2.3.0 (A6: adding
//     the route bumps the version).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMemoryConfig, resolveWorkerPoolConfig, createPressureMonitor } from '../../main/backend/memory/budget.js';
import { createMemoryTelemetry } from '../../main/backend/memory/telemetry.js';
import { ConcurrencyScheduler } from '../../main/backend/memory/scheduler.js';
import { IdleUnloadController } from '../../main/backend/memory/idle-unload.js';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server.js';
import { StubEngine } from '../../main/backend/engine.js';
import { createLoopbackGuard } from '../../main/security/loopback-guard.js';
import { WorkerReranker, ResumableReranker, WorkerEmbedder } from '../../main/backend/retrieval/reranker.js';
import { DEFAULT_PROFILE_THRESHOLD_GB } from '../../main/backend/inference/profile-select.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root discovery via the established contracts marker (b4/b6 convention). */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Fixture worker speaking the b7 protocol for all three job kinds — rerank
 * (immediate descending (n-i)/n scores), embed (fixed [0.25, 0.75] vector per
 * text), and memory (fixed rss/external/arrayBuffers) — so every C9 surface is
 * exercised with NO ONNX weights. Written to a temp dir AT RUNTIME.
 */
const FIXTURE_WORKER_SOURCE = [
  "import { parentPort } from 'node:worker_threads';",
  "parentPort.on('message', (msg) => {",
  "  if (!msg || typeof msg.jobId !== 'number') return;",
  "  if (msg.kind === 'rerank') {",
  '    const scores = msg.candidates.map((_, i) => (msg.candidates.length - i) / msg.candidates.length);',
  "    parentPort.postMessage({ kind: 'rerank:result', jobId: msg.jobId, scores });",
  '    return;',
  '  }',
  "  if (msg.kind === 'embed') {",
  '    const vectors = msg.texts.map(() => [0.25, 0.75]);',
  "    parentPort.postMessage({ kind: 'embed:result', jobId: msg.jobId, vectors });",
  '    return;',
  '  }',
  "  if (msg.kind === 'memory') {",
  "    parentPort.postMessage({ kind: 'memory:result', jobId: msg.jobId, memory: { rss: 111, external: 222, arrayBuffers: 333 } });",
  '  }',
  '});',
  '',
].join('\n');

function writeFixtureWorker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-c9-fixture-'));
  const file = path.join(dir, 'fixture-rerank-worker.mjs');
  fs.writeFileSync(file, FIXTURE_WORKER_SOURCE, 'utf8');
  return file;
}

const fixtureCleanups: Array<() => void> = [];

afterEach(() => {
  while (fixtureCleanups.length > 0) {
    const cleanup = fixtureCleanups.pop();
    try {
      cleanup?.();
    } catch {
      /* best effort */
    }
  }
});

describe('b8 C9: budget config cross-references (threshold + recovery window + pools)', () => {
  it(
    'pressureThresholdGb is B4\'s DEFAULT_PROFILE_THRESHOLD_GB (imported, not restated)',
    () => {
      expect(resolveMemoryConfig({}).pressureThresholdGb).toBe(DEFAULT_PROFILE_THRESHOLD_GB);
    },
    20_000,
  );

  it(
    'recoverySustainedMs defaults to 60000; TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS overrides; junk/zero fall back',
    () => {
      expect(resolveMemoryConfig({}).recoverySustainedMs).toBe(60000);
      const overridden = resolveMemoryConfig({ TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS: '1500' });
      expect(overridden.recoverySustainedMs).toBe(1500);
      expect(resolveMemoryConfig({ TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS: 'junk' }).recoverySustainedMs).toBe(60000);
      expect(resolveMemoryConfig({ TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS: '0' }).recoverySustainedMs).toBe(60000);
    },
    20_000,
  );

  it(
    'resolveWorkerPoolConfig is HONEST: explicit ints >= 1 reported, defaults 1, junk/zero -> default (rejection is host-side)',
    () => {
      expect(resolveWorkerPoolConfig({})).toMatchObject({ embeddingWorkerPoolSize: 1, rerankerWorkerPoolSize: 1 });
      expect(
        resolveWorkerPoolConfig({ TRAININGAPP_RERANKER_WORKER_POOL_SIZE: '3' }),
        'the resolver reports the configured value; >1 rejection happens at the host consumption site',
      ).toMatchObject({ embeddingWorkerPoolSize: 1, rerankerWorkerPoolSize: 3 });
      expect(resolveWorkerPoolConfig({ TRAININGAPP_EMBEDDING_WORKER_POOL_SIZE: '2' })).toMatchObject({
        embeddingWorkerPoolSize: 2,
        rerankerWorkerPoolSize: 1,
      });
      expect(resolveWorkerPoolConfig({ TRAININGAPP_RERANKER_WORKER_POOL_SIZE: 'many' }).rerankerWorkerPoolSize).toBe(1);
      expect(resolveWorkerPoolConfig({ TRAININGAPP_EMBEDDING_WORKER_POOL_SIZE: '0' }).embeddingWorkerPoolSize).toBe(1);
    },
    20_000,
  );
});

describe('b8 C9: /telemetry/memory without host wiring (503 fallback) + contract doc drift', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = createBackendServer({
      guard: createLoopbackGuard({ token: 'b8-c9-503-token' }),
      tokenHeaderName: 'X-Desktop-Token',
      engine: new StubEngine(),
      // deliberately NO telemetry option: the route degrades to 503
    });
    port = await listenOnRandomPort(server);
  }, 20_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it(
    'unwired server answers 503 with a JSON detail — the route is a KNOWN path, not 404-absent',
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/telemetry/memory`, {
        headers: { 'x-desktop-token': 'b8-c9-503-token' },
      });
      expect(response.status, 'no-telemetry-option degrades to 503 (503, never 404: the path is known)').toBe(503);
      expect(response.headers.get('content-type')).toBe('application/json');
      const body = (await response.json()) as { detail?: unknown };
      expect(body.detail, 'the 503 carries a human-readable detail string').toBeTypeOf('string');
      expect((body.detail as string).length).toBeGreaterThan(0);
    },
    20_000,
  );

  it(
    "contracts/api.openapi.yaml declares the route and both schemas, and the info version is bumped",
    () => {
      const yaml = fs.readFileSync(path.join(findRepoRoot(THIS_DIR), 'contracts', 'api.openapi.yaml'), 'utf8');
      expect(yaml, 'the OpenAPI spec must declare /telemetry/memory:').toContain('/telemetry/memory:');
      expect(yaml, 'the OpenAPI spec must declare the MemorySnapshot schema').toContain('MemorySnapshot');
      expect(yaml, 'the OpenAPI spec must declare the DowngradeState schema').toContain('DowngradeState');
      expect(yaml, 'adding the route requires an info.version bump (was 2.3.0)').not.toContain('version: 2.3.0');
    },
    20_000,
  );
});

describe('b8 C9: LlamaEngine profile override precedence (the downgrade actuator)', () => {
  it(
    "setProfileOverride beats an explicit inference.profile setting; null restores selectProfile semantics",
    () => {
      let freeBytes = 10 * GIB; // high free RAM
      const engine = new LlamaEngine({ freeMemBytes: () => freeBytes });

      // Baseline (override defaults to null): explicit 'quality' + high RAM -> quality.
      expect(engine.applySettingsPatch({ 'inference.profile': 'quality' }).ok).toBe(true);
      expect(engine.effectiveProfile(), 'explicit quality + high free RAM -> quality').toBe('quality');

      // selectProfile semantics unchanged: 'auto' + low RAM -> fast.
      freeBytes = 1 * GIB;
      expect(engine.applySettingsPatch({ 'inference.profile': 'auto' }).ok).toBe(true);
      expect(engine.effectiveProfile(), 'auto + low free RAM -> fast (B4 semantics unchanged)').toBe('fast');

      // The override WINS even against an explicit setting + high free RAM.
      freeBytes = 10 * GIB;
      expect(engine.applySettingsPatch({ 'inference.profile': 'quality' }).ok).toBe(true);
      engine.setProfileOverride('fast');
      expect(engine.effectiveProfile(), "override 'fast' beats settings-applied 'quality' + high free RAM").toBe('fast');

      // Clearing the override restores the pre-override answer.
      engine.setProfileOverride(null);
      expect(engine.effectiveProfile(), 'null override restores explicit quality + high free RAM -> quality').toBe(
        'quality',
      );
    },
    20_000,
  );
});

describe('b8 C9: scheduler observability triple (the host upgrade predicate)', () => {
  it(
    'reads (inFlight=true, queueDepth=1, active=1) with one running + one queued, then (false,0,0) drained',
    async () => {
      const scheduler = new ConcurrencyScheduler(); // default maxConcurrentGenerations 1
      const held1 = deferred();
      const held2 = deferred();
      const first = scheduler.runGeneration(() => held1.promise);
      await sleep(50);
      const second = scheduler.runGeneration(() => held2.promise);
      await sleep(50);
      expect(
        [scheduler.generationInFlight, scheduler.queueDepth, scheduler.activeGenerations],
        'the exact predicate the host checks before clearing a profile override',
      ).toEqual([true, 1, 1]);

      held1.resolve();
      held2.resolve();
      await Promise.all([first, second]);
      expect([scheduler.generationInFlight, scheduler.queueDepth, scheduler.activeGenerations]).toEqual([false, 0, 0]);
    },
    20_000,
  );
});

describe('b8 C9: ResumableReranker lifecycle (AC5 reload at the retrieval surface)', () => {
  it(
    'score -> unload -> score rebuilds transparently with a measured onReload latency; embed rebuilds too; dispose is idempotent after unload',
    async () => {
      const fixturePath = writeFixtureWorker();
      fixtureCleanups.push(() => fs.rmSync(path.dirname(fixturePath), { recursive: true, force: true }));
      const reloadLatencies: number[] = [];
      const resumable = new ResumableReranker({ workerPath: fixturePath, onReload: (ms) => reloadLatencies.push(ms) });

      // Session alive.
      const before = await resumable.score('first', ['a', 'b', 'c', 'd']);
      expect(before).toEqual([1, 0.75, 0.5, 0.25]);

      // Idle unload terminates the worker without disposing the instance.
      await resumable.unload();

      // Transparent rebuild on next use + measured reload latency.
      const afterUnload = await resumable.score('second', ['a', 'b']);
      expect(afterUnload, 'score() works after unload (transparent rebuild)').toEqual([1, 0.5]);
      expect(reloadLatencies.length, 'the rebuild reported its latency via onReload').toBeGreaterThanOrEqual(1);
      expect(reloadLatencies[0], 'the reload latency is a finite positive number of ms').toBeGreaterThan(0);
      expect(Number.isFinite(reloadLatencies[0])).toBe(true);

      // embed() rebuilds after a second unload (WorkerEmbedder wraps the same surface).
      await resumable.unload();
      const embedder = new WorkerEmbedder(resumable, 'b8-c9-embedder');
      const vectors = await embedder.embed(['hello']);
      expect(vectors, 'embed() works after unload (transparent rebuild)').toEqual([[0.25, 0.75]]);
      expect(reloadLatencies.length, 'the embed rebuild also reported its latency').toBeGreaterThanOrEqual(2);

      // dispose() after unload does not throw and is idempotent.
      await resumable.dispose();
      await resumable.dispose();
    },
    20_000,
  );
});

describe('b8 C9: WorkerReranker.reportMemory (per-worker RSS for the snapshot)', () => {
  it(
    "resolves null before the worker ever starts, then the worker's rss/external/arrayBuffers numbers",
    async () => {
      const fixturePath = writeFixtureWorker();
      fixtureCleanups.push(() => fs.rmSync(path.dirname(fixturePath), { recursive: true, force: true }));
      const runner = new WorkerReranker({ workerPath: fixturePath });

      // Never started: reportMemory must NOT spawn a worker just to ask.
      await expect(runner.reportMemory(), 'no worker yet -> null').resolves.toBeNull();

      const scores = await runner.score('memory probe', ['a', 'b', 'c', 'd']);
      expect(scores).toEqual([1, 0.75, 0.5, 0.25]);

      const memory = await runner.reportMemory();
      expect(memory, 'memory:result round-trips as numbers').toMatchObject({ rss: 111, external: 222, arrayBuffers: 333 });
      expect(memory?.rss).toBeTypeOf('number');
      expect(memory?.external).toBeTypeOf('number');
      expect(memory?.arrayBuffers).toBeTypeOf('number');

      await runner.dispose();
    },
    20_000,
  );
});

describe('b8 C9: host downgrade wiring composition (telemetry -> monitor -> decision)', () => {
  it(
    'sustained sub-threshold samples downgrade to fast; sustained recovery reports eligibility WITHOUT auto-flipping back',
    () => {
      const config = resolveMemoryConfig({});
      let freeBytes = 2 * GIB; // below the 6 GiB threshold
      const telemetry = createMemoryTelemetry({
        freeMemBytes: () => freeBytes,
        totalMemBytes: () => 16 * GIB,
        rssProvider: () => 0,
      });
      const monitor = createPressureMonitor({
        pressureThresholdGb: config.pressureThresholdGb,
        pressureSustainedMs: 200,
        recoverySustainedMs: 200,
      });

      // The host loop (compressed): sample -> observe -> evaluate.
      for (const t of [0, 100, 200, 300]) {
        monitor.observe(telemetry.sample().systemFreeMb * MIB, t);
      }
      const downgraded = monitor.evaluate(300);
      expect(downgraded, 'sustained sub-threshold free RAM downgrades the effective profile').toMatchObject({
        downgraded: true,
        effectiveProfile: 'fast',
      });

      // Recovery: free RAM back above threshold for the recovery window.
      freeBytes = 10 * GIB;
      for (const t of [400, 500, 600, 700]) {
        monitor.observe(telemetry.sample().systemFreeMb * MIB, t);
      }
      const recovered = monitor.evaluate(700);
      expect(recovered.recoveryEligible, 'sustained recovery reports upgrade eligibility').toBe(true);
      expect(recovered.effectiveProfile, 'NO silent auto-upgrade — the flip is host policy between generations').toBe(
        'fast',
      );
    },
    20_000,
  );

  it(
    'the idle-unload controller composes from the same resolved config (idleUnloadMs)',
    () => {
      const config = resolveMemoryConfig({});
      const controller = new IdleUnloadController({ idleUnloadMs: config.idleUnloadMs, unload: () => {} });
      controller.touch();
      expect(controller.unloadCount, 'armed but not elapsed').toBe(0);
      controller.dispose();
      expect(controller.lastReloadMs).toBe(null);
    },
    20_000,
  );

  it(
    'default telemetry providers yield all seven numeric non-negative fields; injected bytes map exactly to MB',
    () => {
      // Defaults (no seams at all): os.freemem/os.totalmem/process RSS paths.
      const defaults = createMemoryTelemetry();
      const snap = defaults.sample();
      for (const field of [
        'chromiumRssMb',
        'llmRssMb',
        'embeddingSessionRssMb',
        'rerankerSessionRssMb',
        'sqliteRssMb',
        'systemFreeMb',
        'systemTotalMb',
      ] as const) {
        expect(snap[field], `default snapshot.${field} is a number`).toBeTypeOf('number');
        expect(Number.isFinite(snap[field]), `default snapshot.${field} is finite`).toBe(true);
        expect(snap[field], `default snapshot.${field} is non-negative`).toBeGreaterThanOrEqual(0);
      }

      // Injected per-component bytes convert exactly (bytes / 1024 / 1024).
      const table: Record<string, number> = {
        chromium: 512 * MIB,
        llm: 2 * GIB,
        embeddingSession: 256 * MIB,
        rerankerSession: 128 * MIB,
        sqlite: 64 * MIB,
      };
      const injected = createMemoryTelemetry({
        freeMemBytes: () => 2 * GIB,
        totalMemBytes: () => 8 * GIB,
        rssProvider: (component: string) => table[component],
      });
      const exact = injected.sample();
      expect(exact.chromiumRssMb).toBe(512);
      expect(exact.llmRssMb).toBe(2048);
      expect(exact.embeddingSessionRssMb).toBe(256);
      expect(exact.rerankerSessionRssMb).toBe(128);
      expect(exact.sqliteRssMb).toBe(64);
      expect(exact.systemFreeMb).toBe(2048);
      expect(exact.systemTotalMb).toBe(8192);
    },
    20_000,
  );
});
