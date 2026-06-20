/**
 * Tests for engine capability detection + recommendation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Control the memory budget the detector reads.
let mockAvailableMB = 8192;
vi.mock('../embeddings/memory-aware', () => ({
  getMemoryBudget: () => ({ totalMB: 16384, availableMB: mockAvailableMB, browserOverheadMB: 2048 }),
}));

import { detectEngineCapability } from './engine-capability';

/** Configure the environment a detection run sees. */
function setEnv(opts: {
  webgpuAdapter?: 'ok' | 'null' | 'throw' | 'absent';
  coi?: boolean;
  availableMB?: number;
}) {
  mockAvailableMB = opts.availableMB ?? 8192;

  if (opts.webgpuAdapter === 'absent') {
    (navigator as unknown as { gpu?: unknown }).gpu = undefined;
  } else {
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn(async () => {
        if (opts.webgpuAdapter === 'throw') throw new Error('no adapter');
        return opts.webgpuAdapter === 'ok' ? {} : null;
      }),
    };
  }

  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    value: opts.coi ?? true,
    configurable: true,
  });
}

describe('detectEngineCapability', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('recommends WebLLM (green) when WebGPU is available', async () => {
    setEnv({ webgpuAdapter: 'ok', coi: true, availableMB: 8192 });
    const cap = await detectEngineCapability();
    expect(cap.webgpu).toBe(true);
    expect(cap.recommendedEngine).toBe('webllm');
    expect(cap.recommendedMode).toBe('browser-local');
    expect(cap.tier).toBe('green');
    // Should still hint that wllama covers multimodal.
    expect(cap.reasons.join(' ')).toMatch(/multimodal|image/i);
  });

  it('recommends wllama (green) without WebGPU when threads + memory are good', async () => {
    setEnv({ webgpuAdapter: 'null', coi: true, availableMB: 8192 });
    const cap = await detectEngineCapability();
    expect(cap.webgpu).toBe(false);
    expect(cap.recommendedEngine).toBe('wllama');
    expect(cap.tier).toBe('green');
    expect(cap.memoryTier).toBe('HIGH');
  });

  it('falls to yellow when wllama lacks cross-origin isolation', async () => {
    setEnv({ webgpuAdapter: 'absent', coi: false, availableMB: 8192 });
    const cap = await detectEngineCapability();
    expect(cap.recommendedEngine).toBe('wllama');
    expect(cap.crossOriginIsolated).toBe(false);
    expect(cap.tier).toBe('yellow');
    expect(cap.reasons.join(' ')).toMatch(/single-threaded/i);
  });

  it('falls to yellow on low memory even with threads', async () => {
    setEnv({ webgpuAdapter: 'null', coi: true, availableMB: 2048 });
    const cap = await detectEngineCapability();
    expect(cap.memoryTier).toBe('LOW');
    expect(cap.tier).toBe('yellow');
  });

  it('treats a throwing requestAdapter as no WebGPU', async () => {
    setEnv({ webgpuAdapter: 'throw', coi: true, availableMB: 8192 });
    const cap = await detectEngineCapability();
    expect(cap.webgpu).toBe(false);
    expect(cap.recommendedEngine).toBe('wllama');
  });

  it('classifies memory tiers at the documented thresholds', async () => {
    setEnv({ webgpuAdapter: 'null', coi: true, availableMB: 4096 });
    expect((await detectEngineCapability()).memoryTier).toBe('MEDIUM');
    setEnv({ webgpuAdapter: 'null', coi: true, availableMB: 4095 });
    expect((await detectEngineCapability()).memoryTier).toBe('LOW');
  });
});
