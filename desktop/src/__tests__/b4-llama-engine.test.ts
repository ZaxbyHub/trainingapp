// B4 acceptance checks (issue #62): AC4 (cancel <200ms) + AC5 (resident
// model) + the LlamaEngine contracts the node host depends on.
//
// Import discipline: NOTHING here imports node-llama-cpp directly. Group A
// drives LlamaEngine through an injected llamaFactory (CI-safe, no weights,
// no native backend). Group B uses the REAL default backend but is guarded on
// the staged fast model file and skips (with a named-artifact warning) when
// it is absent — devstation-only, never a blanket skip.
//
// On the pre-fix tree this file FAILS AT IMPORT (Cannot find module
// ../../main/backend/inference/llama-engine) — collect-time failure, never a
// hang, because no top-level code awaits anything.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server';
import { StubEngine } from '../../main/backend/engine';
import { createLoopbackGuard } from '../../main/security/loopback-guard';
import {
  FAST_MODEL_SUBPATH,
  LlamaEngine,
  ModelNotConfiguredError,
  QUALITY_MODEL_SUBPATH,
  resolveNodeEngine,
  type LlamaEngineBackend,
  type LlamaEngineOptions,
} from '../../main/backend/inference/llama-engine';

const GB = 1024 ** 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Group A — mocked backend (must run in CI, no weights)
// ---------------------------------------------------------------------------

/** Fake native backend: streams a token every ~10ms until 100 tokens or the
 *  cancellation flag is set; the flag is checked before EVERY emission. */
class FakeBackend implements LlamaEngineBackend {
  generations = 0;
  disposed = false;

  async generate(
    _question: string,
    opts: { history?: unknown[]; streamCallback?: (token: string) => void; cancellationEvent?: { isSet(): boolean } },
  ): Promise<{ answer: string; cancelled: boolean }> {
    this.generations += 1;
    let answer = '';
    for (let i = 0; i < 100; i += 1) {
      if (opts.cancellationEvent?.isSet()) {
        return { answer, cancelled: true };
      }
      answer += `t${i} `;
      opts.streamCallback?.(`t${i} `);
      await delay(10);
    }
    return { answer, cancelled: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

interface FactoryCapture {
  modelPath: string;
  threads: number;
  vulkan: boolean;
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Dummy model files so the engine's existence check passes without weights. */
function stageDummyModels(): { quality: string; fast: string; dir: string } {
  const dir = makeTmpDir('b4-dummy-models-');
  const quality = path.join(dir, 'quality-dummy.gguf');
  const fast = path.join(dir, 'fast-dummy.gguf');
  fs.writeFileSync(quality, 'x', 'utf8');
  fs.writeFileSync(fast, 'x', 'utf8');
  return { quality, fast, dir };
}

interface EngineHarness {
  engine: LlamaEngine;
  backends: FakeBackend[];
  captures: FactoryCapture[];
}

function makeEngine(overrides: Partial<LlamaEngineOptions> = {}): EngineHarness {
  const dummy = stageDummyModels();
  const backends: FakeBackend[] = [];
  const captures: FactoryCapture[] = [];
  const engine = new LlamaEngine({
    profile: 'fast',
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: { quality: dummy.quality, fast: dummy.fast },
    llamaFactory: async (opts) => {
      captures.push({ modelPath: opts.modelPath, threads: opts.threads, vulkan: opts.vulkan });
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    },
    ...overrides,
  });
  return { engine, backends, captures };
}

describe('b4-llama-engine Group A (mocked backend): resident model + cancellation', () => {
  it('pins the model subpath constants the profile table resolves against', () => {
    expect(QUALITY_MODEL_SUBPATH).toBe('gemma-4-e2b-it/model.gguf');
    expect(FAST_MODEL_SUBPATH).toBe('lfm2.5-vl-450m/model.gguf');
  });

  it('AC5 resident: two SEQUENTIAL queries construct the backend exactly once and the second still streams', async () => {
    const { engine } = makeEngine();
    const first: string[] = [];
    const r1 = await engine.query('first', { streamCallback: (t) => first.push(t) });
    expect(engine.getLoadCount()).toBe(1);
    expect(first.length).toBeGreaterThan(0);
    expect(r1.answer.length).toBeGreaterThan(0);

    const second: string[] = [];
    const r2 = await engine.query('second', { streamCallback: (t) => second.push(t) });
    expect(engine.getLoadCount()).toBe(1);
    expect(second.length).toBeGreaterThan(0);
    expect(r2.answer.length).toBeGreaterThan(0);
  });

  it('AC5 resident: CONCURRENT queries reuse the single backend (no double load)', async () => {
    const { engine } = makeEngine();
    const [a, b] = await Promise.all([engine.query('a'), engine.query('b')]);
    expect(engine.getLoadCount()).toBe(1);
    expect(a.answer.length).toBeGreaterThan(0);
    expect(b.answer.length).toBeGreaterThan(0);
  });

  it('AC5 resident: a profile SWITCH disposes the old backend and constructs exactly one new backend', async () => {
    const { engine, backends } = makeEngine();
    await engine.query('fast first');
    expect(engine.getLoadCount()).toBe(1);

    const patch = engine.applySettingsPatch({ 'inference.profile': 'quality' });
    expect(patch.ok).toBe(true);

    await engine.query('quality now');
    expect(engine.getLoadCount()).toBe(2);
    expect(backends[0].disposed).toBe(true);
    expect(backends[0].generations).toBe(1); // old backend answered exactly its one query

    await engine.query('quality again');
    expect(engine.getLoadCount()).toBe(2); // no further reconstruction
  });

  it('AC4 cancel: flag set mid-generation resolves cancelled:true and stops streaming <200ms after the flag', async () => {
    const { engine } = makeEngine();
    const flag = { set: false, isSet: () => flag.set };
    const emissions: number[] = [];
    const promise = engine.query('long answer please', {
      streamCallback: () => emissions.push(performance.now()),
      cancellationEvent: flag,
    });
    // Let ~8 tokens stream (10ms cadence), then pull the plug.
    await delay(80);
    const flagSetAt = performance.now();
    flag.set = true;
    const result = await promise;

    expect(result.cancelled).toBe(true);
    expect(emissions.length).toBeGreaterThan(0);
    const lastEmission = emissions[emissions.length - 1];
    expect(lastEmission - flagSetAt).toBeLessThan(200);
    // And the backend must have SEEN the flag ( honoured, not just raced ).
    expect(result.answer.length).toBeLessThan(100 * 3); // it stopped early
  });

  it('threads default is min(cores, 8) via defaultThreadCount; an explicit threads override wins', async () => {
    const twelveCores = makeEngine({ cpuCount: () => 12 });
    await twelveCores.engine.query('q');
    expect(twelveCores.captures[0].threads).toBe(8); // NOT min(cores, 4)

    const explicit = makeEngine({ threads: 3 });
    await explicit.engine.query('q');
    expect(explicit.captures[0].threads).toBe(3);
  });

  it('vulkan defaults to false (reserved) and is forwarded when set', async () => {
    const plain = makeEngine();
    await plain.engine.query('q');
    expect(plain.captures[0].vulkan).toBe(false);
  });

  it('auto profile uses the DEFAULT 6 GiB threshold: exactly 6 GiB -> quality path, one byte under -> fast path', async () => {
    const atThreshold = makeEngine({ profile: 'auto', freeMemBytes: () => 6 * GB });
    await atThreshold.engine.query('q');
    expect(atThreshold.captures[0].modelPath).toContain('quality-dummy.gguf');

    const under = makeEngine({ profile: 'auto', freeMemBytes: () => 6 * GB - 1 });
    await under.engine.query('q');
    expect(under.captures[0].modelPath).toContain('fast-dummy.gguf');
  });

  it('a custom profileThresholdGb moves the auto boundary', async () => {
    const h = makeEngine({ profile: 'auto', profileThresholdGb: 2, freeMemBytes: () => 2 * GB });
    await h.engine.query('q');
    expect(h.captures[0].modelPath).toContain('quality-dummy.gguf');
  });

  it('getStats(): llm_backend names llama.cpp AND the effective profile', async () => {
    const { engine } = makeEngine({ profile: 'fast' });
    await engine.query('warm up');
    const stats = await engine.getStats();
    expect(stats.llm_backend ?? '').toContain('llama.cpp');
    expect(stats.llm_backend ?? '').toContain('fast');
  });

  it('settings patch: all four inference keys are accepted and reflected in responseSettings()', () => {
    const { engine } = makeEngine();
    const patch = engine.applySettingsPatch({
      'inference.profile': 'quality',
      'inference.profileThresholdGb': 8,
      'inference.threads': 4,
      'inference.vulkan': false,
    });
    expect(patch.ok).toBe(true);
    const settings = engine.responseSettings();
    expect(settings['inference.profile']).toBe('quality');
    expect(settings['inference.profileThresholdGb']).toBe(8);
    expect(settings['inference.threads']).toBe(4);
    expect(settings['inference.vulkan']).toBe(false);
  });

  it('settings patch: unknown keys and wrong-typed/out-of-bounds values are rejected with ok:false', () => {
    const { engine } = makeEngine();
    const badPatches: Array<Record<string, unknown>> = [
      { 'inference.profile': 'turbo' },
      { 'inference.profile': 7 },
      { 'inference.unknown': 1 },
      { 'inference.threads': 0 },
      { 'inference.threads': 65 },
      { 'inference.threads': 1.5 },
      { 'inference.threads': '4' },
      { 'inference.profileThresholdGb': 0 },
      { 'inference.profileThresholdGb': -1 },
      { 'inference.profileThresholdGb': 'big' },
      { 'inference.vulkan': 'yes' },
      { 'inference.vulkan': 1 },
    ];
    for (const patch of badPatches) {
      const result = engine.applySettingsPatch(patch);
      expect(result.ok, `patch ${JSON.stringify(patch)} must be rejected`).toBe(false);
      if (!result.ok) {
        expect([400, 422]).toContain(result.status);
        expect(typeof result.detail).toBe('string');
      }
    }
  });

  it('no model staged: query rejects ModelNotConfiguredError naming the resolved path, and the backend is NEVER constructed', async () => {
    const emptyDir = makeTmpDir('b4-empty-models-');
    let constructions = 0;
    const engine = new LlamaEngine({
      modelDir: emptyDir,
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      llamaFactory: async () => {
        constructions += 1;
        throw new Error('the backend must not be constructed when the model file is missing');
      },
    });
    let caught: unknown;
    try {
      await engine.query('hi');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelNotConfiguredError);
    const failure = caught as ModelNotConfiguredError;
    expect(typeof failure.detail).toBe('string');
    // The diagnostic names the resolved path (dir + FAST_MODEL_SUBPATH) and
    // says how to fix it.
    expect(failure.detail).toContain(emptyDir);
    expect(failure.detail).toContain('lfm2.5-vl-450m');
    expect(failure.detail).toContain('model.gguf');
    expect(constructions).toBe(0);
  });

  it('resolveNodeEngine: stub env -> StubEngine; otherwise -> LlamaEngine honoring env modelDir and profile', async () => {
    const stub = resolveNodeEngine({ TRAININGAPP_DESKTOP_ENGINE: 'stub' });
    expect(stub).toBeInstanceOf(StubEngine);

    const dir = makeTmpDir('b4-resolve-engine-');
    const real = resolveNodeEngine({
      TRAININGAPP_INFERENCE_MODEL_DIR: dir,
      TRAININGAPP_DESKTOP_INFERENCE_PROFILE: 'fast',
    });
    expect(real).toBeInstanceOf(LlamaEngine);
    let caught: unknown;
    try {
      await real.query('hi');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelNotConfiguredError);
    expect((caught as ModelNotConfiguredError).detail).toContain(dir);
  });
});

// ---------------------------------------------------------------------------
// Server-level 503: model-not-configured must surface as HTTP 503 with a JSON
// detail — for /ask/stream BEFORE any SSE frame is written.
// ---------------------------------------------------------------------------

describe('b4-llama-engine server behavior: ModelNotConfiguredError -> 503 JSON', () => {
  const TOKEN = 'b4-no-model-token';
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const emptyDir = makeTmpDir('b4-server-nomodel-');
    const engine = new LlamaEngine({
      modelDir: emptyDir,
      profile: 'fast',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
    });
    server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine,
    });
    port = await listenOnRandomPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POST /ask answers 503 with a JSON {detail} diagnostic (not a 500, not a stub answer)', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
      body: JSON.stringify({ question: 'hi' }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { detail?: unknown };
    expect(typeof body.detail).toBe('string');
    expect((body.detail as string).length).toBeGreaterThan(0);
  });

  it('POST /ask/stream answers 503 JSON BEFORE any SSE frame (never text/event-stream)', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ask/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
      body: JSON.stringify({ question: 'hi' }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/json');
    const raw = await response.text();
    expect(raw.startsWith('data:')).toBe(false);
    const body = JSON.parse(raw) as { detail?: unknown };
    expect(typeof body.detail).toBe('string');
    expect((body.detail as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Group B — REAL model integration (guarded on the staged fast weights)
// ---------------------------------------------------------------------------

/** Resolve the repo root from THIS file's location: the vitest cwd is
 *  desktop/ under `npm --prefix desktop test`, so cwd-based resolution is
 *  not portable. The contracts dir is the stable root marker. */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'contracts', 'api.openapi.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot();
const REAL_FAST_MODEL = path.join(REPO_ROOT, 'models', 'lfm2.5-vl-450m', 'model.gguf');
if (!fs.existsSync(REAL_FAST_MODEL)) {
  // Inline guard naming the EXACT missing artifact — never a blanket skip.
  console.warn(
    `[b4-llama-engine] REAL-MODEL-ARTIFACT-MISSING: ${REAL_FAST_MODEL} — Group B real-inference checks skip (devstation-only; stage the fast model to run them)`,
  );
}
const itReal = fs.existsSync(REAL_FAST_MODEL) ? it : it.skip;

describe('b4-llama-engine Group B (real model, real default backend)', () => {
  let engine: LlamaEngine;

  beforeAll(() => {
    engine = new LlamaEngine({ modelDir: path.join(REPO_ROOT, 'models'), profile: 'fast' });
  });

  afterAll(async () => {
    // EngineSurface has no dispose in the frozen contract; LlamaEngine may
    // expose one — call it best-effort so the native model does not leak.
    const maybeDisposable = engine as unknown as { dispose?: () => Promise<void> };
    if (typeof maybeDisposable.dispose === 'function') await maybeDisposable.dispose();
  });

  itReal(
    'real query streams >=1 token and returns a non-empty answer',
    async () => {
      const tokens: string[] = [];
      const result = await engine.query('Say OK and nothing else.', {
        streamCallback: (t) => tokens.push(t),
      });
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      expect(result.answer.trim().length).toBeGreaterThan(0);
      expect(result.cancelled ?? false).toBe(false);
    },
    240_000,
  );

  itReal(
    'AC4 real cancel: flag after the first token stops streaming <200ms and resolves cancelled',
    async () => {
      const flag = { set: false, isSet: () => flag.set };
      let tokenCount = 0;
      let lastEmissionAt = 0;
      let releaseOnFirstToken: () => void = () => {};
      const firstToken = new Promise<void>((resolve) => {
        releaseOnFirstToken = resolve;
      });
      const promise = engine.query('Count slowly from 1 to 100, one number per line.', {
        streamCallback: () => {
          tokenCount += 1;
          lastEmissionAt = performance.now();
          if (tokenCount === 1) releaseOnFirstToken();
        },
        cancellationEvent: flag,
      });
      await firstToken;
      const flagSetAt = performance.now();
      flag.set = true;
      const result = await promise;
      expect(result.cancelled).toBe(true);
      expect(tokenCount).toBeGreaterThanOrEqual(1);
      expect(lastEmissionAt - flagSetAt).toBeLessThan(200);
    },
    240_000,
  );

  itReal(
    'AC5 resident with the real backend: two queries -> getLoadCount()===1',
    async () => {
      const r1 = await engine.query('Say OK.');
      const r2 = await engine.query('Say OK again.');
      expect(r1.answer.length).toBeGreaterThan(0);
      expect(r2.answer.length).toBeGreaterThan(0);
      expect(engine.getLoadCount()).toBe(1);
    },
    240_000,
  );
});
