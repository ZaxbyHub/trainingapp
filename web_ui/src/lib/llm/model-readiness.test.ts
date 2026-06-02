import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelReadinessGate } from './model-readiness';
import type { MemoryTier } from './model-readiness';
import { getMemoryBudget } from '../embeddings/memory-aware';
import { WebLLMService } from './web-llm-service';

// Mock the memory-aware module
vi.mock('../embeddings/memory-aware', () => ({
  getMemoryBudget: vi.fn<() => { totalMB: number; availableMB: number; browserOverheadMB: number }>(),
}));

// Mock the WebLLMService module
vi.mock('./web-llm-service', () => ({
  WebLLMService: {
    getInstance: vi.fn<() => WebLLMService>(),
  },
}));

describe('ModelReadinessGate', () => {
  let gate: ModelReadinessGate;
  let mockGpu: { requestAdapter: () => Promise<unknown> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    gate = new ModelReadinessGate();
    mockGpu = undefined;

    // Directly set navigator properties
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        get gpu() {
          return mockGpu;
        },
        deviceMemory: 8,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkWebGPU', () => {
    test('returns false when navigator.gpu is missing', async () => {
      mockGpu = undefined;
      const result = await gate.checkWebGPU();
      expect(result).toBe(false);
    });

    test('returns false when navigator.gpu.requestAdapter is not a function', async () => {
      mockGpu = { requestAdapter: 'not a function' as unknown as () => Promise<unknown> };
      const result = await gate.checkWebGPU();
      expect(result).toBe(false);
    });

    test('returns true when adapter is available (non-null)', async () => {
      const mockAdapter = { isFallback: false };
      const requestAdapterFn = vi.fn<() => Promise<unknown>>().mockResolvedValue(mockAdapter);
      mockGpu = {
        requestAdapter: requestAdapterFn,
      };

      const result = await gate.checkWebGPU();

      expect(result).toBe(true);
      expect(requestAdapterFn).toHaveBeenCalled();
    });

    test('returns false when adapter is null', async () => {
      const requestAdapterFn = vi.fn<() => Promise<unknown>>().mockResolvedValue(null);
      mockGpu = {
        requestAdapter: requestAdapterFn,
      };

      const result = await gate.checkWebGPU();

      expect(result).toBe(false);
    });

    test('returns false when requestAdapter throws', async () => {
      const requestAdapterFn = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('WebGPU error'));
      mockGpu = {
        requestAdapter: requestAdapterFn,
      };

      const result = await gate.checkWebGPU();

      expect(result).toBe(false);
    });
  });

  describe('checkMemory', () => {
    beforeEach(() => {
      getMemoryBudget.mockReturnValue({
        totalMB: 8192,
        availableMB: 6144,
        browserOverheadMB: 2048,
      });
    });

    test('returns HIGH tier when availableMB >= 8192', () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      });

      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M');

      expect(result.tier).toBe<MemoryTier>('HIGH');
      expect(result.sufficient).toBe(true);
    });

    test('returns MEDIUM tier when availableMB >= 4096 and < 8192', () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 8192,
        availableMB: 6144,
        browserOverheadMB: 2048,
      });

      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M');

      expect(result.tier).toBe<MemoryTier>('MEDIUM');
    });

    test('returns LOW tier when availableMB < 4096', () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 4096,
        availableMB: 2048,
        browserOverheadMB: 2048,
      });

      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M');

      expect(result.tier).toBe<MemoryTier>('LOW');
    });

    test('returns sufficient=false when memory is below required threshold', () => {
      // Default requirement is 2GB = 2_000_000_000 bytes
      // Set available to 1500MB (~1.46GB)
      getMemoryBudget.mockReturnValue({
        totalMB: 4096,
        availableMB: 1500,
        browserOverheadMB: 2048,
      });

      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M');

      expect(result.sufficient).toBe(false);
      expect(result.availableBytes).toBe(1500 * 1024 * 1024);
      expect(result.requiredBytes).toBe(2_000_000_000);
    });

    test('returns sufficient=true when memory meets or exceeds requirement', () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      });

      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M');

      expect(result.sufficient).toBe(true);
    });

    test('uses custom requiredBytes when provided', () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 4096,
        availableMB: 3072, // 3GB available
        browserOverheadMB: 1024,
      });

      const customRequired = 2_000_000_000; // 2GB
      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M', customRequired);

      expect(result.sufficient).toBe(true);
      expect(result.requiredBytes).toBe(customRequired);
    });

    test('uses modelId to determine required bytes (SmolLM3-3B-Q4_K_M)', () => {
      // SmolLM3-3B-Q4_K_M requires 2GB
      getMemoryBudget.mockReturnValue({
        totalMB: 8192,
        availableMB: 3_000_000_000 / (1024 * 1024), // ~2862MB
        browserOverheadMB: 1024,
      });

      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M');

      expect(result.requiredBytes).toBe(2_000_000_000);
    });

    test('uses default 2GB for unknown modelId', () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 8192,
        availableMB: 3072,
        browserOverheadMB: 1024,
      });

      const result = gate.checkMemory('unknown-model-xyz');

      expect(result.requiredBytes).toBe(2_000_000_000);
    });

    test('returns correct memory check structure', () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 8192,
        availableMB: 6144,
        browserOverheadMB: 2048,
      });

      const result = gate.checkMemory('SmolLM3-3B-Q4_K_M');

      expect(result).toHaveProperty('availableBytes');
      expect(result).toHaveProperty('requiredBytes');
      expect(result).toHaveProperty('sufficient');
      expect(result).toHaveProperty('tier');
      expect(typeof result.availableBytes).toBe('number');
      expect(typeof result.requiredBytes).toBe('number');
      expect(typeof result.sufficient).toBe('boolean');
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(result.tier);
    });
  });

  describe('checkModelCached', () => {
    // Reusable mock service factory
    const createMockService = (getModelInfoReturn: unknown) => {
      const mockService = {
        getModelInfo: vi.fn().mockReturnValue(getModelInfoReturn),
      };
      return mockService as unknown as WebLLMService;
    };

    beforeEach(() => {
      // Reset the mock for each test
      vi.mocked(WebLLMService.getInstance).mockReset();
    });

    test('returns false when WebLLMService.getInstance throws', async () => {
      vi.mocked(WebLLMService.getInstance).mockImplementation(() => {
        throw new Error('Service not available');
      });

      const result = await gate.checkModelCached('SmolLM3-3B-Q4_K_M');

      expect(result).toBe(false);
    });

    test('returns false when getModelInfo returns null (service not initialized)', async () => {
      const mockService = createMockService(null);
      vi.mocked(WebLLMService.getInstance).mockReturnValue(mockService);

      const result = await gate.checkModelCached('SmolLM3-3B-Q4_K_M');

      expect(result).toBe(false);
    });

    test('returns true when model is cached (getModelInfo().cached === true)', async () => {
      const mockService = createMockService({
        modelId: 'SmolLM3-3B-Q4_K_M',
        cached: true,
        sizeBytes: 2_000_000_000,
        quantization: 'Q4_K_M',
      });
      vi.mocked(WebLLMService.getInstance).mockReturnValue(mockService);

      const result = await gate.checkModelCached('SmolLM3-3B-Q4_K_M');

      expect(result).toBe(true);
    });

    test('returns false when model is not cached (getModelInfo().cached === false)', async () => {
      const mockService = createMockService({
        modelId: 'SmolLM3-3B-Q4_K_M',
        cached: false,
        sizeBytes: 0,
        quantization: 'Q4_K_M',
      });
      vi.mocked(WebLLMService.getInstance).mockReturnValue(mockService);

      const result = await gate.checkModelCached('SmolLM3-3B-Q4_K_M');

      expect(result).toBe(false);
    });
  });

  describe('checkReadiness', () => {
    beforeEach(() => {
      getMemoryBudget.mockReturnValue({
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      });
    });

    test('returns ready=false when WebGPU unavailable', async () => {
      mockGpu = undefined; // WebGPU not available

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result.ready).toBe(false);
      expect(result.checks.webgpu).toBe(false);
      expect(result.failures).toContain('WebGPU is not available in this browser.');
      expect(result.recommendations.some(r => r.includes('server API mode'))).toBe(true);
    });

    test('returns ready=false when memory insufficient', async () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 4096,
        availableMB: 1500, // ~1.5GB available (insufficient for 2GB requirement)
        browserOverheadMB: 2048,
      });

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result.ready).toBe(false);
      expect(result.checks.memory.sufficient).toBe(false);
      expect(result.failures.some(f => f.includes('Insufficient memory'))).toBe(true);
      expect(result.recommendations.some(r => r.includes('server API mode'))).toBe(true);
    });

    test('returns ready=true but with recommendation when model is not cached', async () => {
      // Mock WebGPU available
      const mockAdapter = { isFallback: false };
      mockGpu = {
        requestAdapter: vi.fn<() => Promise<unknown>>().mockResolvedValue(mockAdapter),
      };

      // Mock memory sufficient
      getMemoryBudget.mockReturnValue({
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      });

      // Mock model not cached
      const mockService = {
        getModelInfo: vi.fn().mockReturnValue({
          modelId: 'SmolLM3-3B-Q4_K_M',
          cached: false,
          sizeBytes: 2_000_000_000,
          quantization: 'Q4_K_M',
        }),
      } as unknown as WebLLMService;
      vi.mocked(WebLLMService.getInstance).mockReturnValue(mockService);

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result.ready).toBe(true);
      expect(result.checks.modelCached).toBe(false);
      expect(result.recommendations.some(r => r.includes('not cached'))).toBe(true);
    });

    test('returns ready=true with model cached', async () => {
      // Mock WebGPU available
      const mockAdapter = { isFallback: false };
      mockGpu = {
        requestAdapter: vi.fn<() => Promise<unknown>>().mockResolvedValue(mockAdapter),
      };

      // Mock memory sufficient
      getMemoryBudget.mockReturnValue({
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      });

      // Mock model cached
      const mockService = {
        getModelInfo: vi.fn().mockReturnValue({
          modelId: 'SmolLM3-3B-Q4_K_M',
          cached: true,
          sizeBytes: 2_000_000_000,
          quantization: 'Q4_K_M',
        }),
      } as unknown as WebLLMService;
      vi.mocked(WebLLMService.getInstance).mockReturnValue(mockService);

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result.ready).toBe(true);
      expect(result.checks.webgpu).toBe(true);
      expect(result.checks.memory.sufficient).toBe(true);
      expect(result.checks.modelCached).toBe(true);
      expect(result.failures).toEqual([]);
    });

    test('populates failures array correctly when WebGPU unavailable', async () => {
      mockGpu = undefined;

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result.ready).toBe(false);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures).toContain('WebGPU is not available in this browser.');
    });

    test('populates recommendations correctly for server API mode', async () => {
      mockGpu = undefined;

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      const serverApiRecommendations = result.recommendations.filter(r =>
        r.toLowerCase().includes('server api mode')
      );
      expect(serverApiRecommendations.length).toBeGreaterThanOrEqual(1);
    });

    test('recommends smaller model when memory is insufficient', async () => {
      getMemoryBudget.mockReturnValue({
        totalMB: 4096,
        availableMB: 1500, // insufficient
        browserOverheadMB: 2048,
      });

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result.recommendations.some(r => r.includes('smaller model'))).toBe(true);
    });

    test('checkReadiness result has correct structure', async () => {
      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result).toHaveProperty('ready');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('failures');
      expect(result).toHaveProperty('recommendations');
      expect(result.checks).toHaveProperty('webgpu');
      expect(result.checks).toHaveProperty('memory');
      expect(result.checks).toHaveProperty('modelCached');
      expect(Array.isArray(result.failures)).toBe(true);
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    test('handles unknown model ID with default 2GB requirement', async () => {
      // With 14GB available and 2GB required, should have sufficient memory
      getMemoryBudget.mockReturnValue({
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      });

      const result = await gate.checkReadiness('unknown-model-xyz');

      expect(result.checks.memory.sufficient).toBe(true);
    });

    test('returns ready=false when both WebGPU and memory fail', async () => {
      mockGpu = undefined;
      getMemoryBudget.mockReturnValue({
        totalMB: 4096,
        availableMB: 1500,
        browserOverheadMB: 2048,
      });

      const result = await gate.checkReadiness('SmolLM3-3B-Q4_K_M');

      expect(result.ready).toBe(false);
      expect(result.failures.length).toBe(2);
      expect(result.failures).toContain('WebGPU is not available in this browser.');
      expect(result.failures.some(f => f.includes('Insufficient memory'))).toBe(true);
    });
  });
});
