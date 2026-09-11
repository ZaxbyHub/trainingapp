// b8-pressure-downgrade.test.ts — FROZEN ACCEPTANCE SPEC (issue #66 trace, AC2 + AC3 support, checks S1/S2/S6, check C2).
//
// NEW-SURFACE: statically imports desktop/main/backend/memory/budget.js and
// desktop/main/backend/memory/telemetry.js, neither of which exists at the
// base revision — the whole file fails collection with a module-not-found
// error, which IS the acceptance evidence for the missing memory subsystem.
//
// FROZEN PRODUCTION CONTRACT #1 — module desktop/main/backend/memory/budget.ts:
//
//   export interface MemoryBudgetConfig {
//     telemetryIntervalMs: number;   // default 5000   (memory.telemetryIntervalMs)
//     maxTotalGb: number;            // default 16     (memory.maxTotalGb)
//     pressureThresholdGb: number;   // default 6      (memory.pressureThresholdGb, cross-referenced
//                                    //                 with B4 inference.profileThresholdGb)
//     pressureSustainedMs: number;   // default 10000  (memory.pressureSustainedMs)
//     idleUnloadMs: number;          // default 300000 (memory.idleUnloadMs)
//   }
//   export function resolveMemoryConfig(
//     env?: Record<string, string | undefined>,   // default process.env
//   ): MemoryBudgetConfig;
//
//   Env overrides follow the established per-subsystem pattern (explicit
//   positive integers only; any invalid value falls back to that key's
//   default — exactly like ingest/config.ts):
//     TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS
//     TRAININGAPP_MEMORY_MAX_TOTAL_GB
//     TRAININGAPP_MEMORY_PRESSURE_THRESHOLD_GB
//     TRAININGAPP_MEMORY_PRESSURE_SUSTAINED_MS
//     TRAININGAPP_MEMORY_IDLE_UNLOAD_MS
//
//   Downgrade decision — a PURE, synchronously testable state machine (no
//   polling loop inside the monitor; the host feeds it samples):
//
//   export type MemoryComponent = 'chromium' | 'llm' | 'embeddingSession' | 'rerankerSession' | 'sqlite';
//   export interface PressureMonitorOptions {
//     pressureThresholdGb?: number;   // default from resolveMemoryConfig
//     pressureSustainedMs?: number;   // default from resolveMemoryConfig
//     recoverySustainedMs?: number;   // default: pressureSustainedMs
//     nowMs?: () => number;           // clock seam, default Date.now
//   }
//   export interface PressureStatus {
//     downgraded: boolean;            // true once sub-threshold free RAM sustained >= pressureSustainedMs
//     effectiveProfile: 'quality' | 'fast';  // 'fast' iff downgraded (NO silent auto-upgrade)
//     recoveryEligible: boolean;      // true once above-threshold free RAM sustained >= recoverySustainedMs
//   }                                 //   — eligibility ONLY; the upgrade transition is host
//                                     //   policy between generations (AC3, no thrash)
//   export interface PressureMonitor {
//     observe(freeBytes: number, atMs?: number): void;
//     evaluate(atMs?: number): PressureStatus;
//   }
//   export function createPressureMonitor(options?: PressureMonitorOptions): PressureMonitor;
//
//   Semantics pinned below:
//     - pressure boundary is INCLUSIVE like B4 selectProfile: freeBytes
//       >= pressureThresholdGb GiB is NOT pressure; strictly below is;
//     - a pressure streak broken by an above-threshold sample never matures;
//     - once downgraded, effectiveProfile stays 'fast' until the host upgrades
//       it; sustained recovery only flips recoveryEligible.
//
// FROZEN PRODUCTION CONTRACT #2 — module desktop/main/backend/memory/telemetry.ts:
//
//   export interface MemorySnapshot {   // MB fields, 1 MB = 1024 * 1024 bytes
//     chromiumRssMb: number;
//     llmRssMb: number;
//     embeddingSessionRssMb: number;
//     rerankerSessionRssMb: number;
//     sqliteRssMb: number;
//     systemFreeMb: number;
//     systemTotalMb: number;
//   }
//   export interface MemoryTelemetryOptions {
//     freeMemBytes?: () => number;    // default os.freemem()
//     totalMemBytes?: () => number;   // default os.totalmem()
//     rssProvider?: (component: MemoryComponent) => number;  // returns BYTES
//     intervalMs?: number;            // default resolveMemoryConfig().telemetryIntervalMs
//   }
//   export interface MemoryTelemetry {
//     sample(): MemorySnapshot;       // takes a fresh sample through the seams and records it
//     snapshot(): MemorySnapshot;     // returns the latest sample WITHOUT re-sampling
//                                     // (lazily takes one if none exists yet)
//   }
//   export function createMemoryTelemetry(options?: MemoryTelemetryOptions): MemoryTelemetry;
import { describe, expect, it } from 'vitest';
import { resolveMemoryConfig, createPressureMonitor } from '../../main/backend/memory/budget.js';
import { createMemoryTelemetry } from '../../main/backend/memory/telemetry.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const ENV = {
  telemetryIntervalMs: 'TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS',
  maxTotalGb: 'TRAININGAPP_MEMORY_MAX_TOTAL_GB',
  pressureThresholdGb: 'TRAININGAPP_MEMORY_PRESSURE_THRESHOLD_GB',
  pressureSustainedMs: 'TRAININGAPP_MEMORY_PRESSURE_SUSTAINED_MS',
  idleUnloadMs: 'TRAININGAPP_MEMORY_IDLE_UNLOAD_MS',
} as const;

/** Structural local types: the implementer's exports must be assignable to these. */
interface PressureStatus {
  downgraded: boolean;
  effectiveProfile: string;
  recoveryEligible: boolean;
}
interface PressureMonitor {
  observe(freeBytes: number, atMs?: number): unknown;
  evaluate(atMs?: number): PressureStatus;
}
interface MemorySnapshot {
  chromiumRssMb: number;
  llmRssMb: number;
  embeddingSessionRssMb: number;
  rerankerSessionRssMb: number;
  sqliteRssMb: number;
  systemFreeMb: number;
  systemTotalMb: number;
}
interface MemoryTelemetry {
  sample(): MemorySnapshot;
  snapshot(): MemorySnapshot;
}

/** Monitor with short windows and explicit timestamps: pure, ~0 ms wall time. */
function monitor(pressureSustainedMs = 200, recoverySustainedMs = 200): PressureMonitor {
  return createPressureMonitor({ pressureThresholdGb: 6, pressureSustainedMs, recoverySustainedMs });
}

describe('b8 C2 (S2): resolveMemoryConfig defaults + env overrides', () => {
  it('defaults are the documented 16 GB runtime budget', () => {
    const config = resolveMemoryConfig({});
    expect(config.telemetryIntervalMs).toBe(5000);
    expect(config.maxTotalGb).toBe(16);
    expect(config.pressureThresholdGb).toBe(6);
    expect(config.pressureSustainedMs).toBe(10000);
    expect(config.idleUnloadMs).toBe(300000);
  });

  it('explicit positive env values override; invalid values fall back to defaults', () => {
    const overridden = resolveMemoryConfig({
      [ENV.telemetryIntervalMs]: '1000',
      [ENV.maxTotalGb]: '8',
      [ENV.pressureThresholdGb]: '4',
      [ENV.pressureSustainedMs]: '2500',
      [ENV.idleUnloadMs]: '60000',
    });
    expect(overridden.telemetryIntervalMs).toBe(1000);
    expect(overridden.maxTotalGb).toBe(8);
    expect(overridden.pressureThresholdGb).toBe(4);
    expect(overridden.pressureSustainedMs).toBe(2500);
    expect(overridden.idleUnloadMs).toBe(60000);

    const notANumber = resolveMemoryConfig({ [ENV.maxTotalGb]: 'not-a-number' });
    expect(notANumber.maxTotalGb).toBe(16);
    // Explicit positive integers only: zero is invalid and falls back.
    const zero = resolveMemoryConfig({ [ENV.pressureSustainedMs]: '0' });
    expect(zero.pressureSustainedMs).toBe(10000);
  });
});

describe('b8 C2 (AC2): sustained memory pressure flips the effective profile quality -> fast', () => {
  it('a sub-threshold free-RAM streak flips to fast only once it is SUSTAINED', () => {
    const m = monitor(); // pressureSustainedMs = 200
    m.observe(4 * GIB, 0); // below 6 GiB from t=0
    expect(m.evaluate(100), '100ms of pressure (< 200ms) must not downgrade yet').toMatchObject({
      downgraded: false,
      effectiveProfile: 'quality',
      recoveryEligible: false,
    });
    expect(m.evaluate(200), '>= 200ms of sustained pressure downgrades (AC2)').toMatchObject({
      downgraded: true,
      effectiveProfile: 'fast',
      recoveryEligible: false,
    });
  });

  it('a pressure streak broken by an above-threshold sample never matures', () => {
    const broken = monitor();
    broken.observe(4 * GIB, 0);
    broken.observe(7 * GIB, 50); // streak broken long before it could mature
    expect(broken.evaluate(400).downgraded).toBe(false);
    expect(broken.evaluate(400).effectiveProfile).toBe('quality');
  });

  it('the pressure boundary is inclusive: exactly pressureThresholdGb GiB free is NOT pressure', () => {
    // Cross-references B4 selectProfile: quality when freeBytes >= threshold * GIB.
    const boundary = monitor();
    boundary.observe(6 * GIB, 0);
    expect(boundary.evaluate(400).downgraded).toBe(false);
  });
});

describe('b8 C2 (AC3): recovery hysteresis — eligibility only, never a silent auto-upgrade', () => {
  it('does NOT flip back mid-recovery-window, and sustained recovery only reports eligibility', () => {
    const m = monitor(); // pressureSustainedMs = 200, recoverySustainedMs = 200
    m.observe(4 * GIB, 0);
    expect(m.evaluate(200).effectiveProfile, 'precondition: downgraded to fast').toBe('fast');

    m.observe(8 * GIB, 300); // free RAM back above threshold: recovery streak starts
    const mid = m.evaluate(400); // 100ms into recovery (< 200ms window)
    expect(mid.effectiveProfile, 'no flip back mid-recovery-window').toBe('fast');
    expect(mid.recoveryEligible).toBe(false);

    const mature = m.evaluate(500); // 200ms into recovery (>= recoverySustainedMs)
    expect(mature.recoveryEligible, 'sustained recovery reports upgrade eligibility').toBe(true);
    expect(
      mature.effectiveProfile,
      'NO silent auto-upgrade: eligibility only — the upgrade transition is host policy between generations',
    ).toBe('fast');
  });
});

describe('b8 C2 (S1): MemoryTelemetry maps injectable seams onto the documented snapshot', () => {
  it('sample() converts seam BYTES to MB (1 MB = 1024*1024) for all seven fields', () => {
    const rssTable: Record<string, number> = {
      chromium: 512 * MIB,
      llm: 2 * GIB,
      embeddingSession: 256 * MIB,
      rerankerSession: 128 * MIB,
      sqlite: 64 * MIB,
    };
    let freeCalls = 0;
    const telemetry: MemoryTelemetry = createMemoryTelemetry({
      freeMemBytes: () => {
        freeCalls += 1;
        return 2 * GIB;
      },
      totalMemBytes: () => 8 * GIB,
      rssProvider: (component: string) => rssTable[component],
    });

    const snap = telemetry.sample();
    expect(snap.systemFreeMb).toBe(2048);
    expect(snap.systemTotalMb).toBe(8192);
    expect(snap.chromiumRssMb).toBe(512);
    expect(snap.llmRssMb).toBe(2048);
    expect(snap.embeddingSessionRssMb).toBe(256);
    expect(snap.rerankerSessionRssMb).toBe(128);
    expect(snap.sqliteRssMb).toBe(64);
  });

  it('snapshot() returns the LATEST sample without re-sampling, and lazily samples when none exists', () => {
    let freeCalls = 0;
    const telemetry: MemoryTelemetry = createMemoryTelemetry({
      freeMemBytes: () => {
        freeCalls += 1;
        return 2 * GIB;
      },
      totalMemBytes: () => 8 * GIB,
      rssProvider: () => 0,
    });

    // Lazy: snapshot() before any sample() takes exactly one sample.
    const first = telemetry.snapshot();
    expect(first.systemFreeMb).toBe(2048);
    expect(freeCalls).toBe(1);

    // snapshot() afterwards returns the same latest sample with NO new sampling.
    const again = telemetry.snapshot();
    expect(freeCalls).toBe(1);
    expect(again).toEqual(first);

    // sample() takes a fresh one through the seams.
    const fresh = telemetry.sample();
    expect(freeCalls).toBe(2);
    expect(fresh.systemFreeMb).toBe(2048);
  });
});
