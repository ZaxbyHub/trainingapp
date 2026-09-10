// b7-rerank-worker.test.ts — FROZEN ACCEPTANCE SPEC (issue #65 trace, AC4 / check C4).
//
// This file is a frozen acceptance spec authored by the issue-tracer v3 CHECK
// AUTHOR. It pins the worker-thread reranker runner the implementer must
// provide at desktop/main/backend/retrieval/reranker.ts (with the production
// worker ENTRY at desktop/main/backend/retrieval/rerank-worker.ts — the real
// ONNX worker is the implementer's concern; this spec proves the RUNNER against
// a fixture worker and needs NO model weights). It must FAIL at the base
// revision (module does not exist).
//
// FROZEN PRODUCTION CONTRACT (module desktop/main/backend/retrieval/reranker.ts):
//
//   export interface RerankerRunnerOptions {
//     workerPath?: string;  // absolute path to a worker entry; defaults to the
//                           // compiled rerank-worker.js sibling of this module
//     modelDir?: string;    // forwarded to the worker (workerData) for the
//                           // production reranker; fixture workers ignore it
//   }
//   export class WorkerReranker implements RerankerSurface {
//     constructor(options?: RerankerRunnerOptions);
//     score(query: string, candidates: string[]): Promise<number[]>;
//     dispose(): Promise<void>;  // terminates the worker; REJECTS in-flight jobs; idempotent
//   }
//
// FROZEN WORKER MESSAGE PROTOCOL (the fixture below speaks it; the production
// worker entry must speak the same):
//   main -> worker:  { kind: 'rerank', jobId: number, query: string, candidates: string[] }
//   worker -> main:  { kind: 'rerank:result', jobId: number, scores: number[] }
//                or  { kind: 'rerank:error',   jobId: number, message: string }
//
// TOLERANCE JUSTIFICATION (the responsiveness assertions):
//   The fixture worker BUSY-SLEEPS ~800ms on ITS OWN thread. If the rerank ran
//   on the main/event-loop thread instead (the defect AC4 exists to prevent),
//   the loop would be blocked for that whole window: a 5ms setInterval would
//   tick ~0-2 times and a 25ms setTimeout probe could not settle before the
//   block ends (~775ms+). With the work genuinely off-thread, the interval
//   ticks ~160 times (even with Windows timer coarsening stretching 5ms to the
//   ~15.6ms scheduler quantum: >= 51 ticks) and the probe settles in ~25-45ms.
//   Bounds chosen with wide margins both ways: ticksDuring >= 40 (blocked can
//   never reach it), probeMs < 300 (off-thread can never exceed it).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerReranker } from '../../main/backend/retrieval/reranker.js';

/**
 * Fixture worker: busy-sleeps ~800ms on its own thread, then answers with
 * deterministic descending scores (n-i)/n. Written to a temp dir AT RUNTIME so
 * the spec stays self-contained and weight-free.
 */
const FIXTURE_WORKER_SOURCE = [
  "import { parentPort } from 'node:worker_threads';",
  'parentPort.on(\'message\', (msg) => {',
  "  if (!msg || msg.kind !== 'rerank') return;",
  '  const deadline = Date.now() + 800;',
  '  while (Date.now() < deadline) { /* busy sleep: blocks ONLY this worker thread */ }',
  '  const scores = msg.candidates.map((_, i) => (msg.candidates.length - i) / msg.candidates.length);',
  "  parentPort.postMessage({ kind: 'rerank:result', jobId: msg.jobId, scores });",
  '});',
  '',
].join('\n');

function writeFixtureWorker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-c4-fixture-'));
  const file = path.join(dir, 'fixture-rerank-worker.mjs');
  fs.writeFileSync(file, FIXTURE_WORKER_SOURCE, 'utf8');
  return file;
}

/** Remove the fixture's temp dir (best effort; vitest process exit also cleans /tmp). */
function cleanupFixture(workerPath: string): void {
  try {
    fs.rmSync(path.dirname(workerPath), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

describe('b7 C4 (AC4): WorkerReranker runs the rerank OFF the main event loop', () => {
  it(
    'main loop stays responsive while the fixture worker busy-sleeps, and the job round-trips',
    async () => {
      const fixturePath = writeFixtureWorker();
      const runner = new WorkerReranker({ workerPath: fixturePath });
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 5);
      try {
        const ticksBeforeJob = ticks;
        const jobStartedAt = Date.now();
        const job = runner.score('b7 rerank query', ['alpha', 'beta', 'gamma', 'delta']);

        // Concurrent promise settles promptly: a 25ms timer probe measured
        // DURING the in-flight window. Off-thread: ~25-45ms (Windows timer
        // coarsening adds at most ~20ms). Main-thread-blocked: >= ~750ms.
        const probeStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 25));
        const probeMs = Date.now() - probeStartedAt;
        expect(probeMs).toBeLessThan(300);

        const scores = await job;
        const jobMs = Date.now() - jobStartedAt;
        const ticksDuring = ticks - ticksBeforeJob;

        // The busy window really elapsed (the runner did not fake the work).
        expect(jobMs).toBeGreaterThanOrEqual(700);
        // The 5ms tick counter advanced THROUGH the in-flight window: with the
        // work off-thread this is ~160 (>= 51 even under full Windows timer
        // coarsening); a blocked event loop would tick ~0-2 times.
        expect(ticksDuring).toBeGreaterThanOrEqual(40);

        // Round-trip: deterministic fixture scores (n-i)/n, exact doubles.
        expect(scores).toEqual([1, 0.75, 0.5, 0.25]);

        // A second job over a different candidate list round-trips too.
        const second = await runner.score('another query', ['x', 'y']);
        expect(second).toEqual([1, 0.5]);

        await runner.dispose();
      } finally {
        clearInterval(timer);
        cleanupFixture(fixturePath);
      }
    },
    20000,
  );

  it(
    'dispose() terminates a busy worker promptly and rejects the in-flight job; dispose is idempotent',
    async () => {
      const fixturePath = writeFixtureWorker();
      const runner = new WorkerReranker({ workerPath: fixturePath });
      try {
        const job = runner.score('terminate me', ['a', 'b', 'c']);
        // Let the worker receive the job and enter its busy window.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const disposeStartedAt = Date.now();
        await runner.dispose();
        const disposeMs = Date.now() - disposeStartedAt;
        // Termination is prompt (well inside the remaining ~650ms busy window;
        // generous bound for worker teardown on a loaded CI box).
        expect(disposeMs).toBeLessThan(5000);
        // A terminated worker cannot answer: the pending job must REJECT.
        await expect(job).rejects.toThrow();
        // Idempotent.
        await runner.dispose();
      } finally {
        cleanupFixture(fixturePath);
      }
    },
    20000,
  );
});
