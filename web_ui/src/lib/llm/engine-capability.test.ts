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

  it('recommends WebLLM (green) when WebGPU is available and WebLLM is visible', async () => {
    setEnv({ webgpuAdapter: 'ok', coi: true, availableMB: 8192 });
    const cap = await detectEngineCapability();
    expect(cap.webgpu).toBe(true);
    expect(cap.recommendedEngine).toBe('webllm');
    expect(cap.recommendedMode).toBe('browser-local');
    expect(cap.tier).toBe('green');
    // #265 (AC2/A2): truthful copy — the LFM2 model is text-only; the old
    // "multimodal" hint was false and is gone.
    expect(cap.reasons.join(' ')).toMatch(/bundled LFM2/i);
    expect(cap.reasons.join(' ')).not.toMatch(/multimodal|image/i);
  });

  it('recommends wllama (green) on WebGPU hardware when WebLLM is hidden (#265 A3-iv)', async () => {
    // Packaged/offline builds hide WebLLM; the recommendation is computed
    // among visible engines only, while the raw webgpu result is retained.
    vi.doMock('./engine-visibility', () => ({ WEBLLM_VISIBLE: false }));
    vi.resetModules();
    const { detectEngineCapability: detectHidden } = await import('./engine-capability');
    setEnv({ webgpuAdapter: 'ok', coi: true, availableMB: 8192 });
    const cap = await detectHidden();
    expect(cap.webgpu).toBe(true);
    expect(cap.recommendedEngine).toBe('wllama');
    expect(cap.recommendedMode).toBe('browser-local');
    expect(cap.tier).toBe('green');
    expect(cap.reasons.join(' ')).toMatch(/wllama can run the bundled model/i);
    vi.doUnmock('./engine-visibility');
    vi.resetModules();
  });

  it('INT-1: on Firefox without JSPI the hidden-mode reason tells the CPU/WASM truth, not a wllama WebGPU claim', async () => {
    // navigator.gpu exists and requestAdapter succeeds (the raw webgpu probe
    // is true), but wllama itself disables WebGPU on Firefox without JSPI —
    // the recommendation copy must not claim wllama will use WebGPU there.
    const savedUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
      configurable: true,
    });
    try {
      vi.doMock('./engine-visibility', () => ({ WEBLLM_VISIBLE: false }));
      vi.resetModules();
      const { detectEngineCapability: detectHidden } = await import('./engine-capability');
      setEnv({ webgpuAdapter: 'ok', coi: true, availableMB: 8192 });
      const cap = await detectHidden();
      // The RAW hardware result is still true...
      expect(cap.webgpu).toBe(true);
      expect(cap.recommendedEngine).toBe('wllama');
      expect(cap.tier).toBe('green');
      // ...but the reason names the CPU/WASM reality (jsdom has no
      // WebAssembly.Suspending, so JSPI is absent: the exact carve-out).
      expect(cap.reasons).toContain('WebGPU is present, but the bundled model runs on CPU/WASM in this browser.');
      expect(cap.reasons.join(' ')).not.toMatch(/wllama can run the bundled model on it/);
    } finally {
      vi.doUnmock('./engine-visibility');
      vi.resetModules();
      Object.defineProperty(navigator, 'userAgent', { value: savedUA, configurable: true });
    }
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
