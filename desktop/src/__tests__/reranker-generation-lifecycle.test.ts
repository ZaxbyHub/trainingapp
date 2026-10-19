// reranker-generation-lifecycle.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #229 sub-defect (a); trace 199-229-backend-host-lifecycle).
//
// AC1 (DISCRIMINATING): WHEN a reranker job rejection settles after an idle
// unload has published a replacement runner, THEN THE SYSTEM SHALL dispose
// only the failed job's own runner and never the replacement.
// RED at base, GREEN after the fix.
//
// AC2 (PRESERVING): THE SYSTEM SHALL keep the idle-unload contract — after
// unload() terminates the worker, the next score()/embed() rebuilds a fresh
// runner and succeeds. GREEN at base and after the fix.
//
// Both tests drive the REAL ResumableReranker with a runtime-written fixture
// worker (no ONNX weights). Determinism is by construction, not by sleeps:
// the AC1 fixture never answers rerank jobs, so a job can only settle through
// its own runner's disposal (scheduled via setImmediate inside dispose()),
// and the ordering "unload publishes this.runner = null synchronously -> the
// next score() installs runner B synchronously -> runner A's in-flight job
// rejects -> the rejection branch runs" is forced by the promise chain alone.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResumableReranker } from '../../main/backend/retrieval/reranker.js';

/**
 * AC1 fixture: answers ONLY memory probes (with deterministic counters) and
 * NEVER answers a rerank job — a rerank job stays pending until the runner
 * that owns it is disposed, which is exactly the in-flight state the
 * wrong-generation disposal bug needs.
 */
const MEMORY_FIXTURE_SOURCE = [
  "import { parentPort } from 'node:worker_threads';",
  "parentPort.on('message', (msg) => {",
  "  if (!msg || msg.kind !== 'memory') return;",
  "  parentPort.postMessage({",
  "    kind: 'memory:result',",
  "    jobId: msg.jobId,",
  "    memory: { rss: 1, external: 2, arrayBuffers: 3 },",
  "  });",
  '});',
  '',
].join('\n');

/**
 * AC2 fixture: answers rerank jobs immediately with the deterministic
 * descending scores (n-i)/n and embed jobs with a fixed vector (the b8
 * C4 fixture, extended with the embed reply).
 */
const ANSWERING_FIXTURE_SOURCE = [
  "import { parentPort } from 'node:worker_threads';",
  "parentPort.on('message', (msg) => {",
  "  if (!msg || typeof msg.jobId !== 'number') return;",
  "  if (msg.kind === 'rerank') {",
  '    const scores = msg.candidates.map((_, i) => (msg.candidates.length - i) / msg.candidates.length);',
  "    parentPort.postMessage({ kind: 'rerank:result', jobId: msg.jobId, scores });",
  '    return;',
  '  }',
  "  if (msg.kind === 'embed') {",
  "    parentPort.postMessage({",
  "      kind: 'embed:result',",
  "      jobId: msg.jobId,",
  "      vectors: msg.texts.map(() => [0.25]),",
  '    });',
  '  }',
  '});',
  '',
].join('\n');

function writeFixture(source: string, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const file = path.join(dir, 'fixture-rerank-worker.mjs');
  fs.writeFileSync(file, source, 'utf8');
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

function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'RESOLVED',
    (e: unknown) => `REJECTED: ${e instanceof Error ? e.message : String(e)}`,
  );
}

describe('issue 229 reranker generation lifecycle', () => {
  it(
    'AC1 a stale-generation rejection must not dispose the replacement runner',
    async () => {
      const fixturePath = writeFixture(MEMORY_FIXTURE_SOURCE, 'i229-gen-memory');
      try {
        const rr = new ResumableReranker({ workerPath: fixturePath });

        // 1. Job 1 starts on runner A and stays pending: the fixture never
        //    answers rerank jobs, so this promise can only settle through
        //    runner A's own disposal.
        const job1 = outcome(rr.score('q1', ['a', 'b']));

        // 2. Idle unload publishes this.runner = null synchronously, THEN
        //    awaits A.dispose() (its in-flight rejection is deferred one
        //    macrotask via setImmediate).
        const unloaded = rr.unload();

        // 3. A fresh query inside that window installs runner B synchronously
        //    (ensureRunner() runs before the first await inside score()).
        const job2 = outcome(rr.score('q2', ['a', 'b']));

        await unloaded;
        const r1 = await job1;

        // Harness sanity (holds at base AND after the fix): job 1 really ran
        // in-flight on runner A and was settled by A's own disposal rejection.
        expect(
          r1,
          'harness sanity: the stale job rejected through its own runner disposal',
        ).toContain('REJECTED');

        // THE DEFECT (reranker.ts runWithReloadTiming catch branch): job 1's
        // rejection re-reads this.runner — which is now runner B — and
        // disposes it, tearing down a healthy replacement. A correct
        // generation-bound disposal leaves the replacement alive.
        //
        // reportMemory() is the public probe of a live runner: it returns null
        // exactly when no runner is installed (it never rebuilds), and the
        // fixture answers memory probes, so a SURVIVING replacement answers
        // with the fixture counters while a disposed one leaves null.
        const mem = await rr.reportMemory();
        expect(
          mem,
          'the replacement runner must survive the stale generation rejection',
        ).not.toBeNull();
        expect(mem, 'the surviving replacement runner answers a memory probe').toEqual({
          rss: 1,
          external: 2,
          arrayBuffers: 3,
        });

        // Cleanup: reap whatever is still pending (job 2) through the public
        // API so no promise is left unsettled.
        await rr.unload();
        await job2;
        await rr.dispose();
      } finally {
        cleanupFixture(fixturePath);
      }
    },
    30_000,
  );

  it(
    'AC2 unload then score and embed rebuild a fresh runner and succeed',
    async () => {
      const fixturePath = writeFixture(ANSWERING_FIXTURE_SOURCE, 'i229-gen-answer');
      try {
        const rr = new ResumableReranker({ workerPath: fixturePath });

        const first = await rr.score('first', ['alpha', 'beta']);
        expect(first, 'the first score succeeds on the initial runner').toEqual([1, 0.5]);

        // Idle unload terminates the worker; in-flight work is done.
        await rr.unload();

        const second = await rr.score('second', ['gamma']);
        expect(
          second,
          'the next score after unload rebuilds a fresh runner and succeeds',
        ).toEqual([1]);

        await rr.unload();

        const embedded = await rr.embed(['hello']);
        expect(
          embedded,
          'the next embed after unload rebuilds a fresh runner and succeeds',
        ).toEqual([[0.25]]);

        await rr.dispose();
      } finally {
        cleanupFixture(fixturePath);
      }
    },
    20_000,
  );

  // AC9 (PRR review finding H2): the production path the generation-bound
  // catch branch actually protects is an ORGANIC worker exit — the worker
  // dies on its own while this.runner still IS the failed generation. AC1
  // cannot reach that path because unload() nulls this.runner before the
  // rejection lands, so `this.runner === own` is always false there; deleting
  // the guard line was an uncaught mutant. This spec drives the real path.
  it(
    'AC9 an organic worker exit drops the dead generation so the next score rebuilds',
    async () => {
      // Fixture that dies ONCE, on the first job it ever receives, WITHOUT
      // answering it. The job is therefore still in the runner's `pending` map
      // when the 'exit' event fires, so WorkerReranker's orphan-exit handler
      // (reranker.ts:182-184) rejects it synchronously with "rerank worker
      // exited with code N" — an organic exit, not a dispose.
      //
      // A sidecar marker file makes the exit exactly-once: each spawn is a
      // fresh module instance, so an in-memory flag would reset and the REBUILT
      // worker would die too. Without the marker this spec passes alone and
      // fails in the full suite (the second score hits the fresh worker, which
      // exits again and rejects).
      const selfExitingSource = [
        "import { parentPort, workerData } from 'node:worker_threads';",
        "import fs from 'node:fs';",
        "const marker = workerData.modelDir;",
        "parentPort.on('message', (msg) => {",
        "  if (!msg || msg.kind !== 'rerank') return;",
        "  if (!fs.existsSync(marker)) {",
        "    // First job ever: die with it still pending — the organic-exit",
        "    // shape the generation-bound catch branch exists for.",
        "    fs.writeFileSync(marker, '1');",
        "    process.exit(0);",
        "  }",
        "  const scores = msg.candidates.map((_, i) => (msg.candidates.length - i) / msg.candidates.length);",
        "  parentPort.postMessage({ kind: 'rerank:result', jobId: msg.jobId, scores });",
        '});',
        '',
      ].join('\n');
      const fixturePath = writeFixture(selfExitingSource, 'i229-gen-selfexit');
      // The marker lives beside the fixture so cleanupFixture() removes both.
      const markerPath = `${fixturePath}.exited`;
      try {
        const rr = new ResumableReranker({ workerPath: fixturePath, modelDir: markerPath });

        // Job 1 is admitted against generation A and rejected by A's organic
        // exit. At that moment this.runner still IS A (nothing nulled it), so
        // the catch branch's `this.runner === own` guard is TRUE and must drop
        // generation A.
        const rejected = await rr.score('one', ['alpha', 'beta']).then(
          () => 'RESOLVED',
          (e: unknown) => `REJECTED: ${e instanceof Error ? e.message : String(e)}`,
        );
        expect(
          rejected,
          'the job admitted against the organically exited generation must reject, not hang',
        ).toContain('REJECTED');
        expect(
          rejected,
          'the rejection must be the organic exit message that arms the catch branch',
        ).toContain('exited');

        // THE GUARD: generation A was dropped, so the next score rebuilds a
        // fresh runner and succeeds. Without `if (this.runner === own)
        // this.runner = null;` this score replays the same rejection forever —
        // the PRR-F5 "a dead runner must not be reused" contract.
        const second = await rr.score('two', ['gamma']);
        expect(
          second,
          'the next score after an organic exit rebuilds a fresh runner and succeeds',
        ).toEqual([1]);

        await rr.dispose();
      } finally {
        cleanupFixture(fixturePath);
      }
    },
    30_000,
  );
});
