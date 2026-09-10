// retrieval/config.ts — hybrid retrieval configuration (issue #65, B7).
//
// Mirrors the frozen-defaults + env-resolution pattern of
// desktop/main/backend/ingest/config.ts. The defaults mirror the browser
// balanced preset (web_ui/src/lib/rag/rag-presets.ts:24: topK 10,
// candidateMultiplier 3, rerank true) plus RRF k=60, the value both the
// browser fusion (rrf-fusion.ts) and the Python reference (utils.py rrf_fuse)
// use. relevanceFloor is the CALIBRATED cross-encoder floor recorded in
// docs/adr/0007-relevance-floor-calibration.md — deliberately NOT the
// browser's un-revalidated 0.2 (web_ui/src/lib/rag/rag-orchestrator.ts:163).
//
// The floor gates RERANKER-scale sigmoid scores only. It is never applied to
// raw RRF fused scores (a ~0.03-max scale): when no reranker ran, the floor is
// bypassed entirely (see retrieval/hybrid.ts).

export interface RetrievalConfig {
  /** Final result slice (`retrieval.topK`); per-leg fetch is topK * candidateMultiplier. */
  topK: number;
  /** Over-retrieval factor per leg and the reranker candidate window size. */
  candidateMultiplier: number;
  /** Whether the worker cross-encoder reranks the fused window. */
  rerank: boolean;
  /** Reciprocal Rank Fusion constant: score += 1/(rrfK + rank + 1). */
  rrfK: number;
  /** Calibrated floor on reranker sigmoid scores (scores < floor are dropped). */
  relevanceFloor: number;
}

export const RETRIEVAL_TOPK_ENV = 'TRAININGAPP_RETRIEVAL_TOPK';
export const RETRIEVAL_CANDIDATE_MULTIPLIER_ENV = 'TRAININGAPP_RETRIEVAL_CANDIDATE_MULTIPLIER';
export const RETRIEVAL_RERANK_ENV = 'TRAININGAPP_RETRIEVAL_RERANK';
export const RETRIEVAL_RRF_K_ENV = 'TRAININGAPP_RETRIEVAL_RRF_K';
export const RETRIEVAL_RELEVANCE_FLOOR_ENV = 'TRAININGAPP_RETRIEVAL_RELEVANCE_FLOOR';

/**
 * Calibrated on the ettin-reranker-32m-v1 cross-encoder over the A4 tier-0
 * eval set (positives = expected-document chunks, negatives = other docs);
 * procedure and histogram in docs/adr/0007-relevance-floor-calibration.md.
 * Must stay in lockstep with the ADR's `floor:` line (pinned by C2).
 */
export const CALIBRATED_RELEVANCE_FLOOR = 0.569387;

export const DEFAULT_RETRIEVAL_CONFIG: Readonly<RetrievalConfig> = Object.freeze({
  topK: 10,
  candidateMultiplier: 3,
  rerank: true,
  rrfK: 60,
  relevanceFloor: CALIBRATED_RELEVANCE_FLOOR,
});

const POSITIVE_INT_PATTERN = /^\d+$/;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value !== undefined && POSITIVE_INT_PATTERN.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed >= 1) return parsed;
  }
  return fallback;
}

function boolOrFallback(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function floorOrFallback(value: string | undefined, fallback: number): number {
  if (value !== undefined && value.length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < 1) return parsed;
  }
  return fallback;
}

/** Resolve the retrieval config from an env-like record (defaults on invalid input). */
export function resolveRetrievalConfig(env?: Record<string, string | undefined>): RetrievalConfig {
  const source = env ?? process.env;
  return {
    topK: positiveInt(source[RETRIEVAL_TOPK_ENV], DEFAULT_RETRIEVAL_CONFIG.topK),
    candidateMultiplier: positiveInt(
      source[RETRIEVAL_CANDIDATE_MULTIPLIER_ENV],
      DEFAULT_RETRIEVAL_CONFIG.candidateMultiplier,
    ),
    rerank: boolOrFallback(source[RETRIEVAL_RERANK_ENV], DEFAULT_RETRIEVAL_CONFIG.rerank),
    rrfK: positiveInt(source[RETRIEVAL_RRF_K_ENV], DEFAULT_RETRIEVAL_CONFIG.rrfK),
    relevanceFloor: floorOrFallback(
      source[RETRIEVAL_RELEVANCE_FLOOR_ENV],
      DEFAULT_RETRIEVAL_CONFIG.relevanceFloor,
    ),
  };
}
