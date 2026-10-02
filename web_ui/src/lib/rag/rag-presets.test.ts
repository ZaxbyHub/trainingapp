import { describe, it, expect } from 'vitest';
import type { SettingsRequestedValues } from '../api/types';
import {
  RAG_PRESETS,
  presetOptions,
  DEFAULT_RAG_PRESET,
  DESKTOP_PRESET_KEYS,
  DESKTOP_PRESET_SETTINGS,
  presetFromBackend,
} from './rag-presets';

describe('rag-presets', () => {
  it('fast is cheapest (no rerank, fewest chunks, shortest)', () => {
    expect(RAG_PRESETS.fast.rerank).toBe(false);
    expect(RAG_PRESETS.fast.topK).toBeLessThan(RAG_PRESETS.balanced.topK!);
    expect(RAG_PRESETS.fast.maxTokens).toBeLessThanOrEqual(RAG_PRESETS.balanced.maxTokens!);
  });

  it('quality is richest (rerank on, most chunks, longest)', () => {
    expect(RAG_PRESETS.quality.rerank).toBe(true);
    expect(RAG_PRESETS.quality.topK).toBeGreaterThan(RAG_PRESETS.balanced.topK!);
    expect(RAG_PRESETS.quality.maxTokens).toBeGreaterThanOrEqual(RAG_PRESETS.balanced.maxTokens!);
  });

  it('presetOptions defaults to balanced for undefined', () => {
    expect(presetOptions(undefined)).toEqual(RAG_PRESETS[DEFAULT_RAG_PRESET]);
    expect(DEFAULT_RAG_PRESET).toBe('balanced');
  });

  it('presetOptions returns the named preset', () => {
    expect(presetOptions('quality')).toEqual(RAG_PRESETS.quality);
  });

  // Issue #40 RC2: every preset sets anti-repetition penalties + a sane topP.
  it('all presets set repeatPenalty 1.1, topP 0.9, and zero freq/presence penalty', () => {
    for (const preset of ['fast', 'balanced', 'quality'] as const) {
      expect(RAG_PRESETS[preset].repeatPenalty).toBe(1.1);
      expect(RAG_PRESETS[preset].topP).toBe(0.9);
      expect(RAG_PRESETS[preset].frequencyPenalty).toBe(0.0);
      expect(RAG_PRESETS[preset].presencePenalty).toBe(0.0);
    }
  });

  it('presetOptions surfaces the penalty + topP fields (forwarded into RAGQueryOptions)', () => {
    const opts = presetOptions('balanced');
    expect(opts).toHaveProperty('repeatPenalty', 1.1);
    expect(opts).toHaveProperty('topP', 0.9);
    expect(opts).toHaveProperty('frequencyPenalty', 0.0);
    expect(opts).toHaveProperty('presencePenalty', 0.0);
  });
});

// settings-wiring-honesty (AC1-AC3): the desktop preset contract and the
// backend-as-truth display derivation.
describe('desktop preset contract', () => {
  it('each preset writes all four keys inside the desktop PUT bounds, n_results distinct', () => {
    const ns = new Set<number>();
    for (const preset of ['fast', 'balanced', 'quality'] as const) {
      const patch = DESKTOP_PRESET_SETTINGS[preset];
      expect(Object.keys(patch).sort()).toEqual([...DESKTOP_PRESET_KEYS].sort());
      expect(patch.rag_n_results).toBeGreaterThanOrEqual(1);
      expect(patch.rag_n_results).toBeLessThanOrEqual(10);
      expect(patch.rag_max_tokens).toBeGreaterThanOrEqual(256);
      expect(patch.rag_max_tokens).toBeLessThanOrEqual(4096);
      expect(patch.rag_temperature).toBeGreaterThanOrEqual(0);
      expect(patch.rag_temperature).toBeLessThanOrEqual(2);
      // The card promises match the browser rows ("no reranking, shorter answers").
      expect(patch.rag_reranking_enabled).toBe(RAG_PRESETS[preset].rerank);
      expect(patch.rag_max_tokens).toBe(RAG_PRESETS[preset].maxTokens);
      ns.add(patch.rag_n_results);
    }
    expect(ns.size).toBe(3);
  });
});

describe('presetFromBackend', () => {
  const requested = (r: SettingsRequestedValues): SettingsRequestedValues => ({
    n_results: null,
    reranking_enabled: null,
    max_tokens: null,
    temperature: null,
    ...r,
  });

  it('no explicit preset keys -> "Using server defaults"', () => {
    expect(presetFromBackend({ n_results: 4, explicit_keys: [], requested: requested({}) })).toEqual({ kind: 'defaults' });
    // A non-preset explicit key does not make the preset custom.
    expect(presetFromBackend({ n_results: 4, explicit_keys: ['rag_chunk_size'], requested: requested({}) })).toEqual({ kind: 'defaults' });
  });

  it('the full explicit patch of a preset matches that preset', () => {
    const q = DESKTOP_PRESET_SETTINGS.quality;
    const settings = {
      explicit_keys: [...DESKTOP_PRESET_KEYS],
      requested: requested({ n_results: q.rag_n_results, reranking_enabled: q.rag_reranking_enabled, max_tokens: q.rag_max_tokens, temperature: q.rag_temperature }),
      reranking_available: true,
    };
    expect(presetFromBackend(settings)).toEqual({ kind: 'preset', preset: 'quality' });
  });

  it('only n_results explicit (saved before presets wrote the full patch) matches on n_results alone', () => {
    expect(presetFromBackend({ explicit_keys: ['rag_n_results'], requested: requested({ n_results: 5 }) })).toEqual({ kind: 'preset', preset: 'fast' });
  });

  it('n_results must be explicit before any preset matches (IC4)', () => {
    expect(presetFromBackend({ explicit_keys: ['rag_max_tokens'], requested: requested({ max_tokens: 1024 }) })).toEqual({ kind: 'custom' });
  });

  it('a mismatching explicit value makes it custom', () => {
    const b = DESKTOP_PRESET_SETTINGS.balanced;
    expect(
      presetFromBackend({
        explicit_keys: ['rag_n_results', 'rag_max_tokens'],
        requested: requested({ n_results: b.rag_n_results, max_tokens: 2048 }),
      }),
    ).toEqual({ kind: 'custom' });
  });

  it('reranking is not compared when the backend has no reranker', () => {
    const b = DESKTOP_PRESET_SETTINGS.balanced;
    expect(
      presetFromBackend({
        explicit_keys: ['rag_n_results', 'rag_reranking_enabled'],
        requested: requested({ n_results: b.rag_n_results, reranking_enabled: !b.rag_reranking_enabled }),
        reranking_available: false,
      }),
    ).toEqual({ kind: 'preset', preset: 'balanced' });
  });

  it('older backend without explicit_keys falls back to the flat n_results (IC4)', () => {
    expect(presetFromBackend({ n_results: 8 })).toEqual({ kind: 'preset', preset: 'balanced' });
    // The fresh-install Node backend default (4) matches no preset.
    expect(presetFromBackend({ n_results: 4, rag_n_results: 4 })).toEqual({ kind: 'custom' });
  });
});
