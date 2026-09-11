// b8-host-loop.test.ts — PR-review regression pin (PRR-F1/PRR-F6, issue #66
// PR #104 review round). ADDITIVE spec: not part of the frozen checkpoint
// set; it exists because the frozen b8 specs exercise the memory units and
// the frozen route/scheduler seams but never the REAL NodeBackendHost
// memoryTick loop across ticks — the exact seam where the downgrade/upgrade
// oscillation (fast/quality re-latch every ~2 ticks after one pressure
// episode) shipped and passed CI.
//
// What this pins, end to end through the REAL host loop (real
// NodeBackendHost + real LlamaEngine + real PressureMonitor + real sampler
// interval; only os.freemem() is mocked so the pressure episodes are
// deterministic):
//   1. sustained sub-threshold os.freemem() latches the override
//      (effectiveProfile 'fast' even though the ENGINE sees ample RAM — the
//      override, not auto-selection, must be the cause) + downgrade event;
//   2. sustained recovery + drained scheduler clears the override
//      (effectiveProfile back to 'quality') + recovery-eligible and
//      override-cleared events;
//   3. THE REGRESSION: ticks after the upgrade produce NO further events and
//      the profile STAYS quality (the monitor ack resets the latch — no
//      fast/quality oscillation).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { NodeBackendHost } from '../../main/backend/index.js';
import { LlamaEngine } from '../../main/backend/inference/llama-engine.js';
import type { MemoryEvent } from '../../main/backend/types.js';

const GIB = 1024 ** 3;

// freemem() is the HOST-side pressure signal (index.ts monitor.observe); the
// ENGINE's own free-RAM seam is injected separately and kept HIGH so any
// 'fast' observed in phase A can only come from the pressure override.
const hostFree = vi.hoisted(() => ({ bytes: 10 * 1024 ** 3 }));

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
  TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS: '25',
  TRAININGAPP_MEMORY_PRESSURE_SUSTAINED_MS: '80',
  TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS: '80',
} as const;

describe('b8 host loop (PRR-F1 regression pin): real memoryTick across ticks', () => {
  let host: NodeBackendHost | null = null;
  let events: MemoryEvent[] = [];
  let engine: LlamaEngine;

  const drain = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  afterEach(async () => {
    if (host !== null) {
      await host.stop().catch(() => {});
      host = null;
    }
  });

  it(
    'downgrade latches once, upgrade clears the override, and post-upgrade ticks do NOT re-downgrade (no oscillation)',
    async () => {
      let engineFree = 10 * GIB; // engine auto-selection would say 'quality'
      engine = new LlamaEngine({ freeMemBytes: () => engineFree, modelDir: 'Z:/b8-host-loop-none' });
      events = [];
      host = new NodeBackendHost({
        token: 'b8-host-loop-token',
        env: { ...ENV },
        engine,
        onMemoryEvent: (event) => events.push(event),
      });
      await host.start();

      // Phase A: sustained sub-threshold HOST free RAM -> override latches.
      hostFree.bytes = 1 * GIB;
      await drain(500);
      const afterPressure = engine.effectiveProfile();
      expect(
        afterPressure,
        'sustained host-level pressure must downgrade the effective profile',
      ).toBe('fast');
      expect(events.some((e) => e.type === 'downgrade'), 'a downgrade event fired').toBe(true);
      const eventsAfterPressure = events.length;

      // Phase B: sustained recovery -> eligibility -> override cleared.
      hostFree.bytes = 12 * GIB;
      await drain(700);
      expect(
        engine.effectiveProfile(),
        'sustained recovery must clear the override (back to auto quality)',
      ).toBe('quality');
      expect(events.some((e) => e.type === 'recovery-eligible'), 'recovery-eligible fired').toBe(
        true,
      );
      expect(
        events.some((e) => e.type === 'telemetry'),
        'the override-cleared telemetry event fired',
      ).toBe(true);

      // Phase C (THE PIN): healthy ticks after the upgrade must be quiet —
      // no re-downgrade, no event spam, profile stable at quality. Before the
      // PRR-F1 fix this phase re-latched 'fast' every other tick.
      const eventsBeforeQuiet = events.length;
      await drain(900); // ~36 ticks at the 25 ms interval
      expect(engine.effectiveProfile(), 'profile must STAY quality after the upgrade').toBe(
        'quality',
      );
      expect(
        events.length,
        `no events may fire after the upgrade (had ${eventsBeforeQuiet}, got ${events.length}: ${JSON.stringify(events.slice(eventsBeforeQuiet))})`,
      ).toBe(eventsBeforeQuiet);
      expect(eventsAfterPressure).toBeGreaterThan(0);

      // Teardown exercises the B8 stop() path as well.
      await host.stop();
      host = null;
    },
    20_000,
  );
});
