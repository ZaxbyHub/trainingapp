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
 * Returns device memory from navigator.deviceMemory API
 * Falls back to 4GB conservative default for browsers without support (Firefox, Safari)
 */
export function getDeviceMemory(): number {
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory === 'number' && deviceMemory > 0) {
    return deviceMemory;
  }
  return 4;
}

/**
 * Estimates available memory budget after accounting for browser overhead
 * Browser overhead varies by browser family
 */
export function getMemoryBudget(): MemoryBudget {
  const totalMB = getDeviceMemory() * 1024;

  const userAgent = navigator.userAgent;
  const isFirefox = /Firefox/i.test(userAgent);
  const browserOverheadMB = isFirefox ? 2560 : 2048;

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
