// b4-warmup-queue.test.ts — issue #280 (C2 / check C16): warmup() must chain
// its load onto the engine's per-generation queue exactly as query() does.
//
// RED at base, GREEN after the fix: at the base revision warmup() awaited
// ensureResident DIRECTLY, so a warmup landing while a generation was parked
// on the resident backend ran loadBackend immediately — and loadBackend
// disposes the OLD resident before constructing the new identity — disposing
// the backend that was still generating. After the fix the load is chained
// onto this.queue (this.queue = this.queue.then(load).catch(() => {})), the
// admission-gate + assertEngineActive semantics are unchanged, and the
// single-flight loadInFlight branch still merges a concurrent query load.
//
// Harness: stub llamaFactory backend whose generate() parks on a deferred
// promise (the deferred() pattern from b8-wiring.test.ts /
// gpu-test-coordination.test.ts), CI-safe (no weights, no native backend).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlamaEngine, type LlamaEngineBackend } from '../../main/backend/inference/llama-engine';

const GB = 1024 ** 3;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for: ${what}`);
}

/** Factory backend whose generate() parks on a caller-held deferred; disposal is recorded. */
class ParkingBackend implements LlamaEngineBackend {
  disposed = false;
  generating = false;
  constructor(private readonly gate: Promise<void>) {}
  async generate(
    _question: string,
    _opts: { history?: unknown[]; streamCallback?: (t: string) => void },
  ): Promise<{ answer: string; cancelled: boolean }> {
    this.generating = true;
    await this.gate;
    this.generating = false;
    return { answer: 'warmup-queue answer', cancelled: false };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function stageModels(): { quality: string; fast: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-warmup-queue-'));
  tmpDirs.push(dir);
  const quality = path.join(dir, 'q.gguf');
  const fast = path.join(dir, 'f.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return { quality, fast };
}

describe('C16: warmup() queues its load behind an in-flight generation', () => {
  it('the resident backend is NOT disposed before the parked generation resolves and IS disposed after', async () => {
    const models = stageModels();
    const gate = deferred();
    const resident = new ParkingBackend(gate.promise);
    let constructed = 0;
    const engine = new LlamaEngine({
      profile: 'quality',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      // issue #155: a pinned selection keeps the admission gate unarmed
      // (gpuIsForced) so the warmup path takes the deterministic fast path.
      vulkan: false,
      models,
      llamaFactory: async () => {
        constructed += 1;
        return resident;
      },
    });

    // 1. Start a query whose generation parks on the deferred.
    const query = engine.query('parked question', {});
    await until(() => resident.generating, 5000, 'the parked generation to start');
    expect(resident.disposed).toBe(false);
    expect(constructed).toBe(1);

    // 2. Switch the profile and warm up the OTHER identity while the
    //    generation is parked.
    expect(engine.applySettingsPatch({ 'inference.profile': 'fast' }).ok).toBe(true);
    const warm = engine.warmup();
    let warmSettled = false;
    void warm.then(() => {
      warmSettled = true;
    });

    // 3. The queued warmup must NOT dispose the resident the parked
    //    generation is still using. At base, loadBackend disposed it here.
    await new Promise((r) => setTimeout(r, 150));
    expect(resident.disposed, 'the resident stays alive while the parked generation runs').toBe(false);
    expect(warmSettled, 'the warmup load waits behind the generation').toBe(false);

    // 4. Release the generation: the query completes, THEN the warmup load
    //    runs and disposes the old resident while constructing the new one.
    gate.resolve();
    const result = await query;
    expect(result.answer).toBe('warmup-queue answer');
    await until(() => resident.disposed, 5000, 'the resident disposal after the queued load runs');
    await warm;
    expect(warmSettled).toBe(true);
    expect(constructed, 'the fast-profile load constructed a backend').toBeGreaterThanOrEqual(2);
  });
});
