/**
 * D7 acceptance check C3 (issue #83, AC3): the orchestrator's `pinnedContext`
 * option is injected into the LLM messages AND charged against the existing
 * token budget (reservedTokens), so a pin + long history + long retrieved
 * context can never overflow DEFAULT_N_CTX.
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec (web_ui/src/lib/rag/rag-orchestrator.ts):
 *
 *   export interface RAGQueryOptions {
 *     ...
 *     // D7 (issue #83): text of the pinned training slide the user is
 *     // viewing. Threaded into the LLM messages and charged against
 *     // reservedTokens exactly like `history` is.
 *     pinnedContext?: string;
 *   }
 *
 * Behavioral requirements pinned here:
 *   (i)   the pinned text must reach the LLM message array;
 *   (ii)  the pinned text must be charged to the budget: in a scenario where
 *         correct budget math drops at least one retrieved chunk, an
 *         implementation that injects but forgets to charge (or ignores the
 *         option entirely) keeps every chunk and fails;
 *   (iii) with pin + long history + long retrieved context combined, the total
 *         assembled prompt stays within DEFAULT_N_CTX (estimated with the
 *         pipeline's own chars/4 model + generation reserve + safety margin).
 *
 * NOTE: vitest does not typecheck — at base, an unknown option is silently
 * ignored, so these are BEHAVIORAL assertions (text missing from the prompt,
 * budget unchanged), not compile errors.
 *
 * Scenario sizing (deliberately oversized pin to make the arithmetic
 * observable with margin; CHARS_PER_TOKEN=4, DEFAULT_N_CTX=8192,
 * TOKEN_SAFETY_MARGIN=96, default system prompt ~370 chars):
 *   - history: 2 turns x 4000 chars = 8000 chars  (2000 tokens reserved)
 *   - pinnedContext: ~16090 chars                  (~4023 tokens reserved)
 *   - 3 ranked chunks x 3000 chars
 *   - without charging the pin: context budget ≈ 21900 chars -> all 3 fit;
 *   - with the pin charged:     context budget ≈ 5850 chars  -> only the
 *     top chunk fits, the rest are dropped (contextTrimmed >= 1).
 *
 * Mock layout mirrors src/lib/rag/rag-orchestrator.test.ts (all service
 * modules mocked at their boundaries; no network, no models).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResult } from '../../types/search';
import type { EmbeddingVector } from '../../types/embedding';
import type { LLMMessage } from '../../types/llm';

// --- Mock implementations (same shape as rag-orchestrator.test.ts) ---

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

// Import the module under test AFTER mocks are set up
import { RAGOrchestrator } from './rag-orchestrator';
// DEFAULT_N_CTX (8192) is the pipeline's binding context window, exported by
// the wllama service module (imported here for the AC3 ceiling assertion only).
import { DEFAULT_N_CTX } from '../llm/wllama-service';

// Import mocked modules for setting up returns
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
import type { RAGEvent } from './rag-orchestrator';

const CHARS_PER_TOKEN = 4;
const TOKEN_SAFETY_MARGIN = 96;

/** Marker placed at the START of the pin text so it survives any truncation. */
const PIN_MARKER = '[AC3-PINMARK]';

describe('D7 C3: pinnedContext injection + budget charge (issue #83 AC3)', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockLLMService: ReturnType<typeof createMockLLMService>;

  /** Drain a query into an event array. */
  async function collect(orch: RAGOrchestrator, question: string, options: Record<string, unknown>) {
    const events: RAGEvent[] = [];
    for await (const event of orch.query(question, options as never)) {
      events.push(event);
    }
    return events;
  }

  /** Concatenate every string message content the LLM received. */
  const promptTextOf = (messages: LLMMessage[]): string =>
    messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

  const completeOf = (events: RAGEvent[]): Extract<RAGEvent, { type: 'complete' }>['data'] => {
    const complete = events.find((e) => e.type === 'complete');
    if (!complete) throw new Error('no complete event yielded');
    return (complete as Extract<RAGEvent, { type: 'complete' }>).data;
  };

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
    // in afterEach wipes the factory-set implementations (without these, the
    // pipeline degrades to keyword-only retrieval and abstains).
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

  test('(i) pinnedContext text reaches the LLM messages', async () => {
    const chunks: SearchResult[] = [
      { docId: 'd1', chunkIndex: 0, score: 0.9, text: 'ordinary retrieved chunk' },
    ];
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);
    mockLLMService.generateComplete.mockResolvedValue('answer');

    const pinnedText = `${PIN_MARKER} The user is viewing slide 5rN4PvXJM5d "Welcome" (section Intro Module).`;

    let capturedMessages: LLMMessage[] = [];
    mockLLMService.generateComplete.mockImplementation(async (messages: LLMMessage[]) => {
      capturedMessages = messages;
      return 'answer';
    });

    const orch = new RAGOrchestrator();
    await collect(orch, 'explain this step', {
      pinnedContext: pinnedText,
      streamTokens: false,
      rerank: false,
    });

    expect(
      mockLLMService.generateComplete,
      '[AC3-RED] expected the LLM to be invoked (retrieval produced a chunk)'
    ).toHaveBeenCalled();
    expect(
      promptTextOf(capturedMessages),
      '[AC3-RED] expected pinnedContext text to reach the LLM messages — the option is currently ignored'
    ).toContain(PIN_MARKER);
    expect(promptTextOf(capturedMessages)).toContain('Welcome');
  });

  test('(ii) pinnedContext is charged to reservedTokens: budget pressure drops at least one retrieved chunk', async () => {
    const pinnedText =
      `${PIN_MARKER} The user is viewing slide 5rN4PvXJM5d "Welcome" (section Intro Module). ` +
      'p'.repeat(16000);
    const history = [
      { role: 'user' as const, content: 'h'.repeat(4000) },
      { role: 'assistant' as const, content: 'a'.repeat(4000) },
    ];
    // Three ranked chunks of 3000 chars each (RRF-floor-safe scores).
    const chunks: SearchResult[] = [
      { docId: 'keep-or-drop-1', chunkIndex: 0, score: 0.9, text: 'c'.repeat(3000) },
      { docId: 'keep-or-drop-2', chunkIndex: 0, score: 0.8, text: 'c'.repeat(3000) },
      { docId: 'keep-or-drop-3', chunkIndex: 0, score: 0.7, text: 'c'.repeat(3000) },
    ];
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);
    mockLLMService.generateComplete.mockResolvedValue('answer');

    const orch = new RAGOrchestrator();
    const events = await collect(orch, 'explain this step', {
      pinnedContext: pinnedText,
      history,
      maxTokens: 512,
      streamTokens: false,
      rerank: false,
    });

    const complete = completeOf(events);
    expect(
      complete.abstain,
      '[AC3-RED] scenario must not abstain (top chunk must fit the charged budget)'
    ).not.toBe(true);
    expect(
      complete.chunks.length,
      '[AC3-RED] expected the pinnedContext charge against reservedTokens to shrink the context budget so at least one of the 3 retrieved chunks is dropped — all 3 were kept, so the pin is not being charged (or not injected)'
    ).toBeLessThan(3);
    expect(
      complete.contextTrimmed ?? 0,
      '[AC3-RED] expected complete.contextTrimmed >= 1 — the pin must consume budget exactly like history does'
    ).toBeGreaterThanOrEqual(1);
  });

  test('(iii) pin + long history + long retrieved context: total prompt stays within DEFAULT_N_CTX', async () => {
    const pinnedText =
      `${PIN_MARKER} The user is viewing slide 5rN4PvXJM5d "Welcome" (section Intro Module). ` +
      'p'.repeat(16000);
    const history = [
      { role: 'user' as const, content: 'h'.repeat(4000) },
      { role: 'assistant' as const, content: 'a'.repeat(4000) },
    ];
    const chunks: SearchResult[] = [
      { docId: 'chunk-1', chunkIndex: 0, score: 0.9, text: 'c'.repeat(3000) },
      { docId: 'chunk-2', chunkIndex: 0, score: 0.8, text: 'c'.repeat(3000) },
      { docId: 'chunk-3', chunkIndex: 0, score: 0.7, text: 'c'.repeat(3000) },
    ];
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    let capturedMessages: LLMMessage[] = [];
    mockLLMService.generateComplete.mockImplementation(async (messages: LLMMessage[]) => {
      capturedMessages = messages;
      return 'answer';
    });

    const orch = new RAGOrchestrator();
    await collect(orch, 'explain this step', {
      pinnedContext: pinnedText,
      history,
      maxTokens: 512,
      streamTokens: false,
      rerank: false,
    });

    // AC3 ceiling: the assembled prompt (system + history + pin + context +
    // question) plus the generation reserve and safety margin must fit in the
    // model context window, using the pipeline's own conservative chars/4
    // estimate. An implementation that injects the pin without charging it
    // keeps every chunk and overflows this bound.
    expect(
      mockLLMService.generateComplete,
      '[AC3-RED] expected generation to run (non-vacuous scenario guard: the prompt must actually be assembled)'
    ).toHaveBeenCalledTimes(1);
    const totalPromptChars = capturedMessages
      .map((m) => (typeof m.content === 'string' ? m.content.length : 0))
      .reduce((a, b) => a + b, 0);
    const estimatedPromptTokens = Math.ceil(totalPromptChars / CHARS_PER_TOKEN);
    expect(
      estimatedPromptTokens + 512 + TOKEN_SAFETY_MARGIN,
      '[AC3-RED] total context (prompt estimate + maxTokens reserve + safety margin) must not exceed DEFAULT_N_CTX (8192) — the pin is not being charged to the budget'
    ).toBeLessThanOrEqual(DEFAULT_N_CTX);
  });
});
