// i230-host-stop-profile-reset.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #232 residual (a) — sub-defect (a) of PR #230’s host lifecycle
// work; trace 199-230-backend-host-lifecycle).
//
// AC (DISCRIMINATING): WHEN sustained memory pressure has latched the B8
// engine profile override ('fast') via memoryTick's setProfileOverride, THEN
// THE SYSTEM SHALL clear that override as part of BackendHost.stop()
// teardown, so a host started again on the SAME engine instance reports the
// engine's own effective profile — here the explicit 'quality' setting — and
// not the stale pressure override from the previous lifecycle.
// RED at base, GREEN after the fix.
//
// The engine is constructed with an explicit profile 'quality', so with NO
// override latched effectiveProfile() is 'quality' by construction. The
// pressure episode is released BEFORE the restart (hostFree.bytes raised
// above the 6 GiB threshold) so the restarted sampler cannot legitimately
// re-latch a downgrade: any 'fast' observed after the restart can only be
// the stale override that stop() failed to clear.
//
// Drives the REAL NodeBackendHost + REAL LlamaEngine + REAL sampler interval
// (the backend-memory-tick-lifecycle.test.ts idiom); only os.freemem() is
// mocked so the pressure episode is deterministic. The post-restart
// observation window is bounded by the tickCounter liveness witness — no
// bare sleeps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeBackendHost } from '../../main/backend/index.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';

const GIB = 1024 ** 3;

// freemem() is the HOST-side pressure signal (index.ts monitor.observe); the
// ENGINE's own free-RAM seam is injected separately and kept HIGH so any
// 'fast' observed can only come from the host's pressure override.
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
 * LIVENESS WITNESS (the backend-memory-tick-lifecycle.test.ts helper): counts
 * how many sampler ticks have actually been dispatched by wrapping the
 * per-instance `memoryTick` own property.
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

describe('issue 230 host stop clears the latched engine profile override', () => {
  let host: NodeBackendHost | null = null;

  afterEach(async () => {
    if (host !== null) {
      await host.stop().catch(() => {});
      host = null;
    }
  });

  it(
    'stop-clears-latched-override across a restart on the same engine instance',
    async () => {
      hostFree.bytes = 1 * GIB; // below the 6 GiB default pressure threshold

      // Explicit profile 'quality': with no override latched, the engine's
      // effective profile is 'quality' by construction (an explicit setting
      // beats both the pressure override's absence and the auto-by-free-RAM
      // path). The engine's own free-RAM seam is kept HIGH.
      const engine = new LlamaEngine({
        profile: 'quality',
        freeMemBytes: () => 10 * GIB,
        modelDir: 'Z:/i230-stop-reset-none',
      });
      host = new NodeBackendHost({
        token: 'i230-stop-reset-token',
        env: { ...ENV },
        engine,
      });
      await host.start();

      // ANTI-VACUITY GUARD: sustained pressure must have latched the downgrade
      // BEFORE stop() — otherwise the post-restart assertion below could pass
      // simply because no override was ever latched.
      await until(() => engine.effectiveProfile() === 'fast', 5000);
      expect(
        engine.effectiveProfile(),
        'harness sanity: sustained pressure must have latched the fast override before stop',
      ).toBe('fast');

      await host.stop();

      // Release the pressure BEFORE the restart so the new generation's
      // sampler cannot legitimately re-latch a downgrade: any 'fast' after
      // this point is the stale override stop() failed to clear.
      hostFree.bytes = 16 * GIB;

      // Same host instance, same engine instance (engine is a private
      // readonly constructor property; runStart does not recreate it).
      await host.start();

      // Let the RESTARTED sampler actually run under released pressure (the
      // liveness witness bounds this window): prove the new generation ticked
      // at least twice, then measure the engine's profile.
      const ticks = tickCounter(host);
      await until(() => ticks() >= 2, 5000);
      expect(ticks(), 'harness sanity: the restarted sampler ticked').toBeGreaterThanOrEqual(2);
      await drain(60); // a few more intervals at 20ms cadence, bounded

      // THE DISCRIMINATING ASSERTION: the restart must observe the engine's
      // own profile, not the previous lifecycle's stale pressure override.
      expect(engine.effectiveProfile()).toBe('quality');
    },
    30_000,
  );
});
