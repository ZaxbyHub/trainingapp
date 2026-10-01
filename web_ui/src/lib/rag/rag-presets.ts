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
export const RAG_PRESETS: Record<
  RAGPreset,
  Pick<RAGQueryOptions, 'topK' | 'candidateMultiplier' | 'rerank' | 'maxTokens' | 'temperature' | 'topP' | 'repeatPenalty' | 'frequencyPenalty' | 'presencePenalty'>
> = {
  // fast: no rerank → over-fetching wastes work. candidateMultiplier 1 keeps
  // both legs at topK.
  fast: { topK: 5, candidateMultiplier: 1, rerank: false, maxTokens: 384, temperature: 0.3, topP: 0.9, repeatPenalty: 1.1, frequencyPenalty: 0.0, presencePenalty: 0.0 },
  // balanced: retrieve 3×topK per leg (30 candidates), rerank down to topK=10.
  balanced: { topK: 10, candidateMultiplier: 3, rerank: true, maxTokens: 512, temperature: 0.3, topP: 0.9, repeatPenalty: 1.1, frequencyPenalty: 0.0, presencePenalty: 0.0 },
  // quality: retrieve 4×topK per leg (64 candidates), rerank down to topK=16.
  // The reranker caps scoring at RERANK_INPUT_CAP=50 to bound per-query cost.
  quality: { topK: 16, candidateMultiplier: 4, rerank: true, maxTokens: 1024, temperature: 0.2, topP: 0.9, repeatPenalty: 1.1, frequencyPenalty: 0.0, presencePenalty: 0.0 },
};

/** Human-readable description for the settings UI. */
export const RAG_PRESET_LABELS: Record<RAGPreset, { label: string; description: string }> = {
  fast: { label: 'Fast', description: 'Fewer sources, no reranking, shorter answers — lowest latency.' },
  balanced: { label: 'Balanced', description: 'Reranked retrieval with moderate length — the default.' },
  quality: { label: 'Quality', description: 'More sources, reranking, longer answers — best grounding, slower.' },
};

/** Return the query-option overrides for a preset (defaults to balanced). */
export function presetOptions(
  preset: RAGPreset | undefined
): Pick<RAGQueryOptions, 'topK' | 'candidateMultiplier' | 'rerank' | 'maxTokens' | 'temperature' | 'topP' | 'repeatPenalty' | 'frequencyPenalty' | 'presencePenalty'> {
  return RAG_PRESETS[preset ?? DEFAULT_RAG_PRESET];
}

// ============================================================================
// Desktop backend preset contract (settings-wiring-honesty)
// ============================================================================

/** The desktop PUT /settings patch a preset writes. */
export interface DesktopPresetPatch {
  rag_n_results: number;
  rag_reranking_enabled: boolean;
  rag_max_tokens: number;
  rag_temperature: number;
}

/**
 * What each preset writes to the DESKTOP backend: result count, reranking,
 * and generation length/temperature, so each card's promise ("no reranking,
 * shorter answers") is real in the desktop app too (user decision
 * 2026-09-30: presets control reranking, max tokens and temperature).
 * Values stay inside the desktop PUT bounds (n_results 1..10, max_tokens
 * 256..4096, temperature 0..2) and n_results stay DISTINCT per preset so
 * GET /settings tells the presets apart. max_tokens/temperature mirror the
 * browser rows above.
 */
export const DESKTOP_PRESET_SETTINGS: Record<RAGPreset, DesktopPresetPatch> = {
  fast: { rag_n_results: 5, rag_reranking_enabled: false, rag_max_tokens: 384, rag_temperature: 0.3 },
  balanced: { rag_n_results: 8, rag_reranking_enabled: true, rag_max_tokens: 512, rag_temperature: 0.3 },
  quality: { rag_n_results: 10, rag_reranking_enabled: true, rag_max_tokens: 1024, rag_temperature: 0.2 },
};

/** The keys a preset writes (also the keys the "Reset to defaults" button resets). */
export const DESKTOP_PRESET_KEYS = [
  'rag_n_results',
  'rag_reranking_enabled',
  'rag_max_tokens',
  'rag_temperature',
] as const satisfies ReadonlyArray<keyof DesktopPresetPatch>;

/**
 * Display state of the desktop Response Quality control, derived from the
 * backend (never from the persisted browser-local `ragPreset`):
 *  - preset:   the backend's explicitly set values match this preset
 *  - custom:   explicit values match no preset ("Custom server settings")
 *  - defaults: nothing preset-related was explicitly set ("Using server defaults")
 */
export type DesktopPresetState =
  | { kind: 'preset'; preset: RAGPreset }
  | { kind: 'custom' }
  | { kind: 'defaults' };

const REQUESTED_FIELD: Record<(typeof DESKTOP_PRESET_KEYS)[number], string> = {
  rag_n_results: 'n_results',
  rag_reranking_enabled: 'reranking_enabled',
  rag_max_tokens: 'max_tokens',
  rag_temperature: 'temperature',
};

const PRESET_ORDER: RAGPreset[] = ['fast', 'balanced', 'quality'];

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

/**
 * Derive the desktop display state from a GET (or PUT) /settings body.
 *
 * Matches on REQUESTED values: a preset matches when every explicitly set
 * preset key equals that preset's value. rag_n_results must be explicit
 * before any preset can match; when it is the only explicit key (settings
 * saved before presets wrote the full patch) it decides alone. Reranking is
 * not compared when the backend reports no reranker on this installation.
 * A backend without `explicit_keys` (older desktop build) falls back to the
 * flat n_results value.
 */
export function presetFromBackend(settings: Record<string, unknown>): DesktopPresetState {
  const flatN = settings.n_results ?? settings.rag_n_results;
  const explicitKeys = settings.explicit_keys;
  if (!Array.isArray(explicitKeys)) {
    const match = PRESET_ORDER.find((p) => sameValue(DESKTOP_PRESET_SETTINGS[p].rag_n_results, flatN));
    return match !== undefined ? { kind: 'preset', preset: match } : { kind: 'custom' };
  }
  const explicitPresetKeys = DESKTOP_PRESET_KEYS.filter((key) => explicitKeys.includes(key));
  if (explicitPresetKeys.length === 0) return { kind: 'defaults' };
  if (!explicitPresetKeys.includes('rag_n_results')) return { kind: 'custom' };
  const requested = (settings.requested ?? {}) as Record<string, unknown>;
  const rerankComparable = settings.reranking_available !== false;
  const match = PRESET_ORDER.find((preset) =>
    explicitPresetKeys.every((key) => {
      if (key === 'rag_reranking_enabled' && !rerankComparable) return true;
      return sameValue(requested[REQUESTED_FIELD[key]], DESKTOP_PRESET_SETTINGS[preset][key]);
    }),
  );
  return match !== undefined ? { kind: 'preset', preset: match } : { kind: 'custom' };
}
