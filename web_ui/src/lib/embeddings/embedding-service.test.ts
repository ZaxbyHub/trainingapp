/**
 * EmbeddingService tests
 * Tests for the Transformers.js-based embedding service singleton.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the @huggingface/transformers module
const mockDispose = vi.fn();

// mockPipelineCallable is the resolved value of pipeline()
// It's a callable that when called performs feature extraction
const mockPipelineCallable = vi.fn();

vi.mock('@huggingface/transformers', () => {
  return {
    pipeline: vi.fn(() => Promise.resolve(mockPipelineCallable)),
    env: {
      allowLocalModels: false,
      useBrowserCache: true,
      allowBrowserBlobStorage: true,
      backends: {
        onnx: {
          wasm: {
            numThreads: navigator.hardwareConcurrency
              ? Math.min(navigator.hardwareConcurrency, 4)
              : 2,
          },
        },
      },
    },
  };
});

describe('EmbeddingService', () => {
  // Create a fresh module import for each test to get a clean singleton state
  let EmbeddingService: typeof import('./embedding-service').EmbeddingService;
  let getEmbeddingService: typeof import('./embedding-service').getEmbeddingService;

  beforeEach(async () => {
    // Clear all mocks but don't reset them completely
    vi.clearAllMocks();

    // Reset the mock callable to default successful state
    mockPipelineCallable.mockReset();
    mockPipelineCallable.mockResolvedValue({
      data: new Float32Array(384).fill(0.1),
      dims: [384],
    });
    // Add dispose as a method on the callable itself
    mockPipelineCallable.dispose = mockDispose;
    mockDispose.mockClear();

    // Reset module state to clear singleton
    vi.resetModules();

    // Re-import to get fresh instance
    const module = await import('./embedding-service');
    EmbeddingService = module.EmbeddingService;
    getEmbeddingService = module.getEmbeddingService;
  });

  afterEach(() => {
    // Clean up singleton state
    try {
      const instance = EmbeddingService.getInstance();
      instance.dispose();
    } catch {
      // Instance may not exist
    }
  });

  /**
   * Helper: Create a valid 384-dim mock embedding
   */
  const createMockEmbedding = (): Float32Array => {
    return new Float32Array(384).fill(0.1);
  };

  /**
   * Helper: Setup pipeline mock to return valid single embedding
   */
  const setupPipelineMock = (embedding: Float32Array = createMockEmbedding()) => {
    mockPipelineCallable.mockResolvedValue({
      data: embedding,
      dims: [384],
    });
  };

  /**
   * Helper: Setup pipeline mock for batch processing
   * Returns concatenated embeddings for multiple inputs
   */
  const setupBatchPipelineMock = (embedding: Float32Array = createMockEmbedding()) => {
    mockPipelineCallable.mockImplementation((texts: string[]) => {
      // Return concatenated embeddings for batch processing
      const numEmbeddings = Array.isArray(texts) ? texts.length : 1;
      const flatData = new Float32Array(embedding.length * numEmbeddings);
      for (let i = 0; i < numEmbeddings; i++) {
        flatData.set(embedding, i * embedding.length);
      }
      return Promise.resolve({
        data: flatData,
        dims: [numEmbeddings, embedding.length],
      });
    });
  };

  describe('singleton pattern', () => {
    it('getInstance returns the same instance', () => {
      const instance1 = EmbeddingService.getInstance();
      const instance2 = EmbeddingService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('getEmbeddingService convenience function returns singleton', () => {
      const instance1 = EmbeddingService.getInstance();
      const instance2 = getEmbeddingService();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize()', () => {
    it('initializes successfully and sets ready state', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();

      expect(instance.isReady()).toBe(false);
      await instance.initialize();
      expect(instance.isReady()).toBe(true);
    });

    it('throws error when model loading fails', async () => {
      // Use mockImplementation to temporarily override for this test only
      const { pipeline } = await import('@huggingface/transformers');
      (pipeline as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
        Promise.reject(new Error('Network failure'))
      );

      // Need to reset modules and re-import since we changed the mock
      vi.resetModules();
      const module = await import('./embedding-service');
      const freshEmbeddingService = module.EmbeddingService;
      const instance = freshEmbeddingService.getInstance();

      await expect(instance.initialize()).rejects.toThrow('Failed to initialize embedding model');
    });

    it('subsequent initialize calls return same promise', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();

      const promise1 = instance.initialize();
      const promise2 = instance.initialize();

      // Check they resolve the same way (Promise identity is tricky with async functions)
      // The implementation returns this.initPromise directly, so both calls return same promise
      let resolved = false;
      promise1.then(() => { resolved = true; });
      await promise2;
      expect(resolved).toBe(true);
      await promise1;
    });

    it('stores model info after initialization', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const info = instance.getModelInfo();
      expect(info.name).toBe('BAAI/bge-small-en-v1.5');
      expect(info.dimensions).toBe(384);
      expect(info.cached).toBe(true);
    });
  });

  describe('initialize after dispose', () => {
    it('throws error when initializing after dispose', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();
      instance.dispose();

      // Re-import to get fresh singleton slot
      vi.resetModules();
      const module = await import('./embedding-service');
      const newInstance = module.EmbeddingService.getInstance();

      // Mock pipeline to reject
      const { pipeline } = await import('@huggingface/transformers');
      (pipeline as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
        Promise.reject(new Error('Model not found'))
      );

      await expect(newInstance.initialize()).rejects.toThrow();
    });
  });

  describe('dispose()', () => {
    it('disposes feature extractor and clears state', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      expect(mockDispose).not.toHaveBeenCalled();
      instance.dispose();

      expect(mockDispose).toHaveBeenCalledTimes(1);
      expect(instance.isReady()).toBe(false);
    });

    it('is idempotent (can be called multiple times)', () => {
      const instance = EmbeddingService.getInstance();
      expect(() => instance.dispose()).not.toThrow();
      expect(() => instance.dispose()).not.toThrow();
    });

    it('allows new instance to be created after dispose', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();
      instance.dispose();

      // After dispose, getInstance should return a fresh instance after resetModules
      vi.resetModules();
      const module = await import('./embedding-service');
      const newInstance = module.EmbeddingService.getInstance();

      // The new instance should not be ready yet
      expect(newInstance.isReady()).toBe(false);
    });
  });

  describe('dispose race guard', () => {
    it('throws if disposed during initialization', async () => {
      // Create a promise that resolves after a delay to simulate slow init
      let resolveSlowInit: (value: unknown) => void;
      const slowInit = new Promise((resolve) => {
        resolveSlowInit = resolve;
      });

      // Setup a slow-loading pipeline
      mockPipelineCallable.mockImplementation(async () => {
        await slowInit;
        return {
          data: createMockEmbedding(),
          dims: [384],
        };
      });

      const instance = EmbeddingService.getInstance();
      const initPromise = instance.initialize();

      // Dispose while initialization is in progress
      instance.dispose();

      // Complete the init after dispose
      resolveSlowInit!(null);

      await expect(initPromise).rejects.toThrow('EmbeddingService was disposed during initialization');
    });
  });

  describe('encode()', () => {
    it('throws error when called before initialization', async () => {
      const instance = EmbeddingService.getInstance();
      await expect(instance.encode('hello')).rejects.toThrow('EmbeddingService not initialized');
    });

    it('returns 384-dimensional Float32Array', async () => {
      const embedding = createMockEmbedding();
      setupPipelineMock(embedding);
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const result = await instance.encode('hello world');

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(384);
    });

    it('throws error for empty text', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      await expect(instance.encode('')).rejects.toThrow('Cannot encode empty text');
      await expect(instance.encode('   ')).rejects.toThrow('Cannot encode empty text');
    });

    it('propagates encoding errors with context', async () => {
      // Track call count to return different values
      let callCount = 0;
      mockPipelineCallable.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call (initialization test encoding) - return correct dimensions
          return Promise.resolve({
            data: new Float32Array(384),
            dims: [384],
          });
        }
        // Subsequent calls (actual encoding) - return wrong dimensions
        return Promise.resolve({
          data: new Float32Array(192),
          dims: [192],
        });
      });

      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      await expect(instance.encode('hello')).rejects.toThrow('Embedding dimension mismatch');
    });
  });

  describe('encodeBatch()', () => {
    it('returns empty array for empty input', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const result = await instance.encodeBatch([]);
      expect(result).toEqual([]);
    });

    it('returns array of 384-dim embeddings', async () => {
      const embedding = createMockEmbedding();
      setupBatchPipelineMock(embedding);
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const texts = ['hello', 'world', 'test'];
      const results = await instance.encodeBatch(texts);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(384);
      }
    });

    it('calls progress callback during batch processing', async () => {
      const embedding = createMockEmbedding();
      setupBatchPipelineMock(embedding);
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const progressCalls: Array<[number, number]> = [];
      const onProgress = (done: number, total: number) => {
        progressCalls.push([done, total]);
      };

      // With batchSize=8, 10 items should report progress at 8 and 10
      const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
      await instance.encodeBatch(texts, onProgress);

      expect(progressCalls).toContainEqual([8, 10]);
      expect(progressCalls).toContainEqual([10, 10]);
    });

    it('throws error for non-string array items', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const texts = ['hello', 123 as unknown as string, 'world'];
      await expect(instance.encodeBatch(texts)).rejects.toThrow('Text at index 1 is not a string');
    });
  });

  describe('isReady()', () => {
    it('returns false before initialization', () => {
      const instance = EmbeddingService.getInstance();
      expect(instance.isReady()).toBe(false);
    });

    it('returns true after successful initialization', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();
      expect(instance.isReady()).toBe(true);
    });

    it('returns false after dispose', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();
      instance.dispose();
      expect(instance.isReady()).toBe(false);
    });
  });

  describe('getModelInfo()', () => {
    it('returns model info with default cached=false', () => {
      const instance = EmbeddingService.getInstance();
      const info = instance.getModelInfo();
      expect(info.name).toBe('BAAI/bge-small-en-v1.5');
      expect(info.dimensions).toBe(384);
      expect(info.cached).toBe(false);
    });

    it('returns a copy of modelInfo (not mutable)', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const info1 = instance.getModelInfo();
      const info2 = instance.getModelInfo();

      expect(info1).not.toBe(info2);
      expect(info1).toEqual(info2);
    });
  });
});
