/**
 * Memory-aware model selection utilities
 * Detects available device memory and selects appropriate embedding model configuration
 */

export interface MemoryBudget {
  totalMB: number;
  availableMB: number;
  browserOverheadMB: number;
}

export interface ModelTierConfig {
  embeddingModel: string;
  embeddingDimension: number;
  rerankingEnabled: boolean;
  maxChunkCount: number;
}

export type MemoryPressureStatus = 'normal' | 'moderate' | 'critical';

/**
 * Returns device memory from navigator.deviceMemory API.
 *
 * Falls back to 8GB (the Chrome privacy cap) for browsers that don't expose
 * navigator.deviceMemory (Firefox, Safari). This is intentional: returning a
 * low conservative value caused the memory budget arithmetic to subtract
 * browser overhead down below the model requirement, hard-blocking the CPU
 * wllama engine — the engine that exists precisely for WebGPU-less / memory
 * constrained machines. Treating unknown as high-capacity waives the overhead
 * subtraction (see getMemoryBudget's isHighCapacity branch) and lets the model
 * gate decide on its own merits instead of false-blocking on unknown hardware.
 * (issue #21 F4)
 */
export function getDeviceMemory(): number {
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory === 'number' && deviceMemory > 0) {
    return deviceMemory;
  }
  return 8;
}

/**
 * Estimates available memory budget after accounting for browser overhead
 * Browser overhead varies by browser family
 *
 * Note: navigator.deviceMemory caps at 8GB for privacy in Chrome.
 * When raw value >= 8, we waive overhead subtraction because actual
 * RAM on such systems is far higher (typically 16GB+).
 */
export function getMemoryBudget(): MemoryBudget {
  const rawGD = getDeviceMemory();
  const totalMB = rawGD * 1024;

  const userAgent = navigator.userAgent;
  const isFirefox = /Firefox/i.test(userAgent);
  // navigator.deviceMemory caps at 8GB for privacy. Waive overhead when
  // at the cap — the actual RAM on such systems is far higher.
  const isHighCapacity = rawGD >= 8;
  const browserOverheadMB = isHighCapacity ? 0 : (isFirefox ? 2560 : 2048);

  const availableMB = Math.max(0, totalMB - browserOverheadMB);

  return {
    totalMB,
    availableMB,
    browserOverheadMB,
  };
}

/**
 * Selects appropriate model tier configuration based on available memory
 */
export function selectModelTier(memoryMB: number): ModelTierConfig {
  if (memoryMB >= 8192) {
    return {
      embeddingModel: 'bge-small-en-v1.5',
      embeddingDimension: 384,
      rerankingEnabled: true,
      maxChunkCount: 10000,
    };
  }

  if (memoryMB >= 4096) {
    return {
      embeddingModel: 'bge-small-en-v1.5',
      embeddingDimension: 384,
      rerankingEnabled: false,
      maxChunkCount: 5000,
    };
  }

  return {
    embeddingModel: 'bge-small-en-v1.5',
    embeddingDimension: 384,
    rerankingEnabled: false,
    maxChunkCount: 1000,
  };
}

/**
 * Determines current memory pressure level based on available memory
 */
export function getMemoryPressureStatus(): MemoryPressureStatus {
  const { availableMB } = getMemoryBudget();

  if (availableMB >= 8192) {
    return 'normal';
  }

  if (availableMB >= 4096) {
    return 'moderate';
  }

  return 'critical';
}

/**
 * Formats a human-readable memory indicator string
 */
export function formatMemoryIndicator(
  status: MemoryPressureStatus,
  budget: MemoryBudget
): string {
  const availableGB = (budget.availableMB / 1024).toFixed(1);

  switch (status) {
    case 'normal':
      return `Memory: ${availableGB}GB available — Full feature set enabled`;
    case 'moderate':
      return `Memory: ${availableGB}GB available — Reduced mode (reranking disabled)`;
    case 'critical':
      return `Memory: ${availableGB}GB available — Minimal mode (reduced chunk limit)`;
  }
}
