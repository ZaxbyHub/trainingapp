// t156-tier-policy.test.ts — issue #156 (frozen check C2 runs this suite).
//
// Pins the per-tier inference policy record (approved plan section 1):
//   - INFERENCE_TIER_POLICY is keyed by exactly 'quality' | 'fast' and every
//     tier carries {modelSubpath, generation, reasoningPolicy} with the LFM
//     literals — and NO nResults key (chunk counts stay preset-owned, D1).
//   - QUALITY_MODEL_SUBPATH / FAST_MODEL_SUBPATH are DERIVED reads of the
//     record (asserted by equality, so a second source of truth fails here).
//   - buildGenerationParams returns exactly {maxTokens, temperature, topP} —
//     no repeatPenalty (#156 retired the penalty wiring) — with profile
//     defaults and field-by-field override precedence.
//   - AC2 atomicity: a rag_* settings patch changes generation values but can
//     never change a tier's reasoningPolicy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGenerationParams,
  FAST_MODEL_SUBPATH,
  INFERENCE_TIER_POLICY,
  LlamaEngine,
  QUALITY_MODEL_SUBPATH,
} from '../../main/backend/inference/llama-engine.js';

// The AC2 test drives the production defaultLlamaFactory against a mocked
// node-llama-cpp (the settings-wiring-honesty seam): what reaches
// LlamaChatSession.prompt is the wiring under test.
const NLC = vi.hoisted(() => ({
  prompts: [] as Array<Record<string, unknown>>,
}));
vi.mock('node-llama-cpp', () => {
  class LlamaChatSession {
    constructor(_options: Record<string, unknown>) {
      // session construction shape is not this suite's subject
    }
    setChatHistory(): void {}
    resetChatHistory(): void {}
    async prompt(_question: string, options: Record<string, unknown>): Promise<string> {
      NLC.prompts.push(options);
      return 'ok';
    }
  }
  return {
    readGgufFileInfo: async () => ({
      // LFM metadata: the wrapper pin is gemma-4-identity-gated and must not fire.
      metadata: { general: { architecture: 'lfm2', name: 'LFM2.5 2.6B' } },
    }),
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't156-tier-policy-'));
  NLC.prompts.length = 0;
});

function modelFiles(): { quality: string; fast: string } {
  const quality = path.join(tmpDir, 'quality.gguf');
  const fast = path.join(tmpDir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast };
}

describe('#156 INFERENCE_TIER_POLICY: shape and literals', () => {
  it('is keyed by exactly the two inference tiers', () => {
    expect(Object.keys(INFERENCE_TIER_POLICY).sort()).toEqual(['fast', 'quality']);
  });

  it('quality: LFM2.5-2.6B subpath, 1024/0.2 generation, responsePrefix reasoning policy', () => {
    expect(INFERENCE_TIER_POLICY.quality.modelSubpath).toBe('lfm2.5-2.6b/model.gguf');
    expect(INFERENCE_TIER_POLICY.quality.generation).toEqual({ maxTokens: 1024, temperature: 0.2 });
    expect(INFERENCE_TIER_POLICY.quality.reasoningPolicy).toEqual({
      responsePrefix: '\n</think>\n\n',
      budgets: { thoughtTokens: 0 },
    });
  });

  it('fast: LFM2-1.2B-RAG subpath, 384/0.3 generation, null reasoning policy', () => {
    expect(INFERENCE_TIER_POLICY.fast.modelSubpath).toBe('lfm2-1.2b-rag/model.gguf');
    expect(INFERENCE_TIER_POLICY.fast.generation).toEqual({ maxTokens: 384, temperature: 0.3 });
    expect(INFERENCE_TIER_POLICY.fast.reasoningPolicy).toBeNull();
  });

  it('NO tier record carries an nResults key (chunk counts stay preset-owned, D1)', () => {
    for (const [tier, policy] of Object.entries(INFERENCE_TIER_POLICY)) {
      expect(Object.keys(policy), `${tier} must not grow retrieval knobs`).not.toContain('nResults');
      expect(policy, tier).not.toHaveProperty('nResults');
      expect(policy.generation, `${tier}.generation must not grow retrieval knobs`).not.toHaveProperty('nResults');
    }
  });
});

describe('#156 the exported subpath constants are derived from the record', () => {
  it('QUALITY_MODEL_SUBPATH / FAST_MODEL_SUBPATH equal the policy subpaths (one source of truth)', () => {
    expect(QUALITY_MODEL_SUBPATH).toBe(INFERENCE_TIER_POLICY.quality.modelSubpath);
    expect(FAST_MODEL_SUBPATH).toBe(INFERENCE_TIER_POLICY.fast.modelSubpath);
    // Literal pins (C2): a record edit that stops matching these fails here.
    expect(QUALITY_MODEL_SUBPATH).toBe('lfm2.5-2.6b/model.gguf');
    expect(FAST_MODEL_SUBPATH).toBe('lfm2-1.2b-rag/model.gguf');
  });
});

describe('#156 buildGenerationParams: exact sampler shape, defaults and override precedence', () => {
  it('returns exactly {maxTokens, temperature, topP} per profile — NO repeatPenalty key', () => {
    expect(buildGenerationParams('quality')).toEqual({ maxTokens: 1024, temperature: 0.2, topP: 0.9 });
    expect(buildGenerationParams('fast')).toEqual({ maxTokens: 384, temperature: 0.3, topP: 0.9 });
    expect(buildGenerationParams('quality')).not.toHaveProperty('repeatPenalty');
    expect(buildGenerationParams('fast')).not.toHaveProperty('repeatPenalty');
  });

  it('profile defaults apply when no override is set; empty overrides equal no overrides', () => {
    expect(buildGenerationParams('quality', {})).toEqual(buildGenerationParams('quality'));
    expect(buildGenerationParams('fast', {})).toEqual(buildGenerationParams('fast'));
  });

  it('each override wins field by field over the profile default', () => {
    expect(buildGenerationParams('quality', { maxTokens: 300 })).toEqual({ maxTokens: 300, temperature: 0.2, topP: 0.9 });
    expect(buildGenerationParams('fast', { temperature: 1.1 })).toEqual({ maxTokens: 384, temperature: 1.1, topP: 0.9 });
    expect(buildGenerationParams('fast', { maxTokens: 100, temperature: 0 })).toEqual({
      maxTokens: 100,
      temperature: 0,
      topP: 0.9,
    });
  });

  it('the profile generation block IS the tier policy block (not a second table)', () => {
    // PROFILE_GENERATION is derived from INFERENCE_TIER_POLICY; the observable
    // consequence is that profileGeneration() and buildGenerationParams agree
    // with the record for both tiers.
    expect(buildGenerationParams('quality').maxTokens).toBe(INFERENCE_TIER_POLICY.quality.generation.maxTokens);
    expect(buildGenerationParams('quality').temperature).toBe(INFERENCE_TIER_POLICY.quality.generation.temperature);
    expect(buildGenerationParams('fast').maxTokens).toBe(INFERENCE_TIER_POLICY.fast.generation.maxTokens);
    expect(buildGenerationParams('fast').temperature).toBe(INFERENCE_TIER_POLICY.fast.generation.temperature);
  });
});

describe('#156 AC2 atomicity: rag_* settings cannot change a tier\'s reasoning policy', () => {
  it('a rag_max_tokens/rag_temperature patch overrides generation but leaves responsePrefix+budgets pinned', async () => {
    const engine = new LlamaEngine({
      profile: 'quality',
      freeMemBytes: () => 8 * GB,
      cpuCount: () => 8,
      models: modelFiles(),
    });
    expect(engine.applySettingsPatch({ rag_max_tokens: 300, rag_temperature: 0.9 })).toEqual({ ok: true });
    await engine.query('q', {});
    expect(NLC.prompts).toHaveLength(1);
    // The override won —
    expect(NLC.prompts[0]).toMatchObject({ maxTokens: 300, temperature: 0.9, topP: 0.9 });
    // — and the tier's reasoning policy is unchanged by the same patch.
    expect(NLC.prompts[0]).toMatchObject({
      responsePrefix: '\n</think>\n\n',
      budgets: { thoughtTokens: 0 },
    });
    expect(INFERENCE_TIER_POLICY.quality.reasoningPolicy).toEqual({
      responsePrefix: '\n</think>\n\n',
      budgets: { thoughtTokens: 0 },
    });
    // And the sampler carries no penalty keys on this path either.
    expect(NLC.prompts[0]).not.toHaveProperty('repeatPenalty');
  });
});
