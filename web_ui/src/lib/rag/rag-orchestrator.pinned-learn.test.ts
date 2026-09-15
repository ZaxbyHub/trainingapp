/**
 * D7 acceptance check C6 (issue #83, AC6): the pinned-slide context COEXISTS
 * with the Learn panel — with pinnedContext present and retrieved chunks
 * including a training-slide chunk (docs/slide-<n>-<slide_id>.json whose text
 * starts with the [training-slide] marker), the complete event still carries
 * non-empty learn[] rows for that slide AND the pinned text reached the
 * prompt. The pin neither suppresses nor replaces the Learn results.
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract pinned here (rag-orchestrator.ts): passing options.pinnedContext
 * must not alter the learn[] computation — complete.learn is still
 * buildLearnResults(contextChunks) over the budgeted chunks, and the pinned
 * text is present in the LLM messages.
 *
 * At base the learn[] half already passes (D6 infra); the pinned-text half
 * fails because the option does not exist — that is the RED.
 *
 * Mock layout mirrors src/lib/rag/rag-orchestrator.test.ts.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResult } from '../../types/search';
import type { EmbeddingVector } from '../../types/embedding';
import type { LLMMessage } from '../../types/llm';

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

vi.mock('../llm/llm-factory', () => ({
  getLLMService: vi.fn(),
}));

vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn().mockResolvedValue(true),
  ensureReadinessGateChecked: vi.fn().mockResolvedValue({ ready: true }),
}));

import { RAGOrchestrator } from './rag-orchestrator';
import type { RAGEvent } from './rag-orchestrator';

import { getEmbeddingService } from '../embeddings/embedding-service';
import { getVectorIndex } from '../search/vector-index';
import { getKeywordIndex } from '../search/keyword-index';
import { getRerankerService } from '../search/reranker';
import { rrfFuse } from '../search/rrf-fusion';
import { getLLMService } from '../llm/llm-factory';
import {
  ensureEmbeddingServiceReady,
  ensureReadinessGateChecked,
} from '../../hooks/useServiceInitialization';

const PIN_MARKER = '[AC6-PINMARK]';

describe('D7 C6: pinnedContext coexists with the Learn panel (issue #83 AC6)', () => {
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

    // Re-establish the readiness-gate mocks every test: vi.restoreAllMocks()
    // in afterEach wipes the factory-set implementations.
    (ensureEmbeddingServiceReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ensureReadinessGateChecked as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: true });

    (rrfFuse as ReturnType<typeof vi.fn>).mockImplementation((lists: SearchResult[][]) => {
      const combined: SearchResult[] = [];
      for (const list of lists) {
        combined.push(...list);
      }
      return combined;
    });

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: new Float32Array(768).fill(0.1) as EmbeddingVector,
      text: 'q',
      dimensions: 768,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('with a pin active, complete.learn still carries the cited slide AND the pin reached the prompt', async () => {
    // One training-slide doc chunk (D6/#82 schema) + one ordinary chunk, both
    // retrieved and small enough to fit the budget comfortably.
    const slideChunk: SearchResult = {
      docId: 'slide-doc-1',
      chunkIndex: 0,
      score: 0.9,
      source: 'docs/slide-3-ABC123.json',
      text: '[training-slide] section=Intro to CDP | title=Welcome | slide_id=ABC123\nThe welcome screen introduces the CDP home dashboard and the roles menu.',
    };
    const plainChunk: SearchResult = {
      docId: 'doc-plain',
      chunkIndex: 0,
      score: 0.7,
      text: 'An ordinary policy document chunk about medication ordering.',
    };
    const chunks = [slideChunk, plainChunk];

    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    let capturedMessages: LLMMessage[] = [];
    mockLLMService.generateComplete.mockImplementation(async (messages: LLMMessage[]) => {
      capturedMessages = messages;
      return 'This step welcomes you to CDP. [1]';
    });

    const pinnedText =
      `${PIN_MARKER} The user is viewing slide 5rN4PvXJM5d "Welcome" (section Intro to CDP).`;

    const orch = new RAGOrchestrator();
    const events: RAGEvent[] = [];
    for await (const event of orch.query('explain this step', {
      pinnedContext: pinnedText,
      streamTokens: false,
      rerank: false,
    } as never)) {
      events.push(event);
    }

    const complete = events.find((e) => e.type === 'complete') as
      | Extract<RAGEvent, { type: 'complete' }>
      | undefined;
    expect(complete, '[AC6-RED] expected a complete event').toBeDefined();

    // Learn half: the cited slide still produces its learn row — the pin must
    // neither suppress nor replace the Learn panel results.
    const learn = complete!.data.learn ?? [];
    expect(
      learn.length,
      '[AC6-RED] expected non-empty learn[] rows with a pin active — the pin must not suppress the Learn panel results'
    ).toBeGreaterThanOrEqual(1);
    const slideRow = learn.find((row) => row.slide_id === 'ABC123');
    expect(
      slideRow,
      '[AC6-RED] expected a learn row for the cited slide id ABC123'
    ).toBeDefined();
    expect(slideRow!.title, '[AC6-RED] learn row title must come from the slide-doc marker').toBe('Welcome');
    expect(slideRow!.section, '[AC6-RED] learn row section must come from the slide-doc marker').toBe('Intro to CDP');

    // The slide chunk is still among the cited chunks (not displaced by the pin).
    expect(
      complete!.data.chunks.some((c) => c.source === 'docs/slide-3-ABC123.json'),
      '[AC6-RED] the training-slide chunk must still be cited with a pin active'
    ).toBe(true);

    // Pin half: the pinned text reached the LLM prompt (fails at base).
    const promptText = capturedMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(
      promptText,
      '[AC6-RED] expected the pinned slide text to reach the LLM prompt alongside the learn[] results — the option is currently ignored'
    ).toContain(PIN_MARKER);
  });
});
