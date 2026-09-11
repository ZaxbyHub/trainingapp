// b8-idle-unload.test.ts — FROZEN ACCEPTANCE SPEC (issue #66 trace, AC5 / S5, check C4).
//
// NEW-SURFACE: statically imports desktop/main/backend/memory/idle-unload.js,
// which does not exist at the base revision — the whole file fails collection
// with a module-not-found error, which IS the acceptance evidence for the
// missing idle-session-unload surface.
//
// FROZEN PRODUCTION CONTRACT — module desktop/main/backend/memory/idle-unload.ts:
//
//   export interface IdleUnloadOptions {
//     idleUnloadMs: number;                 // the idle window (memory.idleUnloadMs, S5)
//     unload: () => void | Promise<void>;   // invoked ONCE per elapsed idle window
//     nowMs?: () => number;                 // clock seam, default Date.now
//   }
//   export class IdleUnloadController {
//     constructor(options: IdleUnloadOptions);
//     touch(): void;                 // marks use; (re-)arms the idle window.
//                                    // The idle window runs from the LAST touch();
//                                    // construction alone does not arm a window
//                                    // (nothing loaded -> nothing to unload).
//     dispose(): void;               // stops the timer; unload NEVER fires after.
//     readonly unloadCount: number;  // how many times unload has fired (>= 0).
//     recordReload(ms: number): void;       // host records a measured reload latency (AC5)
//     readonly lastReloadMs: number | null; // null until the first recordReload.
//   }
//
//   Idle semantics pinned below: after idleUnloadMs with NO use, unload fires
//   EXACTLY ONCE for that window (never repeatedly); a touch() during a window
//   re-arms it (the pending unload does NOT fire); a touch() after an unload
//   re-arms a FRESH window which may fire again (the reload-then-idle-again
//   lifecycle); dispose() cancels a pending window outright.
//
// FROZEN HOST-LEVEL RELOAD CONTRACT (AC5, exercised in the last test with the
// REAL WorkerReranker and a fixture worker — NO ONNX weights needed):
//   - unload  = await runner.dispose()            (WorkerReranker.dispose terminates the worker);
//   - reload  = lazily constructing a FRESH WorkerReranker on the next use
//     (a disposed instance is single-shot by construction — reranker.ts
//     throws after dispose — so reload means a new instance);
//   - the measured reload latency = time from reload start until the FIRST
//     post-reload request resolves, recorded via controller.recordReload(ms)
//     and surfaced as controller.lastReloadMs.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdleUnloadController } from '../../main/backend/memory/idle-unload.js';
import { WorkerReranker } from '../../main/backend/retrieval/reranker.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fixture worker: answers rerank jobs IMMEDIATELY with deterministic
 * descending scores (n-i)/n (the b7 message protocol, no busy sleep — the
 * reload-latency measurement here must not be dominated by fake work).
 * Written to a temp dir AT RUNTIME so the spec stays self-contained and
 * weight-free.
 */
const FIXTURE_WORKER_SOURCE = [
  "import { parentPort } from 'node:worker_threads';",
  "parentPort.on('message', (msg) => {",
  "  if (!msg || msg.kind !== 'rerank') return;",
  '  const scores = msg.candidates.map((_, i) => (msg.candidates.length - i) / msg.candidates.length);',
  "  parentPort.postMessage({ kind: 'rerank:result', jobId: msg.jobId, scores });",
  '});',
  '',
].join('\n');

function writeFixtureWorker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-c4-fixture-'));
  const file = path.join(dir, 'fixture-rerank-worker.mjs');
  fs.writeFileSync(file, FIXTURE_WORKER_SOURCE, 'utf8');
  return file;
}

/** Remove the fixture's temp dir (best effort). */
function cleanupFixture(workerPath: string): void {
  try {
    fs.rmSync(path.dirname(workerPath), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Real-timer windows kept tiny (< 500 ms per wait) with wide margins against
// Windows timer coarsening (~15.6 ms quantum): checks at 70-80 ms against a
// 150 ms window can never flake.
const WINDOW_MS = 150;

describe('b8 C4 (S5): IdleUnloadController idle semantics', () => {
  it(
    'fires unload EXACTLY ONCE after the idle window elapses with no use',
    async () => {
      const times: number[] = [];
      const controller = new IdleUnloadController({
        idleUnloadMs: WINDOW_MS,
        unload: () => {
          times.push(Date.now());
        },
      });
      controller.touch();
      await sleep(70); // inside the 150 ms window
      expect(controller.unloadCount, 'not fired before the idle window elapses').toBe(0);
      await sleep(300); // well past the window
      expect(controller.unloadCount, 'unload fired exactly once for the window').toBe(1);
      expect(times).toHaveLength(1);
      await sleep(150); // idle continues; it must NOT fire again for the same window
      expect(controller.unloadCount, 'unload never repeats within one idle period').toBe(1);
    },
    20_000,
  );

  it(
    'a touch() mid-window re-arms it, and a touch() after an unload starts a fresh window that fires again',
    async () => {
      let calls = 0;
      const controller = new IdleUnloadController({
        idleUnloadMs: WINDOW_MS,
        unload: () => {
          calls += 1;
        },
      });
      controller.touch();
      await sleep(80);
      controller.touch(); // use during the window resets the idle timer
      await sleep(80); // 160 ms since the FIRST touch, but only 80 ms since the last
      expect(controller.unloadCount, 'a re-armed window must not fire on the stale schedule').toBe(0);
      await sleep(300);
      expect(controller.unloadCount, 'the re-armed window fires once when IT elapses').toBe(1);

      controller.touch(); // post-unload use (the reload path) re-arms a fresh window
      await sleep(500);
      expect(controller.unloadCount, 'a second idle period after re-arm fires again (reload-then-idle lifecycle)').toBe(2);
      expect(calls).toBe(2);
    },
    20_000,
  );

  it(
    'dispose() cancels the pending idle window; unload never fires afterwards',
    async () => {
      const controller = new IdleUnloadController({
        idleUnloadMs: WINDOW_MS,
        unload: () => {
          throw new Error('unload must never fire after dispose');
        },
      });
      controller.touch();
      controller.dispose();
      await sleep(400);
      expect(controller.unloadCount, 'dispose stops the timer without firing unload').toBe(0);
    },
    20_000,
  );

  it(
    'AC5 reload-latency recording: lastReloadMs starts null and records the measured value',
    () => {
      const controller = new IdleUnloadController({ idleUnloadMs: 60_000, unload: () => {} });
      expect(controller.lastReloadMs, 'no reload has happened yet').toBe(null);
      controller.recordReload(1234);
      expect(controller.lastReloadMs).toBe(1234);
      // The latest measurement wins.
      controller.recordReload(5678);
      expect(controller.lastReloadMs).toBe(5678);
    },
    20_000,
  );
});

describe('b8 C4 (AC5): unload-then-reload with the REAL WorkerReranker (fixture worker, no weights)', () => {
  it(
    'unload disposes the runner; the documented reload path (fresh runner + first request) succeeds and its latency is recorded',
    async () => {
      const fixturePath = writeFixtureWorker();
      try {
        // Session alive: first use spawns the fixture worker lazily (real spawn).
        const first = new WorkerReranker({ workerPath: fixturePath });
        const before = await first.score('unload me', ['alpha', 'beta', 'gamma', 'delta']);
        expect(before).toEqual([1, 0.75, 0.5, 0.25]);

        // Idle unload fires once and disposes the runner (the frozen host
        // contract: unload = await runner.dispose()).
        let unloaded = false;
        const controller = new IdleUnloadController({
          idleUnloadMs: WINDOW_MS,
          unload: async () => {
            unloaded = true;
            await first.dispose();
          },
        });
        controller.touch();
        await sleep(400);
        expect(controller.unloadCount).toBe(1);
        expect(unloaded, 'the unload callback ran and disposed the real runner').toBe(true);

        // Reload (the frozen host contract): a FRESH runner on next use; the
        // measured construct-to-first-answer latency is recorded (AC5).
        const reloadStartedAt = Date.now();
        const second = new WorkerReranker({ workerPath: fixturePath });
        const after = await second.score('reload me', ['alpha', 'beta']);
        const reloadMs = Date.now() - reloadStartedAt;

        expect(after, 'the next request after unload succeeds through the fresh runner').toEqual([1, 0.5]);
        expect(reloadMs, 'a real, positive reload latency was measured').toBeGreaterThan(0);
        controller.recordReload(reloadMs);
        expect(controller.lastReloadMs, 'the measured reload latency is recorded').toBe(reloadMs);

        await second.dispose();
      } finally {
        cleanupFixture(fixturePath);
      }
    },
    20_000,
  );
});
