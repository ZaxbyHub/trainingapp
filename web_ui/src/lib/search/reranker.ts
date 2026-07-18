/**
 * Cross-encoder reranking service using Transformers.js.
 * Conditionally activates for small document sets.
 * Uses cross-encoder/ms-marco-MiniLM-L-6-v2 model for relevance scoring.
 *
 * Scoring (Issue #37 R1b): the model is a single-logit cross-encoder whose
 * relevance score is `sigmoid(logit)` per its model card. We bypass the
 * `text-classification` pipeline (which applies softmax — `[x] → [1.0]` for a
 * single logit, collapsing all candidates to a tie) and call the tokenizer +
 * model directly so each `[query, passage]` pair is properly pair-encoded via
 * `text_pair` (true `[CLS] q [SEP] p [SEP]` with alternating `token_type_ids`)
 * and scored with sigmoid on the returned logit.
 */

import type { SearchResult } from '../../types/search';
import { RERANKER_MODEL_PATH } from '../models/model-manifest';
import { configureOfflineEnv } from '../models/offline-env';

// Cross-encoder reranker is loaded OFFLINE from the locally packaged path
// (RERANKER_MODEL_PATH -> /models/reranker/ms-marco-MiniLM-L-6-v2).

/**
 * Pathological-input safety bound on `canRerank`. The real per-query latency
 * cap is {@link RERANK_INPUT_CAP} inside `rerank()`, which bounds the number of
 * WASM forward passes regardless of how wide the upstream fetch went.
 */
const MAX_CHUNK_COUNT = 500;

/**
 * Hard cap on the number of candidate pairs scored per query, applied INSIDE
 * `rerank()` independently of {@link canRerank}. With Issue #37 R2's
 * candidate-multiplier over-fetch, the fused union can reach ~128 candidates on
 * the quality preset; reranking all of them would be ~11 sequential WASM
 * batches of a 6-layer MiniLM (2-5s on the target i5). Capping at 50 keeps
 * per-query reranker cost bounded while still covering the post-R2 promotion
 * window (the cross-encoder's top-K lives in the top of the fused list with
 * high probability because both legs already ranked them highly).
 */
const RERANK_INPUT_CAP = 50;

/**
 * Per-batch pair count for the cross-encoder forward pass. Bounds WASM memory
 * peak by limiting how many `[query, passage]` pairs are tokenized + scored in
 * a single model call. 12 ≈ a few hundred tokens of padding per batch.
 */
const RERANKER_BATCH_SIZE = 12;

// Minimal structural type aliases for the transformers.js objects we use. We
// import the factory functions dynamically (see doInitialize) to keep the
// top-level bundle free of the heavy transformers.js module unless the
// reranker actually initializes; these aliases describe only the slice of the
// API we call, so they do not need to track the full upstream surface.
interface Tensor {
  sigmoid(): Tensor;
  tolist(): number[] | number[][];
}

interface SequenceClassifierOutput {
  logits: Tensor;
}

/** Tokenized inputs object produced by the tokenizer and consumed by the model. */
interface TokenizerInputs {
  input_ids: Tensor;
  attention_mask?: Tensor;
  token_type_ids?: Tensor;
}

interface PreTrainedTokenizer {
  (text: string | string[], options: {
    text_pair?: string | string[];
    padding?: boolean;
    truncation?: boolean;
    max_length?: number;
    return_tensor?: 'np' | 'pt' | 'tf';
  }): TokenizerInputs;
}

interface SequenceClassificationModel {
  (inputs: TokenizerInputs): Promise<SequenceClassifierOutput>;
  dispose?: () => Promise<void> | void;
}

/**
 * Singleton service for cross-encoder reranking.
 * Reranks search results using a pretrained cross-encoder model.
 * Only activates when document set is small enough and device has sufficient memory.
 */
export class RerankerService {
  private static instance: RerankerService | null = null;

  private tokenizer: PreTrainedTokenizer | null = null;
  private model: SequenceClassificationModel | null = null;
  private ready: boolean = false;
  private initPromise: Promise<void> | null = null;
  private disposed: boolean = false;

  /**
   * Get the singleton instance, creating it if necessary.
   */
  static getInstance(): RerankerService {
    if (RerankerService.instance === null) {
      RerankerService.instance = new RerankerService();
    }
    return RerankerService.instance;
  }

  /**
   * Private constructor for singleton pattern.
   */
  private constructor() {
    this.configureEnv();
  }

  /**
   * Configure Transformers.js for OFFLINE usage.
   *
   * MUST delegate to the shared `configureOfflineEnv()` — the previous version
   * set `allowLocalModels=false` and left `allowRemoteModels` unset, which
   * clobbered the shared global `env` and re-enabled CDN/HuggingFace downloads
   * for every Transformers.js consumer. See offline-env.ts.
   */
  private configureEnv(): void {
    configureOfflineEnv();
  }

  /**
   * Check if reranking is feasible given chunk count.
   *
   * Note (Issue #37 R1): the previous `deviceMemory < 8` branch was dead —
   * Chrome caps `navigator.deviceMemory` at 8, so the comparison never tripped
   * on any browser that reports the API. It has been removed. The real per-query
   * latency bound is {@link RERANK_INPUT_CAP} inside `rerank()`.
   *
   * @param chunkCount - Number of document chunks to potentially rerank
   * @returns true if reranking can be activated
   */
  canRerank(chunkCount: number): boolean {
    // Pathological-input safety bound. Normal queries hit the RERANK_INPUT_CAP
    // inside rerank() long before this; this guard exists only to refuse
    // absurdly-large inputs outright.
    return chunkCount < MAX_CHUNK_COUNT;
  }

  /**
   * Initialize the cross-encoder model.
   *
   * MUST be called at boot (see useServiceInitialization) — `rerank()` does NOT
   * lazy-init and is a no-op while `isReady()` is false. The orchestrator's
   * `isReady()` gate falls back to fused results gracefully if init fails or the
   * packaged model is absent.
   *
   * @returns Promise that resolves when model is loaded
   */
  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    // Return existing promise if initialization is in progress
    if (this.initPromise !== null) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  /**
   * Internal initialization logic (Issue #37 R1b).
   *
   * Loads the tokenizer + sequence-classification model DIRECTLY rather than
   * via the `text-classification` `pipeline()`. The pipeline applies softmax to
   * the logits, which collapses a single-logit cross-encoder's output to a
   * constant 1.0 for every pair (no discrimination). Calling the model directly
   * lets us apply `sigmoid` to the single relevance logit, which is the scoring
   * function the model was trained for (per the ms-marco-MiniLM-L-6-v2 model
   * card). `dtype: 'q8'` ships a ~23MB quantized ONNX suitable for a 6-layer
   * reranker on CPU WASM.
   *
   * NOTE on the packaged filename: transformers.js maps `dtype:'q8'` to the
   * `model_quantized.onnx` filename (DATA_TYPES.q8 → '_quantized' suffix). The
   * packaged weights MUST be staged at onnx/model_quantized.onnx (NOT
   * model.onnx) or the loader 404s silently. See manifest.json + PACKAGING.md.
   */
  private async doInitialize(): Promise<void> {
    try {
      // Dynamic import keeps transformers.js out of the boot-critical path and
      // out of any bundle slice that does not actually rerank. The factories
      // are cast through `unknown` because their full overload surface causes
      // TS2590 ("expression is too complex"); we only need from_pretrained.
      const transformers = await import('@huggingface/transformers');
      const AutoTokenizer = transformers.AutoTokenizer as unknown as {
        from_pretrained(modelId: string): Promise<PreTrainedTokenizer>;
      };
      const AutoModelForSequenceClassification = transformers.AutoModelForSequenceClassification as unknown as {
        from_pretrained(
          modelId: string,
          options: { dtype: string; device: string }
        ): Promise<SequenceClassificationModel>;
      };

      this.tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL_PATH);
      this.model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL_PATH, {
        dtype: 'q8',
        device: 'wasm',
      });

      // Check disposed flag to prevent race condition with dispose()
      if (this.disposed) {
        throw new Error('RerankerService was disposed during initialization');
      }

      this.ready = true;
    } catch (error) {
      // Release partially-initialized model if it was created
      if (this.model !== null) {
        try {
          await this.model.dispose?.();
        } catch {
          // Best-effort cleanup
        }
        this.model = null;
      }
      this.tokenizer = null;
      this.initPromise = null;
      throw new Error(
        `Failed to initialize reranker model: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Check if the reranker model is ready.
   */
  isReady(): boolean {
    return this.ready && this.model !== null && this.tokenizer !== null;
  }

  /**
   * Rerank search results using cross-encoder relevance scoring.
   * Falls back to returning results unchanged if reranking fails or is unavailable.
   *
   * @param query - The search query
   * @param results - Initial search results to rerank
   * @param topK - Number of top results to return (default: all results)
   * @returns Reranked results sorted by cross-encoder relevance score
   */
  async rerank(
    query: string,
    results: SearchResult[],
    topK?: number
  ): Promise<SearchResult[]> {
    // Return unchanged if no results or reranking not feasible
    if (!results || results.length === 0) {
      return results;
    }

    // Return unchanged if not ready (model failed to load)
    if (!this.isReady() || this.model === null || this.tokenizer === null) {
      return results;
    }

    // Return unchanged if query is empty
    if (!query || query.trim().length === 0) {
      return results;
    }

    try {
      // Cap the candidate list at RERANK_INPUT_CAP to bound per-query WASM
      // cost. The fused list is already approximately relevance-ordered (RRF),
      // so dropping the tail retains the chunks most likely to be promoted.
      // Results beyond the cap pass through unchanged in input order.
      const capped = results.length > RERANK_INPUT_CAP ? results.slice(0, RERANK_INPUT_CAP) : results;
      const overflow = results.length > RERANK_INPUT_CAP ? results.slice(RERANK_INPUT_CAP) : [];

      // Build parallel arrays of (query, passage) pairs for pair-encoding.
      // Chunks with no text are NOT scored (scoring [query, ''] would demote
      // exactly the chunks we want to keep); they pass through with their input
      // rank preserved so upstream ordering still applies.
      const queries: string[] = [];
      const passages: string[] = [];
      const resultMap: SearchResult[] = [];
      const unscored: SearchResult[] = [];

      for (const result of capped) {
        const text = result.text || '';
        if (text.trim().length === 0) {
          unscored.push(result);
          continue;
        }
        queries.push(query);
        passages.push(text);
        resultMap.push(result);
      }

      // No scorable pairs: return inputs unchanged.
      if (queries.length === 0) {
        return results;
      }

      // Score in batches to bound WASM memory. Each batch tokenizes N pairs via
      // `text_pair` (producing true [CLS] q [SEP] p [SEP] with alternating
      // token_type_ids — the format the model was trained on), runs the model,
      // and applies sigmoid to the single relevance logit per pair.
      const crossScores: number[] = [];
      for (let i = 0; i < queries.length; i += RERANKER_BATCH_SIZE) {
        const batchQueries = queries.slice(i, i + RERANKER_BATCH_SIZE);
        const batchPassages = passages.slice(i, i + RERANKER_BATCH_SIZE);
        const inputs = this.tokenizer(batchQueries, {
          text_pair: batchPassages,
          padding: true,
          truncation: true,
        });
        const { logits } = await this.model(inputs);
        // sigmoid on the single logit per pair → relevance in (0, 1). tolist()
        // returns number[][] for a 2-D tensor ([batch, 1]); flatten the inner.
        const batchScores = logits.sigmoid().tolist();
        if (Array.isArray(batchScores) && Array.isArray(batchScores[0])) {
          for (const row of batchScores as number[][]) {
            crossScores.push(Array.isArray(row) ? (row[0] ?? 0) : (row as unknown as number));
          }
        } else {
          for (const s of batchScores as number[]) {
            crossScores.push(s);
          }
        }
      }

      // Map scores back to the scored results.
      const scoredResults: Array<{ result: SearchResult; crossScore: number }> = resultMap.map((result, i) => ({
        result,
        crossScore: crossScores[i] ?? 0,
      }));

      // Sort by cross-encoder score descending
      scoredResults.sort((a, b) => b.crossScore - a.crossScore);

      // Scored results first (cross-encoder score replaces the vector score);
      // unscored (empty-text) results are appended afterwards in their input
      // order so they are not lost, but never promoted above scored hits. The
      // RERANK_INPUT_CAP overflow tail follows last so callers still see every
      // input chunk if they requested no topK slice.
      const rerankedAll: SearchResult[] = scoredResults.map((sr) => ({
        ...sr.result,
        score: sr.crossScore,
      }));
      for (const result of unscored) {
        rerankedAll.push(result);
      }
      for (const result of overflow) {
        rerankedAll.push(result);
      }

      // Optionally limit to topK
      return topK !== undefined ? rerankedAll.slice(0, topK) : rerankedAll;
    } catch (error) {
      // Graceful degradation: return original results if reranking fails
      console.warn(
        `Cross-encoder reranking failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return results;
    }
  }

  /**
   * Dispose of the service and release resources.
   * Call when done using the reranker service.
   */
  dispose(): void {
    this.disposed = true;
    if (this.model !== null) {
      // Release ONNX/WASM session memory (fire-and-forget — dispose may be sync)
      try {
        const maybe = this.model.dispose?.();
        if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
          (maybe as Promise<void>).catch(() => { /* best-effort */ });
        }
      } catch {
        // Best-effort cleanup
      }
      this.model = null;
    }
    this.tokenizer = null;
    this.ready = false;
    this.initPromise = null;
    RerankerService.instance = null;
  }
}

/**
 * Convenience function to get the reranker service instance.
 */
export function getRerankerService(): RerankerService {
  return RerankerService.getInstance();
}
