/**
 * Tests for RerankerService cross-encoder reranking.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { RerankerService } from './reranker';
import type { SearchResult } from '../../types/search';

/**
 * Test result fixture shape. These fixtures intentionally carry the legacy
 * field names (`id`, `chunk_id`, `document_id`, `metadata`) used by the
 * assertions below to verify ordering and field preservation. The production
 * `rerank()` only reads `result.text` and spreads `...result`, so these
 * fixtures are cast through `unknown` to {@link SearchResult} at the call
 * site without altering their runtime shape.
 */
type TestResult = {
  id: string;
  text: string;
  score: number;
  chunk_id: string;
  document_id: string;
  metadata?: { foo: string };
};

/**
 * Cast an array of {@link TestResult} fixtures to {@link SearchResult} for the
 * production `rerank()` call. The cast is `unknown`-mediated because the
 * fixtures use legacy field names; only `text` is read at runtime.
 */
function asSearchResults(results: TestResult[]): SearchResult[] {
  return results as unknown as SearchResult[];
}

/**
 * Cast a `rerank()` return value back to {@link TestResult} so legacy
 * assertions reading `.id` continue to type-check. The production code
 * spreads `...result`, so all fixture fields survive the round trip.
 */
function asTestResults(results: SearchResult[]): TestResult[] {
  return results as unknown as TestResult[];
}

// Helper to create a callable mock with dispose
function createMockPipeline() {
  const mockFn = vi.fn();
  (mockFn as any).dispose = vi.fn();
  return mockFn as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
}

// Mock the @huggingface/transformers module
vi.mock('@huggingface/transformers', () => {
  const mockPipelineInstance = createMockPipeline();
  return {
    pipeline: vi.fn(() => Promise.resolve(mockPipelineInstance)),
    env: {
      allowLocalModels: false,
      useBrowserCache: true,
      allowBrowserBlobStorage: true,
      backends: {
        onnx: {
          wasm: {
            numThreads: 2,
          },
        },
      },
    },
  };
});

// Import the mocked module to access the pipeline mock
import { pipeline as pipelineMock } from '@huggingface/transformers';

describe('RerankerService', () => {
  let service: RerankerService;

  beforeEach(() => {
    // Dispose existing instance if any
    try {
      RerankerService.getInstance().dispose();
    } catch {
      // Ignore cleanup errors
    }

    // Reset the pipeline mock to return a fresh mock instance
    const freshMock = createMockPipeline();
    (pipelineMock as ReturnType<typeof vi.fn>).mockResolvedValue(freshMock);

    // Get fresh instance
    service = RerankerService.getInstance();
  });

  afterEach(() => {
    service?.dispose();
  });

  describe('getInstance', () => {
    test('returns singleton instance', () => {
      const instance1 = RerankerService.getInstance();
      const instance2 = RerankerService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('canRerank', () => {
    test('returns true when chunkCount < 500 and deviceMemory >= 8', () => {
      Object.defineProperty(navigator, 'deviceMemory', {
        value: 16,
        configurable: true,
      });
      expect(service.canRerank(100)).toBe(true);
    });

    test('returns false when chunkCount >= 500', () => {
      Object.defineProperty(navigator, 'deviceMemory', {
        value: 16,
        configurable: true,
      });
      expect(service.canRerank(500)).toBe(false);
      expect(service.canRerank(501)).toBe(false);
      expect(service.canRerank(1000)).toBe(false);
    });

    test('returns false when deviceMemory < 8', () => {
      Object.defineProperty(navigator, 'deviceMemory', {
        value: 4,
        configurable: true,
      });
      expect(service.canRerank(100)).toBe(false);
    });

    test('returns true when deviceMemory is undefined (some browsers)', () => {
      Object.defineProperty(navigator, 'deviceMemory', {
        value: undefined,
        configurable: true,
      });
      expect(service.canRerank(100)).toBe(true);
      expect(service.canRerank(499)).toBe(true);
    });

    test('returns false when deviceMemory is undefined but chunkCount >= 500', () => {
      Object.defineProperty(navigator, 'deviceMemory', {
        value: undefined,
        configurable: true,
      });
      expect(service.canRerank(500)).toBe(false);
    });
  });

  describe('initialize', () => {
    test('initializes pipeline with correct task type and model', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn>;
      pipeline.mockResolvedValue(createMockPipeline());

      await service.initialize();

      expect(pipeline).toHaveBeenCalledWith(
        'text-classification',
        'reranker/ms-marco-MiniLM-L-6-v2', // local offline path (was 'cross-encoder/ms-marco-MiniLM-L-6-v2')
        expect.objectContaining({
          dtype: 'fp32',
          device: 'wasm',
        })
      );
    });

    test('isReady returns true after successful initialization', async () => {
      await service.initialize();
      expect(service.isReady()).toBe(true);
    });

    test('multiple initialize calls do not error', async () => {
      await service.initialize();
      await service.initialize();
      expect(service.isReady()).toBe(true);
    });

    test('initialize throws error when disposed during initialization', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn>;
      const freshMock = createMockPipeline();
      pipeline.mockImplementation(async () => {
        service.dispose();
        return freshMock;
      });

      await expect(service.initialize()).rejects.toThrow(
        'RerankerService was disposed during initialization'
      );
    });
  });

  describe('rerank', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns results unchanged when not ready', async () => {
      RerankerService.getInstance().dispose();
      const unreadyService = RerankerService.getInstance();

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.9, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.8, chunk_id: 'c2', document_id: 'd1' },
      ];

      const reranked = asTestResults(await unreadyService.rerank('query', asSearchResults(results)));
      expect(reranked).toEqual(results);
      unreadyService.dispose();
    });

    test('returns results unchanged when pipeline throws (graceful degradation)', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn>;
      pipeline.mockResolvedValue(createMockPipeline());
      const mockFn = pipelineMock as unknown as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
      // Make the pipeline throw when called
      mockFn.mockImplementation(async () => {
        throw new Error('Pipeline failed');
      });

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.9, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.8, chunk_id: 'c2', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));
      expect(reranked).toEqual(results);
    });

    test('returns results unchanged when query is empty', async () => {
      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.9, chunk_id: 'c1', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('', asSearchResults(results)));
      expect(reranked).toEqual(results);
    });

    test('returns results unchanged when results array is empty', async () => {
      const reranked = await service.rerank('query', []);
      expect(reranked).toEqual([]);
    });

    test('returns results unchanged when results is null', async () => {
      const reranked = await service.rerank('query', null as any);
      expect(reranked).toBeNull();
    });

    test('uses text-classification pipeline type', () => {
      expect(pipelineMock).toHaveBeenCalledWith(
        'text-classification',
        'reranker/ms-marco-MiniLM-L-6-v2', // local offline path (was 'cross-encoder/ms-marco-MiniLM-L-6-v2')
        expect.any(Object)
      );
    });

    test('extracts .score from {label, score} output format', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
      const mockFn = Object.assign(
        vi.fn().mockResolvedValue([
          { label: 'positive', score: 0.95 },
          { label: 'positive', score: 0.85 },
          { label: 'positive', score: 0.75 },
        ]),
        { dispose: vi.fn() }
      );
      pipeline.mockResolvedValue(mockFn);
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.9, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.8, chunk_id: 'c2', document_id: 'd1' },
        { id: '3', text: 'doc 3', score: 0.7, chunk_id: 'c3', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));

      expect(reranked[0].score).toBe(0.95);
      expect(reranked[1].score).toBe(0.85);
      expect(reranked[2].score).toBe(0.75);
    });

    test('sorts by cross-encoder score descending', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
      const mockFn = Object.assign(
        vi.fn().mockResolvedValue([
          { label: 'positive', score: 0.3 },  // doc 1
          { label: 'positive', score: 0.9 },  // doc 2
          { label: 'positive', score: 0.6 },  // doc 3
        ]),
        { dispose: vi.fn() }
      );
      pipeline.mockResolvedValue(mockFn);
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.1, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.2, chunk_id: 'c2', document_id: 'd1' },
        { id: '3', text: 'doc 3', score: 0.3, chunk_id: 'c3', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));

      expect(reranked[0].id).toBe('2'); // score 0.9
      expect(reranked[1].id).toBe('3'); // score 0.6
      expect(reranked[2].id).toBe('1'); // score 0.3
    });

    test('respects topK parameter', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
      const mockFn = Object.assign(
        vi.fn().mockResolvedValue([
          { label: 'positive', score: 0.3 },
          { label: 'positive', score: 0.9 },
          { label: 'positive', score: 0.6 },
        ]),
        { dispose: vi.fn() }
      );
      pipeline.mockResolvedValue(mockFn);
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.1, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.2, chunk_id: 'c2', document_id: 'd1' },
        { id: '3', text: 'doc 3', score: 0.3, chunk_id: 'c3', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results), 2));

      expect(reranked).toHaveLength(2);
      expect(reranked[0].id).toBe('2');
      expect(reranked[1].id).toBe('3');
    });

    test('topK returns all results when topK > results.length', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
      const mockFn = Object.assign(
        vi.fn().mockResolvedValue([
          { label: 'positive', score: 0.3 },
          { label: 'positive', score: 0.9 },
        ]),
        { dispose: vi.fn() }
      );
      pipeline.mockResolvedValue(mockFn);
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.1, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.2, chunk_id: 'c2', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results), 10));
      expect(reranked).toHaveLength(2);
    });

    test('preserves result fields beyond score', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
      const mockFn = Object.assign(
        vi.fn().mockResolvedValue([{ label: 'positive', score: 0.9 }]),
        { dispose: vi.fn() }
      );
      pipeline.mockResolvedValue(mockFn);
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        {
          id: '1',
          text: 'doc 1',
          score: 0.5,
          chunk_id: 'c1',
          document_id: 'd1',
          metadata: { foo: 'bar' },
        },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));

      expect(reranked[0]).toEqual({
        id: '1',
        text: 'doc 1',
        score: 0.9,
        chunk_id: 'c1',
        document_id: 'd1',
        metadata: { foo: 'bar' },
      });
    });

    test('handles empty text in results (F5: empty-text passes through UNSCORED)', async () => {
      const pipeline = pipelineMock as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
      // Only ONE score is returned because only the non-empty chunk is scored.
      const mockFn = Object.assign(
        vi.fn().mockResolvedValue([
          { label: 'positive', score: 0.9 }, // non-empty text only
        ]),
        { dispose: vi.fn() }
      );
      pipeline.mockResolvedValue(mockFn);
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        { id: '1', text: '', score: 0.1, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.2, chunk_id: 'c2', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));

      // Both results survive.
      expect(reranked).toHaveLength(2);
      // F5 contract: the cross-encoder must NOT be called with [query, ''] for
      // the empty-text chunk — only the single non-empty pair is scored.
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith([['query', 'doc 2']]);
      // The empty-text result passes through UNSCORED (retains its original
      // score 0.1, not a cross-encoder score), and is appended after the
      // scored result (score 0.9).
      expect(reranked[0].score).toBe(0.9);
      expect(reranked[0].id).toBe('2');
      expect(reranked[1].score).toBe(0.1);
      expect(reranked[1].id).toBe('1');
    });
  });

  describe('isReady', () => {
    test('returns false before initialization', () => {
      expect(service.isReady()).toBe(false);
    });

    test('returns true after successful initialization', async () => {
      await service.initialize();
      expect(service.isReady()).toBe(true);
    });

    test('returns false after dispose', async () => {
      await service.initialize();
      service.dispose();
      expect(service.isReady()).toBe(false);
    });
  });

  describe('dispose', () => {
    test('sets disposed flag', async () => {
      await service.initialize();
      service.dispose();

      // Trying to get a new instance should work
      const newService = RerankerService.getInstance();
      expect(newService.isReady()).toBe(false);
      newService.dispose();
    });

    test('can reinitialize after dispose', async () => {
      await service.initialize();
      service.dispose();

      const newService = RerankerService.getInstance();
      await newService.initialize();
      expect(newService.isReady()).toBe(true);

      newService.dispose();
    });
  });
});
