import { describe, it, expect } from 'vitest';
import { RAG_PRESETS, presetOptions, DEFAULT_RAG_PRESET } from './rag-presets';

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
