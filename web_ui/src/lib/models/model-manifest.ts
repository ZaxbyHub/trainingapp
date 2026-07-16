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

import { probeAsset } from './probe';

/**
 * Resolve the deploy-relative base (`import.meta.env.BASE_URL`, `'./'` by
 * default per `vite.config.ts`) into an ABSOLUTE same-origin pathname prefix.
 *
 * Why absolute, not relative: Transformers.js sets `env.localModelPath` to this
 * value and `fetch`es against it, and wllama's GGUF/mmproj URLs are derived from
 * it. A relative value like `./models` would resolve against the CURRENT client
 * route (e.g. under `/app/chat/` it would fetch `/app/chat/models/...` — wrong).
 * Resolving against `document.baseURI` yields the HTML document's deploy root, so
 * `/training/` deployments produce `/training/models` while origin-root stays
 * `/models` — identical to the old hardcoded behavior at root, correct everywhere
 * else. `document.baseURI` is stable across client-side routing.
 */
function resolveAbsoluteBase(): string {
  const baseUrl = import.meta.env.BASE_URL;
  try {
    // `document.baseURI` is the document's URL (the HTML location), unaffected by
    // client-side route changes. `new URL(baseUrl, document.baseURI).pathname`
    // normalizes './' → '/' at origin root, './' → '/training/' under a subpath.
    const resolved = new URL(baseUrl, document.baseURI).pathname;
    // Ensure exactly one leading slash, no trailing slash, so `${MODELS_BASE}/x`
    // joins cleanly.
    return `/${resolved.replace(/^\/+|\/+$/g, '')}`;
  } catch {
    // `document` is undefined in non-browser contexts (e.g. tests that import
    // this module without a jsdom env). Fall back to the historical absolute path.
    return '/';
  }
}

/**
 * Absolute same-origin base under which all packaged models live. Also the value
 * of Transformers.js `env.localModelPath`, so every model is addressed by a path
 * RELATIVE to it (e.g. `embeddings/bge-small-en-v1.5`).
 */
export const MODELS_BASE = `${resolveAbsoluteBase()}/models`.replace(/\/+/g, '/');

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

/** Packaged browser LLM: LFM2.5-VL-450M (vision-language) for wllama. */
export const LLM_MODEL_DIR = 'lfm2.5-vl-450m';
/**
 * GGUF weights URL passed to wllama `loadModelFromUrl`. LFM2.5-VL-450M Q4_K_M is
 * ~229 MB — well under wllama's 2 GB/file limit, so a single unsplit file is used.
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
 * Packaging group a model belongs to. Mirrors the `group` field in
 * `public/models/manifest.json` and drives both `validate-build.mjs` (which
 * group to enforce / skip) and the runtime readiness gate (which groups the
 * operator intentionally excluded for this build — see
 * {@link EXCLUDED_MODEL_GROUPS}).
 */
export type PackagedModelGroup = 'core' | 'optional' | 'llm';

/**
 * Declarative description of one packaged model and the files it needs.
 */
export interface PackagedModel {
  /** Stable id used in code and readiness reporting. */
  id: string;
  /** Human-readable name for the UI. */
  label: string;
  kind: PackagedModelKind;
  /** Packaging group — drives validation + runtime exclusion (see {@link EXCLUDED_MODEL_GROUPS}). */
  group: PackagedModelGroup;
  files: PackagedModelFile[];
}

/**
 * Shape of `public/models/manifest.json` — the single source of truth for what
 * must be packaged. Paths there are RELATIVE to the models dir; we prefix them
 * with the deploy-aware absolute {@link MODELS_BASE} when building
 * {@link PACKAGED_MODELS}. The same JSON is read by `scripts/validate-build.mjs`
 * to gate the produced dist/, so the TS and the build validator cannot drift.
 */
interface ManifestFile {
  path: string;
  required: boolean;
}
interface ManifestModel {
  id: string;
  label: string;
  kind: PackagedModelKind;
  group: 'core' | 'optional' | 'llm';
  files: ManifestFile[];
}
interface Manifest {
  version: string;
  models: ManifestModel[];
}

// Imported at build/runtime via Vite's native JSON support (resolveJsonModule).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- JSON modules are resolved by Vite; the resolved shape is typed as Manifest below.
import packagedManifestSource from '../../../public/models/manifest.json';
const packagedManifest = packagedManifestSource as Manifest;

/**
 * Packaging groups the operator intentionally EXCLUDED from this build, so the
 * runtime readiness gate does not report them as missing. Set at build time via
 * the `VITE_EXCLUDE_MODEL_GROUPS` env var (a comma-separated list of group
 * names from `manifest.json`). For example, an embeddings-only / server-mode
 * archive built with `validate-build --no-llm` sets `VITE_EXCLUDE_MODEL_GROUPS=llm`
 * so `checkPackagedModels()` does not flag the (deliberately absent) browser-LLM
 * runtime + weights as missing — which would otherwise leave the UI permanently
 * showing "models not ready" on a valid, intentional configuration.
 *
 * `prepare-models --no-llm` writes this value into the build env automatically.
 */
export const EXCLUDED_MODEL_GROUPS: ReadonlySet<PackagedModelGroup> = new Set(
  ((import.meta.env.VITE_EXCLUDE_MODEL_GROUPS as string | undefined) ?? '')
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter((g): g is PackagedModelGroup => g === 'core' || g === 'optional' || g === 'llm')
);

/**
 * The full packaged-model set, derived from `public/models/manifest.json` (the
 * single source of truth) with each relative path prefixed by the deploy-aware
 * absolute {@link MODELS_BASE}. Group tags (`core` / `optional` / `llm`) drive
 * packaging validation (see scripts/validate-build.mjs `--no-llm`) and the
 * runtime exclusion set ({@link EXCLUDED_MODEL_GROUPS}).
 */
export const PACKAGED_MODELS: PackagedModel[] = packagedManifest.models.map((m) => ({
  id: m.id,
  label: m.label,
  kind: m.kind,
  group: m.group,
  files: m.files.map((f) => ({
    path: `${MODELS_BASE}/${f.path}`.replace(/\/+/g, '/'),
    required: f.required,
  })),
}));

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
  group: PackagedModelGroup;
  /**
   * True when the model is ready to use: either every REQUIRED file is present,
   * OR the model's group was intentionally excluded for this build
   * ({@link EXCLUDED_MODEL_GROUPS}, e.g. the `llm` group on a `--no-llm` build).
   */
  ready: boolean;
  /**
   * True when the model's group was intentionally excluded from this build, so
   * `ready: true` reflects "not applicable" rather than "files present." The UI
   * can use this to show the model as absent-but-expected instead of missing.
   */
  excluded: boolean;
  files: FilePresence[];
}

/** Aggregate readiness across all packaged models. */
export interface PackagedModelsReport {
  /**
   * True when every model is ready: either its required files are present, OR
   * its group was intentionally excluded for this build ({@link EXCLUDED_MODEL_GROUPS}).
   */
  allReady: boolean;
  models: ModelReadiness[];
  /** Required files that are missing, for a concise "what to fix" message. */
  missing: string[];
}

/**
 * A minimal fetcher signature so this is testable without a real network.
 * Defaults to the global `fetch`. Carries an optional `contentType` so the
 * probe can reject SPA-fallback HTML responses (see {@link probeAsset}).
 */
export type HeadFetcher = (path: string) => Promise<{
  ok: boolean;
  contentType?: string | null;
}>;

/**
 * Probe whether a packaged file exists, same-origin, without downloading it.
 *
 * Delegates to {@link probeAsset}, which treats HTTP 200 + `Content-Type:
 * text/html` as "not present" — that is the SPA-fallback signature (Vite
 * dev/preview serve `index.html` with HTTP 200 for any unmatched path). A
 * network error or non-2xx response also counts as "not present". Real model
 * files (`.onnx`, `.wasm`, `.gguf`, `.json`) are never served as HTML.
 */
async function probe(path: string, fetcher: HeadFetcher): Promise<boolean> {
  return probeAsset(path, fetcher);
}

/**
 * Verify that all packaged models are present in the served build.
 *
 * This does NOT load any weights — it only checks presence so the UI can render
 * a "ready vs missing" gate. Safe to call on startup.
 *
 * Models whose `group` is in {@link EXCLUDED_MODEL_GROUPS} (e.g. the `llm`
 * group on a `--no-llm` embeddings-only build) are reported `ready: true` with
 * `excluded: true` and their files are NOT probed or counted as missing — so a
 * valid, intentional configuration is not flagged as broken.
 *
 * @param fetcher       Optional fetch override (used in tests).
 * @param models        Optional model set override (used in tests / future phases).
 * @param excludedGroups Optional override of the excluded-group set (used in tests).
 */
export async function checkPackagedModels(
  fetcher: HeadFetcher = async (p) => {
    const res = await fetch(p, { method: 'HEAD' });
    return { ok: res.ok, contentType: res.headers.get('content-type') };
  },
  models: PackagedModel[] = PACKAGED_MODELS,
  excludedGroups: ReadonlySet<PackagedModelGroup> = EXCLUDED_MODEL_GROUPS
): Promise<PackagedModelsReport> {
  const results: ModelReadiness[] = await Promise.all(
    models.map(async (model) => {
      const isExcluded = excludedGroups.has(model.group);
      // An excluded model's files are intentionally absent; don't probe them
      // (avoids both wasted requests and false "missing" entries).
      const files: FilePresence[] = isExcluded
        ? model.files.map((f) => ({ path: f.path, required: f.required, present: false }))
        : await Promise.all(
            model.files.map(async (f) => ({
              path: f.path,
              required: f.required,
              present: await probe(f.path, fetcher),
            }))
          );
      // Excluded models are "ready" (not applicable), not missing.
      const ready = isExcluded || files.filter((f) => f.required).every((f) => f.present);
      return {
        id: model.id,
        label: model.label,
        kind: model.kind,
        group: model.group,
        ready,
        excluded: isExcluded,
        files,
      };
    })
  );

  const missing = results
    .filter((m) => !m.excluded)
    .flatMap((m) => m.files)
    .filter((f) => f.required && !f.present)
    .map((f) => f.path);

  return {
    allReady: results.every((m) => m.ready),
    models: results,
    missing,
  };
}
