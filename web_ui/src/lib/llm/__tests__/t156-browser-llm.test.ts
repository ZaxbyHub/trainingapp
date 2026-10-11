/**
 * Issue #156 (browser half): the browser LLM is LiquidAI LFM2-1.2B-RAG —
 * text-only, GGUF-only. Pins the packaging/manifest/load/readiness surface of
 * the model swap (scanner C6 runs this suite):
 *
 *  - public/models/manifest.json: the llm entry is 'lfm2-1.2b-rag' with
 *    exactly one file, llm/lfm2-1.2b-rag/model.gguf — no mmproj anywhere.
 *  - model-manifest: LLM_GGUF_URL points at the new GGUF; LLM_MMPROJ_URL is
 *    no longer exported at all.
 *  - model-readiness: wllama availability is GGUF-ONLY (a mmproj-shaped URL,
 *    if anything ever probes one again, must not gate readiness), and
 *    MODEL_REQUIRED_BYTES is keyed by the new id.
 *  - the decline-sentence filter (browser twin of
 *    desktop/main/backend/inference/decline-filter.ts) strips the shared
 *    decline fixtures and leaves answerable text byte-identical.
 *  - wllama loads the model with a { url } ModelSource only — no mmprojUrl
 *    key — and no Gemma-era chat-template override.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import manifestJson from '../../../../public/models/manifest.json';

// --- manifest.json: the llm entry is the new model, GGUF-only ------------------

describe('issue #156: manifest.json llm entry', () => {
  const llmEntries = (manifestJson.models as Array<{ id: string; kind: string; files: Array<{ path: string; required: boolean }> }>)
    .filter((m) => m.kind === 'llm');

  it('has exactly one llm entry, id lfm2-1.2b-rag', () => {
    expect(llmEntries).toHaveLength(1);
    expect(llmEntries[0].id).toBe('lfm2-1.2b-rag');
  });

  it('declares exactly one required file: llm/lfm2-1.2b-rag/model.gguf', () => {
    expect(llmEntries[0].files).toEqual([
      { path: 'llm/lfm2-1.2b-rag/model.gguf', required: true },
    ]);
  });

  it('contains no mmproj file anywhere in the manifest', () => {
    expect(JSON.stringify(manifestJson)).not.toMatch(/mmproj/i);
  });
});

// --- model-manifest exports ----------------------------------------------------

describe('issue #156: model-manifest exports', () => {
  it('does not export LLM_MMPROJ_URL (import * and assert absence)', async () => {
    const mod = (await import('../../models/model-manifest')) as Record<string, unknown>;
    expect(mod['LLM_MMPROJ_URL']).toBeUndefined();
    expect(Object.keys(mod)).not.toContain('LLM_MMPROJ_URL');
  });

  it('exports LLM_MODEL_DIR = lfm2-1.2b-rag and LLM_GGUF_URL ending llm/lfm2-1.2b-rag/model.gguf', async () => {
    const mod = await import('../../models/model-manifest');
    expect(mod.LLM_MODEL_DIR).toBe('lfm2-1.2b-rag');
    expect(mod.LLM_GGUF_URL.endsWith('llm/lfm2-1.2b-rag/model.gguf')).toBe(true);
  });
});

// --- model-readiness: gguf-only availability + bytes key -----------------------

// Factory default: every asset probe reports present. The readiness describe
// below narrows this to "GGUF present, everything else absent" per test.
vi.mock('../../models/probe', () => ({
  probeAsset: vi.fn(async () => true),
}));
import { probeAsset as probeAssetMock } from '../../models/probe';

vi.mock('../web-llm-service', () => ({
  WebLLMService: { getInstance: vi.fn() },
}));

vi.mock('../../embeddings/memory-aware', () => ({
  getMemoryBudget: vi.fn(() => ({ totalMB: 16384, availableMB: 14336, browserOverheadMB: 2048 })),
}));

import { ModelReadinessGate } from '../model-readiness';
import { LLM_GGUF_URL } from '../../models/model-manifest';

describe('issue #156: model-readiness is gguf-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Engine-aware probe mock: the packaged GGUF is present; ANY other URL
    // (an mmproj-shaped path, had one been probed) reports absent. Readiness
    // must still pass on the GGUF alone.
    vi.mocked(probeAssetMock).mockImplementation(async (path: string) => path === LLM_GGUF_URL);
  });

  it('checkModelCached(wllama) is true with the GGUF present and everything else absent', async () => {
    const gate = new ModelReadinessGate();
    await expect(gate.checkModelCached('lfm2-1.2b-rag', 'wllama')).resolves.toBe(true);
    // The gate probed ONLY the GGUF — there is no second (mmproj) probe.
    const probedPaths = vi.mocked(probeAssetMock).mock.calls.map((c) => c[0]);
    expect(probedPaths).toEqual([LLM_GGUF_URL]);
  });

  it('checkReadiness(wllama) is ready with memory to spare (lfm2-1.2b-rag budget)', async () => {
    const gate = new ModelReadinessGate();
    const result = await gate.checkReadiness('lfm2-1.2b-rag', 'wllama');
    // MODEL_REQUIRED_BYTES is keyed by the new id: 1.2 GB budget (0.73 GB file
    // + runtime overhead), not the retired 4 GB gemma entry nor the 2 GB default.
    expect(result.checks.memory.requiredBytes).toBe(1_200_000_000);
    expect(result.checks.memory.sufficient).toBe(true);
    expect(result.ready).toBe(true);
  });
});

// --- decline filter (shared fixtures with the desktop suite) -------------------

/**
 * Fixture texts duplicated from the desktop suite
 * desktop/src/__tests__/t156-decline-filter.test.ts (issue #156 AC4: shared
 * fixtures on both sides). Source: the captured LFM2-1.2B-RAG decline output
 * in .agents/issue-traces/156-llm-model-swap/02-reproduction.md R6 — keep the
 * strings identical on both sides when either suite changes.
 */
const DECLINE_FIXTURE =
  'The provided context does not contain information regarding the maximum permitted annual leave carryover for contractors in the EU. Did you perhaps forget to include the document containing this information? Once you provide the relevant document, I will be able to assist further.';
const ANSWERABLE_FIXTURE = 'The expense portal closes on the 15th of each month.';

describe('issue #156: decline-sentence filter (browser twin)', () => {
  it('strips the trained-in artefact sentences from a decline answer', async () => {
    const { filterDeclineSentences } = await import('../decline-filter');
    const filtered = filterDeclineSentences(DECLINE_FIXTURE);
    expect(filtered).toContain('does not contain information regarding');
    expect(filtered).not.toMatch(/did you perhaps forget/i);
    expect(filtered).not.toMatch(/once you provide the relevant document/i);
  });

  it('leaves answerable answers byte-identical', async () => {
    const { filterDeclineSentences } = await import('../decline-filter');
    expect(filterDeclineSentences(ANSWERABLE_FIXTURE)).toBe(ANSWERABLE_FIXTURE);
  });

  it('is byte-identical passthrough for text without a decline marker', async () => {
    const { filterDeclineSentences } = await import('../decline-filter');
    const text =
      'Please provide the relevant document so I can cite it precisely. Did you forget to attach the document?';
    // No decline marker ("does not contain..." etc.) → nothing is removed,
    // even though the artefact-sentence shapes are present.
    expect(filterDeclineSentences(text)).toBe(text);
  });

  it('strips the short "did you forget to attach" variant too', async () => {
    const { filterDeclineSentences } = await import('../decline-filter');
    const out = filterDeclineSentences(
      'The policy is not mentioned in the provided context. Did you forget to attach the document?'
    );
    expect(out).not.toMatch(/did you forget to attach/i);
    expect(out).toContain('not mentioned in the provided context');
  });
});

// --- wllama loads { url } only (no mmprojUrl, no template override) -------------

const loadModelFromUrl = vi.fn(async () => undefined);
const createChatCompletion = vi.fn(async (opts: { stream?: boolean }) => {
  if (opts.stream) {
    async function* gen() {
      yield { choices: [{ delta: { content: 'ok' } }] };
    }
    return gen();
  }
  return { choices: [{ message: { content: 'ok' } }] };
});

vi.mock('@wllama/wllama', () => ({
  Wllama: class {
    loadModelFromUrl = loadModelFromUrl;
    createChatCompletion = createChatCompletion;
    exit = vi.fn(async () => undefined);
    isModelLoaded = vi.fn(() => true);
    setCompat = vi.fn();
    constructor(_paths: unknown, _config: unknown) {}
  },
  CacheManager: class {
    constructor(_backends: unknown[]) {}
  },
}));

describe('issue #156: wllama loads the LFM2 GGUF with { url } only', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Re-import fresh so the WllamaService singleton is new per test; the
    // probe mock re-instantiates with its factory default (present).
    const mod = await import('../wllama-service');
    const svc = mod.WllamaService.getInstance();
    await svc.initialize();
  });

  it('loadModelFromUrl receives a ModelSource with ONLY a url key (no mmprojUrl)', () => {
    expect(loadModelFromUrl).toHaveBeenCalledTimes(1);
    const [modelSource, loadParams] = loadModelFromUrl.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(modelSource).toEqual({ url: LLM_GGUF_URL });
    expect(modelSource).not.toHaveProperty('mmprojUrl');
    // The Gemma-era chat-template override must NOT be injected: LFM2's
    // embedded template is used as-is.
    expect(loadParams).not.toHaveProperty('chat_template');
    expect(loadParams).not.toHaveProperty('jinja');
  });
});
