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
      await host.start();

      await until(() => engine.effectiveProfile() === 'fast', 5000);
      expect(
        engine.effectiveProfile(),
        'the sampler still latches the downgrade during normal operation',
      ).toBe('fast');

      // Quiescence: several further ticks under the SAME sustained pressure
      // must not re-latch or re-emit (the latch is edge-triggered).
      await drain(150);

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
});
