// memory/budget.ts — the 16 GB runtime memory budget (issue #66, S2/S6).
//
// Pure configuration + decision logic: the resolve* helpers follow the
// established per-subsystem pattern (explicit positive integers only; any
// invalid value falls back to that key's default — exactly like
// ingest/config.ts and inference/llama-engine.ts's env ingress), and the
// pressure monitor is a synchronous state machine the host feeds samples
// into (no polling loop lives here; the host owns the timer).
//
// Cross-reference contract (b8-wiring C9 pins it): pressureThresholdGb is
// IMPORTED from inference/profile-select.js — B4's inference.profileThresholdGb
// and B8's memory.pressureThresholdGb are the SAME threshold by construction,
// so the two knobs cannot drift apart.
import { DEFAULT_PROFILE_THRESHOLD_GB } from '../inference/profile-select.js';

const GIB = 1024 ** 3;

/** The measurable memory components (the MemorySnapshot budget lines, S1). */
export type MemoryComponent = 'chromium' | 'llm' | 'embeddingSession' | 'rerankerSession' | 'sqlite';

export interface MemoryBudgetConfig {
  /** memory.telemetryIntervalMs — host sampler cadence (default 5000). */
  telemetryIntervalMs: number;
  /** memory.maxTotalGb — the ACCOUNTING ceiling: the component table (ADR-0008 /
 *  bench/RESULTS.md) must sum under it with headroom. It is enforced
 *  procedurally (ADR accounting + soak evidence), not as a runtime kill-switch. */
  maxTotalGb: number;
  /** memory.pressureThresholdGb — B4's inference.profileThresholdGb (default 6). */
  pressureThresholdGb: number;
  /** memory.pressureSustainedMs — sub-threshold streak that latches the downgrade (default 10000). */
  pressureSustainedMs: number;
  /** memory.recoverySustainedMs — above-threshold streak before upgrade ELIGIBILITY (default 60000). */
  recoverySustainedMs: number;
  /** memory.idleUnloadMs — idle window before ONNX sessions unload (default 300000). */
  idleUnloadMs: number;
}

/** Explicit positive integers only, bounded to the 32-bit timer range: junk or
 *  out-of-range values fall back to the default. Values above 2^31-1 reaching
 *  setInterval/setTimeout get silently CLAMPED TO 1ms by Node
 *  (TimeoutOverflowWarning) — a hot loop (PRR-F3). */
const MAX_TIMER_MS = 2147483647;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : fallback;
}

export function resolveMemoryConfig(env: Record<string, string | undefined> = process.env): MemoryBudgetConfig {
  return {
    telemetryIntervalMs: positiveInt(env.TRAININGAPP_MEMORY_TELEMETRY_INTERVAL_MS, 5000),
    maxTotalGb: positiveInt(env.TRAININGAPP_MEMORY_MAX_TOTAL_GB, 16),
    pressureThresholdGb: positiveInt(env.TRAININGAPP_MEMORY_PRESSURE_THRESHOLD_GB, DEFAULT_PROFILE_THRESHOLD_GB),
    pressureSustainedMs: positiveInt(env.TRAININGAPP_MEMORY_PRESSURE_SUSTAINED_MS, 10000),
    recoverySustainedMs: positiveInt(env.TRAININGAPP_MEMORY_RECOVERY_SUSTAINED_MS, 60000),
    idleUnloadMs: positiveInt(env.TRAININGAPP_MEMORY_IDLE_UNLOAD_MS, 300000),
  };
}

// ---- pressure monitor (the downgrade decision, S6) -------------------------

export interface PressureMonitorOptions {
  /** Default from resolveMemoryConfig (DEFAULT_PROFILE_THRESHOLD_GB). */
  pressureThresholdGb?: number;
  /** Default from resolveMemoryConfig. */
  pressureSustainedMs?: number;
  /** Default: pressureSustainedMs. */
  recoverySustainedMs?: number;
  /** Clock seam, default Date.now. */
  nowMs?: () => number;
}

export interface PressureStatus {
  /** True once sub-threshold free RAM has been sustained >= pressureSustainedMs. */
  downgraded: boolean;
  /** 'fast' iff downgraded — NO silent auto-upgrade (AC3). */
  effectiveProfile: 'quality' | 'fast';
  /** True once above-threshold free RAM has been sustained >= recoverySustainedMs
   *  AFTER the downgrade. Eligibility ONLY: the upgrade transition is host policy
   *  between generations (the host clears its override; the monitor never does). */
  recoveryEligible: boolean;
}

export interface PressureMonitor {
  observe(freeBytes: number, atMs?: number): void;
  evaluate(atMs?: number): PressureStatus;
  /**
   * Host acknowledgement after it clears a latched downgrade override (the
   * monitor's only upgrade path is the host's; PRR-F1). Clears the downgrade
   * latch and recovery state so the NEXT downgrade requires a NEW sustained
   * pressure episode — without this, `downgraded` stays true forever and the
   * host re-latches the override on the next tick (level-vs-edge bug:
   * oscillating fast/quality flips + event spam).
   */
  resetAfterUpgrade(): void;
}

/**
 * Pure hysteresis state machine:
 *   - the pressure boundary is INCLUSIVE like B4 selectProfile: freeBytes
 *     >= pressureThresholdGb GiB is NOT pressure; strictly below is;
 *   - a pressure streak broken by an above-threshold sample never matures;
 *   - once downgraded, effectiveProfile stays 'fast' until the host upgrades;
 *     sustained recovery only flips recoveryEligible, and a return to pressure
 *     revokes eligibility (a fresh recovery window is required again).
 */
export function createPressureMonitor(options: PressureMonitorOptions = {}): PressureMonitor {
  const defaults = resolveMemoryConfig();
  const thresholdBytes = (options.pressureThresholdGb ?? defaults.pressureThresholdGb) * GIB;
  const pressureSustainedMs = options.pressureSustainedMs ?? defaults.pressureSustainedMs;
  const recoverySustainedMs = options.recoverySustainedMs ?? pressureSustainedMs;
  const nowMs = options.nowMs ?? Date.now;

  let pressureStreakStartMs: number | null = null;
  let recoveryStreakStartMs: number | null = null;
  let downgradedLatch = false;
  let recoveryEligibleLatch = false;

  return {
    observe(freeBytes, atMs) {
      const stamp = atMs ?? nowMs();
      if (freeBytes < thresholdBytes) {
        recoveryStreakStartMs = null;
        recoveryEligibleLatch = false;
        if (pressureStreakStartMs === null) pressureStreakStartMs = stamp;
      } else {
        pressureStreakStartMs = null;
        if (downgradedLatch && recoveryStreakStartMs === null) recoveryStreakStartMs = stamp;
      }
    },
    evaluate(atMs) {
      const stamp = atMs ?? nowMs();
      if (!downgradedLatch && pressureStreakStartMs !== null && stamp - pressureStreakStartMs >= pressureSustainedMs) {
        downgradedLatch = true;
      }
      if (
        downgradedLatch &&
        !recoveryEligibleLatch &&
        recoveryStreakStartMs !== null &&
        stamp - recoveryStreakStartMs >= recoverySustainedMs
      ) {
        recoveryEligibleLatch = true;
      }
      return {
        downgraded: downgradedLatch,
        effectiveProfile: downgradedLatch ? 'fast' : 'quality',
        recoveryEligible: recoveryEligibleLatch,
      };
    },
    resetAfterUpgrade() {
      downgradedLatch = false;
      recoveryEligibleLatch = false;
      pressureStreakStartMs = null;
      recoveryStreakStartMs = null;
    },
  };
}

// ---- concurrency + worker-pool sizing (S3/S4) ------------------------------

export interface ConcurrencyConfig {
  /** concurrency.maxConcurrentGenerations (default 1, S3). */
  maxConcurrentGenerations: number;
}

export function resolveConcurrencyConfig(env: Record<string, string | undefined> = process.env): ConcurrencyConfig {
  return {
    maxConcurrentGenerations: positiveInt(env.TRAININGAPP_CONCURRENCY_MAX_CONCURRENT_GENERATIONS, 1),
  };
}

export interface WorkerPoolConfig {
  /** embedding.workerPoolSize (default 1) — explicit, never os.cpus()-derived. */
  embeddingWorkerPoolSize: number;
  /** reranker.workerPoolSize (default 1) — explicit, never os.cpus()-derived. */
  rerankerWorkerPoolSize: number;
}

/**
 * The resolver is HONEST: it reports the configured value (e.g. 3). The >1
 * REJECTION is deliberately at the host consumption site, where the B7
 * single-thread ORT ownership constraint applies (onnxruntime-node aborts the
 * process when one module instance is used from two threads — see
 * backend/index.ts). Parsing and policy must not be conflated.
 */
export function resolveWorkerPoolConfig(env: Record<string, string | undefined> = process.env): WorkerPoolConfig {
  return {
    embeddingWorkerPoolSize: positiveInt(env.TRAININGAPP_EMBEDDING_WORKER_POOL_SIZE, 1),
    rerankerWorkerPoolSize: positiveInt(env.TRAININGAPP_RERANKER_WORKER_POOL_SIZE, 1),
  };
}
