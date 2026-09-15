/**
 * D7 acceptance check C9 (issue #83, AC3 placement): the pinned slide context
 * is rendered inside the USER turn of the LLM messages — never in the system
 * message and never by rewriting a prior history turn.
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec (web_ui/src/lib/rag/rag-orchestrator.ts):
 *
 *   buildMessages(systemPrompt, question, context, images?, history?,
 *                 pinnedContext?)
 *
 *   When options.pinnedContext is a non-empty string, its text must appear in
 *   the LAST message of the assembled LLM message array (the user turn that
 *   also carries the numbered context block and the question), and must NOT
 *   appear in the system message (first) nor in any threaded history turn
 *   (intermediate messages). The pin is context for the CURRENT question —
 *   it is not a system instruction and it must not mutate the transcript's
 *   recorded turns.
 *
 * Message shape this check relies on (existing behavior, unchanged by the
 * fix): buildMessages returns [system, ...history, user] — so with one
 * history turn the array is [system, history-turn..., user-last].
 *
 * NOTE: vitest does not typecheck — at base the option is silently ignored,
 * so assertion (a) below fails BEHAVIORALLY (marker absent from the user
 * turn), not as a compile error.
 *
 * Mock layout mirrors src/lib/rag/rag-orchestrator.test.ts (all service
 * modules mocked at their boundaries; no network, no models).
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

// Import the module under test AFTER mocks are set up
import { RAGOrchestrator } from './rag-orchestrator';

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

/** Marker that must land in the USER turn and nowhere else. */
const PIN_MARKER = '[AC9-USER-TURN]';

describe('D7 C9: pinnedContext is placed in the USER turn (issue #83)', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockLLMService: ReturnType<typeof createMockLLMService>;

  /** Stringify a message content regardless of string / multimodal shape. */
  const textOf = (message: LLMMessage): string =>
    typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);

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

  test('the pinned text lands in the LAST (user) message — not the system message, not a history turn', async () => {
    // One ordinary retrieved chunk (small: no budget pressure — this check is
    // about PLACEMENT, C3 owns the budget charge).
    const chunks: SearchResult[] = [
      { docId: 'd1', chunkIndex: 0, score: 0.9, text: 'ordinary retrieved chunk' },
    ];
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);

    let capturedMessages: LLMMessage[] = [];
    mockLLMService.generateComplete.mockImplementation(async (messages: LLMMessage[]) => {
      capturedMessages = messages;
      return 'answer';
    });

    // One prior conversation turn (user + assistant), threaded as history.
    const history = [
      { role: 'user' as const, content: 'Earlier question about the roles menu' },
      { role: 'assistant' as const, content: 'Earlier answer about the roles menu' },
    ];

    const pinnedText = `${PIN_MARKER} Pinned training slide: Intro Module > Welcome.\nSlide text: The welcome screen introduces the CDP home dashboard.`;

    const orch = new RAGOrchestrator();
    const events: RAGEvent[] = [];
    for await (const event of orch.query('explain this step', {
      pinnedContext: pinnedText,
      history,
      streamTokens: false,
      rerank: false,
    } as never)) {
      events.push(event);
    }

    // Non-vacuous guards: generation ran, and the message array has the
    // expected [system, history..., user] shape (>= 3 messages here).
    expect(
      mockLLMService.generateComplete,
      '[AC9-RED] expected the LLM to be invoked (retrieval produced a chunk)'
    ).toHaveBeenCalledTimes(1);
    expect(
      capturedMessages.length,
      '[AC9-RED] expected [system, history-turns..., user] — at least 3 messages with one history turn threaded'
    ).toBeGreaterThanOrEqual(3);

    const last = capturedMessages[capturedMessages.length - 1];
    const first = capturedMessages[0];
    const middle = capturedMessages.slice(1, -1);

    // (a) The pin is in the USER turn (the last message).
    expect(
      last.role,
      '[AC9-RED] expected the last message to be the user turn'
    ).toBe('user');
    expect(
      textOf(last),
      '[AC9-RED] expected the pinned slide text to be rendered inside the USER turn (the last LLM message) — the option is currently ignored'
    ).toContain(PIN_MARKER);

    // (b) The pin is NOT in the system message.
    expect(
      textOf(first),
      '[AC9-RED] the pinned slide text must NOT be rendered into the system message — the pin is context for the current question, not a system instruction'
    ).not.toContain(PIN_MARKER);

    // (c) The pin is NOT threaded into any history turn.
    for (const message of middle) {
      expect(
        textOf(message),
        '[AC9-RED] the pinned slide text must NOT appear in a history turn — the transcript\'s recorded turns must never be rewritten with the pin'
      ).not.toContain(PIN_MARKER);
    }

    // Structural sanity: the history turn itself is still present verbatim
    // between the system message and the user turn.
    expect(
      middle.some((m) => m.role === 'user' && textOf(m).includes('Earlier question about the roles menu')),
      '[AC9-RED] expected the prior user turn to still be threaded between system and the current user turn'
    ).toBe(true);
  });
});
