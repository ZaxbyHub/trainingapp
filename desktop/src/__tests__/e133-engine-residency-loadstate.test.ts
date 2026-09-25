// e133-engine-residency-loadstate.test.ts — issue #133 round 4 guardrails:
//
// 1. AUTO-profile HYSTERESIS: free RAM oscillating around the 6 GiB boundary
//    must NOT swap + reload the resident model per query (the operator saw
//    multi-minute EVERY request). quality holds until free RAM drops a full
//    hysteresis band below the threshold; fast only upgrades at the full
//    threshold.
// 2. Load-state surface: idle -> loading -> ready on a successful load
//    (visible in modelStatus().resident); a failed load resets to idle.
// 3. Boot warmup: loads the effective-profile model without a query, and a
//    concurrent warmup + first query load ONE backend (single-flight).
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlamaEngine, type LlamaEngineBackend, type LlamaEngineOptions } from '../../main/backend/inference/llama-engine';

const GB = 1024 ** 3;

let dummyQuality = '';
let dummyFast = '';

function stageDummyModels(): { quality: string; fast: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e133-engine-'));
  dummyQuality = path.join(root, 'quality-dummy.gguf');
  dummyFast = path.join(root, 'fast-dummy.gguf');
  fs.writeFileSync(dummyQuality, 'quality');
  fs.writeFileSync(dummyFast, 'fast');
  return { quality: dummyQuality, fast: dummyFast };
}

class FakeBackend implements LlamaEngineBackend {
  static created = 0;
  created = ++FakeBackend.created;
  disposed = false;
  async generate(): Promise<{ answer: string; cancelled: boolean }> {
    return { answer: 'ok', cancelled: false };
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

function makeEngine(overrides: Partial<LlamaEngineOptions> = {}): {
  engine: LlamaEngine;
  loads: () => number;
} {
  const dummy = stageDummyModels();
  let loadCount = 0;
  const engine = new LlamaEngine({
    profile: 'fast',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 4,
    models: { quality: dummy.quality, fast: dummy.fast },
    llamaFactory: async () => {
      loadCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new FakeBackend();
    },
    ...overrides,
  });
  return { engine, loads: () => loadCount };
}

beforeAll(() => {
  FakeBackend.created = 0;
});

afterAll(() => {
  // temp roots are cleaned by the OS; nothing to restore
});

describe('auto-profile hysteresis (#133 round 4)', () => {
  it('does not reload when free RAM oscillates INSIDE the hysteresis band', async () => {
    // Start above the threshold -> quality loads.
    let free = 6 * GB;
    const h = makeEngine({ profile: 'auto', freeMemBytes: () => free });
    await h.engine.query('q1');
    expect(h.loads()).toBe(1);
    // Oscillate between 4.5 GiB (below threshold, inside the 2 GiB band) and
    // 5.9 GiB (below threshold) — old behavior re-selected fast per query and
    // reloaded every time; the sticky band must keep quality resident.
    free = 4.5 * GB;
    await h.engine.query('q2');
    free = 5.9 * GB;
    await h.engine.query('q3');
    free = 4.6 * GB;
    await h.engine.query('q4');
    expect(h.loads()).toBe(1);
  });

  it('downgrades only below the band and upgrades back at the full threshold', async () => {
    let free = 6 * GB;
    const h = makeEngine({ profile: 'auto', freeMemBytes: () => free });
    await h.engine.query('q1'); // quality
    expect(h.loads()).toBe(1);
    free = 3.9 * GB; // below threshold - 2 GiB band
    await h.engine.query('q2'); // fast loads
    expect(h.loads()).toBe(2);
    free = 5.9 * GB; // recovered but under the full threshold: stays fast
    await h.engine.query('q3');
    expect(h.loads()).toBe(2);
    free = 6 * GB; // full threshold: upgrades
    await h.engine.query('q4');
    expect(h.loads()).toBe(3);
  });

  it('an explicit profile setting is unaffected by the band (never flips)', async () => {
    let free = 6 * GB;
    const h = makeEngine({ profile: 'quality', freeMemBytes: () => free });
    await h.engine.query('q1');
    free = 3 * GB;
    await h.engine.query('q2');
    expect(h.loads()).toBe(1);
  });
});

describe('load-state surface + warmup (#133 round 4)', () => {
  it('modelStatus().resident: idle initially, ready after a load', async () => {
    const h = makeEngine();
    expect(h.engine.modelStatus().resident?.state).toBe('idle');
    await h.engine.query('q');
    expect(h.engine.modelStatus().resident?.state).toBe('ready');
    expect(h.engine.modelStatus().resident?.profile).toBe('fast');
  });

  it('warmup loads the model without a query; concurrent warmup + query load ONE backend', async () => {
    const h = makeEngine();
    const warm = h.engine.warmup();
    const query = h.engine.query('concurrent');
    await Promise.all([warm, query]);
    expect(h.loads()).toBe(1);
    expect(h.engine.modelStatus().resident?.state).toBe('ready');
  });

  it('a failed load reports idle (never a stuck loading state) and warmup swallows it', async () => {
    const dummy = stageDummyModels();
    let loadCount = 0;
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 4,
      models: { quality: dummy.quality, fast: dummy.fast },
      llamaFactory: async () => {
        loadCount += 1;
        throw new Error('boom');
      },
    });
    await engine.warmup(); // must not throw
    expect(engine.modelStatus().resident?.state).toBe('idle');
    await expect(engine.query('q')).rejects.toThrow();
    expect(engine.modelStatus().resident?.state).toBe('idle');
    expect(loadCount).toBeGreaterThanOrEqual(1);
  });

  it('a slow load reports loading while in flight', async () => {
    const dummy = stageDummyModels();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 4,
      models: { quality: dummy.quality, fast: dummy.fast },
      llamaFactory: async () => {
        await gate;
        return new FakeBackend();
      },
    });
    const load = engine.warmup();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.modelStatus().resident?.state).toBe('loading');
    expect(engine.modelStatus().resident?.loadStartedAt).not.toBeNull();
    // Round-5 finding: the profile must be visible DURING the load (the
    // resident entry is null until ready) so the chat banner can say which
    // model is loading instead of falling back to "auto".
    expect(engine.modelStatus().resident?.profile).toBe('fast');
    release();
    await load;
    expect(engine.modelStatus().resident?.state).toBe('ready');
    expect(engine.modelStatus().resident?.profile).toBe('fast');
  });
});
