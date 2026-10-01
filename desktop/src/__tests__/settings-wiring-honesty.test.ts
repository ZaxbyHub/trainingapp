// settings-wiring-honesty: the desktop preset contract. Pins explicit-set
// precedence (an explicit rag_max_tokens / rag_temperature /
// rag_reranking_enabled wins; otherwise the inference profile and retrieval
// env default apply), query-time application through the REAL generation
// seam (defaultLlamaFactory -> session.prompt) and the per-query rerank flag,
// the reset directive, and the honest GET /settings report. The last block is
// guardrail (b): every keyspace key either has an observable query-time
// effect or is reported in `not_applied` — and a reported key has none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_BOUNDS } from '../../main/backend/engine.js';
import {
  buildGenerationParams,
  LlamaEngine,
  type LlamaEngineBackend,
} from '../../main/backend/inference/llama-engine.js';

// The real defaultLlamaFactory dynamically imports node-llama-cpp; this fake
// records the options that reach LlamaChatSession.prompt (the sampler).
const NLC = vi.hoisted(() => ({ prompts: [] as Array<Record<string, unknown>> }));
vi.mock('node-llama-cpp', () => {
  class LlamaChatSession {
    setChatHistory(): void {}
    resetChatHistory(): void {}
    async prompt(_question: string, options: Record<string, unknown>): Promise<string> {
      NLC.prompts.push(options);
      return 'ok';
    }
  }
  return {
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: () => undefined }),
        dispose: () => undefined,
      }),
    }),
    LlamaChatSession,
  };
});

const GB = 1024 ** 3;
let tmpDir = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-wiring-honesty-'));
  NLC.prompts.length = 0;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

class RecordingBackend implements LlamaEngineBackend {
  calls: Array<Record<string, unknown>> = [];
  async generate(_question: string, opts: Record<string, unknown>): Promise<{ answer: string; cancelled: boolean }> {
    this.calls.push(opts);
    return { answer: 'ok', cancelled: false };
  }
  async dispose(): Promise<void> {}
}

/** Recording retrieval surface (rerank-capable unless told otherwise). */
function recordingSurface(opts: { floorActive?: boolean; rerankDefault?: boolean } = {}) {
  const searches: Array<{ n: number | undefined; options: unknown }> = [];
  const surface = {
    floorActive: opts.floorActive ?? true,
    ...(opts.rerankDefault !== undefined ? { rerankDefault: opts.rerankDefault } : {}),
    async search(query: string, n?: number, options?: unknown) {
      searches.push({ n, options });
      return [{ text: `chunk for ${query}`, source: 'doc.md', similarity: 0.9, chunkId: 'c1' }];
    },
  };
  return { surface, searches };
}

function modelFiles(): { quality: string; fast: string } {
  const quality = path.join(tmpDir, 'quality.gguf');
  const fast = path.join(tmpDir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast };
}

/** LlamaEngine on the injected recording backend. */
function engineWithRecorder(profile: 'quality' | 'fast' = 'quality') {
  const backend = new RecordingBackend();
  const engine = new LlamaEngine({
    profile,
    freeMemBytes: () => 8 * GB,
    cpuCount: () => 8,
    models: modelFiles(),
    llamaFactory: async () => backend,
  });
  return { engine, backend };
}

describe('settings-wiring-honesty: explicit-set precedence (desktop LlamaEngine)', () => {
  it('PRESERVING: quality profile with nothing explicit generates with 1024/0.2 and keeps reranking on (real sampler seam)', async () => {
    // No llamaFactory: the production defaultLlamaFactory runs against the
    // mocked node-llama-cpp, so this pins what actually reaches prompt().
    const engine = new LlamaEngine({ profile: 'quality', freeMemBytes: () => 8 * GB, cpuCount: () => 8, models: modelFiles() });
    const { surface, searches } = recordingSurface();
    engine.attachRetrievalSurface(surface);

    const result = await engine.query('fresh install question', {});

    expect(NLC.prompts).toHaveLength(1);
    expect(NLC.prompts[0]).toMatchObject({ maxTokens: 1024, temperature: 0.2, topP: 0.9 });
    expect(searches[0].options).toEqual({ rerank: true });
    expect(result.grounding).toBe('grounded');
    const settings = engine.responseSettings();
    expect(settings.explicit_keys).toEqual([]);
    expect(settings.requested).toEqual({ n_results: null, reranking_enabled: null, max_tokens: null, temperature: null });
    expect(settings.effective).toEqual({ n_results: 4, reranking_enabled: true, max_tokens: 1024, temperature: 0.2 });
    // Flat keys carry the effective values (backward-compatible names).
    expect(settings).toMatchObject({ n_results: 4, reranking_enabled: true, max_tokens: 1024, temperature: 0.2 });
    expect(settings.reranking_available).toBe(true);
  });

  it('explicit rag_max_tokens / rag_temperature reach the real sampler and are re-read per query', async () => {
    const engine = new LlamaEngine({ profile: 'quality', freeMemBytes: () => 8 * GB, cpuCount: () => 8, models: modelFiles() });

    expect(engine.applySettingsPatch({ rag_max_tokens: 300, rag_temperature: 0.7 })).toEqual({ ok: true });
    await engine.query('first', {});
    expect(NLC.prompts[0]).toMatchObject({ maxTokens: 300, temperature: 0.7 });

    expect(engine.applySettingsPatch({ rag_max_tokens: 900 })).toEqual({ ok: true });
    await engine.query('second', {});
    expect(NLC.prompts[1]).toMatchObject({ maxTokens: 900, temperature: 0.7 });
  });

  it('buildGenerationParams: overrides win field by field; omitted overrides keep the profile value', () => {
    expect(buildGenerationParams('quality', {}, { maxTokens: 300 })).toEqual({ maxTokens: 300, temperature: 0.2, topP: 0.9 });
    expect(buildGenerationParams('fast', {}, { temperature: 1.1 })).toEqual({ maxTokens: 384, temperature: 1.1, topP: 0.9 });
    expect(buildGenerationParams('fast', {}, {})).toEqual(buildGenerationParams('fast'));
  });

  it('generate() opts carry no generation keys until they are explicitly set', async () => {
    const { engine, backend } = engineWithRecorder('fast');
    await engine.query('q', {});
    expect(backend.calls[0]).not.toHaveProperty('maxTokens');
    expect(backend.calls[0]).not.toHaveProperty('temperature');
    expect(engine.responseSettings().effective).toMatchObject({ max_tokens: 384, temperature: 0.3 });
  });

  it('explicit rag_reranking_enabled=false skips the reranker per query and resolves grounding "general"', async () => {
    const { engine } = engineWithRecorder();
    const { surface, searches } = recordingSurface();
    engine.attachRetrievalSurface(surface);
    expect(engine.applySettingsPatch({ rag_reranking_enabled: false })).toEqual({ ok: true });

    const result = await engine.query('q', {});
    expect(searches[0].options).toEqual({ rerank: false });
    // Issue #72: a rerank-off query was never floor-gated.
    expect(result.grounding).toBe('general');
    // The surface itself still reports a live reranker (no mutable state).
    expect(surface.floorActive).toBe(true);
    const settings = engine.responseSettings();
    expect(settings.requested).toMatchObject({ reranking_enabled: false });
    expect(settings.effective).toMatchObject({ reranking_enabled: false });

    // /search honors the same flag.
    await engine.search('q', 3);
    expect(searches[1]).toEqual({ n: 3, options: { rerank: false } });
  });

  it('the env default (surface rerankDefault=false) applies when rag_reranking_enabled is not explicit', async () => {
    const { engine } = engineWithRecorder();
    const { surface, searches } = recordingSurface({ floorActive: false, rerankDefault: false });
    engine.attachRetrievalSurface(surface);
    await engine.query('q', {});
    expect(searches[0].options).toEqual({ rerank: false });
  });

  it('no reranker built at boot: reranking reported unavailable and effectively off even when explicitly requested', () => {
    const { engine } = engineWithRecorder();
    engine.attachRetrievalSurface(recordingSurface({ floorActive: false }).surface);
    expect(engine.applySettingsPatch({ rag_reranking_enabled: true })).toEqual({ ok: true });
    const settings = engine.responseSettings();
    expect(settings.reranking_available).toBe(false);
    expect(settings.requested).toMatchObject({ reranking_enabled: true });
    expect(settings.effective).toMatchObject({ reranking_enabled: false });
    expect(settings.reranking_enabled).toBe(false);
  });

  it('a rejected patch (422) leaves the explicit key set and stored values unchanged', () => {
    const { engine } = engineWithRecorder();
    expect(engine.applySettingsPatch({ rag_n_results: 6 })).toEqual({ ok: true });
    const result = engine.applySettingsPatch({ rag_max_tokens: 300, rag_temperature: 9 });
    expect(result.ok).toBe(false);
    const settings = engine.responseSettings();
    expect(settings.explicit_keys).toEqual(['rag_n_results']);
    expect(settings.effective).toMatchObject({ max_tokens: 1024 });
  });

  it('inference.* keys never count as explicit preset keys', () => {
    const { engine } = engineWithRecorder();
    expect(engine.applySettingsPatch({ 'inference.profile': 'fast' })).toEqual({ ok: true });
    expect(engine.responseSettings().explicit_keys).toEqual([]);
  });
});

describe('settings-wiring-honesty: reset directive (engine level)', () => {
  it('reset restores the profile default and drops the key from explicit_keys', async () => {
    const { engine, backend } = engineWithRecorder();
    expect(engine.applySettingsPatch({ rag_max_tokens: 300, rag_n_results: 7 })).toEqual({ ok: true });
    expect(engine.resetSettings(['rag_max_tokens', 'rag_n_results'])).toEqual({ ok: true });
    const settings = engine.responseSettings();
    expect(settings.explicit_keys).toEqual([]);
    expect(settings.effective).toMatchObject({ max_tokens: 1024, n_results: 4 });
    await engine.query('q', {});
    expect(backend.calls[0]).not.toHaveProperty('maxTokens');
  });

  it('rejects unknown keys and non-array input with 422, committing nothing', () => {
    const { engine } = engineWithRecorder();
    expect(engine.applySettingsPatch({ rag_max_tokens: 300 })).toEqual({ ok: true });
    for (const bad of [['rag_max_tokens', 'bogus'], 'rag_max_tokens', [1], ['inference.profile']]) {
      const result = engine.resetSettings(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(422);
    }
    expect(engine.responseSettings().explicit_keys).toEqual(['rag_max_tokens']);
  });

  it('rejects a reset that would break overlap < size with 400, committing nothing', () => {
    const { engine } = engineWithRecorder();
    expect(engine.applySettingsPatch({ rag_chunk_size: 3000, rag_chunk_overlap: 1500 })).toEqual({ ok: true });
    const result = engine.resetSettings(['rag_chunk_size']);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(engine.responseSettings().chunk_size).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Guardrail (b): PUT each keyspace key with a non-default value and require
// an observable query-time effect OR a `not_applied` report — and a key that
// is reported not_applied must have NO effect (the report is not a dodge).
// ---------------------------------------------------------------------------

type Bounds = { min?: number; max?: number; type: string };

/** Observable query-time behavior of a fresh engine after an optional patch. */
async function observe(patch: Record<string, unknown> | null) {
  const { engine, backend } = engineWithRecorder('quality');
  const { surface, searches } = recordingSurface();
  engine.attachRetrievalSurface(surface);
  if (patch !== null) expect(engine.applySettingsPatch(patch)).toEqual({ ok: true });
  const result = await engine.query('guardrail question', {});
  await engine.search('guardrail search');
  const generate = backend.calls[0] ?? {};
  return {
    engine,
    signature: JSON.stringify({
      searches,
      maxTokens: generate.maxTokens ?? null,
      temperature: generate.temperature ?? null,
      grounding: result.grounding,
    }),
  };
}

/** A valid value that differs from both the stored default and the reported (effective) value. */
function nonDefaultValue(key: string, reported: unknown): unknown {
  const bounds = (SETTING_BOUNDS as Record<string, Bounds>)[key];
  const stored = (DEFAULT_SETTINGS as Record<string, unknown>)[key];
  if (bounds.type === 'bool') return !(reported as boolean);
  const step = bounds.type === 'int' ? 1 : 0.1;
  for (const delta of [step, -step, 2 * step, -2 * step]) {
    const candidate = Math.round((Number(stored) + delta) * 1000) / 1000;
    const inBounds = (bounds.min === undefined || candidate >= bounds.min) && (bounds.max === undefined || candidate <= bounds.max);
    if (inBounds && candidate !== stored && candidate !== reported) return candidate;
  }
  throw new Error(`no non-default value found for ${key}`);
}

describe('settings-wiring-honesty guardrail (b): every desktop keyspace key is applied or reported', () => {
  const keyspace = Object.keys(SETTING_BOUNDS);

  it('covers the whole keyspace', () => {
    expect(keyspace.length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([...keyspace].sort());
  });

  it.each(keyspace)('%s: an observable query-time effect, or a not_applied report with no effect', async (key) => {
    const baseline = await observe(null);
    const before = baseline.engine.responseSettings();
    const responseKey = key.replace(/^rag_/, '');
    const value = nonDefaultValue(key, before[responseKey]);
    const after = await observe({ [key]: value });
    const notApplied = after.engine.responseSettings().not_applied as string[];
    if (notApplied.includes(key)) {
      expect(after.signature, `${key} is reported not_applied but changed query behavior`).toBe(baseline.signature);
    } else {
      expect(after.signature, `${key}=${String(value)} is claimed applied but changed nothing observable`).not.toBe(baseline.signature);
    }
  });
});
