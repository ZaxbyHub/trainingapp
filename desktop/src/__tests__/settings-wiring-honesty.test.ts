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
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_BOUNDS } from '../../main/backend/engine.js';
import { PENALTY_FULL_CONTEXT_TOKENS } from '../../main/backend/inference/penalties.js';
import {
  buildGenerationParams,
  LlamaEngine,
  type LlamaEngineBackend,
} from '../../main/backend/inference/llama-engine.js';

// The real defaultLlamaFactory dynamically imports node-llama-cpp; this fake
// records the options that reach LlamaChatSession.prompt (the sampler) and the
// options its CONSTRUCTOR receives (the chat wrapper — issue #154).
const NLC = vi.hoisted(() => ({
  prompts: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  historyResets: [] as string[],
  // Failure switches so the production error and cleanup paths are reachable.
  fail: { sessionCtor: false, historySeed: false, reset: false },
}));
vi.mock('node-llama-cpp', () => {
  // Mirrors the real Gemma4ChatWrapper default (reasoning=true) so a missing
  // override shows up instead of passing silently.
  class Gemma4ChatWrapper {
    readonly reasoning: boolean;
    constructor(options?: { reasoning?: boolean }) {
      this.reasoning = options?.reasoning ?? true;
    }
  }
  class LlamaChatSession {
    constructor(options: Record<string, unknown>) {
      if (NLC.fail.sessionCtor) throw new Error('stub: LlamaChatSession constructor failed');
      NLC.sessions.push(options);
    }
    setChatHistory(): void {
      if (NLC.fail.historySeed) throw new Error('stub: setChatHistory failed');
      NLC.historyResets.push('seed');
    }
    resetChatHistory(): void {
      if (NLC.fail.reset) throw new Error('stub: resetChatHistory failed');
      NLC.historyResets.push('reset');
    }
    async prompt(_question: string, options: Record<string, unknown>): Promise<string> {
      NLC.prompts.push(options);
      if (typeof options.onToken === 'function') {
        // The library batches generated tokens into arrays (LlamaChat.js:2619);
        // deliver batches so the answer-token counter is exercised for real.
        for (let i = 0; i < 4; i += 1) (options.onToken as (t: unknown[]) => void)([1, 2]);
      }
      return 'ok';
    }
  }
  return {
    readGgufFileInfo: async (filePath: string) => ({
      metadata: { general: path.basename(String(filePath)).startsWith('quality') ? { architecture: 'gemma4', name: 'Gemma 4 E2B' } : { architecture: 'lfm2', name: 'LFM2.5 VL 450M' } },
    }),
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: () => undefined }),
        dispose: () => undefined,
      }),
    }),
    LlamaChatSession,
    Gemma4ChatWrapper,
  };
});

/** Capture console.info lines emitted by the inference path. */
function captureConsoleInfo(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  return {
    lines,
    restore: (): void => {
      console.info = original;
    },
  };
}

const GB = 1024 ** 3;
let tmpDir = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-wiring-honesty-'));
  NLC.prompts.length = 0;
  NLC.sessions.length = 0;
  NLC.historyResets.length = 0;
  NLC.fail.sessionCtor = false;
  NLC.fail.historySeed = false;
  NLC.fail.reset = false;
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

  it('one query uses one settings snapshot: a PUT landing during retrieval does not reach that query\'s generate (FB140-006)', async () => {
    const { engine, backend } = engineWithRecorder();
    let releaseSearch: () => void = () => undefined;
    let searchEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      searchEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    engine.attachRetrievalSurface({
      floorActive: true,
      async search(query: string) {
        searchEntered();
        await gate;
        return [{ text: `chunk for ${query}`, source: 'doc.md', similarity: 0.9, chunkId: 'c1' }];
      },
    });
    expect(engine.applySettingsPatch({ rag_max_tokens: 300, rag_temperature: 0.7 })).toEqual({ ok: true });

    const inFlight = engine.query('mid-flight question', {});
    await entered;
    // The PUT lands while this query is still retrieving.
    expect(engine.applySettingsPatch({ rag_max_tokens: 900, rag_temperature: 1.1 })).toEqual({ ok: true });
    releaseSearch();
    await inFlight;

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]).toMatchObject({ maxTokens: 300, temperature: 0.7 });
    // The next query sees the new values.
    await engine.query('next question', {});
    expect(backend.calls[1]).toMatchObject({ maxTokens: 900, temperature: 1.1 });
  });

  it('inference.* keys never count as explicit preset keys', () => {
    const { engine } = engineWithRecorder();
    expect(engine.applySettingsPatch({ 'inference.profile': 'fast' })).toEqual({ ok: true });
    expect(engine.responseSettings().explicit_keys).toEqual([]);
  });
});

// Issue #154 Fix 1b: the fast profile must be left on the library's own wrapper
// resolution. LlamaChatSession destructures `chatWrapper = "auto"`, which
// defaults ONLY on undefined — an explicit null reaches
// `chatWrapper.settings` and throws on every query. So the fast path is
// asserted to have NO chatWrapper key at all, not merely an undefined value.
describe('issue #154: the desktop local inference path', () => {
  async function queryWith(
    profile: 'quality' | 'fast',
    settings: Record<string, unknown> = {},
  ): Promise<void> {
    const engine = new LlamaEngine({
      profile,
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: modelFiles(),
    });
    engine.attachRetrievalSurface(recordingSurface().surface);
    if (Object.keys(settings).length > 0) {
      expect(engine.applySettingsPatch(settings)).toEqual({ ok: true });
    }
    await engine.query('what is the escalation path?', { history: [{ role: 'user', content: 'earlier question' }] });
  }

  // AC1 - the wrapper pin is decided by MODEL IDENTITY, not the profile name.
  // A gemma-4 file must pin reasoning off; anything else must carry no
  // chatWrapper key at all so the library's own "auto" resolution applies.
  // (Passing an explicit null would crash on chatWrapper.settings.)
  it('pins a Gemma wrapper only when the model file really is gemma-4', async () => {
    await queryWith('quality');
    expect(NLC.sessions).toHaveLength(1);
    const wrapper = NLC.sessions[0].chatWrapper as { reasoning?: boolean } | undefined;
    expect(wrapper).toBeDefined();
    expect(wrapper?.reasoning).toBe(false);
  });

  it('omits the wrapper key when a non-gemma model sits at the quality path', async () => {
    // Stage a file the stub reports as lfm2, then point the QUALITY profile at
    // it: same profile, different model identity. This proves the pin is keyed
    // to the model, not to the profile name. `in` (rather than toBeUndefined)
    // is what rejects a present-but-undefined key as well as an explicit null.
    const nonGemma = path.join(tmpDir, 'non-gemma.gguf');
    fs.writeFileSync(nonGemma, 'x');
    const engine = new LlamaEngine({
      profile: 'quality',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: { ...modelFiles(), quality: nonGemma },
    });
    engine.attachRetrievalSurface(recordingSurface().surface);
    await engine.query('q', {});
    expect(NLC.sessions).toHaveLength(1);
    expect('chatWrapper' in NLC.sessions[0]).toBe(false);
  });

  it('omits the wrapper key for the fast profile', async () => {
    await queryWith('fast');
    expect('chatWrapper' in NLC.sessions[0]).toBe(false);
  });

  // AC2 - exactly one metrics line per request, on EVERY path.
  it('emits exactly one metrics line per successful request', async () => {
    const seen = captureConsoleInfo();
    try {
      await queryWith('quality');
    } finally {
      seen.restore();
    }
    expect(seen.lines).toHaveLength(1);
    expect(seen.lines[0]).toMatch(/profile=quality/);
    expect(seen.lines[0]).toMatch(/threads=\d+/);
    expect(seen.lines[0]).toMatch(/elapsed_ms=\d+/);
    // The mock delivers 4 batches of 2 tokens, so the counter must read 8.
    expect(seen.lines[0]).toMatch(/answer_tokens=8\b/);
    expect(seen.lines[0]).toMatch(/outcome=ok/);
  });

  it('still emits exactly one metrics line when the session constructor throws', async () => {
    const seen = captureConsoleInfo();
    NLC.fail.sessionCtor = true;
    try {
      await expect(queryWith('quality')).rejects.toThrow();
    } finally {
      seen.restore();
    }
    expect(seen.lines).toHaveLength(1);
    expect(seen.lines[0]).toMatch(/outcome=error/);
  });

  it('still emits exactly one metrics line when history seeding throws', async () => {
    const seen = captureConsoleInfo();
    NLC.fail.historySeed = true;
    try {
      await expect(queryWith('quality')).rejects.toThrow();
    } finally {
      seen.restore();
    }
    expect(seen.lines).toHaveLength(1);
    expect(seen.lines[0]).toMatch(/outcome=error/);
  });

  it('still emits exactly one metrics line when resetChatHistory throws', async () => {
    const seen = captureConsoleInfo();
    NLC.fail.reset = true;
    try {
      await expect(queryWith('quality')).rejects.toThrow();
    } finally {
      seen.restore();
    }
    // The line is emitted BEFORE the reset, so a throwing reset cannot swallow it.
    expect(seen.lines).toHaveLength(1);
    expect(seen.lines[0]).toMatch(/outcome=ok/);
  });

  // The cleanup itself is behaviour, not an implementation detail: removing
  // session?.resetChatHistory() must fail here.
  it('resets the chat history on a successful request', async () => {
    await queryWith('quality');
    expect(NLC.historyResets).toContain('reset');
  });

  it('still resets the chat history when the prompt path throws', async () => {
    NLC.fail.reset = false;
    const engine = new LlamaEngine({
      profile: 'quality', freeMemBytes: () => 8 * GB, cpuCount: () => 8, models: modelFiles(),
    });
    engine.attachRetrievalSurface(recordingSurface().surface);
    await engine.query('q', {});
    expect(NLC.historyResets.filter((entry) => entry === 'reset').length).toBe(1);
  });

  // AC4 was REMOVED as unsound: node-llama-cpp applies repeatPenalty only to
  // generated tokens, so bounding lastTokens never protected retrieved
  // evidence. The desktop path keeps the full-context window; this pins that
  // so a future change to the window is a deliberate, visible act.
  it('keeps the repeat-penalty window at the full-context value base used', async () => {
    await queryWith('quality');
    const penalty = NLC.prompts[0].repeatPenalty as { lastTokens?: number } | undefined;
    expect(penalty).toBeDefined();
    expect(penalty?.lastTokens).toBe(PENALTY_FULL_CONTEXT_TOKENS);
  });
});

describe('issue #154: chat wrapper is pinned only for the quality profile', () => {
  it('quality pins a Gemma4ChatWrapper with reasoning disabled', async () => {
    const engine = new LlamaEngine({ profile: 'quality', freeMemBytes: () => 8 * GB, cpuCount: () => 8, models: modelFiles() });
    await engine.query('q', {});
    expect(NLC.sessions).toHaveLength(1);
    const wrapper = NLC.sessions[0].chatWrapper as { reasoning?: boolean };
    expect(wrapper).toBeDefined();
    expect(wrapper.reasoning).toBe(false);
  });

  it('fast omits chatWrapper entirely so the library default applies', async () => {
    const engine = new LlamaEngine({ profile: 'fast', freeMemBytes: () => 8 * GB, cpuCount: () => 8, models: modelFiles() });
    await engine.query('q', {});
    expect(NLC.sessions).toHaveLength(1);
    // `in` rejects both null and an explicitly-present undefined, which is the
    // shape that would crash LlamaChatSession.
    expect('chatWrapper' in NLC.sessions[0]).toBe(false);
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

// ---------------------------------------------------------------------------
// Guardrail (c) (PR #140 review FB140-003): the observable signature above
// cannot see ingest-time or scoring seams, so a not_applied key is also
// checked statically — no desktop/main source may reference it (the rag_*
// name or its GET /settings name) outside engine.ts's declaration tables.
// Tokens, not text: identifiers/property names and exact string literals
// count; comments and longer strings (error messages) do not.
// ---------------------------------------------------------------------------

const MAIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../main');
const ENGINE_FILE = path.join(MAIN_DIR, 'backend', 'engine.ts');
/** engine.ts tables that DECLARE the keyspace (never read a stored value). */
const KEYSPACE_TABLES = new Set(['DEFAULT_SETTINGS', 'SETTING_BOUNDS', 'RAG_TO_RESPONSE', 'RETRIEVAL_READ_KEYS', 'GENERATION_READ_KEYS']);
/**
 * engine.ts validation that must see these keys to keep the stored
 * overlap < size invariant (api_server.py parity) — storage, not a reader.
 */
const VALIDATION_METHODS = new Set(['applySettingsPatch', 'resetSettings']);
const VALIDATION_KEYS = new Set(['rag_chunk_size', 'rag_chunk_overlap']);

function mainSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mainSources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface KeyReference {
  name: string;
  line: number;
}

/** Every token in `source` naming one of `names`, minus the engine.ts declaration/validation exemptions. */
function keyReferences(fileName: string, source: string, names: ReadonlySet<string>, isEngineFile: boolean): KeyReference[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs: KeyReference[] = [];
  const visit = (node: ts.Node, table: string | null, method: string | null): void => {
    let nextTable = table;
    let nextMethod = method;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableStatement(node.parent.parent) && node.parent.parent.parent === sf) {
      nextTable = node.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) nextMethod = node.name.text;
    const text =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : null;
    if (text !== null && names.has(text)) {
      const exempt =
        isEngineFile &&
        ((nextTable !== null && KEYSPACE_TABLES.has(nextTable)) ||
          (nextMethod !== null && VALIDATION_METHODS.has(nextMethod) && VALIDATION_KEYS.has(text)));
      if (!exempt) refs.push({ name: text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, (child) => visit(child, nextTable, nextMethod));
  };
  visit(sf, null, null);
  return refs;
}

describe('settings-wiring-honesty guardrail (c): a not_applied key has no reader in desktop/main (static)', () => {
  const { engine } = engineWithRecorder();
  const notApplied = engine.responseSettings().not_applied as string[];
  const names = new Set(notApplied.flatMap((key) => [key, key.replace(/^rag_/, '')]));

  it('scans a real keyspace and a real source tree', () => {
    expect(notApplied.length).toBeGreaterThanOrEqual(10);
    expect(notApplied).toContain('rag_chunk_size');
    // The derived GET /settings names are the engine's real response keys
    // (RAG_TO_RESPONSE is module-private, so pin the prefix rule against it).
    const response = engine.responseSettings();
    for (const key of notApplied) expect(response, `${key} -> ${key.replace(/^rag_/, '')}`).toHaveProperty(key.replace(/^rag_/, ''));
    expect(mainSources(MAIN_DIR).length).toBeGreaterThan(20);
    // The exemptions are load-bearing: without them engine.ts's own tables match.
    const engineSource = fs.readFileSync(ENGINE_FILE, 'utf8');
    expect(keyReferences(ENGINE_FILE, engineSource, names, false).length).toBeGreaterThanOrEqual(notApplied.length);
  });

  it('the scanner flags property reads, element reads and destructuring, and ignores comments and messages', () => {
    const scan = (src: string) => keyReferences('x.ts', src, names, false).map((r) => r.name);
    expect(scan('const n = settings.rag_chunk_size;')).toEqual(['rag_chunk_size']);
    expect(scan("const n = settings['rag_chunk_overlap'];")).toEqual(['rag_chunk_overlap']);
    expect(scan('const { min_similarity } = engine.responseSettings();')).toEqual(['min_similarity']);
    expect(scan('// rag_chunk_size is not read\nthrow new Error(`chunk_size must be positive`);')).toEqual([]);
    // In engine.ts only the declaration tables and the overlap<size validation are exempt.
    const engineLike = 'const SETTING_BOUNDS = { rag_chunk_size: 1 };\nclass E { applySettingsPatch() { return this.s.rag_chunk_size; } query() { return this.s.rag_chunk_size; } }';
    expect(keyReferences('engine.ts', engineLike, names, true).map((r) => r.line)).toEqual([2]);
    expect(keyReferences('engine.ts', 'class E { applySettingsPatch() { return this.s.rag_min_similarity; } }', names, true)).toHaveLength(1);
  });

  it('no desktop/main source references a not_applied key outside engine.ts declarations', () => {
    const violations: string[] = [];
    for (const file of mainSources(MAIN_DIR)) {
      const refs = keyReferences(file, fs.readFileSync(file, 'utf8'), names, path.resolve(file) === path.resolve(ENGINE_FILE));
      for (const ref of refs) violations.push(`${path.relative(MAIN_DIR, file)}:${ref.line} ${ref.name}`);
    }
    expect(violations, 'a key reported in not_applied has a reader; wire it (and drop it from not_applied) or remove the reader').toEqual([]);
  });
});
