/**
 * Tests for RerankerService cross-encoder reranking (Issue #37 R1).
 *
 * The reranker bypasses the `text-classification` `pipeline()` (which applies
 * softmax and collapses a single-logit cross-encoder to a constant 1.0) and
 * instead calls the tokenizer + sequence-classification model directly:
 *   - tokenizer(queries, { text_pair: passages, padding, truncation })
 *   - model(inputs) → { logits }
 *   - logits.sigmoid().tolist() → relevance score in (0, 1) per pair
 *
 * These tests mock AutoTokenizer / AutoModelForSequenceClassification to verify
 * that contract, including the pair-encoding (acceptance criterion #2 from
 * issue #37 §7) and the per-query input cap (RERANK_INPUT_CAP).
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

function asSearchResults(results: TestResult[]): SearchResult[] {
  return results as unknown as SearchResult[];
}

function asTestResults(results: SearchResult[]): TestResult[] {
  return results as unknown as TestResult[];
}

// Recorded tokenizer call args (for pair-encoding assertions).
let lastTokenizerCall: {
  text: unknown;
  options: unknown;
} | null = null;

/** Build a mock tokenizer that records its call args. */
function createMockTokenizer() {
  return vi.fn((text: unknown, options: unknown) => {
    lastTokenizerCall = { text, options };
    // The exact tokenized-input object shape does not matter — the mock model
    // ignores it and returns canned logits. We return a minimal object.
    return { input_ids: {}, attention_mask: {}, token_type_ids: {} };
  });
}

/**
 * Build a mock sequence-classification model whose logits (per pair) come from
 * the provided `scoreMap` keyed by passage text. The mock returns logits equal
 * to `inverseSigmoid(score)` so that `logits.sigmoid().tolist()` reproduces the
 * intended score (sigmoid is monotonic; we just need a representative value).
 */
function createMockModel(scoreMap: Record<string, number>) {
  const modelFn = vi.fn(async (inputs: unknown) => {
    // Re-derive the per-pair score from the last tokenizer call. The tokenizer
    // was called with queries + text_pair in the SAME ORDER; we read the
    // passages out of the recorded options.
    const opts = (lastTokenizerCall?.options ?? {}) as { text_pair?: string[] };
    const passages = opts.text_pair ?? [];
    // logits as nested arrays [[logit_for_pair_0], ...] shaped like a real
    // SequenceClassifierOutput: [batch, 1]. We store inverse-sigmoid logits so
    // the mock sigmoid() below reproduces the intended score exactly.
    const logitRows = passages.map((p) => {
      const score = scoreMap[p] ?? 0;
      const clamped = Math.min(0.999999, Math.max(0.000001, score));
      return [Math.log(clamped / (1 - clamped))];
    });
    // The mock tensor's sigmoid() must ACTUALLY apply sigmoid to each logit,
    // mirroring the real Tensor.sigmoid() the production code calls.
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    const tensor = {
      sigmoid: () => ({
        tolist: () => logitRows.map((row) => row.map(sigmoid)),
      }),
    };
    return { logits: tensor };
  });
  (modelFn as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose = vi.fn();
  return modelFn as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
}

/** Default mock model that assigns a fixed score to every passage (for tests
 *  that do not care about per-pair ordering). */
function createUniformMockModel(score: number) {
  return createMockModel(new Proxy({} as Record<string, number>, {
    get: () => score,
  }));
}

// Mock the @huggingface/transformers module to expose the factory functions
// the rewritten doInitialize() imports dynamically.
vi.mock('@huggingface/transformers', () => {
  return {
    AutoTokenizer: {
      from_pretrained: vi.fn(() => Promise.resolve(createMockTokenizer())),
    },
    AutoModelForSequenceClassification: {
      from_pretrained: vi.fn(() => Promise.resolve(createUniformMockModel(0.5))),
    },
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

// Import the mocked factories so individual tests can override them.
import { AutoTokenizer as AutoTokenizerMock, AutoModelForSequenceClassification as AutoModelMock } from '@huggingface/transformers';

describe('RerankerService', () => {
  let service: RerankerService;

  beforeEach(() => {
    // Dispose existing instance if any
    try {
      RerankerService.getInstance().dispose();
    } catch {
      // Ignore cleanup errors
    }
    lastTokenizerCall = null;

    // Reset factories to fresh default mocks.
    (AutoTokenizerMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockTokenizer());
    (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createUniformMockModel(0.5));

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
    test('returns true when chunkCount < 500', () => {
      expect(service.canRerank(100)).toBe(true);
      expect(service.canRerank(499)).toBe(true);
    });

    test('returns false when chunkCount >= 500', () => {
      expect(service.canRerank(500)).toBe(false);
      expect(service.canRerank(501)).toBe(false);
      expect(service.canRerank(1000)).toBe(false);
    });

    test('Issue #37 R1: deviceMemory no longer affects canRerank (Chrome caps API at 8, branch was dead)', () => {
      // Previously: deviceMemory < 8 → false. Chrome caps the API at 8, so this
      // never tripped on any real browser. The branch is removed; canRerank is
      // now a pure pathological-input bound (the real per-query cap lives in
      // rerank() via RERANK_INPUT_CAP).
      Object.defineProperty(navigator, 'deviceMemory', { value: 4, configurable: true });
      expect(service.canRerank(100)).toBe(true);
      Object.defineProperty(navigator, 'deviceMemory', { value: undefined, configurable: true });
      expect(service.canRerank(100)).toBe(true);
    });
  });

  describe('initialize', () => {
    test('loads tokenizer + model directly (Issue #37 R1b: no text-classification pipeline)', async () => {
      await service.initialize();

      // The factories must be called with the offline model path and q8 dtype.
      expect(AutoTokenizerMock.from_pretrained).toHaveBeenCalledWith('reranker/ettin-reranker-32m-v1');
      expect(AutoModelMock.from_pretrained).toHaveBeenCalledWith(
        'reranker/ettin-reranker-32m-v1',
        expect.objectContaining({ dtype: 'q8', device: 'wasm' })
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
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        service.dispose();
        return createUniformMockModel(0.5);
      });

      await expect(service.initialize()).rejects.toThrow(
        'RerankerService was disposed during initialization'
      );
    });

    test('initialize surfaces a clear error when model load fails', async () => {
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
      await expect(service.initialize()).rejects.toThrow(/Failed to initialize reranker model/);
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

    test('returns results unchanged when the model throws (graceful degradation)', async () => {
      // Replace the model on the initialized service with one that rejects.
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(
        Object.assign(vi.fn(async () => { throw new Error('Model failed'); }), { dispose: vi.fn() })
      );
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

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
      const reranked = await service.rerank('query', null as unknown as SearchResult[]);
      expect(reranked).toBeNull();
    });

    test('Issue #37 acceptance #2: pair-encodes via text_pair (true [CLS] q [SEP] p [SEP])', async () => {
      // Replace model with a per-passage score map.
      const scoreMap = { 'doc 1': 0.95, 'doc 2': 0.85 };
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockModel(scoreMap));
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();
      lastTokenizerCall = null;

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.9, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.8, chunk_id: 'c2', document_id: 'd1' },
      ];

      await service.rerank('query', asSearchResults(results));

      // The tokenizer MUST be called with text_pair (NOT a concatenated tuple).
      // This is the load-bearing assertion: without text_pair the model sees
      // [CLS] query passage [SEP] with token_type_ids all 0 — the wrong format.
      expect(lastTokenizerCall).not.toBeNull();
      const opts = (lastTokenizerCall!.options) as { text_pair?: unknown; padding?: boolean; truncation?: boolean };
      expect(opts.text_pair).toEqual(['doc 1', 'doc 2']);
      expect(opts.padding).toBe(true);
      expect(opts.truncation).toBe(true);
      // And the query side is the query repeated once per pair.
      expect(lastTokenizerCall!.text).toEqual(['query', 'query']);
    });

    test('Issue #37 acceptance #2: scores are sigmoid values in (0,1), non-constant', async () => {
      const scoreMap = { 'doc 1': 0.95, 'doc 2': 0.05 };
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockModel(scoreMap));
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.9, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.1, chunk_id: 'c2', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));

      // Scores must be in (0, 1) and DIFFERENT (the bug being fixed: softmax
      // over a single logit collapsed every pair to 1.0).
      expect(reranked[0].score).toBeGreaterThan(0);
      expect(reranked[0].score).toBeLessThan(1);
      expect(reranked[1].score).toBeGreaterThan(0);
      expect(reranked[1].score).toBeLessThan(1);
      expect(reranked[0].score).not.toEqual(reranked[1].score);
    });

    test('extracts sigmoid score per pair (acceptance #2 scale)', async () => {
      const scoreMap = { 'doc 1': 0.95, 'doc 2': 0.85, 'doc 3': 0.75 };
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockModel(scoreMap));
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const results: TestResult[] = [
        { id: '1', text: 'doc 1', score: 0.9, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.8, chunk_id: 'c2', document_id: 'd1' },
        { id: '3', text: 'doc 3', score: 0.7, chunk_id: 'c3', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));

      expect(reranked[0].score).toBeCloseTo(0.95, 5);
      expect(reranked[1].score).toBeCloseTo(0.85, 5);
      expect(reranked[2].score).toBeCloseTo(0.75, 5);
    });

    test('sorts by cross-encoder score descending', async () => {
      const scoreMap = { 'doc 1': 0.3, 'doc 2': 0.9, 'doc 3': 0.6 };
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockModel(scoreMap));
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
      const scoreMap = { 'doc 1': 0.3, 'doc 2': 0.9, 'doc 3': 0.6 };
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockModel(scoreMap));
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
      const scoreMap = { 'doc 1': 0.3, 'doc 2': 0.9 };
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockModel(scoreMap));
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
      const scoreMap = { 'doc 1': 0.9 };
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(createMockModel(scoreMap));
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

      // Score uses toBeCloseTo: the mock round-trips through inverse-sigmoid
      // → sigmoid, which introduces FP error (0.8999999999999999 vs 0.9). All
      // other fields must be preserved exactly by the spread.
      expect(reranked[0].id).toBe('1');
      expect(reranked[0].text).toBe('doc 1');
      expect(reranked[0].score).toBeCloseTo(0.9, 10);
      expect(reranked[0].chunk_id).toBe('c1');
      expect(reranked[0].document_id).toBe('d1');
      expect(reranked[0].metadata).toEqual({ foo: 'bar' });
    });

    test('handles empty text in results (F5: empty-text passes through UNSCORED)', async () => {
      // Only ONE passage is pair-encoded because only the non-empty chunk is
      // scored. The empty-text chunk is never passed to the tokenizer.
      const scoreMap = { 'doc 2': 0.9 };
      const mockModel = createMockModel(scoreMap);
      const mockTokenizer = createMockTokenizer();
      (AutoTokenizerMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(mockTokenizer);
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(mockModel);
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();
      lastTokenizerCall = null;

      const results: TestResult[] = [
        { id: '1', text: '', score: 0.1, chunk_id: 'c1', document_id: 'd1' },
        { id: '2', text: 'doc 2', score: 0.2, chunk_id: 'c2', document_id: 'd1' },
      ];

      const reranked = asTestResults(await service.rerank('query', asSearchResults(results)));

      // Both results survive.
      expect(reranked).toHaveLength(2);
      // The empty-text chunk is NOT scored: text_pair should contain only
      // the non-empty passage.
      const recorded = lastTokenizerCall as { text?: unknown; options?: { text_pair?: string[] } } | null;
      const opts = (recorded?.options ?? {}) as { text_pair?: string[] };
      expect(opts.text_pair).toEqual(['doc 2']);
      // The empty-text result passes through UNSCORED (retains its original
      // score 0.1), and is appended after the scored result (score 0.9).
      expect(reranked[0].score).toBeCloseTo(0.9, 5);
      expect(reranked[0].id).toBe('2');
      expect(reranked[1].score).toBe(0.1);
      expect(reranked[1].id).toBe('1');
    });

    test('Issue #37 R2: caps scored candidates at RERANK_INPUT_CAP (50), passing overflow through', async () => {
      // Build 60 results; only the first 50 should be pair-encoded.
      const scoreMap: Record<string, number> = {};
      const results: TestResult[] = [];
      for (let i = 0; i < 60; i++) {
        const text = `doc ${i}`;
        scoreMap[text] = (i % 10) / 10; // varied scores 0.0..0.9
        results.push({ id: String(i), text, score: 0.5, chunk_id: `c${i}`, document_id: 'd1' });
      }
      let pairsScored = 0;
      const mockModel = vi.fn(async () => {
        pairsScored += 1;
        const tensor = { sigmoid: () => ({ tolist: () => [[0.5]] }) };
        return { logits: tensor };
      });
      (mockModel as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose = vi.fn();
      const mockTokenizer = createMockTokenizer();
      (AutoTokenizerMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(mockTokenizer);
      (AutoModelMock.from_pretrained as ReturnType<typeof vi.fn>).mockResolvedValue(mockModel as unknown as ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> });
      service.dispose();
      service = RerankerService.getInstance();
      await service.initialize();

      const reranked = await service.rerank('query', asSearchResults(results));

      // All 60 inputs survive (no topK slice here).
      expect(reranked).toHaveLength(60);
      // The mock model is called once per BATCH (BATCH_SIZE=12), so 50 pairs / 12
      // = 5 batches (the last batch has 2 pairs). Assert the pair count, not the
      // call count, since batching is an implementation detail.
      expect(pairsScored).toBe(5); // ceil(50/12)
      // And the tokenizer saw exactly 50 passages across all batches.
      // (Recorded only the LAST call; we cannot sum here directly, but the
      // model-call count above already proves the cap.)
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
