/**
 * Model Readiness Gate — pre-flight checks before browser-mode LLM inference.
 *
 * FR-014: Memory-aware model selection
 * FR-015: Graceful degradation
 *
 * Runs three independent checks:
 *   1. WebGPU availability  (hard requirement — no WebGPU = must use server mode)
 *   2. Memory sufficiency   (hard requirement — insufficient RAM = must use server mode)
 *   3. Model cache status  (soft requirement — uncached model triggers download, not failure)
 *
 * WebGPU and memory checks (async)
 */

import { getMemoryBudget } from '../embeddings/memory-aware';
import { WebLLMService, WEBLLM_DEFAULT_MODEL_ID } from './web-llm-service';
import { LLM_GGUF_URL, LLM_MMPROJ_URL } from '../models/model-manifest';
import { probeAsset } from '../models/probe';
import type { BrowserEngine } from '../../types/llm';

/**
 * Memory tier classification based on available RAM.
 * Correlates with embedding-model tier selection in memory-aware.ts.
 */
export type MemoryTier = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Memory check result — describes available vs. required memory for a model.
 */
export interface MemoryCheck {
  /** Bytes of RAM currently available to the browser (after overhead). */
  availableBytes: number;
  /** Minimum bytes required to run the target model (weights + working memory). */
  requiredBytes: number;
  /** True when availableBytes >= requiredBytes. */
  sufficient: boolean;
  /** Memory tier classification. */
  tier: MemoryTier;
}

/**
 * Individual check results bundled into ReadinessResult.
 */
export interface ReadinessChecks {
  webgpu: boolean;
  memory: MemoryCheck;
  modelCached: boolean;
}

/**
 * Full pre-flight result returned by ModelReadinessGate.checkReadiness().
 */
export interface ReadinessResult {
  /** True when all hard requirements (webgpu + memory) are met. */
  ready: boolean;
  /** Detailed results for each individual check. */
  checks: ReadinessChecks;
  /** List of hard failures — any non-empty list means ready === false. */
  failures: string[];
  /** Actionable suggestions to resolve failures or improve the experience. */
  recommendations: string[];
}

/**
 * Per-model memory requirements (weights + working memory).
 * Keep sized to the ACTUAL model being loaded, not a one-size-fits-all default,
 * so the gate doesn't false-block a small model (issue #21 F4).
 */
const MODEL_REQUIRED_BYTES: Record<string, number> = {
  // Llama-3.2-3B (WebLLM): ~1.9 GB weights + ~300 MB working ≈ 2.3 GB.
  'Llama-3.2-3B-Instruct-q4f16_1-MLC': 2_300_000_000,
  // LFM2.5-VL-450M Q4_K_M (wllama): ~229 MB GGUF + ~99 MB mmproj + ~270 MB WASM/ctx.
  'lfm2.5-vl-450m': 600_000_000,
};

/**
 * Returns the minimum required memory in bytes for a given model ID.
 * Falls back to 2 GB for unknown models.
 */
function getRequiredBytes(modelId: string): number {
  return MODEL_REQUIRED_BYTES[modelId] ?? 2_000_000_000;
}

/**
 * Maps available memory MB to a MemoryTier.
 * Thresholds mirror selectModelTier() in memory-aware.ts.
 */
function getMemoryTier(availableMB: number): MemoryTier {
  if (availableMB >= 8192) return 'HIGH';
  if (availableMB >= 4096) return 'MEDIUM';
  return 'LOW';
}

/**
 * Engine-aware "is the model available for use" check.
 *
 * The two engines have different notions of availability:
 *   - webllm: the model must be DOWNLOADED into the browser's Cache Storage
 *     (`caches.open('webllm/model')`, web-llm's default cacheType). Until then
 *     the user must trigger a download.
 *   - wllama: there is no separate download step — the GGUF is packaged and loads
 *     lazily on first use. "Available" therefore means the packaged GGUF is present
 *     in the build (same-origin), probed without downloading it.
 *
 * @returns true if the model is available for the given engine.
 */
async function isModelAvailable(modelId: string, engine: BrowserEngine): Promise<boolean> {
  if (engine === 'wllama') {
    // wllama loads the packaged GGUF + mmproj projector lazily; "available"
    // requires BOTH present. The mmproj must be checked too, otherwise the
    // multimodal (image) path is gated ready while the projector is missing.
    // `probeAsset` rejects the SPA-fallback HTML 200 (see src/lib/models/probe.ts);
    // a bare `fetch(...).ok` would falsely report present under vite dev/preview.
    const [gguf, mmproj] = await Promise.all([
      probeAsset(LLM_GGUF_URL),
      probeAsset(LLM_MMPROJ_URL),
    ]);
    return gguf && mmproj;
  }
  // webllm: present in the browser's Cache Storage (web-llm's default
  // cacheType 'cache' stores weights in `caches.open('webllm/model')`). Probe
  // the Cache Storage API for a cross-session check (a prior session's download
  // persists), and fall back to the in-memory _modelInfo (populated once
  // initialize() runs this session). (issue #21 F3)
  try {
    const info = WebLLMService.getInstance().getModelInfo();
    if (info && info.modelId === modelId && info.cached) return true;
  } catch {
    // ignore — fall through to cache probe
  }
  // Cache Storage persistence probe: web-llm caches model artifacts under the
  // 'webllm' cache. If the Cache Storage API is unavailable, fall back to false
  // (the first send's initialize() will populate _modelInfo and a subsequent
  // gate check passes — see issue #21 F1).
  if (typeof caches !== 'undefined' && typeof caches.has === 'function') {
    try {
      const hasWebllmCache = await caches.has('webllm/model');
      if (hasWebllmCache) {
        // Confirm the cache actually contains entries for THIS model id, so an
        // orphaned/partial cache from a different model doesn't false-positive.
        const cache = await caches.open('webllm/model');
        const keys = await cache.keys();
        if (keys.some((req) => req.url.includes(modelId))) return true;
      }
    } catch {
      // Cache Storage unavailable or denied — fall back below.
    }
  }
  return false;
}

/**
 * ModelReadinessGate — pre-flight checker for browser-mode LLM inference.
 *
 * Usage:
 *   const gate = new ModelReadinessGate();
 *   const result = await gate.checkReadiness('Llama-3.2-3B-Instruct-q4f16_1-MLC');
 *   if (!result.ready) {
 *     // Show failures + recommendations to user
 *   }
 */
export class ModelReadinessGate {
  /**
   * Asynchronously checks whether WebGPU is available in the current browser.
   *
   * Checks navigator.gpu first (fast), then attempts a requestAdapter()
   * to confirm the adapter is non-null (more thorough).
   *
   * Note: This does a live adapter request each call. The result is not cached
   * because WebGPU availability can change if a discrete GPU is hot-plugged or
   * if a browser tab gains/loses GPU access.
   */
  async checkWebGPU(): Promise<boolean> {
    // Cast to allow access to the WebGPU API which is not yet in standard TS lib
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) {
      return false;
    }

    if (typeof gpu.requestAdapter !== 'function') {
      return false;
    }

    try {
      const adapter = await gpu.requestAdapter();
      return adapter !== null;
    } catch {
      return false;
    }
  }

  /**
   * Checks whether the browser has sufficient memory to run the target model.
   *
   * Uses navigator.deviceMemory (with conservative fallback) and accounts for
   * browser overhead via getMemoryBudget().
   *
   * @param modelId The model identifier to check memory requirements for.
   *                Defaults to WEBLLM_DEFAULT_MODEL_ID if not provided.
   * @param requiredBytes Optional override for the required memory threshold.
   *                      Defaults to model-specific requirement from getRequiredBytes().
   */
  checkMemory(modelId: string = WEBLLM_DEFAULT_MODEL_ID, requiredBytes?: number): MemoryCheck {
    const { availableMB } = getMemoryBudget();
    const availableBytes = Math.floor(availableMB * 1024 * 1024);
    const required = requiredBytes ?? getRequiredBytes(modelId);
    const sufficient = availableBytes >= required;

    return {
      availableBytes,
      requiredBytes: required,
      sufficient,
      tier: getMemoryTier(availableMB),
    };
  }

  /**
   * Checks whether the model artifact is already present in the browser's Cache
   * Storage (webllm) or the packaged build (wllama).
   *
   * Returns true if the model is cached and ready to load without a download.
   * Returns false if the model is not cached and must be downloaded first.
   *
   * @param modelId The model identifier to check.
   * @param engine  Which engine's availability semantics to use (default 'webllm').
   */
  async checkModelCached(modelId: string, engine: BrowserEngine = 'webllm'): Promise<boolean> {
    return isModelAvailable(modelId, engine);
  }

  /**
   * Runs the pre-flight checks and returns a combined ReadinessResult.
   *
   * Engine-aware: WebGPU is a HARD requirement only for the WebLLM engine. The
   * wllama engine runs on CPU/WASM, so for `engine === 'wllama'` a missing WebGPU
   * is NOT a failure (it is reported in checks but does not block readiness).
   *
   * Hard failures:
   *   - WebGPU unavailable        (only when engine === 'webllm')
   *   - Insufficient memory
   * Soft warnings:
   *   - Model not cached (download/availability — not a hard failure)
   *
   * @param modelId The model to check readiness for.
   * @param engine  Which browser engine the check is for (default 'webllm' to
   *                preserve existing callers' behavior).
   */
  async checkReadiness(
    modelId: string,
    engine: BrowserEngine = 'webllm'
  ): Promise<ReadinessResult> {
    const webgpu = await this.checkWebGPU();
    const memory = this.checkMemory(modelId);
    const modelCached = await this.checkModelCached(modelId, engine);

    const failures: string[] = [];
    const recommendations: string[] = [];

    const webgpuRequired = engine === 'webllm';

    // Hard failure: WebGPU required — only for the WebLLM (WebGPU) engine.
    if (webgpuRequired && !webgpu) {
      failures.push('WebGPU is not available in this browser.');
      recommendations.push(
        'Switch to the wllama engine (runs on CPU, no WebGPU) or use server API mode.'
      );
    } else if (!webgpuRequired && !webgpu) {
      // Informational only for wllama — it does not need WebGPU.
      recommendations.push(
        'WebGPU is unavailable, but the wllama engine runs on the CPU and does not require it.'
      );
    }

    // Hard failure: memory insufficient
    if (!memory.sufficient) {
      const availableGB = (memory.availableBytes / 1024 / 1024 / 1024).toFixed(1);
      const requiredGB = (memory.requiredBytes / 1024 / 1024 / 1024).toFixed(1);
      failures.push(
        `Insufficient memory: ${availableGB} GB available, ${requiredGB} GB required for ${modelId}.`
      );
      recommendations.push(
        `Use a smaller model that fits within ${availableGB} GB of available memory, ` +
        'or switch to server API mode for memory-intensive inference.'
      );
    }

    // Soft warning: model not cached — engine-aware messaging.
    // wllama weights are packaged same-origin and loaded on first use, NOT
    // downloaded from the internet. webllm weights ARE fetched from a CDN
    // into Cache Storage on first use.
    if (!modelCached) {
      if (webgpuRequired) {
        recommendations.push(
          `Model "${modelId}" is not in the browser cache. A download (~2 GB) ` +
          'from the WebLLM CDN will be required before first inference. ' +
          'Ensure a stable internet connection.'
        );
      } else {
        recommendations.push(
          `The browser model files ("${modelId}") were not found in this build. ` +
          'Run "npm run prepare-models" to stage the packaged weights, ' +
          'or rebuild with --no-llm for a server-mode-only archive.'
        );
      }
    }

    const ready = (!webgpuRequired || webgpu) && memory.sufficient;

    return {
      ready,
      checks: {
        webgpu,
        memory,
        modelCached,
      },
      failures,
      recommendations,
    };
  }
}
