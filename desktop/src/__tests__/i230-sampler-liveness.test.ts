// i230-sampler-liveness.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #232 residual (c) — sub-defect (c) of PR #230's host lifecycle work;
// trace 199-230-backend-host-lifecycle).
//
// AC (DISCRIMINATING): WHEN a resumable.reportMemory() never settles (the
// tick holds the in-flight exclusion flag forever and every subsequent tick
// skips), THEN THE SYSTEM SHALL surface that wedge as an OBSERVABLE event on
// the host's onMemoryEvent stream — a sampler-staleness signal of type
// 'sampler-stale' — rather than freezing telemetry, downgrade/recovery
// emission, and the sampler pipeline with no signal at all.
// RED at base, GREEN after the fix. The 'sampler-stale' event does not exist
// at base; no event of that type is ever emitted, which is the defect.
//
// Drives the REAL NodeBackendHost + REAL LlamaEngine + REAL sampler interval
// (the backend-memory-tick-lifecycle.test.ts idiom); only os.freemem() is
// mocked. The wedged resumable is injected the same way AC3 of the lifecycle
// spec injects its gated one — post-start, on the private seam — except its
// reportMemory() returns a promise that NEVER settles. The observation window
// is several telemetry intervals long and witnessed by the tickCounter
// liveness helper, so the assertion proves a wedged pipeline under a LIVE
// dispatch loop, not a sampler that never ran.
//
// Feedback coverage (PR #241 review PRR-003/004/016/021): exactly-one latch,
// workerMemory stays null while wedged, the samplerStaleMs snapshot field
// through the real /telemetry/memory route (0 healthy, >0 while latched,
// back to 0 after restart), and no second event after a stop()->start()
// cycle (the witness reset is condition-scoped, issue #232's own class).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeBackendHost } from '../../main/backend/index.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import type { MemoryEvent } from '../../main/backend/types.js';

const GIB = 1024 ** 3;

// freemem() is the HOST-side pressure signal (index.ts monitor.observe); the
// ENGINE's own free-RAM seam is injected separately and kept HIGH.
const hostFree = vi.hoisted(() => ({ bytes: 1 * 1024 ** 3 }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = {
    ...actual,
    freemem: () => hostFree.bytes,
  };
  return {
    ...actual,
    default: mocked,
    freemem: mocked.freemem,
  };
});

const ENV = {
  TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS: '20',
  TRAININGAPP_MEMORY_PRESSURE_SUSTAINED_MS: '10',
  TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS: '10',
} as const;

const drain = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/** Poll every 10 ms until cond() is true or the deadline passes. */
const until = async (cond: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await drain(10);
};

/**
 * LIVENESS WITNESS (the backend-memory-tick-lifecycle.test.ts helper): counts
 * how many sampler ticks have actually been dispatched by wrapping the
 * per-instance `memoryTick` own property. Skipped ticks still count as
 * dispatches, so a growing count under a silent pipeline is exactly the
 * wedge signature.
 */
function tickCounter(host: NodeBackendHost): () => number {
  const h = host as unknown as { memoryTick: () => Promise<void> };
  const original = h.memoryTick.bind(host);
  let count = 0;
  h.memoryTick = (): Promise<void> => {
    count += 1;
    return original();
  };
  return () => count;
}

describe('issue 230 a wedged sampler is observable on the memory event stream', () => {
  let host: NodeBackendHost | null = null;

  afterEach(async () => {
    if (host !== null) {
      // stop() clears the interval and force-clears the in-flight flag; the
      // wedged tick's never-settling promise holds no event-loop handles.
      await host.stop().catch(() => {});
      host = null;
    }
  });

  it(
    'wedged-sampler-is-observable via a sampler-stale memory event',
    async () => {
      const engine = new LlamaEngine({
        freeMemBytes: () => 10 * GIB,
        modelDir: 'Z:/i230-wedge-none',
      });
      const events: MemoryEvent[] = [];

      host = new NodeBackendHost({
        token: 'i230-wedge-token',
        env: { ...ENV },
        engine,
        onMemoryEvent: (event) => events.push(event),
      });
      const ticks = tickCounter(host);
      await host.start();

      // HEALTHY-BASELINE (feedback PRR-003): while the sampler is healthy,
      // /telemetry/memory must report samplerStaleMs === 0 — this kills the
      // always-age mutant (computing Date.now() - startedAt unconditionally,
      // ignoring the latch) which the >0-latched assertion alone cannot.
      const healthy = await fetch(`${(host as unknown as { handle: { url: string } }).handle!.url}/telemetry/memory`, {
        headers: { 'X-Desktop-Token': 'i230-wedge-token' },
      });
      expect(healthy.status).toBe(200);
      const healthyBody = (await healthy.json()) as { snapshot: Record<string, number> };
      expect(
        healthyBody.snapshot.samplerStaleMs,
        'a healthy sampler reports samplerStaleMs === 0',
      ).toBe(0);

      // A resumable whose reportMemory() NEVER settles: the first tick that
      // reaches it suspends inside the await forever, holding the in-flight
      // exclusion flag, and every later tick skips at the guard. This is the
      // AC3 lifecycle-spec injection shape with the gate never released.
      const h = host as unknown as {
        resumable: { reportMemory: () => Promise<unknown> } | null;
      };
      h.resumable = {
        reportMemory: () => new Promise(() => {}),
      };

      // Let well over the required 2-3 telemetry intervals elapse (20ms
      // cadence, 300ms window). ANTI-VACUITY GUARD: the dispatch loop must be
      // PROVABLY alive across the window — a sampler that never ran would
      // trivially emit nothing.
      const ticksBefore = ticks();
      await drain(300);
      const ticksDuring = ticks() - ticksBefore;
      expect(
        ticksDuring,
        'harness sanity: the sampler dispatch loop kept firing while the pipeline was wedged',
      ).toBeGreaterThanOrEqual(3);

      // THE DISCRIMINATING ASSERTION: assert on the EVENT stream the host
      // forwards to the renderer as `memory:event`, through the shipped
      // MemoryEvent union (the type-level pin: a reverted union member fails
      // this comparison at typecheck, not just at runtime).
      const staleEvents = events.filter((e) => e.type === 'sampler-stale');
      expect(staleEvents.length, 'the wedge latches EXACTLY ONE sampler-stale event').toBe(1);

      // The frozen-pipeline claim: a wedged tick writes nothing.
      const hw = host as unknown as { workerMemory: unknown };
      expect(hw.workerMemory, 'workerMemory stays null while the tick is wedged').toBeNull();

      // samplerStaleMs through the REAL /telemetry/memory route (feedback
      // PRR-003/021): once the wedge has latched, the snapshot field reports
      // the in-flight age (>0) instead of a silent 0.
      const handle = (host as unknown as { handle: { port: number; url: string } }).handle;
      expect(handle, 'harness sanity: the host handle carries the bound server').toBeTruthy();
      const res = await fetch(`${handle!.url}/telemetry/memory`, {
        headers: { 'X-Desktop-Token': 'i230-wedge-token' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { snapshot: Record<string, number> };
      expect(
        body.snapshot.samplerStaleMs,
        'the wedged sampler reports a nonzero samplerStaleMs on /telemetry/memory',
      ).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    'stop clears the staleness witness: no second sampler-stale after a restart',
    async () => {
      const engine = new LlamaEngine({
        freeMemBytes: () => 10 * GIB,
        modelDir: 'Z:/i230-wedge-restart',
      });
      const events: MemoryEvent[] = [];

      host = new NodeBackendHost({
        token: 'i230-wedge-token',
        env: { ...ENV },
        engine,
        onMemoryEvent: (event) => events.push(event),
      });
      await host.start();

      const h = host as unknown as {
        resumable: { reportMemory: () => Promise<unknown> } | null;
      };
      h.resumable = { reportMemory: () => new Promise(() => {}) };
      await drain(300);
      const latched = events.filter((e) => e.type === 'sampler-stale');
      expect(latched.length, 'harness sanity: the first wedge latched').toBe(1);

      // issue #232's own class: the witness (startedAt / latch / interval)
      // must NOT outlive the condition. stop() zeroes it; the restarted host
      // admits fresh ticks (resumable null on the new seam), so no second
      // event may appear even with the sampler running.
      await host.stop();
      await host.start();
      const hw = host as unknown as {
        samplerStaleEmitted: boolean;
        memoryTickStartedAt: number;
        workerMemory: unknown;
      };
      expect(
        hw.samplerStaleEmitted,
        'the staleness latch is clear after a stop()->start() cycle',
      ).toBe(false);
      const eventsAfter = events.filter((e) => e.type === 'sampler-stale');
      await drain(120);
      expect(
        events.filter((e) => e.type === 'sampler-stale').length,
        'no second sampler-stale event after the restart',
      ).toBe(eventsAfter.length);
      // The restarted sampler admits fresh ticks (startedAt stamped at each
      // admission) and stays healthy — the real resumable reports null until
      // its worker is used, so health here is witnessed by admission + latch
      // state, not by workerMemory.
      await until(() => (hw.memoryTickStartedAt ?? 0) > 0, 5000);
      expect(
        hw.samplerStaleEmitted,
        'the restarted sampler stays unlatched (healthy)',
      ).toBe(false);
      // samplerStaleMs is back to 0 after the restart (feedback PRR-003:
      // kills the always-age mutant from the recovery side too).
      const restarted = await fetch(
        `${(host as unknown as { handle: { url: string } }).handle!.url}/telemetry/memory`,
        { headers: { 'X-Desktop-Token': 'i230-wedge-token' } },
      );
      expect(restarted.status).toBe(200);
      const restartedBody = (await restarted.json()) as { snapshot: Record<string, number> };
      expect(
        restartedBody.snapshot.samplerStaleMs,
        'samplerStaleMs returns to 0 after the restart',
      ).toBe(0);
    },
    30_000,
  );
});
