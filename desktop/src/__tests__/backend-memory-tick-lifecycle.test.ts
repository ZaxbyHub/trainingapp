// backend-memory-tick-lifecycle.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #229 sub-defect (b); trace 199-229-backend-host-lifecycle).
//
// AC3 (DISCRIMINATING): WHEN a memory tick is in flight across stop(), THEN
// THE SYSTEM SHALL NOT write workerMemory, latch downgradeLatched, call
// setProfileOverride, or emit a downgrade event after teardown completes.
// RED at base, GREEN after the fix.
//
// AC4 (PRESERVING): THE SYSTEM SHALL keep the sampler working during normal
// operation — sustained low memory still latches a single downgrade to fast
// with one event. GREEN at base and after the fix.
//
// Both tests drive the REAL NodeBackendHost + REAL LlamaEngine + REAL sampler
// interval; only os.freemem() is mocked so the pressure episode is
// deterministic (the b8-host-loop.test.ts idiom). The AC3 in-flight tick is
// deterministic by construction: the injected resumable's reportMemory()
// signals entry BEFORE suspending on a gate promise the test releases, so
// stop() provably runs while the tick is suspended inside its await — no
// sleep-based race.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeBackendHost } from '../../main/backend/index.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import type { MemoryEvent } from '../../main/backend/types.js';

const GIB = 1024 ** 3;

// freemem() is the HOST-side pressure signal (index.ts monitor.observe); the
// ENGINE's own free-RAM seam is injected separately and kept HIGH so any
// 'fast' observed can only come from the pressure override. Held at 1 GiB,
// below the 6 GiB default pressure threshold, for the whole of both tests.
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
async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await drain(10);
}

/**
 * LIVENESS WITNESS helper: counts how many sampler ticks have actually run.
 *
 * The host starts the sampler with a bare `setInterval(() => { void
 * this.memoryTick().catch(...) }, ...)`, so the only observable proof that the
 * loop is alive is to count invocations. Wrapping the per-instance
 * `memoryTick` arrow property (it is an own property, assigned in the class
 * field initializer) intercepts every dispatch without touching production
 * code or the interval itself.
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

describe('issue 229 memory tick lifecycle across stop', () => {
  let host: NodeBackendHost | null = null;

  afterEach(async () => {
    if (host !== null) {
      await host.stop().catch(() => {});
      host = null;
    }
  });

  it(
    'AC3 a memory tick in flight across stop must not write host or engine state',
    async () => {
      const engine = new LlamaEngine({
        freeMemBytes: () => 10 * GIB,
        modelDir: 'Z:/i229-memtick-none',
      });
      const setProfileOverride = vi.spyOn(engine, 'setProfileOverride');
      const events: MemoryEvent[] = [];

      host = new NodeBackendHost({
        token: 'i229-memtick-token',
        env: { ...ENV },
        engine,
        onMemoryEvent: (event) => events.push(event),
      });
      await host.start();

      // ANTI-VACUITY GUARD: sustained pressure must already have latched the
      // downgrade BEFORE stop() — otherwise the post-stop assertions below
      // could pass simply because no downgrade was ever pending.
      await until(() => engine.effectiveProfile() === 'fast', 5000);
      expect(
        engine.effectiveProfile(),
        'harness sanity: sustained pressure must have latched the downgrade before stop',
      ).toBe('fast');
      expect(
        setProfileOverride,
        'harness sanity: the downgrade override was applied before stop',
      ).toHaveBeenCalled();

      // From here on, measure ONLY post-stop activity.
      setProfileOverride.mockClear();
      events.length = 0;

      // A resumable whose reportMemory() never settles until released: a tick
      // is guaranteed to be suspended INSIDE the racing await when stop()
      // runs. The entry signal fires before the gate suspension, making the
      // interleaving deterministic rather than a sleep-based race.
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signalEntered: (() => void) | null = null;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const h = host as unknown as {
        resumable: { reportMemory: () => Promise<unknown> } | null;
        memoryTick: () => Promise<void>;
        workerMemory: unknown;
        downgradeLatched: boolean;
      };
      h.resumable = {
        reportMemory: async () => {
          signalEntered?.();
          await gate;
          return { rss: 1, external: 2, arrayBuffers: 3 };
        },
      };

      const tick = h.memoryTick();
      await entered; // deterministic: the tick is suspended inside reportMemory()

      await host.stop(); // teardown while the tick is suspended

      release?.();
      await tick.catch(() => {});
      await drain(120); // let every chained task of the resumed tick land

      // stop() nulls workerMemory and resets downgradeLatched; a tick that
      // resumes past its await after teardown writes all four of these back
      // at base. None of them may change after teardown completes.
      expect(
        h.workerMemory,
        'no post-stop workerMemory write from an in-flight tick',
      ).toBeNull();
      expect(h.downgradeLatched, 'no post-stop downgradeLatched latch write').toBe(false);
      expect(setProfileOverride, 'no post-stop engine profile override').not.toHaveBeenCalled();
      expect(events, 'no post-stop memory event').toHaveLength(0);
    },
    30_000,
  );

  it(
    'AC4 sustained pressure latches exactly one downgrade with one event',
    async () => {
      const engine = new LlamaEngine({
        freeMemBytes: () => 10 * GIB,
        modelDir: 'Z:/i229-memtick-none',
      });
      const setProfileOverride = vi.spyOn(engine, 'setProfileOverride');
      const events: MemoryEvent[] = [];

      host = new NodeBackendHost({
        token: 'i229-memtick-token',
        env: { ...ENV },
        engine,
        onMemoryEvent: (event) => events.push(event),
      });
      const tickCount = tickCounter(host);
      await host.start();

      await until(() => engine.effectiveProfile() === 'fast', 5000);
      expect(
        engine.effectiveProfile(),
        'the sampler still latches the downgrade during normal operation',
      ).toBe('fast');

      // Quiescence: several further ticks under the SAME sustained pressure
      // must not re-latch or re-emit (the latch is edge-triggered).
      //
      // LIVENESS WITNESS (PRR review finding): the two "exactly one"
      // assertions below are equally satisfied by a sampler that wedged right
      // after the first latch — which is precisely the new failure mode this
      // fix introduces (an in-flight exclusion flag that is never released).
      // So prove the sampler kept running during the observation window before
      // proving it stayed quiet.
      const ticksBefore = tickCount();
      await drain(150);
      const ticksDuring = tickCount() - ticksBefore;
      expect(
        ticksDuring,
        `the sampler must keep ticking through the quiescence window (saw ${ticksDuring})`,
      ).toBeGreaterThan(0);

      expect(
        setProfileOverride.mock.calls.filter((call) => call[0] === 'fast'),
        'exactly one downgrade override fires during sustained pressure',
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'downgrade'),
        'exactly one downgrade event fires during sustained pressure',
      ).toHaveLength(1);
    },
    20_000,
  );

  // AC10 (PRR review finding H1): the in-flight exclusion must be GENERATION-
  // BOUND. A tick suspended across stop()->start() resumes, fails the
  // generation check, and must NOT clear the exclusion a NEW generation's tick
  // holds — otherwise a third tick is admitted concurrently with the new one,
  // which is exactly the invariant the fix comment claims. Execution-proven
  // defect at the previous head (maxConcurrentReportMemory: 2).
  it(
    'AC10 a stale tick across stop then start must not release the new generation exclusion',
    async () => {
      const engine = new LlamaEngine({
        freeMemBytes: () => 10 * GIB,
        modelDir: 'Z:/i229-memtick-none',
      });
      const ac10Events: MemoryEvent[] = [];
      host = new NodeBackendHost({
        token: 'i229-memtick-token',
        env: { ...ENV },
        engine,
        onMemoryEvent: (event) => ac10Events.push(event),
      });
      await host.start();

      // Each reportMemory() call gets its OWN gate, so the test can release the
      // stale generation's tick while the new generation's tick is still
      // suspended — the exact interleaving the defect needs.
      const gates: Array<() => void> = [];
      let inFlight = 0;
      let maxConcurrent = 0;
      const makeResumable = (): { reportMemory: () => Promise<unknown> } => ({
        reportMemory: async () => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise<void>((resolve) => gates.push(resolve));
          inFlight -= 1;
          return { rss: 1, external: 2, arrayBuffers: 3 };
        },
      });
      const h = host as unknown as {
        resumable: { reportMemory: () => Promise<unknown> } | null;
        memoryTick: () => Promise<void>;
      };
      h.resumable = makeResumable();

      // Generation 0: one tick enters and suspends inside reportMemory().
      const staleTick = h.memoryTick();
      await new Promise((r) => setTimeout(r, 40));
      expect(gates.length, 'harness sanity: the stale tick entered reportMemory').toBe(1);
      expect(inFlight, 'harness sanity: exactly one tick is in flight').toBe(1);

      // Teardown bumps the generation and force-clears the flag.
      await host.stop();

      // A new generation starts. stop() nulled this.resumable and runStart does
      // not rebuild it on the hash-embedder path, so re-inject the suspending
      // seam before driving the new generation's first tick.
      await host.start();
      h.resumable = makeResumable();
      const newTick = h.memoryTick();
      await new Promise((r) => setTimeout(r, 40));
      expect(gates.length, 'harness sanity: the new tick entered reportMemory').toBe(2);
      expect(inFlight, 'harness sanity: both ticks are suspended in flight').toBe(2);

      // Release ONLY the stale generation's tick. It fails its generation check
      // and unwinds; the new generation's tick is still suspended.
      gates[0]?.();
      await staleTick.catch(() => {});
      await new Promise((r) => setTimeout(r, 40));

      // THE GUARD: the stale tick's finally must not have released the new
      // generation's exclusion. With the un-tokened release a further tick is
      // admitted while the new one is still suspended (maxConcurrent 3, and a
      // third gate appears). Probe: swap the finally's guard for an
      // unconditional `this.memoryTickInflight = false;` and this goes RED.
      expect(
        gates.length,
        'no further tick may be admitted while the new generation tick is suspended',
      ).toBe(2);
      expect(
        maxConcurrent,
        'no tick may run concurrently with an in-flight tick of another generation',
      ).toBe(2);

      // Release the new generation's tick and let it complete.
      gates[1]?.();
      await newTick.catch(() => {});
      await host.stop().catch(() => {});
      host = null;
    },
    30_000,
  );
});
