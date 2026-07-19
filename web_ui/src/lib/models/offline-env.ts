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
  // pipeline(task, 'embeddings/snowflake-arctic-embed-m-v1.5') -> /models/embeddings/...
  env.localModelPath = MODELS_BASE;

  // OPFS/IndexedDB caching is irrelevant once models are local; keep it off so we
  // never accidentally try to populate it from the network.
  env.useBrowserCache = false;

  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    // Serve the ONNX Runtime WASM binaries locally rather than the default
    // jsdelivr CDN — otherwise the app is not truly offline.
    //
    // Dev-mode caveat: Vite serves files in `public/` as static assets only and
    // blocks dynamic `import()` of JS modules from that path. The ORT `.mjs`
    // glue file must go through Vite's module pipeline, so in dev we point
    // wasmPaths at the onnxruntime-web package in node_modules (Vite serves
    // node_modules files as proper modules). In production builds the files are
    // copied into dist/models/ort/ and served same-origin, so the packaged
    // ONNX_RUNTIME_WASM_BASE path is used.
    if (import.meta.env.DEV) {
      wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
    } else {
      wasm.wasmPaths = ONNX_RUNTIME_WASM_BASE;
    }

    // Adaptive thread count for the WASM backend. Guard `navigator` so this
    // module can be imported in non-browser contexts (SSR, node-env tests).
    // CRITICAL: ONNX Runtime's multi-threaded proxy worker deadlocks silently
    // when the page is NOT cross-origin isolated (SharedArrayBuffer unavailable).
    // The worker spawns but never posts a message, so createInferenceSession
    // never resolves — the app hangs on first document upload with no error.
    // Force numThreads=1 when crossOriginIsolated is false to avoid the hang.
    const cores =
      typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
    const isCrossOriginIsolated =
      typeof globalThis !== 'undefined' && globalThis.crossOriginIsolated === true;
    wasm.numThreads = isCrossOriginIsolated && cores ? Math.min(cores, 4) : 1;
  }
}
