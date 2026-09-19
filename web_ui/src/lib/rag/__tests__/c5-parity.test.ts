// c5-parity.test.ts — C6 (issue #72) browser leg of the cross-backend parity
// check. Runs the SAME grounded fixture semantics as the Python leg in
// repro/c5_py_legs.py (one chunk in the final evidence set above the active
// relevance floor) and prints the emitted value as
//   BROWSER_GROUNDING=<value>
// on stdout. The frozen driver repro/check-c6.sh captures both values and
// fails unless they are present, valid, and equal.
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
vi.mock('../../search/vector-index', () => ({ getVectorIndex: vi.fn() }));
vi.mock('../../search/keyword-index', () => ({ getKeywordIndex: vi.fn() }));
vi.mock('../../search/rrf-fusion', () => ({ rrfFuse: vi.fn() }));
vi.mock('../../search/reranker', () => ({ getRerankerService: vi.fn() }));
vi.mock('../../llm/web-llm-service', () => ({
  WebLLMService: { getInstance: vi.fn() },
}));
vi.mock('../../llm/llm-factory', () => ({ getLLMService: vi.fn() }));
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

describe('C6: browser-side grounding for the parity fixture', () => {
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

  test('grounded fixture emits grounding and prints it for the parity driver', async () => {
    const mockEmbedding = createMockEmbedding();
    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: 'parity fixture question',
      dimensions: 768,
    });
    // Same fixture semantics as the Python leg: exactly one chunk, clearly
    // above the active relevance floor (RRF scale here; rerank disabled).
    const hits: SearchResult[] = [
      { docId: 'parity-doc', chunkIndex: 0, score: 0.5, text: 'Fixture passage for the parity question.' },
    ];
    mockVectorIndex.search.mockResolvedValue(hits);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(hits);
    mockWebLLMService.generateComplete.mockResolvedValue('Fixture answer.');

    const orchestrator = new RAGOrchestrator();
    let grounding: string | undefined;
    for await (const ev of orchestrator.query('parity fixture question', {
      streamTokens: false,
      rerank: false,
    })) {
      if (ev.type === 'complete') grounding = (ev.data as { grounding?: string }).grounding;
    }

    expect(grounding).toBe('grounded');
    // The parity driver greps this exact line from the captured output.
    console.log(`BROWSER_GROUNDING=${grounding}`);
  });
});
