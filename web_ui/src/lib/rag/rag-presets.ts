/**
 * RAG quality presets — let users trade speed for answer quality without
 * exposing every retrieval knob. Applied as the base of RAGQueryOptions.
 *
 * Tuned for the target hardware (12th-gen i5 + Iris Xe): "fast" keeps latency
 * low (fewer chunks, no rerank, shorter answers); "quality" maximizes grounding.
 */

import type { RAGQueryOptions } from './rag-orchestrator';

export type RAGPreset = 'fast' | 'balanced' | 'quality';

export const DEFAULT_RAG_PRESET: RAGPreset = 'balanced';

/** Retrieval/generation parameters per preset (merged into query options). */
export const RAG_PRESETS: Record<RAGPreset, Pick<RAGQueryOptions, 'topK' | 'rerank' | 'maxTokens' | 'temperature'>> = {
  fast: { topK: 5, rerank: false, maxTokens: 384, temperature: 0.3 },
  balanced: { topK: 10, rerank: true, maxTokens: 512, temperature: 0.3 },
  quality: { topK: 16, rerank: true, maxTokens: 1024, temperature: 0.2 },
};

/** Human-readable description for the settings UI. */
export const RAG_PRESET_LABELS: Record<RAGPreset, { label: string; description: string }> = {
  fast: { label: 'Fast', description: 'Fewer sources, no reranking, shorter answers — lowest latency.' },
  balanced: { label: 'Balanced', description: 'Reranked retrieval with moderate length — the default.' },
  quality: { label: 'Quality', description: 'More sources, reranking, longer answers — best grounding, slower.' },
};

/** Return the query-option overrides for a preset (defaults to balanced). */
export function presetOptions(preset: RAGPreset | undefined): Pick<RAGQueryOptions, 'topK' | 'rerank' | 'maxTokens' | 'temperature'> {
  return RAG_PRESETS[preset ?? DEFAULT_RAG_PRESET];
}
