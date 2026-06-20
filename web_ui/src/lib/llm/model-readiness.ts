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
import { WebLLMService } from './web-llm-service';

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
 * Default model requirements.
 * Llama-3.2-3B-Instruct-q4f16_1-MLC: ~1.9 GB model weights + ~300 MB working memory ≈ 2.3 GB total.
 */
const MODEL_REQUIRED_BYTES: Record<string, number> = {
  'Llama-3.2-3B-Instruct-q4f16_1-MLC': 2_300_000_000,
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
 * Checks whether a model artifact is present in OPFS.
 *
 * Uses WebLLMService.getModelInfo().cached to determine cache status.
 * If the service hasn't been initialized yet, defaults to false (model not cached).
 *
 * @returns true if the model's cache directory exists in OPFS.
 */
async function isModelCachedInOPFS(modelId: string): Promise<boolean> {
  try {
    const service = WebLLMService.getInstance();
    const info = service.getModelInfo();
    // If service not initialized, default to not cached
    if (!info) {
      return false;
    }
    // WebLLMService is a singleton that tracks only one model at a time.
    // Verify the cached model matches the requested model.
    if (info.modelId !== modelId) {
      return false;
    }
    return info.cached;
  } catch {
    return false;
  }
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
   *                Defaults to Llama-3.2-3B-Instruct-q4f16_1-MLC if not provided.
   * @param requiredBytes Optional override for the required memory threshold.
   *                      Defaults to model-specific requirement from getRequiredBytes().
   */
  checkMemory(modelId: string = 'Llama-3.2-3B-Instruct-q4f16_1-MLC', requiredBytes?: number): MemoryCheck {
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
   * Checks whether the model artifact is already present in the browser's OPFS.
   *
   * Returns true if the model is cached and ready to load without a download.
   * Returns false if the model is not cached and must be downloaded first.
   *
   * @param modelId The model identifier to check.
   */
  async checkModelCached(modelId: string): Promise<boolean> {
    return isModelCachedInOPFS(modelId);
  }

  /**
   * Runs all three pre-flight checks and returns a combined ReadinessResult.
   *
   * Hard failures (any of):
   *   - WebGPU unavailable
   *   - Insufficient memory
   *
   * Soft warnings (any of):
   *   - Model not cached (download will be triggered — not a hard failure)
   *
   * @param modelId The model to check readiness for.
   */
  async checkReadiness(modelId: string): Promise<ReadinessResult> {
    const webgpu = await this.checkWebGPU();
    const memory = this.checkMemory(modelId);
    const modelCached = await this.checkModelCached(modelId);

    const failures: string[] = [];
    const recommendations: string[] = [];

    // Hard failure: WebGPU required
    if (!webgpu) {
      failures.push('WebGPU is not available in this browser.');
      recommendations.push(
        'Switch to server API mode for LLM inference — browser-mode WebGPU is required.'
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

    // Soft warning: model not cached
    if (!modelCached) {
      recommendations.push(
        `Model "${modelId}" is not cached locally. A download (~2 GB) will be required ` +
        'before first inference. Ensure stable internet connection.'
      );
    }

    const ready = webgpu && memory.sufficient;

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
