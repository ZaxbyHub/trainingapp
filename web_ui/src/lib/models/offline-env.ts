/**
 * Single source of truth for the Transformers.js offline configuration.
 *
 * `env` in @huggingface/transformers is a SHARED module-global. Every consumer
 * (embeddings, reranker, ...) mutates the same object, so if any one of them
 * configures it inconsistently — e.g. re-enabling remote downloads — it clobbers
 * the offline guarantee for ALL of them, depending on construction order.
 *
 * To make that class of bug impossible, every Transformers.js consumer MUST call
 * `configureOfflineEnv()` instead of setting `env` fields directly. The function
 * is idempotent and always writes the same values, so order no longer matters.
 *
 * The defining product constraint: the app runs fully offline. Models are served
 * same-origin from `public/models/`; nothing is fetched from a CDN or the
 * HuggingFace Hub at runtime.
 */

import { env } from '@huggingface/transformers';
import { MODELS_BASE, ONNX_RUNTIME_WASM_BASE } from './model-manifest';

/**
 * Configure Transformers.js for local-only, fully-offline operation.
 *
 * Safe to call multiple times and from multiple modules — it is deterministic.
 */
export function configureOfflineEnv(): void {
  // Load packaged model files from disk; forbid any remote (CDN/HF) download.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;

  // All models resolve under the same-origin /models base, e.g.
  // pipeline(task, 'embeddings/bge-small-en-v1.5') -> /models/embeddings/...
  env.localModelPath = MODELS_BASE;

  // OPFS/IndexedDB caching is irrelevant once models are local; keep it off so we
  // never accidentally try to populate it from the network.
  env.useBrowserCache = false;

  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    // Serve the ONNX Runtime WASM binaries locally rather than the default
    // jsdelivr CDN — otherwise the app is not truly offline.
    wasm.wasmPaths = ONNX_RUNTIME_WASM_BASE;

    // Adaptive thread count for the WASM backend. Guard `navigator` so this
    // module can be imported in non-browser contexts (SSR, node-env tests).
    const cores =
      typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
    wasm.numThreads = cores ? Math.min(cores, 4) : 2;
  }
}
