// i169-llama-getstats-counts.test.ts — regression spec for issue #169's
// LlamaEngine path.
//
// Lifecycle: RED at base (dbbd93ca, before the fix), GREEN after the fix.
//
// LlamaEngine.attachDocumentSurface stores the surface on THIS engine
// (llama-engine.ts), not on its internal stub, so getStats() must read the
// counts from this.documents — the same source every sibling document
// method uses. Before the fix, getStats() spread the stub's hardcoded
// zeros even with a surface attached. The b4 harness idiom (FakeBackend +
// staged dummy models) is duplicated here because it is inline/not
// exported in b4-llama-engine.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LlamaEngine, type LlamaEngineBackend, type LlamaEngineOptions } from '../../main/backend/inference/llama-engine';
// The fake surface factory lives in ./fixtures/document-surface-fake.ts —
// ONE fixture source shared by i103c/i169-llama/i175/i185 (issue #193 AC19 /
// #200 AC2; previously copy-pasted here). The zero-arg form preserves this
// spec's historical payload exactly: 'test-embedder' (asserted below) + the
// 2-doc (2+3 chunks) DEFAULT_DOCS corpus.
import { makeFakeSurface } from './fixtures/document-surface-fake.js';

const GB = 1024 ** 3;

// Every staged dummy-model dir is tracked and drained at suite end so repeated
// runs leave no `i169-dummy-models-*` litter in os.tmpdir() (issue #189 —
// the b4 harness leaks the same way; this file does not copy that debt).
const tempDirs: string[] = [];

function drainTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterAll(drainTempDirs);

/** Fake native backend: getStats never generates, but the factory contract
 *  requires the interface. */
class FakeBackend implements LlamaEngineBackend {
  async generate(): Promise<{ answer: string; cancelled: boolean }> {
    return { answer: '', cancelled: false };
  }

  async dispose(): Promise<void> {}
}

function stageDummyModels(): { quality: string; fast: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i169-dummy-models-'));
  tempDirs.push(dir);
  const quality = path.join(dir, 'quality-dummy.gguf');
  const fast = path.join(dir, 'fast-dummy.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return { quality, fast, dir };
}

function makeEngine(overrides: Partial<LlamaEngineOptions> = {}): LlamaEngine {
  const dummy = stageDummyModels();
  return new LlamaEngine({
    profile: 'fast',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: { quality: dummy.quality, fast: dummy.fast },
    llamaFactory: async () => new FakeBackend(),
    ...overrides,
  });
}

/** Minimal fake surface: shared fixture (see the import above). */

describe('issue #169: LlamaEngine.getStats reads the attached document surface', () => {
  it('with a surface attached, getStats counts equal the SAME engine\'s listDocuments totals (the stub spread cannot leak zeros)', async () => {
    const engine = makeEngine();
    engine.attachDocumentSurface(makeFakeSurface());

    const listed = await engine.listDocuments();
    const stats = await engine.getStats();

    expect(listed.total).toBe(2);
    const summedChunks = listed.documents.reduce((acc, doc) => acc + doc.chunk_count, 0);
    expect(summedChunks).toBe(5);
    expect(stats.document_count).toBe(listed.total);
    expect(stats.document_count).toBe(2);
    expect(stats.chunk_count).toBe(summedChunks);
    expect(stats.chunk_count).toBe(5);
    // The existing B6 override must keep working alongside the counts.
    expect(stats.embedding_model).toBe('test-embedder');
  });

  it('no-surface: getStats returns zero counts, and detach restores the zeros', async () => {
    const engine = makeEngine();
    const bare = await engine.getStats();
    expect(bare.document_count).toBe(0);
    expect(bare.chunk_count).toBe(0);

    engine.attachDocumentSurface(makeFakeSurface());
    engine.attachDocumentSurface(null);
    const detached = await engine.getStats();
    expect(detached.document_count).toBe(0);
    expect(detached.chunk_count).toBe(0);
  });

  it('mixed-state: a detach landing inside the listDocuments await can never pair real counts with the stub embedder id', async () => {
    // issue #191 falsification: enter the surface's listDocuments, then detach
    // while getStats is parked on that await. With the attachment captured
    // once before the await, the payload must stay internally consistent —
    // counts and embedding_model describe the SAME (captured) surface.
    const engine = makeEngine();
    const base = makeFakeSurface();
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.attachDocumentSurface({
      ...base,
      async listDocuments() {
        entered();
        await releaseGate;
        return base.listDocuments();
      },
    });

    const pending = engine.getStats();
    await enteredGate; // getStats is now suspended INSIDE listDocuments
    engine.attachDocumentSurface(null); // detach lands in the await window
    release();
    const stats = await pending;

    // The captured-attachment payload: counts from the old surface paired
    // with the OLD surface's embedder id — never the stub marker. The
    // pre-fix double-read produced counts 2/5 + 'desktop-stub (B5 #63)'.
    expect(stats.document_count).toBe(2);
    expect(stats.chunk_count).toBe(5);
    expect(stats.embedding_model).toBe('test-embedder');
  });

  it('tmp-cleanup: staged dummy-model directories are drained by the suite cleanup', () => {
    // issue #189: every stageDummyModels() dir is tracked; drainTempDirs()
    // (wired into afterAll) removes each one so repeated runs leave no
    // i169-dummy-models-* litter in os.tmpdir().
    const staged = stageDummyModels();
    expect(fs.existsSync(staged.dir)).toBe(true);
    expect(tempDirs).toContain(staged.dir);

    drainTempDirs();

    expect(fs.existsSync(staged.dir)).toBe(false);
    expect(tempDirs).toHaveLength(0);
  });
});

// issue #190 AC17 (trace test-batch-oct2026 Cluster A): the LLAMA engine's
// rejection path — a listDocuments() that throws during getStats must
// propagate to the caller (the route turns it into a 500), never be
// swallowed into a zeroed/marker payload. The stub engine's rejection
// propagation is already pinned at i185-stub-getstats-mixed-state.test.ts
// (:166-174); this is the llama-side twin, previously untested.
describe('LlamaEngine.getStats rejection path (issue #190 AC17)', () => {
  it('listDocuments-rejects', async () => {
    const engine = makeEngine();
    const boom = new Error('llama surface exploded');
    engine.attachDocumentSurface(makeFakeSurface('test-embedder', { rejectList: boom }));

    let rejected: unknown = null;
    let payload: Awaited<ReturnType<LlamaEngine['getStats']>> | null = null;
    try {
      payload = await engine.getStats();
    } catch (err) {
      rejected = err;
    }

    // Rejected with THAT exact error (not a generic wrapper)...
    expect(rejected).toBe(boom);
    // ...and never resolved into a zeroed/marker payload either: the
    // try/catch-swallow mutant (zero counts + stub marker) fails both rows.
    expect(payload).toBeNull();
  });
});

// PRR-010 folded finding (F-2, trace test-batch-oct2026 Cluster A): the
// external-provider + attached-surface COMPOSITION was unpinned — external-engine
// tests attach no surface and the count tests set no externalProvider, so the two
// getStats branches (counts override from the surface vs llm_backend naming) were
// never asserted together. The keys are disjoint by design; this pins both in one
// spec so a future refactor cannot let one branch mask the other.
describe('LlamaEngine.getStats external-provider + attached surface composition (F-2)', () => {
  it('external-with-surface: counts come from the surface and llm_backend names the external endpoint', async () => {
    const engine = makeEngine();
    engine.attachDocumentSurface(makeFakeSurface());
    const applied = engine.applySettingsPatch({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://127.0.0.1:8080/v1',
      'external.model': 'm1',
    });
    expect(applied.ok).toBe(true);

    const stats = await engine.getStats();

    // Counts: the attached surface's payload (not zeros, not the stub spread).
    expect(stats.document_count).toBe(2);
    expect(stats.chunk_count).toBe(5);
    // llm_backend: the external endpoint naming, not the llama.cpp default —
    // a counts-only or backend-only regression fails the other assertion here.
    expect(stats.llm_backend).toBe('external (openai) model=m1 endpoint=http://127.0.0.1:8080');
    // The B6 embedder override keeps working alongside both branches.
    expect(stats.embedding_model).toBe('test-embedder');
  });
});
