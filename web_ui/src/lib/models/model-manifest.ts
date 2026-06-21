/**
 * Packaged-model manifest — the single source of truth for every model the web
 * app loads, and where it lives in the locally bundled `public/models/` tree.
 *
 * OFFLINE CONTRACT (Phase 1):
 *   This app must run fully offline. Every model file is packaged into the build
 *   under `public/models/` and served same-origin. NOTHING is fetched from a CDN
 *   or the HuggingFace Hub at runtime. The actual weight binaries are NOT checked
 *   into git (they are large); they are assembled at packaging time by
 *   `scripts/prepare-models.mjs`. See PACKAGING.md.
 *
 *   At runtime we therefore cannot assume the weights are present — the operator
 *   may have built the archive without running the prepare step. `checkPackagedModels()`
 *   verifies presence so the UI can show a clear "models packaged & ready" vs
 *   "models missing — see packaging guide" state instead of a cryptic load failure.
 */

/**
 * Base public path (same-origin) under which all packaged models live.
 * This is also the value of Transformers.js `env.localModelPath`, so every
 * model is addressed by a path RELATIVE to it (e.g. `embeddings/bge-small-en-v1.5`).
 */
export const MODELS_BASE = '/models';

/** Absolute base for embedding model files (used by the readiness gate). */
export const EMBEDDING_MODELS_BASE = `${MODELS_BASE}/embeddings`;

/** Folder name of the packaged embedding model. */
export const EMBEDDING_MODEL_DIR = 'bge-small-en-v1.5';

/** Path passed to `pipeline(task, ...)` — relative to `env.localModelPath`. */
export const EMBEDDING_MODEL_PATH = `embeddings/${EMBEDDING_MODEL_DIR}`;

/** Absolute base for reranker model files (used by the readiness gate). */
export const RERANKER_MODELS_BASE = `${MODELS_BASE}/reranker`;

/** Folder name of the packaged cross-encoder reranker model. */
export const RERANKER_MODEL_DIR = 'ms-marco-MiniLM-L-6-v2';

/** Path passed to `pipeline(task, ...)` — relative to `env.localModelPath`. */
export const RERANKER_MODEL_PATH = `reranker/${RERANKER_MODEL_DIR}`;

/**
 * Base path for the ONNX Runtime WASM binaries.
 * Transformers.js v3 requests the JSEP build (`ort-wasm-simd-threaded.jsep.wasm`)
 * plus its `.jsep.mjs` loader, and otherwise loads them from jsdelivr — which
 * breaks offline use. We override `env.backends.onnx.wasm.wasmPaths` to this dir.
 */
export const ONNX_RUNTIME_WASM_BASE = `${MODELS_BASE}/ort/`;

/** The exact ORT artifacts Transformers.js v3 fetches at runtime. */
export const ONNX_RUNTIME_WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm';
export const ONNX_RUNTIME_LOADER_FILE = 'ort-wasm-simd-threaded.jsep.mjs';

/**
 * wllama's own WASM runtime. wllama uses the AssetsPathConfig `default` value
 * VERBATIM as the wasm URL (it does NOT append a filename), so `default` must be
 * the full path to the .wasm file — WLLAMA_WASM_FILE below — not a directory.
 */
export const WLLAMA_WASM_BASE = `${MODELS_BASE}/wllama/`;
export const WLLAMA_WASM_FILE = `${WLLAMA_WASM_BASE}wasm/wllama.wasm`;

/**
 * wllama "compat" runtime (@wllama/wllama-compat). wllama falls back to this when
 * the browser lacks JSPI/Memory64 — which is common on the target hardware. By
 * default it is fetched from jsdelivr (breaks offline!), so we package it locally
 * and pass these paths to `setCompat({ worker, wasm })`.
 */
export const WLLAMA_COMPAT_BASE = `${WLLAMA_WASM_BASE}compat/`;
export const WLLAMA_COMPAT_WASM_URL = `${WLLAMA_COMPAT_BASE}wllama.wasm`;
export const WLLAMA_COMPAT_WORKER_URL = `${WLLAMA_COMPAT_BASE}wllama.js`;

/** Base directory for packaged GGUF LLM weights (wllama). */
export const LLM_MODELS_BASE = `${MODELS_BASE}/llm`;

/** Packaged browser LLM: LFM2-VL (vision-language) for wllama. */
export const LLM_MODEL_DIR = 'lfm2-vl-1.6b';
/**
 * GGUF weights URL passed to wllama `loadModelFromUrl`. LFM2-VL-1.6B Q4 is ~1 GB
 * (under wllama's 2 GB/file limit) so a single file is used; if a larger quant is
 * packaged, split with `llama-gguf-split` and point this at the `-00001-of-...` shard.
 */
export const LLM_GGUF_URL = `${LLM_MODELS_BASE}/${LLM_MODEL_DIR}/model.gguf`;
/** Multimodal projector (mmproj) URL, passed via wllama ModelSource.mmprojUrl. */
export const LLM_MMPROJ_URL = `${LLM_MODELS_BASE}/${LLM_MODEL_DIR}/mmproj.gguf`;

/**
 * Category of a packaged model, used to group readiness reporting in the UI.
 */
export type PackagedModelKind = 'embedding' | 'llm' | 'runtime' | 'reranker';

/**
 * A single file that must be present for a packaged model to work.
 * `path` is an absolute, same-origin URL path under MODELS_BASE.
 */
export interface PackagedModelFile {
  /** Same-origin absolute path, e.g. `/models/embeddings/bge-small-en-v1.5/onnx/model.onnx`. */
  path: string;
  /** Whether the model is unusable without this file (vs an optional asset). */
  required: boolean;
}

/**
 * Declarative description of one packaged model and the files it needs.
 */
export interface PackagedModel {
  /** Stable id used in code and readiness reporting. */
  id: string;
  /** Human-readable name for the UI. */
  label: string;
  kind: PackagedModelKind;
  files: PackagedModelFile[];
}

/**
 * The set of models required for Phase 1 (offline embeddings + ORT runtime).
 * Phase 2 adds the LFM2-VL GGUF + mmproj entries here.
 */
export const PACKAGED_MODELS: PackagedModel[] = [
  {
    id: EMBEDDING_MODEL_DIR,
    label: 'BAAI/bge-small-en-v1.5 (embeddings)',
    kind: 'embedding',
    files: [
      { path: `${EMBEDDING_MODELS_BASE}/${EMBEDDING_MODEL_DIR}/onnx/model.onnx`, required: true },
      { path: `${EMBEDDING_MODELS_BASE}/${EMBEDDING_MODEL_DIR}/tokenizer.json`, required: true },
      { path: `${EMBEDDING_MODELS_BASE}/${EMBEDDING_MODEL_DIR}/config.json`, required: true },
      { path: `${EMBEDDING_MODELS_BASE}/${EMBEDDING_MODEL_DIR}/tokenizer_config.json`, required: true },
    ],
  },
  {
    id: 'onnxruntime-web',
    label: 'ONNX Runtime (WASM)',
    kind: 'runtime',
    files: [
      // Transformers.js v3 fetches the JSEP threaded-SIMD build and its ESM loader.
      { path: `${ONNX_RUNTIME_WASM_BASE}${ONNX_RUNTIME_WASM_FILE}`, required: true },
      { path: `${ONNX_RUNTIME_WASM_BASE}${ONNX_RUNTIME_LOADER_FILE}`, required: true },
    ],
  },
  {
    // Reranking is OPTIONAL: if these files are absent the app still runs and
    // simply skips cross-encoder reranking (see RerankerService graceful
    // degradation). Marked non-required so a build without it is still "ready".
    id: RERANKER_MODEL_DIR,
    label: 'cross-encoder/ms-marco-MiniLM-L-6-v2 (reranker, optional)',
    kind: 'reranker',
    files: [
      { path: `${RERANKER_MODELS_BASE}/${RERANKER_MODEL_DIR}/onnx/model.onnx`, required: false },
      { path: `${RERANKER_MODELS_BASE}/${RERANKER_MODEL_DIR}/tokenizer.json`, required: false },
      { path: `${RERANKER_MODELS_BASE}/${RERANKER_MODEL_DIR}/config.json`, required: false },
      { path: `${RERANKER_MODELS_BASE}/${RERANKER_MODEL_DIR}/tokenizer_config.json`, required: false },
    ],
  },
  {
    // wllama's WASM runtime + offline compat build. Needed for the browser
    // 'wllama' engine, not for server/WebLLM — non-required at the aggregate
    // level. Both the modern and compat wasm are packaged because the browser
    // picks one at runtime based on JSPI/Memory64 support.
    id: 'wllama-runtime',
    label: 'wllama WASM runtime',
    kind: 'runtime',
    files: [
      { path: WLLAMA_WASM_FILE, required: false },
      { path: WLLAMA_COMPAT_WASM_URL, required: false },
      { path: WLLAMA_COMPAT_WORKER_URL, required: false },
    ],
  },
  {
    // Browser LLM weights: LFM2-VL-1.6B (vision-language) for wllama. Engine- and
    // mode-specific (only needed for browser 'wllama' mode), hence non-required at
    // the aggregate level. WllamaService.initialize() HEAD-probes these before
    // loading and fails fast with a clear message if absent.
    id: LLM_MODEL_DIR,
    label: 'LiquidAI LFM2-VL-1.6B (browser LLM, multimodal)',
    kind: 'llm',
    files: [
      { path: LLM_GGUF_URL, required: false },
      { path: LLM_MMPROJ_URL, required: false },
    ],
  },
];

/** Presence result for a single packaged file. */
export interface FilePresence {
  path: string;
  required: boolean;
  present: boolean;
}

/** Readiness result for a single packaged model. */
export interface ModelReadiness {
  id: string;
  label: string;
  kind: PackagedModelKind;
  /** True when every REQUIRED file for the model is present. */
  ready: boolean;
  files: FilePresence[];
}

/** Aggregate readiness across all packaged models. */
export interface PackagedModelsReport {
  /** True when every model's required files are present. */
  allReady: boolean;
  models: ModelReadiness[];
  /** Required files that are missing, for a concise "what to fix" message. */
  missing: string[];
}

/**
 * A minimal fetcher signature so this is testable without a real network.
 * Defaults to the global `fetch`.
 */
export type HeadFetcher = (path: string) => Promise<{ ok: boolean }>;

/**
 * Probe whether a packaged file exists, same-origin, without downloading it.
 *
 * We use a `HEAD` request (range-limited fallback not needed for static hosts).
 * A network error or non-2xx response counts as "not present" — for an offline
 * static archive a missing file reliably 404s.
 */
async function probe(path: string, fetcher: HeadFetcher): Promise<boolean> {
  try {
    const res = await fetcher(path);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Verify that all packaged models are present in the served build.
 *
 * This does NOT load any weights — it only checks presence so the UI can render
 * a "ready vs missing" gate. Safe to call on startup.
 *
 * @param fetcher Optional fetch override (used in tests).
 * @param models  Optional model set override (used in tests / future phases).
 */
export async function checkPackagedModels(
  fetcher: HeadFetcher = (p) => fetch(p, { method: 'HEAD' }),
  models: PackagedModel[] = PACKAGED_MODELS
): Promise<PackagedModelsReport> {
  const results: ModelReadiness[] = await Promise.all(
    models.map(async (model) => {
      const files: FilePresence[] = await Promise.all(
        model.files.map(async (f) => ({
          path: f.path,
          required: f.required,
          present: await probe(f.path, fetcher),
        }))
      );
      const ready = files.filter((f) => f.required).every((f) => f.present);
      return { id: model.id, label: model.label, kind: model.kind, ready, files };
    })
  );

  const missing = results
    .flatMap((m) => m.files)
    .filter((f) => f.required && !f.present)
    .map((f) => f.path);

  return {
    allReady: results.every((m) => m.ready),
    models: results,
    missing,
  };
}
