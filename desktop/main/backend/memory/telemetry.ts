// memory/telemetry.ts — per-component memory sampling (issue #66, S1).
//
// Maps injectable seams onto the documented MemorySnapshot (MB fields,
// 1 MB = 1024 * 1024 bytes). Pure sampling: the polling cadence is host
// policy (a setInterval on memory.telemetryIntervalMs); this module never
// runs a timer.
//
// In-process attribution semantics (the backend is Node in-process; ADR-0003
// is open — see docs/adr/0008-memory-budget.md):
//   - chromium  = main-process RSS (process.memoryUsage().rss; includes the
//                 native heaps: llama.cpp, main-thread ORT if any, sqlite);
//   - llm       = host-injected (resident-model incremental footprint;
//                 0 when no model is resident);
//   - embeddingSession / rerankerSession = host-injected (worker-reported
//                 external+arrayBuffers when the retrieval worker exists —
//                 the ONNX sessions live on that single ORT thread);
//   - sqlite    = host-injected (better-sqlite3's own heap counter);
//   - systemFreeMb / systemTotalMb = os.freemem()/os.totalmem().
// Uninjectable components degrade to 0 — the snapshot shape never changes.
import os from 'node:os';
import type { MemoryComponent } from './budget.js';
import { resolveMemoryConfig } from './budget.js';

const MIB = 1024 * 1024;

export interface MemorySnapshot {
  chromiumRssMb: number;
  llmRssMb: number;
  embeddingSessionRssMb: number;
  rerankerSessionRssMb: number;
  sqliteRssMb: number;
  systemFreeMb: number;
  systemTotalMb: number;
}

export interface MemoryTelemetryOptions {
  /** Default os.freemem(). */
  freeMemBytes?: () => number;
  /** Default os.totalmem(). */
  totalMemBytes?: () => number;
  /** Per-component RSS provider; returns BYTES; default: 0 for every component. */
  rssProvider?: (component: MemoryComponent) => number;
  /** Declared cadence (memory.telemetryIntervalMs); informational here — the
   *  host owns the actual timer. Default resolveMemoryConfig().telemetryIntervalMs. */
  intervalMs?: number;
}

export interface MemoryTelemetry {
  /** Takes a fresh sample through the seams and records it. */
  sample(): MemorySnapshot;
  /** Returns the latest sample WITHOUT re-sampling (lazily takes one if none exists yet). */
  snapshot(): MemorySnapshot;
}

export function createMemoryTelemetry(options: MemoryTelemetryOptions = {}): MemoryTelemetry {
  const freeMemBytes = options.freeMemBytes ?? (() => os.freemem());
  const totalMemBytes = options.totalMemBytes ?? (() => os.totalmem());
  const rssProvider = options.rssProvider ?? (() => 0);
  void (options.intervalMs ?? resolveMemoryConfig().telemetryIntervalMs);

  let latest: MemorySnapshot | null = null;
  const take = (): MemorySnapshot => ({
    chromiumRssMb: rssProvider('chromium') / MIB,
    llmRssMb: rssProvider('llm') / MIB,
    embeddingSessionRssMb: rssProvider('embeddingSession') / MIB,
    rerankerSessionRssMb: rssProvider('rerankerSession') / MIB,
    sqliteRssMb: rssProvider('sqlite') / MIB,
    systemFreeMb: freeMemBytes() / MIB,
    systemTotalMb: totalMemBytes() / MIB,
  });

  return {
    sample: () => {
      latest = take();
      return latest;
    },
    snapshot: () => {
      if (latest === null) latest = take();
      return latest;
    },
  };
}
