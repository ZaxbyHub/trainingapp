// c5-orchestrator-grounding.test.ts — C5 (issue #72): the browser orchestrator
// emits grounding on every complete event: "general" when nothing survives the
// relevance floor + token budget (abstain path), "grounded" when evidence
// survives. Frozen check driver repro/check-c2.sh runs this file.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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

const createMockWebLLMService = () => ({
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

vi.mock('../../llm/web-llm-service', () => ({
  WebLLMService: { getInstance: vi.fn() },
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
import { ensureEmbeddingServiceReady, ensureReadinessGateChecked } from '../../../hooks/useServiceInitialization';

const createMockEmbedding = (): EmbeddingVector => new Float32Array(768).fill(0.1);

describe('C5: orchestrator grounding values', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockWebLLMService: ReturnType<typeof createMockWebLLMService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingService = createMockEmbeddingService();
    mockVectorIndex = createMockVectorIndex();
    mockKeywordIndex = createMockKeywordIndex();
    mockRerankerService = createMockRerankerService();
    mockWebLLMService = createMockWebLLMService();

    (getEmbeddingService as ReturnType<typeof vi.fn>).mockReturnValue(mockEmbeddingService);
    (getVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockVectorIndex);
    (getKeywordIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockKeywordIndex);
    (getRerankerService as ReturnType<typeof vi.fn>).mockReturnValue(mockRerankerService);
    (getLLMService as ReturnType<typeof vi.fn>).mockReturnValue(mockWebLLMService);
    (ensureEmbeddingServiceReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ensureReadinessGateChecked as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: true });
    (rrfFuse as ReturnType<typeof vi.fn>).mockImplementation((lists: SearchResult[][]) => {
      const combined: SearchResult[] = [];
      for (const list of lists) combined.push(...list);
      return combined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('abstain path (nothing survives floor+budget) grounds "general"', async () => {
    const mockEmbedding = createMockEmbedding();
    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: 'q',
      dimensions: 768,
    });
    // One hit with an explicitly sub-floor RRF score (MIN_RRF_SCORE = 0.005):
    // the F3 floor drops it, the pipeline abstains, and the complete event
    // must carry grounding "general".
    const weak: SearchResult[] = [{ docId: 'd', chunkIndex: 0, score: 0.0001, text: 't' }];
    mockVectorIndex.search.mockResolvedValue(weak);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(weak);

    const orchestrator = new RAGOrchestrator();
    const events: any[] = [];
    for await (const ev of orchestrator.query('out of corpus', { streamTokens: false, rerank: false })) {
      events.push(ev);
    }

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.data.abstain).toBe(true);
    expect(complete.data.grounding).toBe('general');
    // Suppressed learn: "general" yields no learn rows (contract semantics).
    expect(complete.data.learn).toEqual([]);
    expect(mockWebLLMService.generateComplete).not.toHaveBeenCalled();
  });

  test('surviving evidence grounds "grounded"', async () => {
    const mockEmbedding = createMockEmbedding();
    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: 'q',
      dimensions: 768,
    });
    // Chunk scores above MIN_RRF_SCORE so it survives the floor; rerank
    // disabled keeps the RRF scale.
    const hits: SearchResult[] = [
      { docId: 'doc-1', chunkIndex: 0, score: 0.5, text: 'Relevant passage about topic X.' },
    ];
    mockVectorIndex.search.mockResolvedValue(hits);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(hits);
    mockWebLLMService.generateComplete.mockResolvedValue('An answer grounded in the passage.');

    const orchestrator = new RAGOrchestrator();
    const events: any[] = [];
    for await (const ev of orchestrator.query('what about topic X?', { streamTokens: false, rerank: false })) {
      events.push(ev);
    }

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.data.abstain).toBeUndefined();
    expect(complete.data.grounding).toBe('grounded');
    expect(complete.data.chunks.length).toBe(1);
  });
});
