// B4 edge cases (issue #62, unfrozen additions per the approved plan): the
// cancellation/profile-switch/failure paths the frozen specs pin only
// partially. Runs everywhere (mocked backend) — no weights required.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LlamaEngine,
  ModelNotConfiguredError,
  buildGenerationParams,
  historyToChatHistory,
  parseEnvThreads,
  resolveNodeEngine,
  type LlamaEngineBackend,
} from '../../main/backend/inference/llama-engine';

const GB = 1024 ** 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeBackend implements LlamaEngineBackend {
  generations = 0;
  disposed = false;
  throwOnGenerate: Error | null = null;

  async generate(
    question: string,
    opts: { streamCallback?: (token: string) => void; cancellationEvent?: { isSet(): boolean } },
  ): Promise<{ answer: string; cancelled: boolean }> {
    this.generations += 1;
    if (this.throwOnGenerate !== null) throw this.throwOnGenerate;
    let answer = '';
    for (let i = 0; i < 100; i += 1) {
      if (opts.cancellationEvent?.isSet()) return { answer, cancelled: true };
      answer += `${question}-t${i} `;
      opts.streamCallback?.(`${question}-t${i} `);
      await delay(10);
    }
    return { answer, cancelled: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function stageDummyModels(): { quality: string; fast: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-edge-models-'));
  const quality = path.join(dir, 'quality-dummy.gguf');
  const fast = path.join(dir, 'fast-dummy.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return { quality, fast };
}

describe('b4-engine-edge-cases', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  function makeEngine(overrides: Record<string, unknown> = {}): {
    engine: LlamaEngine;
    backends: FakeBackend[];
  } {
    const models = stageDummyModels();
    cleanups.push(() => fs.rmSync(path.dirname(models.quality), { recursive: true, force: true }));
    const backends: FakeBackend[] = [];
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models,
      llamaFactory: async () => {
        const backend = new FakeBackend();
        backends.push(backend);
        return backend;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    });
    return { engine, backends };
  }

  it('cancel BEFORE the first emission (pre-set flag) resolves immediately as cancelled', async () => {
    const { engine } = makeEngine();
    const flag = { set: true, isSet: () => flag.set };
    const emissions: string[] = [];
    const result = await engine.query('hi', {
      streamCallback: (t) => emissions.push(t),
      cancellationEvent: flag,
    });
    expect(result.cancelled).toBe(true);
    expect(emissions).toHaveLength(0);
  });

  it('a profile switch DURING an in-flight generation defers the reload to the next query', async () => {
    const { engine, backends } = makeEngine();
    const inFlight = engine.query('long generation');
    // Switch profiles while the fast generation is mid-flight.
    const patch = engine.applySettingsPatch({ 'inference.profile': 'quality' });
    expect(patch.ok).toBe(true);
    const fastResult = await inFlight;
    expect(fastResult.cancelled ?? false).toBe(false);
    // The in-flight generation completed on the FAST backend, untouched.
    expect(backends[0]!.disposed).toBe(false);
    // The NEXT query applies the switch: exactly one new backend, old disposed.
    await engine.query('quality follow-up');
    expect(engine.getLoadCount()).toBe(2);
    expect(backends[0]!.disposed).toBe(true);
    expect(backends[0]!.generations).toBe(1);
  });

  it('a failing factory load wraps into ModelNotConfiguredError carrying the underlying detail', async () => {
    const models = stageDummyModels();
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models,
      llamaFactory: async () => {
        throw new Error('gguf header corrupt: magic mismatch');
      },
    });
    let caught: unknown;
    try {
      await engine.query('hi');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelNotConfiguredError);
    expect((caught as ModelNotConfiguredError).detail).toContain('gguf header corrupt');
  });

  it('rag_* settings keys still round-trip through the composed engine (conformance parity)', () => {
    const { engine } = makeEngine();
    const patch = engine.applySettingsPatch({ rag_n_results: 3 });
    expect(patch.ok).toBe(true);
    expect(engine.responseSettings()['n_results']).toBe(3);
  });

  it('an unknown inference.* key is rejected with 422, not silently ignored', () => {
    const { engine } = makeEngine();
    const result = engine.applySettingsPatch({ 'inference.sampler': 'weird' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });

  it('prototype keys are rejected like unknown settings (hasOwnProperty discipline)', () => {
    const { engine } = makeEngine();
    for (const key of ['toString', 'constructor', 'hasOwnProperty']) {
      const result = engine.applySettingsPatch({ [key]: 1 });
      expect(result.ok, `key ${key} must be rejected`).toBe(false);
    }
  });

  it('resolveNodeEngine pins the Electron model-dir default to <userData>/models', async () => {
    const userData = path.join('base', 'userdata');
    const engine = resolveNodeEngine(
      { TRAININGAPP_DESKTOP_INFERENCE_PROFILE: 'fast' },
      { userDataPath: userData },
    );
    expect(engine).toBeInstanceOf(LlamaEngine);
    // With no weights staged, preflight() fails pointing at the exact
    // location the Electron default resolved to.
    const native = engine as LlamaEngine;
    const error = await native.preflight().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelNotConfiguredError);
    expect((error as Error).message).toContain(path.join(userData, 'models'));
  });

  it('resolveNodeEngine: TRAININGAPP_INFERENCE_MODEL_DIR wins over userDataPath', async () => {
    const modelDir = path.join('custom', 'model-dir');
    const engine = resolveNodeEngine(
      {
        TRAININGAPP_INFERENCE_MODEL_DIR: modelDir,
        TRAININGAPP_DESKTOP_INFERENCE_PROFILE: 'fast',
      },
      { userDataPath: path.join('base', 'userdata') },
    );
    const native = engine as LlamaEngine;
    const error = await native.preflight().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelNotConfiguredError);
    expect((error as Error).message).toContain(modelDir);
    expect((error as Error).message).not.toContain(path.join('base', 'userdata'));
  });

  it('resolveNodeEngine tolerates an invalid TRAININGAPP_DESKTOP_INFERENCE_PROFILE (falls back to auto)', () => {
    expect(() =>
      resolveNodeEngine({ TRAININGAPP_DESKTOP_INFERENCE_PROFILE: 'turbo' }),
    ).not.toThrow();
  });

  it('parseEnvThreads applies the same 1..64 gate as PUT /settings (PRR-001)', () => {
    expect(parseEnvThreads(undefined)).toBeUndefined();
    expect(parseEnvThreads('')).toBeUndefined();
    expect(parseEnvThreads('0')).toBeUndefined();
    expect(parseEnvThreads('-1')).toBeUndefined();
    expect(parseEnvThreads('0x8')).toBeUndefined();
    expect(parseEnvThreads('8.9')).toBeUndefined();
    expect(parseEnvThreads('999999')).toBeUndefined();
    expect(parseEnvThreads('65')).toBeUndefined();
    expect(parseEnvThreads('1')).toBe(1);
    expect(parseEnvThreads('8')).toBe(8);
    expect(parseEnvThreads('64')).toBe(64);
  });

  it('buildGenerationParams pins the sampler shape that reaches session.prompt (PRR-011)', () => {
    expect(buildGenerationParams('quality')).toEqual({ maxTokens: 1024, temperature: 0.2, topP: 0.9 });
    expect(buildGenerationParams('fast')).toEqual({ maxTokens: 384, temperature: 0.3, topP: 0.9 });
    const penalties = { penalty: 1.1, lastTokens: 8192, frequencyPenalty: 0, presencePenalty: 0 };
    expect(buildGenerationParams('fast', penalties)).toEqual({
      maxTokens: 384,
      temperature: 0.3,
      topP: 0.9,
      repeatPenalty: penalties,
    });
    expect(buildGenerationParams('fast', {})).not.toHaveProperty('repeatPenalty');
  });

  it('historyToChatHistory keeps only the last 12 valid turns (PRR-005 overflow cap)', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `t${i}`,
    }));
    const mapped = historyToChatHistory(turns);
    expect(mapped).toHaveLength(12);
    expect(mapped[0]).toEqual({ type: 'user', text: 't18' });
    expect(mapped[mapped.length - 1]).toEqual({ type: 'model', response: ['t29'] });
  });

  it('historyToChatHistory drops malformed entries and tolerates a missing array (PRR-005)', () => {
    const mapped = historyToChatHistory([
      { role: 'user', content: 42 },
      'not-an-object',
      null,
      { role: 'system', content: 'ignored role' },
      { role: 'user', content: 'kept' },
    ]);
    expect(mapped).toEqual([{ type: 'user', text: 'kept' }]);
    expect(historyToChatHistory(undefined)).toEqual([]);
  });

  it('the factory receives the effective profile, updated by settings patches (PRR-011)', async () => {
    const models = stageDummyModels();
    cleanups.push(() => fs.rmSync(path.dirname(models.quality), { recursive: true, force: true }));
    const factoryProfiles: string[] = [];
    const engine = new LlamaEngine({
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models,
      llamaFactory: async (opts) => {
        factoryProfiles.push(opts.profile);
        return new FakeBackend();
      },
    });
    await engine.query('first');
    engine.applySettingsPatch({ 'inference.profile': 'quality' });
    await engine.query('second');
    expect(factoryProfiles).toEqual(['fast', 'quality']);
  });

  it('query after dispose() recreates the backend rather than throwing (PRR-016)', async () => {
    const { engine, backends } = makeEngine();
    await engine.query('before');
    await engine.dispose();
    const result = await engine.query('after');
    expect(result.cancelled ?? false).toBe(false);
    expect(engine.getLoadCount()).toBe(2);
    expect(backends).toHaveLength(2);
    expect(backends[0]!.disposed).toBe(true);
    expect(backends[1]!.disposed).toBe(false);
  });

  it('inference.profileThresholdGb rejects Infinity (PRR-017 boundary)', () => {
    const { engine } = makeEngine();
    const result = engine.applySettingsPatch({ 'inference.profileThresholdGb': Infinity });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });
});
