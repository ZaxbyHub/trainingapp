// i230-sampler-liveness.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #230 sub-defect (c); trace 199-230-backend-host-lifecycle).
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
      // forwards to the renderer as `memory:event`. The staleness signal is
      // compared as a plain string so this spec compiles against the current
      // MemoryEvent union, which does not yet carry a 'sampler-stale' type.
      const stale = events.find((e) => (e as { type: string }).type === 'sampler-stale');
      expect(stale).toBeTruthy();
    },
    30_000,
  );
});
