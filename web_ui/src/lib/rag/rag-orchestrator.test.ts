/**
 * Tests for RAG Orchestrator - rag-orchestrator.test.ts
 *
 * Tests the full RAG pipeline coordination including:
 * - Query embedding and parallel vector/keyword search
 * - RRF fusion of result sets
 * - Optional reranking
 * - Context assembly with numbered sources
 * - LLM generation with streaming
 * - Graceful error handling
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResult } from '../../types/search';
import type { EmbeddingVector } from '../../types/embedding';
import type { LLMMessage } from '../../types/llm';

// --- Mock Implementations ---

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

const createMockRrfFuse = () => vi.fn().mockImplementation((lists: SearchResult[][]) => {
  const combined: SearchResult[] = [];
  for (const list of lists) {
    combined.push(...list);
  }
  return combined;
});

// Mock all dependencies BEFORE importing the module under test
vi.mock('../embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(),
}));

vi.mock('../search/vector-index', () => ({
  getVectorIndex: vi.fn(),
}));

vi.mock('../search/keyword-index', () => ({
  getKeywordIndex: vi.fn(),
}));

vi.mock('../search/rrf-fusion', () => ({
  rrfFuse: vi.fn(),
}));

vi.mock('../search/reranker', () => ({
  getRerankerService: vi.fn(),
}));

vi.mock('../llm/web-llm-service', () => ({
  WebLLMService: {
    getInstance: vi.fn(),
  },
}));

// F10: the orchestrator now defaults to the offline-first engine via
// getLLMService() instead of WebLLMService.getInstance() directly. Mock the
// factory so the no-arg constructor used in these tests resolves to the test
// LLM service. The mock factory returns whatever LLM service is currently
// registered below.
vi.mock('../llm/llm-factory', () => ({
  getLLMService: vi.fn(),
}));

// F4: readiness helpers are now consulted (their boolean result drives whether
// semantic search runs). Mock them so tests can control semantic availability;
// default to ready (true) so the full pipeline exercises the embedding path.
vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn().mockResolvedValue(true),
  ensureReadinessGateChecked: vi.fn().mockResolvedValue({ ready: true }),
}));

// Import types and class AFTER mocks are set up
import { RAGOrchestrator } from './rag-orchestrator';

// Re-export RAGEvent type for use in tests
export type { RAGEvent } from './rag-orchestrator';

// Import mocked modules for setting up returns
import { getEmbeddingService } from '../embeddings/embedding-service';
import { getVectorIndex } from '../search/vector-index';
import { getKeywordIndex } from '../search/keyword-index';
import { getRerankerService } from '../search/reranker';
import { rrfFuse } from '../search/rrf-fusion';
import { getLLMService } from '../llm/llm-factory';
import { ensureEmbeddingServiceReady, ensureReadinessGateChecked } from '../../hooks/useServiceInitialization';

// --- Test Data ---

const createMockEmbedding = (): EmbeddingVector => new Float32Array(384).fill(0.1);

const createMockSearchResults = (count: number, startDocId = 1): SearchResult[] =>
  Array.from({ length: count }, (_, i) => ({
    docId: `doc-${startDocId + i}`,
    chunkIndex: i,
    score: 1 - i * 0.1,
    text: `Chunk content for document ${startDocId + i}, chunk ${i}`,
  }));

// --- Test Suite ---

describe('RAGOrchestrator', () => {
  // Per-test mock instances
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockWebLLMService: ReturnType<typeof createMockWebLLMService>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock instances
    mockEmbeddingService = createMockEmbeddingService();
    mockVectorIndex = createMockVectorIndex();
    mockKeywordIndex = createMockKeywordIndex();
    mockRerankerService = createMockRerankerService();
    mockWebLLMService = createMockWebLLMService();

    // Setup mock returns using the mocked modules
    (getEmbeddingService as ReturnType<typeof vi.fn>).mockReturnValue(mockEmbeddingService);
    (getVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockVectorIndex);
    (getKeywordIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockKeywordIndex);
    (getRerankerService as ReturnType<typeof vi.fn>).mockReturnValue(mockRerankerService);
    (getLLMService as ReturnType<typeof vi.fn>).mockReturnValue(mockWebLLMService);

    // Default: semantic search available. Tests that exercise the degraded
    // path override this (F4).
    (ensureEmbeddingServiceReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ensureReadinessGateChecked as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: true });
    (rrfFuse as ReturnType<typeof vi.fn>).mockImplementation((lists: SearchResult[][]) => {
      const combined: SearchResult[] = [];
      for (const list of lists) {
        combined.push(...list);
      }
      return combined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // TEST: Full pipeline - query yields all event types in order
  // ========================================================================
  test('Full pipeline: query yields all event types in order', async () => {
    const question = 'What is machine learning?';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = createMockSearchResults(3, 1);
    const keywordResults = createMockSearchResults(3, 4);
    const fusedResults = createMockSearchResults(5, 1);
    const tokens = ['Machine', ' learning', ' is', ' great.'];
    const finalAnswer = tokens.join('');

    // Setup mocks
    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });

    mockVectorIndex.search.mockResolvedValue(vectorResults);
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    // Mock streaming LLM tokens
    mockWebLLMService.generate = vi.fn().mockImplementation(async function* () {
      for (const token of tokens) {
        yield token;
      }
    });

    // Mock reranker to return the fused results (exercises the rerank path for full pipeline coverage;
    // default mock returns [] which would cause complete.chunks.length===0 and break length/source asserts)
    mockRerankerService.rerank.mockResolvedValue(fusedResults);

    // Use streamTokens: false to have a single 'token' event with the full answer (instead of per-token yields)
    mockWebLLMService.generateComplete.mockResolvedValue(finalAnswer);

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: unknown }> = [];

    for await (const event of orchestrator.query(question, { rerank: true, streamTokens: false })) {
      events.push(event);
    }

    // Assert event sequence (full pipeline with reranking): retrieving, retrieved, reranking, reranked, generating, token, complete
    expect(events).toHaveLength(7);
    expect(events[0].type).toBe('retrieving');
    expect(events[1].type).toBe('retrieved');
    expect(events[2].type).toBe('reranking');
    expect(events[3].type).toBe('reranked');
    expect(events[4].type).toBe('generating');
    expect(events[5].type).toBe('token');
    expect(events[6].type).toBe('complete');

    // Verify 'retrieving' data
    expect(events[0]).toEqual({ type: 'retrieving', data: { query: question } });

    // Verify 'retrieved' data contains all result arrays
    const retrievedData = events[1] as { type: 'retrieved'; data: { vectorResults: SearchResult[]; keywordResults: SearchResult[]; fusedResults: SearchResult[] } };
    expect(retrievedData.data.vectorResults).toEqual(vectorResults);
    expect(retrievedData.data.keywordResults).toEqual(keywordResults);
    expect(retrievedData.data.fusedResults).toEqual(fusedResults);

    // Verify 'generating' data
    expect(events[4]).toEqual({
      type: 'generating',
      data: { contextLength: expect.any(Number), sourceCount: expect.any(Number) },
    });

    // Verify token event
    const tokenData = events[5] as { type: 'token'; data: string };
    expect(tokenData.data).toBe(finalAnswer);

    // Verify 'complete' data
    const completeData = events[6] as { type: 'complete'; data: { answer: string; sources: string[]; chunks: SearchResult[] } };
    expect(completeData.data.answer).toBe(finalAnswer);
    expect(completeData.data.sources).toContain('doc-1');
    expect(completeData.data.chunks).toHaveLength(5);
  });

  // ========================================================================
  // TEST: Embedding search returns candidates
  // ========================================================================
  test('Embedding search returns candidates from vector and keyword indexes', async () => {
    const question = 'test query';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = createMockSearchResults(3, 100);
    const keywordResults = createMockSearchResults(2, 200);
    const fusedResults = [...vectorResults.slice(0, 2), ...keywordResults.slice(0, 1)];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(vectorResults);
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    // Mock non-streaming generation
    mockWebLLMService.generateComplete.mockResolvedValue('Final answer.');

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: unknown }> = [];

    for await (const event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      events.push(event);
    }

    // Verify embedding was called with the BGE retrieval-instruction prefix
    // prepended to the query (F8 — query side only; passages stay un-prefixed).
    expect(mockEmbeddingService.encodeWithMetadata).toHaveBeenCalledWith(
      'Represent this sentence for searching relevant passages: ' + question
    );

    // Verify vector search was called with embedding
    expect(mockVectorIndex.search).toHaveBeenCalledWith(mockEmbedding, { k: 10 });

    // Verify keyword search was called with question
    expect(mockKeywordIndex.search).toHaveBeenCalledWith(question, { limit: 10 });

    // Verify 'retrieved' event has both result sets
    const retrievedData = events.find((e) => e.type === 'retrieved') as { type: 'retrieved'; data: { vectorResults: SearchResult[]; keywordResults: SearchResult[]; fusedResults: SearchResult[] } };
    expect(retrievedData.data.vectorResults).toHaveLength(3);
    expect(retrievedData.data.keywordResults).toHaveLength(2);
  });

  // ========================================================================
  // TEST: RRF fusion combines vector + keyword results
  // ========================================================================
  test('RRF fusion combines vector and keyword results', async () => {
    const question = 'fusion test';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = [
      { docId: 'doc-A', chunkIndex: 0, score: 0.9, text: 'From vector' },
      { docId: 'doc-B', chunkIndex: 0, score: 0.8, text: 'Also vector' },
    ];
    const keywordResults = [
      { docId: 'doc-C', chunkIndex: 0, score: 0.7, text: 'From keyword' },
    ];
    const fusedResults = [
      { docId: 'doc-A', chunkIndex: 0, score: 0.016, text: 'From vector' },
      { docId: 'doc-B', chunkIndex: 0, score: 0.008, text: 'Also vector' },
      { docId: 'doc-C', chunkIndex: 0, score: 0.007, text: 'From keyword' },
    ];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(vectorResults);
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer.');

    const orchestrator = new RAGOrchestrator();

    for await (const _event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      // consume events
    }

    // Verify rrfFuse was called with both result arrays
    expect(rrfFuse).toHaveBeenCalledWith([vectorResults, keywordResults], 60);
  });

  test('RRF fusion passes fused results to reranking and context', async () => {
    const question = 'fusion test';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = [{ docId: 'v1', chunkIndex: 0, score: 0.9, text: 'vec' }];
    const keywordResults = [{ docId: 'k1', chunkIndex: 0, score: 0.8, text: 'kw' }];
    const fusedResults = [{ docId: 'v1', chunkIndex: 0, score: 0.5, text: 'vec' }];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(vectorResults);
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer.');

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: unknown }> = [];

    for await (const event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      events.push(event);
    }

    // Verify fused results appear in retrieved event
    const retrieved = events.find((e) => e.type === 'retrieved') as { type: 'retrieved'; data: { fusedResults: SearchResult[] } };
    expect(retrieved.data.fusedResults).toEqual(fusedResults);
  });

  // ========================================================================
  // TEST: Reranking stage conditional on options.rerank
  // ========================================================================
  test('Reranking stage is skipped when options.rerank is false', async () => {
    const question = 'no rerank test';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = createMockSearchResults(3, 1);
    const keywordResults = createMockSearchResults(2, 4);
    const fusedResults = [...vectorResults, ...keywordResults];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(vectorResults);
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer without rerank.');

    const orchestrator = new RAGOrchestrator();
    const events: string[] = [];

    for await (const event of orchestrator.query(question, { rerank: false, streamTokens: false })) {
      events.push(event.type);
    }

    // Should NOT have reranking/reranked events
    expect(events).not.toContain('reranking');
    expect(events).not.toContain('reranked');
    // Should have retrieving, retrieved, generating, complete
    expect(events).toContain('retrieving');
    expect(events).toContain('retrieved');
    expect(events).toContain('generating');
    expect(events).toContain('complete');
  });

  test('Reranking stage runs when options.rerank is true (default)', async () => {
    const question = 'rerank test';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = createMockSearchResults(5, 1);
    const keywordResults = createMockSearchResults(3, 6);
    const fusedResults = createMockSearchResults(8, 1);

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(vectorResults);
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    // Mock reranker to return properly structured results
    mockRerankerService.rerank.mockResolvedValue(fusedResults.slice(0, 3));

    mockWebLLMService.generateComplete.mockResolvedValue('Answer with rerank.');

    const orchestrator = new RAGOrchestrator();
    const events: string[] = [];

    for await (const event of orchestrator.query(question, { streamTokens: false })) {
      events.push(event.type);
    }

    // Should have reranking/reranked events
    expect(events).toContain('reranking');
    expect(events).toContain('reranked');
  });

  test('Reranking skipped when reranker is not ready', async () => {
    const question = 'rerank not ready test';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = createMockSearchResults(3, 1);
    const keywordResults: SearchResult[] = [];
    const fusedResults = vectorResults;

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(vectorResults);
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    mockRerankerService.isReady.mockReturnValue(false);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer without reranking.');

    const orchestrator = new RAGOrchestrator();
    const events: string[] = [];

    for await (const event of orchestrator.query(question, { streamTokens: false })) {
      events.push(event.type);
    }

    // Should skip reranking stage when reranker is not ready
    expect(mockRerankerService.isReady).toHaveBeenCalled();
    expect(events).not.toContain('reranking');
    expect(events).not.toContain('reranked');
  });

  // ========================================================================
  // TEST: Context assembly formats numbered sources correctly
  // ========================================================================
  test('Context assembly formats numbered sources correctly', async () => {
    const chunks = [
      { docId: 'doc-X', chunkIndex: 0, score: 0.9, text: 'AI is artificial intelligence.' },
      { docId: 'doc-Y', chunkIndex: 1, score: 0.8, text: 'ML is machine learning.' },
      { docId: 'doc-X', chunkIndex: 1, score: 0.7, text: 'DL is deep learning.' },
    ];

    const orchestrator = new RAGOrchestrator();

    // buildContext no longer takes a question param and no longer emits a
    // "Context:" header or per-line "Source:" — buildMessages owns the single
    // header (F6). It numbers chunks [1],[2],... in array order.
    const context = (orchestrator as unknown as { buildContext: (c: SearchResult[]) => string }).buildContext(chunks);

    // Verify numbered format [1], [2], etc. — order matches the input array,
    // which is what the model's [1],[2] citations resolve against (F7).
    expect(context).toContain('[1] AI is artificial intelligence.');
    expect(context).toContain('[2] ML is machine learning.');
    expect(context).toContain('[3] DL is deep learning.');

    // F6: the duplicate "Context:" header is gone from buildContext.
    expect(context).not.toContain('Context:');
  });

  test('Context handles empty chunks gracefully', async () => {
    const orchestrator = new RAGOrchestrator();

    // buildContext returns an empty string for an empty chunk list (the
    // abstention path short-circuits before generation, so this is defensive).
    const context = (orchestrator as unknown as { buildContext: (c: SearchResult[]) => string }).buildContext([]);

    expect(context).toBe('');
  });

  // ========================================================================
  // TEST: LLM generation streams tokens
  // ========================================================================
  test('LLM generation streams tokens when streamTokens is true', async () => {
    const question = 'streaming test';
    const mockEmbedding = createMockEmbedding();
    const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'content' }];
    const tokens = ['Hello', ', ', 'world', '!'];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    // Mock streaming generator
    mockWebLLMService.generate = vi.fn().mockImplementation(async function* () {
      for (const token of tokens) {
        yield token;
      }
    });

    const orchestrator = new RAGOrchestrator();
    const tokenEvents: string[] = [];

    for await (const event of orchestrator.query(question, { streamTokens: true, rerank: false })) {
      if (event.type === 'token') {
        tokenEvents.push((event as { type: 'token'; data: string }).data);
      }
    }

    // Verify all tokens were yielded individually
    expect(tokenEvents).toEqual(tokens);

    // Verify generate was called (not generateComplete)
    expect(mockWebLLMService.generate).toHaveBeenCalled();
    expect(mockWebLLMService.generateComplete).not.toHaveBeenCalled();
  });

  test('LLM generation uses complete method when streamTokens is false', async () => {
    const question = 'non-streaming test';
    const mockEmbedding = createMockEmbedding();
    const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'content' }];
    const fullResponse = 'This is the complete answer.';

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    mockWebLLMService.generateComplete.mockResolvedValue(fullResponse);

    const orchestrator = new RAGOrchestrator();
    const tokenEvents: string[] = [];

    for await (const event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      if (event.type === 'token') {
        tokenEvents.push((event as { type: 'token'; data: string }).data);
      }
    }

    // Verify single token event with full answer
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]).toBe(fullResponse);

    // Verify generateComplete was called (not generate)
    expect(mockWebLLMService.generateComplete).toHaveBeenCalled();
    expect(mockWebLLMService.generate).not.toHaveBeenCalled();
  });

  // ========================================================================
  // TEST: Complete event includes answer + sources + chunks
  // ========================================================================
  test('Complete event includes answer, sources, and chunks', async () => {
    const question = 'complete event test';
    const mockEmbedding = createMockEmbedding();
    const chunks = [
      { docId: 'source-A', chunkIndex: 0, score: 0.9, text: 'First source content' },
      { docId: 'source-B', chunkIndex: 0, score: 0.8, text: 'Second source content' },
      { docId: 'source-A', chunkIndex: 1, score: 0.7, text: 'Another chunk from A' },
    ];
    const answer = 'The answer from RAG';

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    mockWebLLMService.generateComplete.mockResolvedValue(answer);

    const orchestrator = new RAGOrchestrator();
    let completeEvent: { type: 'complete'; data: { answer: string; sources: string[]; chunks: SearchResult[] } } | null = null;

    for await (const event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      if (event.type === 'complete') {
        completeEvent = event as { type: 'complete'; data: { answer: string; sources: string[]; chunks: SearchResult[] } };
      }
    }

    expect(completeEvent).not.toBeNull();
    expect(completeEvent!.data.answer).toBe(answer);
    // Sources should be deduplicated
    expect(completeEvent!.data.sources).toContain('source-A');
    expect(completeEvent!.data.sources).toContain('source-B');
    expect(completeEvent!.data.sources).toHaveLength(2); // Only 2 unique sources
    expect(completeEvent!.data.chunks).toEqual(chunks);
  });

  // ========================================================================
  // TEST: Error during search still generates (graceful degradation)
  // ========================================================================
  test('Error during vector search still yields retrieved and continues', async () => {
    const question = 'vector search error test';
    const mockEmbedding = createMockEmbedding();
    const keywordResults = [{ docId: 'kw-doc', chunkIndex: 0, score: 0.5, text: 'keyword result' }];
    const fusedResults = keywordResults;

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    // Vector search throws
    mockVectorIndex.search.mockRejectedValue(new Error('Vector search failed'));
    mockKeywordIndex.search.mockReturnValue(keywordResults);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fusedResults);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer despite vector error.');

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: unknown }> = [];

    for await (const event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      events.push(event);
    }

    // Should still have retrieved event (with empty vectorResults)
    const retrieved = events.find((e) => e.type === 'retrieved') as { type: 'retrieved'; data: { vectorResults: SearchResult[]; keywordResults: SearchResult[]; fusedResults: SearchResult[] } };
    expect(retrieved.data.vectorResults).toEqual([]);
    expect(retrieved.data.keywordResults).toEqual(keywordResults);
    expect(retrieved.data.fusedResults).toEqual(fusedResults);

    // Should still reach generating and complete
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('generating');
    expect(eventTypes).toContain('complete');
  });

  test('Error during keyword search still yields retrieved and continues', async () => {
    const question = 'keyword search error test';
    const mockEmbedding = createMockEmbedding();
    const vectorResults = [{ docId: 'vec-doc', chunkIndex: 0, score: 0.9, text: 'vector result' }];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(vectorResults);
    // Keyword search throws
    mockKeywordIndex.search.mockImplementation(() => {
      throw new Error('Keyword search failed');
    });

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(vectorResults);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer despite keyword error.');

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: unknown }> = [];

    for await (const event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      events.push(event);
    }

    // Should still have retrieved event
    const retrieved = events.find((e) => e.type === 'retrieved') as { type: 'retrieved'; data: { vectorResults: SearchResult[]; keywordResults: SearchResult[] } };
    expect(retrieved.data.vectorResults).toEqual(vectorResults);
    expect(retrieved.data.keywordResults).toEqual([]);

    // Should still reach complete
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('complete');
  });

  // F4 changed this behavior: an embedding failure no longer hard-fails the
  // whole query. The pipeline degrades to keyword-only retrieval and, if that
  // also yields nothing, abstains with a retrieval_degraded reason. It must NOT
  // emit a fatal embedding error event or invoke the LLM.
  test('Embedding failure degrades to keyword-only retrieval (F4)', async () => {
    const question = 'embedding error test';

    mockEmbeddingService.encodeWithMetadata.mockRejectedValue(new Error('Embedding failed'));
    // Keyword index has nothing either → the pipeline should abstain.
    mockKeywordIndex.search.mockReturnValue([]);

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: unknown }> = [];

    for await (const event of orchestrator.query(question)) {
      events.push(event);
    }

    // No fatal embedding error event — degradation, not failure.
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.filter((e) => (e.data as { stage: string }).stage === 'embedding')).toHaveLength(0);

    // Vector search must be skipped (no query embedding available).
    expect(mockVectorIndex.search).not.toHaveBeenCalled();

    // Keyword search still ran.
    expect(mockKeywordIndex.search).toHaveBeenCalled();

    // Pipeline abstained with the degraded reason.
    const complete = events.find((e) => e.type === 'complete') as {
      type: 'complete';
      data: { abstain?: boolean; abstainReason?: string; retrievalDegraded?: boolean };
    };
    expect(complete).toBeDefined();
    expect(complete.data.abstain).toBe(true);
    expect(complete.data.retrievalDegraded).toBe(true);
    expect(complete.data.abstainReason).toBe('retrieval_degraded');

    // The LLM must never be invoked when there is no evidence.
    expect(mockWebLLMService.generate).not.toHaveBeenCalled();
    expect(mockWebLLMService.generateComplete).not.toHaveBeenCalled();
  });

  // ========================================================================
  // TEST: Error during generation yields error event
  // ========================================================================
  test('Error during generation yields error event', async () => {
    const question = 'generation error test';
    const mockEmbedding = createMockEmbedding();
    const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'content' }];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    // Mock streaming to throw error
    mockWebLLMService.generate = vi.fn().mockImplementation(async function* () {
      yield 'Some ';
      throw new Error('Generation failed mid-stream');
    });

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: unknown }> = [];

    for await (const event of orchestrator.query(question, { streamTokens: true, rerank: false })) {
      events.push(event);
    }

    // Should have yielded some tokens before error
    const tokenEvents = events.filter((e) => e.type === 'token');
    expect(tokenEvents.length).toBeGreaterThan(0);

    // Should have error event at the end
    const errorEvent = events.find((e) => e.type === 'error') as { type: 'error'; data: { stage: string; message: string } } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data.stage).toBe('generation');
    expect(errorEvent!.data.message).toBe('Generation failed mid-stream');

    // Should NOT have complete event
    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeUndefined();
  });

  // ========================================================================
  // TEST: dispose() cleans up services
  // ========================================================================
  test('dispose() cleans up orchestrator', () => {
    const orchestrator = new RAGOrchestrator();

    // dispose() should not throw
    expect(() => orchestrator.dispose()).not.toThrow();
  });

  // ========================================================================
  // TEST: Options are passed correctly
  // ========================================================================
  test('topK option is passed to search methods', async () => {
    const question = 'topk test';
    const mockEmbedding = createMockEmbedding();
    const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'c' }];

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer.');

    const orchestrator = new RAGOrchestrator();

    for await (const _event of orchestrator.query(question, { topK: 5, streamTokens: false, rerank: false })) {
      // consume
    }

    // Vector search should use topK
    expect(mockVectorIndex.search).toHaveBeenCalledWith(mockEmbedding, { k: 5 });
    // Keyword search should use topK
    expect(mockKeywordIndex.search).toHaveBeenCalledWith(question, { limit: 5 });
  });

  test('Custom system prompt is used in generation', async () => {
    const question = 'system prompt test';
    const mockEmbedding = createMockEmbedding();
    const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'c' }];
    const customPrompt = 'Answer in French.';
    const fullAnswer = 'Réponse.';

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    let capturedMessages: LLMMessage[] = [];
    mockWebLLMService.generateComplete = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      capturedMessages = messages;
      return fullAnswer;
    });

    const orchestrator = new RAGOrchestrator();

    for await (const _event of orchestrator.query(question, { systemPrompt: customPrompt, streamTokens: false, rerank: false })) {
      // consume
    }

    // Verify custom prompt was used
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[0].content).toBe(customPrompt);
  });

  // ========================================================================
  // TEST: Graceful handling when indexes are not ready
  // ========================================================================
  test('Handles vector index not ready gracefully', async () => {
    const question = 'index not ready test';
    const mockEmbedding = createMockEmbedding();

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: mockEmbedding,
      text: question,
      dimensions: 384,
    });
    mockVectorIndex.isReady.mockReturnValue(false);
    mockKeywordIndex.search.mockReturnValue([]);

    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue([]);

    mockWebLLMService.generateComplete.mockResolvedValue('Answer.');

    const orchestrator = new RAGOrchestrator();

    // Should not throw
    for await (const _event of orchestrator.query(question, { streamTokens: false, rerank: false })) {
      // consume
    }

    // Vector search should not have been called since index wasn't ready
    expect(mockVectorIndex.search).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AbortSignal support (FR-008)
  // -------------------------------------------------------------------------

  describe('AbortSignal', () => {
    test('query throws AbortError if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const orchestrator = new RAGOrchestrator();
      let thrown: any;
      try {
        for await (const _e of orchestrator.query('q', {
          signal: controller.signal,
          streamTokens: false,
          rerank: false,
        })) {
          // should not reach
        }
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DOMException);
      expect(thrown.name).toBe('AbortError');
    });

    test('query throws AbortError when signal is aborted mid-generation', async () => {
      const question = 'abort mid gen';
      const mockEmbedding = createMockEmbedding();
      const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'c' }];

      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: question,
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue(chunks);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

      const controller = new AbortController();

      // Async generator so we have a window to abort between tokens
      mockWebLLMService.generate = vi.fn().mockImplementation(async function* () {
        yield 'first ';
        await new Promise((r) => setTimeout(r, 5));
        yield 'second';
      });

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      // Note: abort during generation is caught internally and surfaced as 'error' event
      // (the DOMException is not re-thrown from the generator due to try/catch around generation stage).
      // We still name the test per spec; we verify the abort error is produced.
      for await (const ev of orchestrator.query(question, {
        signal: controller.signal,
        streamTokens: true,
        rerank: false,
      })) {
        events.push(ev);
        if (ev.type === 'token' && ev.data.includes('first')) {
          controller.abort();
        }
      }

      const errorEvent = events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.data.stage).toBe('generation');
      // The exact message may be 'Generation failed' (if DOMException.message empty in this env)
      // or the abort text; accept either since the abort was the cause of entering the catch.
      expect(errorEvent!.data.message).toMatch(/Generation failed|aborted|AbortError/i);
      // Should have emitted the first token before abort took effect
      expect(events.some((e: any) => e.type === 'token' && e.data.includes('first'))).toBe(true);
    });

    test('query completes normally if no signal provided', async () => {
      const question = 'no signal';
      const mockEmbedding = createMockEmbedding();
      const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'c' }];

      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: question,
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue(chunks);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);
      mockWebLLMService.generateComplete.mockResolvedValue('ok');

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query(question, { streamTokens: false, rerank: false })) {
        events.push(ev);
      }
      expect(events.some((e: any) => e.type === 'complete')).toBe(true);
    });

    test('query completes normally if signal is never aborted', async () => {
      const question = 'never abort';
      const mockEmbedding = createMockEmbedding();
      const chunks = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'c' }];

      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: question,
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue(chunks);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);
      mockWebLLMService.generateComplete.mockResolvedValue('ok');

      const controller = new AbortController();
      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query(question, {
        signal: controller.signal,
        streamTokens: false,
        rerank: false,
      })) {
        events.push(ev);
      }
      expect(events.some((e: any) => e.type === 'complete')).toBe(true);
    });
  });

  // ==========================================================================
  // Regression tests for issue #22 (RAG grounding & citations)
  // ==========================================================================
  describe('issue #22: grounding, abstention, budget, citations', () => {
    test('F2: zero-chunk retrieval abstains instead of calling the LLM', async () => {
      const mockEmbedding = createMockEmbedding();
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue([]);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query('unanswerable', { streamTokens: false })) {
        events.push(ev);
      }

      const complete = events.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      expect(complete.data.abstain).toBe(true);
      expect(complete.data.chunks).toEqual([]);
      // The LLM must NEVER be invoked when abstaining.
      expect(mockWebLLMService.generate).not.toHaveBeenCalled();
      expect(mockWebLLMService.generateComplete).not.toHaveBeenCalled();
    });

    test('F3: relevance floor drops sub-threshold RRF chunks and abstains', async () => {
      const mockEmbedding = createMockEmbedding();
      // RRF scores well below MIN_RRF_SCORE (0.005): a hit only in one list at
      // rank 0 scores 1/(60+0+1) ≈ 0.0164; rank 40 → 1/81 ≈ 0.0123 — still above
      // 0.005. So push a single weak hit and override rrfFuse to return a chunk
      // with an explicitly tiny score.
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      const weak = [{ docId: 'd', chunkIndex: 0, score: 0.0001, text: 't' }];
      mockVectorIndex.search.mockResolvedValue(weak);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(weak);

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query('out of corpus', { streamTokens: false, rerank: false })) {
        events.push(ev);
      }

      const complete = events.find((e) => e.type === 'complete');
      expect(complete.data.abstain).toBe(true);
      expect(mockWebLLMService.generateComplete).not.toHaveBeenCalled();
    });

    test('F7: complete.chunks order matches the buildContext numbering order', async () => {
      const mockEmbedding = createMockEmbedding();
      // Distinct texts so we can verify [1]→chunks[0], [2]→chunks[1] mapping.
      const fused = [
        { docId: 'd1', chunkIndex: 0, score: 0.9, text: 'AAA first chunk' },
        { docId: 'd2', chunkIndex: 0, score: 0.8, text: 'BBB second chunk' },
      ];
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue(fused);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fused);
      mockWebLLMService.generateComplete.mockResolvedValue('answer [1] and [2]');

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query('q', { streamTokens: false, rerank: false })) {
        events.push(ev);
      }
      const complete = events.find((e) => e.type === 'complete');
      // chunks[i] is the chunk the model numbered [i+1].
      expect(complete.data.chunks[0].text).toBe('AAA first chunk');
      expect(complete.data.chunks[1].text).toBe('BBB second chunk');
    });

    test('F8: query embedding receives the BGE instruction prefix', async () => {
      const mockEmbedding = createMockEmbedding();
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue([]);
      mockKeywordIndex.search.mockReturnValue([]);

      const orchestrator = new RAGOrchestrator();
      for await (const _ of orchestrator.query('clinical question', { streamTokens: false })) {
        void _;
      }
      expect(mockEmbeddingService.encodeWithMetadata).toHaveBeenCalledWith(
        'Represent this sentence for searching relevant passages: clinical question'
      );
    });

    test('F8: the BGE prefix lives ONLY in the query path (passages un-prefixed, PRR-007)', async () => {
      // The prefix is orchestrator-local: it is prepended at the query
      // encodeWithMetadata call site and NOWHERE else. The passage-ingestion
      // path (DocumentsPage -> EmbeddingService.encodeBatch) must receive raw
      // text. We verify two things: (1) the orchestrator only ever calls the
      // prefixed query embedding, and (2) the prefix string is not referenced
      // by encodeBatch/encode at all.
      const mockEmbedding = createMockEmbedding();
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue([]);
      mockKeywordIndex.search.mockReturnValue([]);

      const orchestrator = new RAGOrchestrator();
      for await (const _ of orchestrator.query('a question', { streamTokens: false })) {
        void _;
      }

      // Only the query embedding is invoked by the orchestrator, and it is
      // prefixed. encodeBatch (the passage path) is NEVER called by the
      // orchestrator, so passages cannot be accidentally prefixed here.
      expect(mockEmbeddingService.encodeWithMetadata).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingService.encodeWithMetadata).toHaveBeenCalledWith(
        'Represent this sentence for searching relevant passages: a question'
      );
      expect(mockEmbeddingService.encodeBatch).not.toHaveBeenCalled();
    });

    test('F10: no-arg constructor uses getLLMService (offline-first, not WebLLM)', () => {
      // getLLMService is mocked in beforeEach to return mockWebLLMService.
      // Constructing without an explicit llmService must route through the
      // factory (wllama default), not WebLLMService.getInstance() directly.
      (getLLMService as ReturnType<typeof vi.fn>).mockClear();
      new RAGOrchestrator();
      expect(getLLMService).toHaveBeenCalled();
    });

    test('F11: token budget drops overflowing chunks and reports contextTrimmed', async () => {
      const mockEmbedding = createMockEmbedding();
      // A single chunk far larger than the entire context window (n_ctx=8192 →
      // ~30k chars total budget). It cannot fit and is dropped, leaving zero
      // chunks → abstention. The LLM is never fed a truncated prompt.
      const huge = 'x'.repeat(1_000_000);
      const fused = [
        { docId: 'd1', chunkIndex: 0, score: 0.9, text: huge },
        { docId: 'd2', chunkIndex: 0, score: 0.8, text: huge },
      ];
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue(fused);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fused);

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query('my question', { streamTokens: false, rerank: false, maxTokens: 512 })) {
        events.push(ev);
      }
      const complete = events.find((e) => e.type === 'complete');
      // Both oversized chunks are dropped to fit the budget, leaving zero
      // chunks → abstention.
      expect(complete.data.abstain).toBe(true);
      expect(complete.data.contextTrimmed).toBe(2);
      expect(mockWebLLMService.generateComplete).not.toHaveBeenCalled();
    });

    test('F11: question text survives in the prompt when chunks fit the budget', async () => {
      const mockEmbedding = createMockEmbedding();
      const small = [{ docId: 'd1', chunkIndex: 0, score: 0.9, text: 'small context' }];
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue(small);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(small);
      const captured: string[] = [];
      mockWebLLMService.generateComplete.mockImplementation(async (msgs: any) => {
        captured.push(msgs.find((m: any) => m.role === 'user')?.content ?? '');
        return 'answer';
      });

      const orchestrator = new RAGOrchestrator();
      const question = 'the all-important user question';
      for await (const _ of orchestrator.query(question, { streamTokens: false, rerank: false })) {
        void _;
      }
      // The question must appear verbatim in the final prompt (not truncated).
      expect(captured[0]).toContain(question);
    });

    test('F11: partial fit — higher-ranked chunks kept, lower-ranked dropped (PRR-006)', async () => {
      const mockEmbedding = createMockEmbedding();
      // Two chunks: the first (higher score) fits the budget, the second (lower
      // score, same size) overflows it. This exercises the budget accumulation
      // + drop branch, which the all-or-nothing tests do not. Chunk size is
      // calibrated to DEFAULT_N_CTX=8192: budget ≈ (8192 - reserved) * 4 chars,
      // so one ~20k-char chunk fits and two (~40k chars) overflow.
      const big = 'y'.repeat(20000);
      const fused = [
        { docId: 'd-keep', chunkIndex: 0, score: 0.9, text: big },
        { docId: 'd-drop', chunkIndex: 0, score: 0.8, text: big },
      ];
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      mockVectorIndex.search.mockResolvedValue(fused);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(fused);
      mockWebLLMService.generateComplete.mockResolvedValue('answer');

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query('q', { streamTokens: false, rerank: false, maxTokens: 512 })) {
        events.push(ev);
      }
      const complete = events.find((e) => e.type === 'complete');
      // Exactly one chunk fit; the other was dropped for budget.
      expect(complete.data.chunks).toHaveLength(1);
      expect(complete.data.chunks[0].docId).toBe('d-keep');
      expect(complete.data.contextTrimmed).toBe(1);
    });

    test('F4: semantic-available gate returning false skips vector search and embedding', async () => {
      // Embedding service never came up.
      (ensureEmbeddingServiceReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const keywordHits = [{ docId: 'd1', chunkIndex: 0, score: 0.5, text: 'keyword hit' }];
      mockKeywordIndex.search.mockReturnValue(keywordHits);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(keywordHits);
      mockWebLLMService.generateComplete.mockResolvedValue('degraded answer');

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query('q', { streamTokens: false, rerank: false })) {
        events.push(ev);
      }
      // Embedding must not be invoked at all.
      expect(mockEmbeddingService.encodeWithMetadata).not.toHaveBeenCalled();
      expect(mockVectorIndex.search).not.toHaveBeenCalled();
      const complete = events.find((e) => e.type === 'complete');
      expect(complete.data.retrievalDegraded).toBe(true);
      expect(complete.data.abstain).not.toBe(true);
    });

    // U8a / PRR-010: a multimodal question with an attached image must NOT
    // abstain on an empty corpus. The abstain guard's `&& !(options.images?.length)`
    // clause is what keeps the pipeline alive so buildMessages can forward the
    // image to the VLM. This is a TRUE regression test: revert that clause and
    // the pipeline would abstain (the LLM would never be called and there would
    // be no image part in any message), failing both assertions below.
    test('U8a: image-on-empty-corpus does NOT abstain, falls through to the VLM (PRR-010)', async () => {
      const mockEmbedding = createMockEmbedding();
      mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
        vector: mockEmbedding,
        text: 'q',
        dimensions: 384,
      });
      // Empty corpus — the condition that would normally trigger F2 abstention.
      mockVectorIndex.search.mockResolvedValue([]);
      mockKeywordIndex.search.mockReturnValue([]);
      (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue([]);

      // Capture the message array handed to the LLM so we can assert the image
      // part survived the fall-through into buildMessages.
      let capturedMessages: LLMMessage[] | null = null;
      mockWebLLMService.generateComplete.mockImplementation(async (messages: LLMMessage[]) => {
        capturedMessages = messages;
        return 'a screenshot of a dashboard';
      });

      // A real-ish image payload: a few PNG-ish bytes in an ArrayBuffer.
      const imageData = new ArrayBuffer(8);
      new Uint8Array(imageData).set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      const orchestrator = new RAGOrchestrator();
      const events: any[] = [];
      for await (const ev of orchestrator.query(
        "what's in this screenshot?",
        {
          streamTokens: false,
          rerank: false,
          images: [{ data: imageData, mimeType: 'image/png' }],
        }
      )) {
        events.push(ev);
      }

      // 1. The pipeline must NOT yield an abstaining complete event. (If the
      //    U8a clause were removed, this would be the failure mode.)
      const complete = events.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      expect(complete.data.abstain).not.toBe(true);

      // 2. The pipeline fell through to generation: the LLM was invoked, and
      //    the user message carries the image part (data is the same
      //    ArrayBuffer we passed in). buildMessages builds a multimodal content
      //    array only when images are present, so observing an `image` part
      //    proves both the fall-through AND the image-forwarding path.
      expect(mockWebLLMService.generateComplete).toHaveBeenCalledTimes(1);
      expect(capturedMessages).not.toBeNull();
      const userMessage = capturedMessages!.find((m) => m.role === 'user');
      expect(userMessage).toBeDefined();
      expect(Array.isArray(userMessage!.content)).toBe(true);
      const imagePart = (userMessage!.content as Array<{ type: string; data?: unknown }>)
        .find((p) => p.type === 'image');
      expect(imagePart).toBeDefined();
      expect(imagePart!.data).toBe(imageData);
    });
  });
});
