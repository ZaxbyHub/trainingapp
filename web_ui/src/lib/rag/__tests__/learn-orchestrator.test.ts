/**
 * Learn-orchestrator integration tests (issue #82, D6) — FROZEN check C7.
 *
 * Exercises the REAL RAGOrchestrator.query flow end-to-end at component
 * level with the retrieval/LLM layers mocked, asserting the complete event
 * carries learn[] built from the cited chunks: a Storyline slide chunk
 * (source = slide filename) yields a direct hit; plain-doc chunks yield none.
 * Browser-side slide FILE ingestion is out of scope here (#76 owns pack
 * support on this surface) — the divergence is documented in the trace.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { SearchResult } from '../../../types/search';
import type { EmbeddingVector } from '../../../types/embedding';

const createMockEmbeddingService = () => ({
  encodeWithMetadata: vi.fn(),
  encodeBatch: vi.fn(),
  isReady: vi.fn().mockReturnValue(true),
});

const createMockVectorIndex = () => ({
  isReady: vi.fn().mockReturnValue(true),
  search: vi.fn(),
});

const createMockKeywordIndex = () => ({
  isReady: vi.fn().mockReturnValue(true),
  search: vi.fn(),
});

const createMockRerankerService = () => ({
  isReady: vi.fn().mockReturnValue(true),
  canRerank: vi.fn().mockReturnValue(true),
  rerank: vi.fn().mockResolvedValue([]),
});

const createMockLLMService = () => ({
  generate: vi.fn(),
  generateComplete: vi.fn(),
  isReady: vi.fn().mockReturnValue(true),
});

vi.mock('../../embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(),
}));

vi.mock('../../search/vector-index', () => ({
  getVectorIndex: vi.fn(),
}));

vi.mock('../../search/keyword-index', () => ({
  getKeywordIndex: vi.fn(),
}));

vi.mock('../../search/rrf-fusion', () => ({
  rrfFuse: vi.fn(),
}));

vi.mock('../../search/reranker', () => ({
  getRerankerService: vi.fn(),
}));

vi.mock('../../llm/llm-factory', () => ({
  getLLMService: vi.fn(),
}));

vi.mock('../../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn().mockResolvedValue(true),
  ensureReadinessGateChecked: vi.fn().mockResolvedValue({ ready: true }),
}));

import { RAGOrchestrator } from '../rag-orchestrator';
import { getEmbeddingService } from '../../embeddings/embedding-service';
import { getVectorIndex } from '../../search/vector-index';
import { getKeywordIndex } from '../../search/keyword-index';
import { getRerankerService } from '../../search/reranker';
import { rrfFuse } from '../../search/rrf-fusion';
import { getLLMService } from '../../llm/llm-factory';

const createMockEmbedding = (): EmbeddingVector => new Float32Array(768).fill(0.1);

const SLIDE_CHUNK: SearchResult = {
  docId: 'doc-slide',
  chunkIndex: 0,
  score: 0.91,
  source: 'slide-001-5rN4PvXJM5d.json',
  text: '[training-slide] section=Course Introduction | title=Welcome | slide_id=5rN4PvXJM5d\nStart\nOpMed CDP MicroLearning Companion',
};

const PLAIN_CHUNK: SearchResult = {
  docId: 'doc-policy',
  chunkIndex: 0,
  score: 0.6,
  source: 'travel-policy.md',
  text: 'Mileage reimbursement rules for personal car use.',
};

describe('RAGOrchestrator learn[] population (issue #82)', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockLLMService: ReturnType<typeof createMockLLMService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingService = createMockEmbeddingService();
    mockVectorIndex = createMockVectorIndex();
    mockKeywordIndex = createMockKeywordIndex();
    mockRerankerService = createMockRerankerService();
    mockLLMService = createMockLLMService();

    (getEmbeddingService as ReturnType<typeof vi.fn>).mockReturnValue(mockEmbeddingService);
    (getVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockVectorIndex);
    (getKeywordIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockKeywordIndex);
    (getRerankerService as ReturnType<typeof vi.fn>).mockReturnValue(mockRerankerService);
    (getLLMService as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMService);

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: createMockEmbedding(),
      degraded: false,
    });
    mockLLMService.generate.mockImplementation(async function* () {
      yield 'Answer ';
      yield 'text.';
    });

    // Single fused leg (the mock rrfFuse concatenates).
    mockVectorIndex.search.mockResolvedValue([SLIDE_CHUNK, PLAIN_CHUNK]);
    mockKeywordIndex.search.mockResolvedValue([]);
    (rrfFuse as unknown as ReturnType<typeof vi.fn>).mockImplementation((lists: SearchResult[][]) =>
      lists.flat().map((doc, index) => ({ ...doc, score: doc.score ?? 1 - index * 0.1 })),
    );
    mockRerankerService.canRerank.mockReturnValue(false);
  });

  test('complete event carries a direct learn hit for a slide-named cited chunk', async () => {
    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of orchestrator.query('Where is the companion introduced?')) {
      events.push(event as { type: string; data: Record<string, unknown> });
    }

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    const learn = complete!.data.learn as Array<{
      slide_id: string;
      title: string;
      section: string;
      score: number;
      reason: string;
      snippet?: string;
    }>;
    expect(Array.isArray(learn)).toBe(true);
    expect(learn).toHaveLength(1);
    expect(learn[0]).toMatchObject({
      slide_id: '5rN4PvXJM5d',
      title: 'Welcome',
      section: 'Course Introduction',
      reason: 'direct',
    });
    expect(learn[0].score).toBeGreaterThan(0);
    expect(learn[0].snippet).toContain('OpMed CDP');
  });

  test('learn is empty when no cited chunk is a training slide', async () => {
    mockVectorIndex.search.mockResolvedValue([PLAIN_CHUNK]);
    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of orchestrator.query('What is the mileage rate?')) {
      events.push(event as { type: string; data: Record<string, unknown> });
    }
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete!.data.learn).toEqual([]);
  });

  test('abstain complete event carries an empty learn array', async () => {
    mockVectorIndex.search.mockResolvedValue([]);
    mockKeywordIndex.search.mockResolvedValue([]);
    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of orchestrator.query('What is the mileage rate?')) {
      events.push(event as { type: string; data: Record<string, unknown> });
    }
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete!.data.abstain).toBe(true);
    expect(complete!.data.learn).toEqual([]);
  });
});
