/**
 * EmbeddingService tests
 * Tests for the Transformers.js-based embedding service singleton.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the @huggingface/transformers module
const mockDispose = vi.fn();

// mockPipelineCallable is the resolved value of pipeline()
// It's a callable that when called performs feature extraction.
// `dispose` is attached ad-hoc to satisfy EmbeddingService's pipeline contract.
const mockPipelineCallable = vi.fn() as ReturnType<typeof vi.fn> & {
  dispose: ReturnType<typeof vi.fn>;
};

vi.mock('@huggingface/transformers', () => {
  return {
    pipeline: vi.fn(() => Promise.resolve(mockPipelineCallable)),
    env: {
      allowLocalModels: false,
      allowRemoteModels: true,
      localModelPath: '',
      useBrowserCache: true,
      allowBrowserBlobStorage: true,
      backends: {
        onnx: {
          wasm: {
            wasmPaths: '',
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
      data: new Float32Array(768).fill(0.1),
      dims: [768],
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
   * Helper: Create a valid 768-dim mock embedding
   */
  const createMockEmbedding = (): Float32Array => {
    return new Float32Array(768).fill(0.1);
  };

  /**
   * Helper: Setup pipeline mock to return valid single embedding
   */
  const setupPipelineMock = (embedding: Float32Array = createMockEmbedding()) => {
    mockPipelineCallable.mockResolvedValue({
      data: embedding,
      dims: [768],
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

  describe('offline configuration (Phase 1)', () => {
    it('configures Transformers.js for local-only, no remote downloads', async () => {
      // Constructing the singleton runs configureEnv().
      EmbeddingService.getInstance();
      const { env } = await import('@huggingface/transformers');

      // The core offline guarantee: never fetch from a CDN/HF at runtime.
      expect(env.allowRemoteModels).toBe(false);
      expect(env.allowLocalModels).toBe(true);
      // Models resolved from the locally packaged base (/models); the embedding
      // pipeline path is `embeddings/snowflake-arctic-embed-m-v1.5` relative to this.
      expect(env.localModelPath).toBe('/models');
      // ORT WASM served locally, not from jsdelivr. Under vitest (DEV=true),
      // wasmPaths points at node_modules for Vite dev; in prod it's /models/ort/.
      const expectedWasmPaths = import.meta.env.DEV
        ? '/node_modules/onnxruntime-web/dist/'
        : '/models/ort/';
      expect(env.backends.onnx.wasm?.wasmPaths).toBe(expectedWasmPaths);
    });
  });

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

    it('throws error when Worker construction fails', async () => {
      // R8: the embedding pipeline now runs in a Web Worker. If Worker is
      // unavailable (or its constructor throws), initialize() must surface
      // a clear error. Temporarily break the Worker global to test this path.
      const origWorker = globalThis.Worker;
      (globalThis as Record<string, unknown>).Worker = undefined;

      try {
        vi.resetModules();
        const module = await import('./embedding-service');
        const freshEmbeddingService = module.EmbeddingService;
        const instance = freshEmbeddingService.getInstance();
        await expect(instance.initialize()).rejects.toThrow('Failed to initialize embedding model');
      } finally {
        (globalThis as Record<string, unknown>).Worker = origWorker;
      }
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
      expect(info.name).toBe('Snowflake/snowflake-arctic-embed-m-v1.5');
      expect(info.dimensions).toBe(768);
      expect(info.cached).toBe(true);
    });
  });

  describe('initialize after dispose', () => {
    it('throws error when initializing without Worker available', async () => {
      // R8: with the Worker path, initialization failure occurs when Worker
      // cannot be created. Verify dispose resets the singleton so a subsequent
      // init attempt without a Worker globally fails cleanly.
      const origWorker = globalThis.Worker;
      (globalThis as Record<string, unknown>).Worker = undefined;

      try {
        vi.resetModules();
        const module = await import('./embedding-service');
        const freshService = module.EmbeddingService;
        const instance = freshService.getInstance();
        await expect(instance.initialize()).rejects.toThrow('Failed to initialize embedding model');
      } finally {
        (globalThis as Record<string, unknown>).Worker = origWorker;
      }
    });
  });

  describe('dispose()', () => {
    it('terminates the Worker and clears state', async () => {
      const instance = EmbeddingService.getInstance();
      await instance.initialize();
      expect(instance.isReady()).toBe(true);

      instance.dispose();

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
          dims: [768],
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

    it('returns 768-dimensional Float32Array via Worker', async () => {
      // R8: encoding now runs inside a Web Worker.
      const instance = EmbeddingService.getInstance();
      await instance.initialize();
      const result = await instance.encode('hello world');
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(768);
    });

    it('PRR46-004: worker applies CLS pooling + normalize (F9 invariant)', async () => {
      // The pooling/normalize options live inside embedding.worker.ts which
      // runs in a separate Worker context (not directly mockable here). This
      // test statically asserts the worker source contains the correct pooling
      // options so a regression (e.g. switching to mean pooling) would fail
      // the test. This replaces the pre-R8 runtime CLS-pooling assertion that
      // was deleted when the pipeline moved into the worker.
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const workerSource = readFileSync(
        resolve(process.cwd(), 'src/lib/embeddings/embedding.worker.ts'),
        'utf8'
      );
      // The worker must pass pooling:'cls' and normalize:true to every
      // pipeline call. Count occurrences — there should be at least 3
      // (probe + encode + encodeBatch).
      const clsPoolingCount = (workerSource.match(/pooling:\s*'cls'/g) ?? []).length;
      const normalizeCount = (workerSource.match(/normalize:\s*true/g) ?? []).length;
      expect(clsPoolingCount).toBeGreaterThanOrEqual(3);
      expect(normalizeCount).toBeGreaterThanOrEqual(3);
    });

    it('throws error for empty text', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      await expect(instance.encode('')).rejects.toThrow('Cannot encode empty text');
      await expect(instance.encode('   ')).rejects.toThrow('Cannot encode empty text');
    });

    it('propagates Worker encoding errors with context', async () => {
      // R8: encoding errors from the Worker are propagated through
      // _postAndWait and surfaced to the caller with context.
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      vi.spyOn(instance as any, '_postAndWait').mockRejectedValue(
        new Error('Inference failed: OOM')
      );

      await expect(instance.encode('hello')).rejects.toThrow('Inference failed: OOM');
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

    it('returns array of 768-dim embeddings', async () => {
      const embedding = createMockEmbedding();
      setupBatchPipelineMock(embedding);
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const texts = ['hello', 'world', 'test'];
      const results = await instance.encodeBatch(texts);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(768);
      }
    });

    it('encodes batch via Worker and returns all vectors', async () => {
      // R8: encodeBatch sends the full batch to the Worker in one message.
      // The Worker handles batching internally. Progress callbacks are
      // accepted for API compatibility but unused at the service level.
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
      const results = await instance.encodeBatch(texts);

      expect(results).toHaveLength(10);
      results.forEach((v) => {
        expect(v).toBeInstanceOf(Float32Array);
        expect(v.length).toBe(768);
      });
    });

    it('throws error for non-string array items', async () => {
      setupPipelineMock();
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      const texts = ['hello', 123 as unknown as string, 'world'];
      await expect(instance.encodeBatch(texts)).rejects.toThrow('Text at index 1 is not a string');
    });

    it('F14: propagates Worker encoding errors during batch', async () => {
      // R8: tensor shape validation is handled inside embedding.worker.ts.
      // Test that errors from the Worker during batch encoding surface
      // to the caller with the original error message.
      const instance = EmbeddingService.getInstance();
      await instance.initialize();

      vi.spyOn(instance as any, '_postAndWait').mockRejectedValue(
        new Error('Worker batch encoding failed')
      );

      await expect(instance.encodeBatch(['a', 'b'])).rejects.toThrow('Worker batch encoding failed');
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
      expect(info.name).toBe('Snowflake/snowflake-arctic-embed-m-v1.5');
      expect(info.dimensions).toBe(768);
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
