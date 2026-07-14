/**
 * Cross-encoder reranking service using Transformers.js.
 * Conditionally activates for small document sets with sufficient memory.
 * Uses cross-encoder/ms-marco-MiniLM-L-6-v2 model for relevance scoring.
 */

import { pipeline, type TextClassificationPipeline } from '@huggingface/transformers';
import type { SearchResult } from '../../types/search';
import { RERANKER_MODEL_PATH } from '../models/model-manifest';
import { configureOfflineEnv } from '../models/offline-env';

// Cross-encoder reranker is loaded OFFLINE from the locally packaged path
// (RERANKER_MODEL_PATH -> /models/reranker/ms-marco-MiniLM-L-6-v2).

// Memory and size thresholds for activation
const MAX_CHUNK_COUNT = 500;
const MIN_DEVICE_MEMORY_GB = 8;

// Task type for cross-encoder
const RERANKER_TASK = 'text-classification';

/**
 * Singleton service for cross-encoder reranking.
 * Reranks search results using a pretrained cross-encoder model.
 * Only activates when document set is small enough and device has sufficient memory.
 */
export class RerankerService {
  private static instance: RerankerService | null = null;

  private crossEncoder: TextClassificationPipeline | null = null;
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
   * Check if reranking is feasible given chunk count and device memory.
   *
   * @param chunkCount - Number of document chunks to potentially rerank
   * @returns true if reranking can be activated
   */
  canRerank(chunkCount: number): boolean {
    // Check chunk count threshold
    if (chunkCount >= MAX_CHUNK_COUNT) {
      return false;
    }

    // Check device memory (undefined means assume OK - some browsers don't expose this)
    const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory;
    if (deviceMemory !== undefined && deviceMemory < MIN_DEVICE_MEMORY_GB) {
      return false;
    }

    return true;
  }

  /**
   * Initialize the cross-encoder model.
   * Model is loaded lazily on first rerank request if conditions are met.
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
   * Internal initialization logic.
   */
  private async doInitialize(): Promise<void> {
    try {
      // Create text-classification pipeline. `pipeline()` is heavily overloaded
      // (TS2590); narrow the factory to the single signature we use (see
      // embedding-service.ts for the same approach).
      const createClassifier = pipeline as unknown as (
        task: 'text-classification',
        modelId: string,
        options: { dtype: string; device: string }
      ) => Promise<TextClassificationPipeline>;
      this.crossEncoder = await createClassifier(
        RERANKER_TASK,
        RERANKER_MODEL_PATH,
        {
          // ONNX runtime configuration
          dtype: 'fp32',
          device: 'wasm',
        }
      );

      // Check disposed flag to prevent race condition with dispose()
      if (this.disposed) {
        throw new Error('RerankerService was disposed during initialization');
      }

      this.ready = true;
    } catch (error) {
      // Release partially-initialized pipeline if it was created
      if (this.crossEncoder !== null) {
        await this.crossEncoder.dispose();
        this.crossEncoder = null;
      }
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
    return this.ready && this.crossEncoder !== null;
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
    if (!this.isReady() || this.crossEncoder === null) {
      return results;
    }

    // Return unchanged if query is empty
    if (!query || query.trim().length === 0) {
      return results;
    }

    try {
      // Build batch of [query, text] pairs for the cross-encoder. Chunks with no
      // text are NOT scored (scoring [query, ''] would demote exactly the chunks
      // we want to keep); they pass through with their input rank preserved so
      // upstream ordering still applies. After F1 lands this branch is
      // unreachable — it exists as defense in depth.
      const pairs: [string, string][] = [];
      const resultMap: SearchResult[] = [];
      const unscored: Array<{ index: number; result: SearchResult }> = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const text = result.text || '';
        if (text.trim().length === 0) {
          unscored.push({ index: i, result });
          continue;
        }
        pairs.push([query, text]);
        resultMap.push(result);
      }

      // No scorable pairs: return inputs unchanged.
      if (pairs.length === 0) {
        return results;
      }

      // Batch inference: call pipeline once with all pairs. Cross-encoder
      // text-classification accepts pair arrays at runtime; the typed callback
      // signature only models string|string[], so cast through unknown.
      const scoreResults = (await (this.crossEncoder as unknown as (input: unknown) => Promise<Array<{ label: string; score: number }>>)(pairs)) as Array<{ label: string; score: number }>;

      // Map scores back to the scored results. Iterate over resultMap (one entry
      // per scored pair) and read the matching score defensively, in case a
      // pipeline returns more/fewer scores than pairs.
      const scoredResults: Array<{ result: SearchResult; crossScore: number }> = resultMap.map((result, i) => ({
        result,
        crossScore: scoreResults[i]?.score ?? 0,
      }));

      // Sort by cross-encoder score descending
      scoredResults.sort((a, b) => b.crossScore - a.crossScore);

      // Scored results first (cross-encoder score replaces the vector score);
      // unscored (empty-text) results are appended afterwards in their input
      // order so they are not lost, but never promoted above scored hits.
      const rerankedAll = scoredResults.map((sr) => ({
        ...sr.result,
        score: sr.crossScore,
      }));
      for (const { result } of unscored) {
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
    if (this.crossEncoder !== null) {
      // Release ONNX/WASM session memory (fire-and-forget)
      this.crossEncoder.dispose();
      this.crossEncoder = null;
    }
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
