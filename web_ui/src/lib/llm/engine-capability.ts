/**
 * Engine capability detection + recommendation.
 *
 * The two browser engines have very different hardware needs:
 *   - WebLLM  → requires usable WebGPU (fails hard without it).
 *   - wllama  → CPU/WASM; benefits from cross-origin isolation (threads) but works
 *               without WebGPU. Multimodal-capable.
 *
 * On the target hardware (12th-gen i5 + Iris Xe) WebGPU is often unavailable, so a
 * naive "WebGPU required" gate would wrongly block all browser inference. This
 * module detects real capabilities and recommends an engine + mode, with a simple
 * green/yellow/red suitability tier the UI can show.
 */

import type { BrowserEngine } from '../../types/llm';
import { getMemoryBudget } from '../embeddings/memory-aware';

export type CapabilityTier = 'green' | 'yellow' | 'red';
export type MemoryTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface EngineCapability {
  /** A usable WebGPU adapter is available (required by WebLLM). */
  webgpu: boolean;
  /** Cross-origin isolated → SharedArrayBuffer/threads available (wllama multi-thread). */
  crossOriginIsolated: boolean;
  /** WebAssembly is available (required by wllama and ORT). */
  wasm: boolean;
  /** Best-effort available memory in MB (after browser overhead). */
  availableMB: number;
  /** Coarse memory classification. */
  memoryTier: MemoryTier;
  /** Logical CPU cores (navigator.hardwareConcurrency). */
  cores: number;
  /** Engine we recommend given the detected capabilities. */
  recommendedEngine: BrowserEngine;
  /** Inference mode we recommend (browser-local vs server api). */
  recommendedMode: 'browser-local' | 'api';
  /** Overall browser-inference suitability for this device. */
  tier: CapabilityTier;
  /** Human-readable reasons backing the recommendation. */
  reasons: string[];
}

function memoryTierFor(availableMB: number): MemoryTier {
  if (availableMB >= 8192) return 'HIGH';
  if (availableMB >= 4096) return 'MEDIUM';
  return 'LOW';
}

/** Live WebGPU adapter probe (more reliable than feature-presence alone). */
async function probeWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function isCrossOriginIsolated(): boolean {
  // crossOriginIsolated is the canonical signal for SharedArrayBuffer/threads.
  if (typeof globalThis !== 'undefined' && typeof globalThis.crossOriginIsolated === 'boolean') {
    return globalThis.crossOriginIsolated;
  }
  return typeof SharedArrayBuffer !== 'undefined';
}

/**
 * Detect capabilities and compute an engine/mode recommendation + tier.
 *
 * Recommendation logic (deliberately simple and explainable):
 *   - No WASM at all                       → red, recommend server (api).
 *   - WebGPU available                     → WebLLM is the fast path (green),
 *                                            but note wllama for multimodal.
 *   - No WebGPU, WASM + threads + ≥MEDIUM  → wllama, green.
 *   - No WebGPU, WASM but no threads or LOW → wllama, yellow (works, slower).
 */
export async function detectEngineCapability(): Promise<EngineCapability> {
  const wasm = typeof WebAssembly !== 'undefined';
  const webgpu = await probeWebGPU();
  const coi = isCrossOriginIsolated();
  const { availableMB } = getMemoryBudget();
  const memoryTier = memoryTierFor(availableMB);
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 0;

  const reasons: string[] = [];
  let recommendedEngine: BrowserEngine;
  let recommendedMode: 'browser-local' | 'api';
  let tier: CapabilityTier;

  if (!wasm) {
    recommendedEngine = 'wllama';
    recommendedMode = 'api';
    tier = 'red';
    reasons.push('WebAssembly is unavailable; browser inference is not supported — use server mode.');
  } else if (webgpu) {
    recommendedEngine = 'webllm';
    recommendedMode = 'browser-local';
    tier = 'green';
    reasons.push('WebGPU is available — WebLLM offers the fastest local inference.');
    reasons.push('Switch to wllama if you need image/screenshot input (multimodal).');
  } else {
    // No WebGPU → wllama is the only viable browser engine.
    recommendedEngine = 'wllama';
    recommendedMode = 'browser-local';
    reasons.push('WebGPU is unavailable — wllama runs on the CPU and is recommended.');
    if (coi && memoryTier !== 'LOW') {
      tier = 'green';
      reasons.push('Multi-threading is enabled and memory is sufficient.');
    } else {
      tier = 'yellow';
      if (!coi) {
        reasons.push('Cross-origin isolation is off; wllama runs single-threaded (slower).');
      }
      if (memoryTier === 'LOW') {
        reasons.push('Low available memory; consider a smaller model or server mode.');
      }
    }
  }

  return {
    webgpu,
    crossOriginIsolated: coi,
    wasm,
    availableMB,
    memoryTier,
    cores,
    recommendedEngine,
    recommendedMode,
    tier,
    reasons,
  };
}
