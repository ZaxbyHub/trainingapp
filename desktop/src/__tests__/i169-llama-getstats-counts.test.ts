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
import { describe, expect, it } from 'vitest';
import { LlamaEngine, type LlamaEngineBackend, type LlamaEngineOptions } from '../../main/backend/inference/llama-engine';
import type { DocumentSurface } from '../../main/backend/types';

const GB = 1024 ** 3;

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

/** Minimal fake surface: two documents, 2 + 3 chunks, everything else no-op. */
function makeFakeSurface(): DocumentSurface {
  return {
    async listDocuments() {
      return {
        documents: [
          { id: 'a.md', chunk_count: 2 },
          { id: 'b.md', chunk_count: 3 },
        ],
        total: 2,
      };
    },
    async clearDocuments() {},
    async ingestDirectory() {
      return { success: true, documents: 0, chunks_added: 0, message: null };
    },
    async ingestFile() {
      return { success: true, documents: 0, chunks_added: 0, message: null };
    },
    async ingestBatch() {
      return { total_files: 0, successful: 0, failed: 0, results: [] };
    },
    embedderModelId: 'test-embedder',
  };
}

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
});
