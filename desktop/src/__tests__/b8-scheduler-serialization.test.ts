// b8-scheduler-serialization.test.ts — FROZEN ACCEPTANCE SPEC (issue #66 trace, AC4 / S3, check C3).
//
// NEW-SURFACE: statically imports desktop/main/backend/memory/scheduler.js,
// which does not exist at the base revision — the whole file fails collection
// with a module-not-found error, which IS the acceptance evidence for the
// missing generation/ingestion serialization. The pipeline-seam test below
// additionally pins HOW the pause must be wired into the EXISTING
// desktop/main/backend/ingest/pipeline.ts (an additive optional option).
//
// FROZEN PRODUCTION CONTRACT #1 — module desktop/main/backend/memory/scheduler.ts:
//
//   export interface ConcurrencySchedulerOptions {
//     maxConcurrentGenerations?: number;   // default 1 (concurrency.maxConcurrentGenerations, S3)
//   }
//   export class ConcurrencyScheduler {
//     constructor(options?: ConcurrencySchedulerOptions);
//     runGeneration<T>(fn: () => Promise<T>): Promise<T>;
//       // Serialized: at most maxConcurrentGenerations fn()s execute at once;
//       // excess generations queue FIFO (matches B4 per-engine queue semantics);
//       // resolves with fn's value, rejects with fn's error.
//     readonly generationInFlight: boolean;  // true while a generation executes
//     readonly queueDepth: number;           // generations waiting to START
//     readonly activeGenerations: number;    // currently executing (0..max)
//     waitForGenerationEnd(): Promise<void>;
//       // resolves the next time the scheduler has NO generation in flight
//       // (i.e. when generationInFlight becomes false); resolves immediately
//       // when called while idle. This is the ingestion-pause seam (S3).
//   }
//
// FROZEN PRODUCTION CONTRACT #2 — additive option on the EXISTING
// IngestPipelineOptions (desktop/main/backend/ingest/pipeline.ts):
//
//   coordination?: { waitForGenerationEnd(): Promise<void> };
//     // ConcurrencyScheduler satisfies this structurally. When present, the
//     // embed phase awaits coordination.waitForGenerationEnd() BEFORE calling
//     // embedder.embed(...) for EVERY document (the AC4 ingestion pause).
//
// AC4 timestamp ordering: the embed phase of an ingest started mid-generation
// must not BEGIN until the in-flight generation ENDS, proven by Date.now()
// ordering (embedStarted >= generationEnded), not by implementation details.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConcurrencyScheduler } from '../../main/backend/memory/scheduler.js';
import { IngestPipeline } from '../../main/backend/ingest/pipeline.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';

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

const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

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

/** Deterministic filler: n short unique words joined by single spaces (b6 convention). */
function words(n: number, prefix = 'w'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

const tempDirs: string[] = [];
const openStores: StoreHandle[] = [];

afterEach(() => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    try {
      store?.close();
    } catch {
      /* best effort */
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir as string, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('b8 C3 (S3): ConcurrencyScheduler generation serialization', () => {
  it(
    'default maxConcurrentGenerations is 1: a second generation queues FIFO with observable queueDepth',
    async () => {
      const scheduler = new ConcurrencyScheduler(); // no options -> default max 1
      const events: string[] = [];
      const held1 = deferred();
      const held2 = deferred();

      const first = scheduler.runGeneration(async () => {
        events.push('g1-start');
        await held1.promise;
        events.push('g1-end');
        return 1;
      });
      await sleep(50);
      expect(scheduler.generationInFlight, 'first generation is in flight').toBe(true);
      expect(scheduler.activeGenerations).toBe(1);

      const second = scheduler.runGeneration(async () => {
        events.push('g2-start');
        await held2.promise;
        events.push('g2-end');
        return 2;
      });
      await sleep(50);
      // FIFO queue: the second fn has NOT started while the first holds.
      expect(events, 'the queued generation must not start').toEqual(['g1-start']);
      expect(scheduler.queueDepth, 'one generation is waiting to start').toBe(1);
      expect(scheduler.activeGenerations).toBe(1);

      held1.resolve();
      expect(await first, 'runGeneration resolves with fn value').toBe(1);
      await sleep(50);
      expect(events, 'the second generation starts only after the first ends').toEqual([
        'g1-start',
        'g1-end',
        'g2-start',
      ]);
      expect(scheduler.queueDepth).toBe(0);

      held2.resolve();
      expect(await second).toBe(2);
      expect(scheduler.generationInFlight).toBe(false);
      expect(scheduler.activeGenerations).toBe(0);
    },
    20_000,
  );

  it(
    'AC4 timestamp ordering: an ingest-style embed that awaits waitForGenerationEnd() starts only AFTER the generation ends',
    async () => {
      const scheduler = new ConcurrencyScheduler({ maxConcurrentGenerations: 1 });
      const held = deferred();

      let generationStartedAt = 0;
      let generationEndedAt = 0;
      const generation = scheduler.runGeneration(async () => {
        generationStartedAt = Date.now();
        await held.promise; // fake slow generation, released by a real timer below
        generationEndedAt = Date.now();
        return 'gen-result';
      });
      await sleep(50); // let the generation actually begin executing
      expect(scheduler.generationInFlight).toBe(true);

      // The ingest side starts MID-GENERATION and must block on the seam.
      const embedRequestedAt = Date.now();
      let embedStartedAt = 0;
      const embed = scheduler.waitForGenerationEnd().then(() => {
        embedStartedAt = Date.now();
      });

      await sleep(50); // still mid-generation: the embed work must not have begun
      expect(embedStartedAt, 'embed work must not start while the generation is in flight').toBe(0);
      expect(scheduler.generationInFlight).toBe(true);

      held.resolve(); // release the held generation with a REAL event-loop tick
      expect(await generation).toBe('gen-result');
      await embed;

      const timestamps = `timestamps ms — embedRequested=${embedRequestedAt} generationStarted=${generationStartedAt} generationEnded=${generationEndedAt} embedStarted=${embedStartedAt}`;
      // The AC4 ordering proof: the embed phase waited for the generation.
      expect(embedStartedAt, `embedStarted must be >= generationEnded (${timestamps})`).toBeGreaterThanOrEqual(
        generationEndedAt,
      );
      expect(generationStartedAt, `generationStart must precede generationEnd (${timestamps})`).toBeLessThan(
        generationEndedAt,
      );
      expect(embedRequestedAt, `the ingest request began mid-generation (${timestamps})`).toBeLessThan(
        generationEndedAt,
      );
      expect(scheduler.generationInFlight).toBe(false);
      expect(scheduler.queueDepth, 'the coordinated embed is not itself a queued generation').toBe(0);
    },
    20_000,
  );
});

describe('b8 C3 (AC4): IngestPipeline embed phase awaits the coordination seam', () => {
  itReal(
    'an ingest started mid-generation does not call embedder.embed until the generation ends',
    async () => {
      const scheduler = new ConcurrencyScheduler({ maxConcurrentGenerations: 1 });
      const held = deferred();
      let generationStartedAt = 0;
      let generationEndedAt = 0;
      const generation = scheduler.runGeneration(async () => {
        generationStartedAt = Date.now();
        await held.promise;
        generationEndedAt = Date.now();
        return 'gen-result';
      });
      await sleep(50);
      expect(scheduler.generationInFlight).toBe(true);

      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-c3-store-'));
      tempDirs.push(storeDir);
      const store = openStore({ dbPath: path.join(storeDir, 'b8-c3.db') });
      openStores.push(store);

      let embedCalls = 0;
      let embedStartedAt = 0;
      const dims = store.dims;
      const unitVector = new Array<number>(dims).fill(1 / Math.sqrt(dims));
      const embedder = {
        modelId: 'b8-c3-embedder',
        embed: async (texts: string[]): Promise<number[][]> => {
          embedCalls += 1;
          if (embedStartedAt === 0) embedStartedAt = Date.now();
          return texts.map(() => unitVector);
        },
      };

      const pipeline = new IngestPipeline({
        store,
        embedder,
        config: { maxConcurrentFiles: 2, chunkWordCount: 256, chunkOverlapWords: 100 },
        coordination: scheduler, // the frozen pipeline seam: ConcurrencyScheduler satisfies it structurally
      });

      const embedRequestedAt = Date.now();
      const ingest = pipeline.ingestFile({ name: 'b8-pause.txt', data: Buffer.from(words(300)) });

      await sleep(150); // extraction + chunking complete instantly; the embed phase must be PAUSED
      expect(embedCalls, 'the embed phase must be observably paused during the generation (AC4)').toBe(0);

      held.resolve(); // release the generation; the embed phase may now proceed
      const [ingestResult] = await Promise.all([ingest, generation]);

      const timestamps = `timestamps ms — embedRequested=${embedRequestedAt} generationStarted=${generationStartedAt} generationEnded=${generationEndedAt} embedStarted=${embedStartedAt}`;
      expect(ingestResult.success, 'the paused ingest completes after the generation').toBe(true);
      expect(ingestResult.chunks_added, 'the embed phase really ran').toBeGreaterThan(0);
      expect(embedCalls).toBe(1);
      expect(embedStartedAt, `embedStarted must be >= generationEnded (${timestamps})`).toBeGreaterThanOrEqual(
        generationEndedAt,
      );
    },
    20_000,
  );
});
