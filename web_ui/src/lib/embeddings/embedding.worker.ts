/**
 * Embedding Web Worker (Issue #37 R8).
 *
 * Runs the transformers.js `feature-extraction` pipeline OFF the main thread so
 * bulk ingestion of large PDFs no longer janks the UI on the target kiosk-class
 * i5. The worker owns the pipeline; the main-thread {@link EmbeddingService} is
 * a thin proxy that posts messages and awaits replies.
 *
 * Protocol (postMessage, request/reply by id):
 *   → { kind: 'init' }
 *   ← { kind: 'ready', dimensions } | { kind: 'error', message }
 *   → { kind: 'encode', id, text }
 *   ← { kind: 'encode-result', id, vector } | { kind: 'error', id, message }
 *   → { kind: 'encodeBatch', id, texts }
 *   ← { kind: 'encodeBatch-result', id, vectors } | { kind: 'error', id, message }
 *
 * The vectors are Float32Arrays; structured-clone transfers them by copy (not
 * transferable unless explicitly listed). For the batch sizes in use (≤8) the
 * copy cost is negligible next to the WASM forward pass.
 *
 * NOTE on offline env: the worker calls `configureOfflineEnv()` BEFORE importing
 * transformers.js so `allowRemoteModels=false` is set on the shared `env` before
 * the pipeline factory runs. The dynamic `import()` below is hoisted by Vite
 * into the worker chunk so the heavy transformers.js code never lands on the
 * main-thread bundle.
 */

/// <reference lib="webworker" />

import { configureOfflineEnv } from '../models/offline-env';

// MUST configure offline env before importing transformers.js.
configureOfflineEnv();

// Lazy-loaded pipeline + model info. Loaded once on 'init'.
type FeatureExtractionPipeline = (input: string | string[], options: {
  pooling: 'cls';
  normalize: true;
}) => Promise<{ data: Float32Array; dims: number[] }> & { dispose?: () => Promise<void> };

let pipeline: FeatureExtractionPipeline | null = null;
let modelPath: string | null = null;
// Issue #37 R9: arctic-embed-m-v1.5 is 768-dim (was bge-small 384). The init
// message overwrites this with EMBEDDING_DIMENSIONS from the service, so the
// default only matters before init resolves.
let dimensions = 768;

type InboundMessage =
  | { kind: 'init'; modelPath: string; dimensions: number }
  | { kind: 'encode'; id: number; text: string }
  | { kind: 'encodeBatch'; id: number; texts: string[] };

self.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  try {
    if (msg.kind === 'init') {
      modelPath = msg.modelPath;
      dimensions = msg.dimensions;
      await doInit();
      (self as unknown as Worker).postMessage({ kind: 'ready', dimensions });
      return;
    }
    if (!pipeline) {
      // If init hasn't completed, surface a clear error rather than crashing.
      (self as unknown as Worker).postMessage({
        kind: 'error',
        id: (msg as { id?: number }).id ?? -1,
        message: 'embedding worker not initialized',
      });
      return;
    }
    if (msg.kind === 'encode') {
      if (!msg.text || msg.text.trim().length === 0) {
        throw new Error('Cannot encode empty text');
      }
      const result = await pipeline(msg.text, { pooling: 'cls', normalize: true });
      (self as unknown as Worker).postMessage({
        kind: 'encode-result',
        id: msg.id,
        vector: new Float32Array(result.data),
      });
      return;
    }
    if (msg.kind === 'encodeBatch') {
      if (!Array.isArray(msg.texts) || msg.texts.length === 0) {
        (self as unknown as Worker).postMessage({
          kind: 'encodeBatch-result',
          id: msg.id,
          vectors: [],
        });
        return;
      }
      const vectors: Float32Array[] = [];
      const batchSize = 8;
      for (let i = 0; i < msg.texts.length; i += batchSize) {
        const batch = msg.texts.slice(i, Math.min(i + batchSize, msg.texts.length));
        const result = await pipeline(batch, { pooling: 'cls', normalize: true });
        const expectedRows = batch.length;
        const actualRows =
          Array.isArray(result.dims) && result.dims.length > 0
            ? result.dims[0]
            : Math.floor(result.data.length / dimensions);
        if (actualRows !== expectedRows) {
          throw new Error(
            `Embedding batch shape mismatch: expected ${expectedRows} row(s) but the model returned ${actualRows}`
          );
        }
        if (result.data.length < expectedRows * dimensions) {
          throw new Error(
            `Embedding batch data too short: expected ${expectedRows * dimensions} floats, got ${result.data.length}`
          );
        }
        for (let r = 0; r < expectedRows; r++) {
          vectors.push(result.data.slice(r * dimensions, (r + 1) * dimensions));
        }
        // Progress: post a batch-progress message the proxy can forward.
        (self as unknown as Worker).postMessage({
          kind: 'batch-progress',
          id: msg.id,
          processed: Math.min(i + batchSize, msg.texts.length),
          total: msg.texts.length,
        });
      }
      (self as unknown as Worker).postMessage({
        kind: 'encodeBatch-result',
        id: msg.id,
        vectors,
      });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (self as unknown as Worker).postMessage({
      kind: 'error',
      id: (msg as { id?: number }).id ?? -1,
      message,
    });
  }
};

async function doInit(): Promise<void> {
  // Dynamic import keeps transformers.js out of any bundle slice that does
  // not actually embed. Inside the worker this resolves to a worker-local chunk.
  const transformers = await import('@huggingface/transformers');
  const createPipeline = transformers.pipeline as unknown as (
    task: 'feature-extraction',
    modelId: string,
    options: { dtype: string; device: string }
  ) => Promise<FeatureExtractionPipeline>;
  pipeline = await createPipeline('feature-extraction', modelPath!, {
    // Issue #37 R8: q8 is 2.7–3.4× faster than fp32 on CPU WASM with ~1–2%
    // retrieval-quality cost. The embedding space changes vs fp32, so the
    // orchestrator bumps VECTOR_INDEX_VERSION (vector-index.ts) to force a
    // re-index of dev corpora.
    dtype: 'q8',
    device: 'wasm',
  });
  // Verify dimensions with a probe encoding (also primes the WASM session).
  // PRR46-009: the probe uses a short literal ('init') and validates ONLY the
  // output dimension — it does not exercise realistic chunk-length truncation
  // behavior. A tokenizer-config mismatch (different model_max_length) would
  // surface at query time when real chunks silently truncate, not here. This
  // is an accepted limitation: staging the correct tokenizer_config.json is an
  // operator responsibility (documented in PACKAGING.md).
  const probe = await pipeline('init', { pooling: 'cls', normalize: true });
  if (probe.data.length !== dimensions) {
    throw new Error(
      `Embedding model returned wrong dimension: expected ${dimensions}, got ${probe.data.length}`
    );
  }
}
