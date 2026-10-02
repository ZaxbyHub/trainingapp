/**
 * F-004 (PR #142 review): with an EXTERNAL generator the browser's grounded
 * prompt carries the same text the desktop backend sends — the shared
 * EXTERNAL_SYSTEM_PROMPT and the grounded framing (instruction, blank line,
 * numbered passages, question label), the same layout as desktop's
 * groundedUserContent(). Local engines keep their own prompt untouched.
 * Mock layout mirrors rag-orchestrator.pinned-placement.test.ts.
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
import { computeReservedTokens } from './rag-orchestrator';
import {
  EXTERNAL_GROUNDED_INSTRUCTION,
  EXTERNAL_GROUNDED_QUESTION_LABEL,
  EXTERNAL_SYSTEM_PROMPT,
} from '../llm/external-prompts';


describe('F-004: external grounded framing matches the desktop prompt', () => {
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

  async function run(options: Record<string, unknown>): Promise<LLMMessage[]> {
    const chunks: SearchResult[] = [
      { docId: 'd1', chunkIndex: 0, score: 0.9, text: 'first passage' },
      { docId: 'd2', chunkIndex: 0, score: 0.8, text: 'second passage' },
    ];
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);
    let captured: LLMMessage[] = [];
    mockLLMService.generateComplete.mockImplementation(async (messages: LLMMessage[]) => {
      captured = messages;
      return 'answer';
    });
    const orch = new RAGOrchestrator();
    for await (const event of orch.query('what is step two?', { streamTokens: false, rerank: false, ...options } as never)) {
      void event;
    }
    expect(mockLLMService.generateComplete).toHaveBeenCalledTimes(1);
    return captured;
  }

  test('external: system prompt and user turn are the desktop text, byte for byte', async () => {
    const messages = await run({
      systemPrompt: EXTERNAL_SYSTEM_PROMPT,
      groundedFraming: { instruction: EXTERNAL_GROUNDED_INSTRUCTION, questionLabel: EXTERNAL_GROUNDED_QUESTION_LABEL },
    });
    expect(messages[0]).toEqual({ role: 'system', content: EXTERNAL_SYSTEM_PROMPT });
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    // Same layout as desktop groundedUserContent(question, [a, b]):
    //   INSTRUCTION, blank line, "[1] a", blank line, "[2] b", two blank lines, QUESTION_LABEL + question.
    const expected = [
      EXTERNAL_GROUNDED_INSTRUCTION,
      '',
      '[1] first passage',
      '',
      '[2] second passage',
      '',
      '',
      `${EXTERNAL_GROUNDED_QUESTION_LABEL}what is step two?`,
    ].join('\n');
    expect(textOf(last)).toBe(expected);
    expect(textOf(last)).not.toContain('Context:');
  });

  test('local engines (no framing) keep the "Context:" header and their own system prompt', async () => {
    const messages = await run({});
    expect(textOf(messages[0])).not.toBe(EXTERNAL_SYSTEM_PROMPT);
    const user = textOf(messages[messages.length - 1]);
    expect(user.startsWith(['Context:', '[1] first passage'].join('\n'))).toBe(true);
    expect(user).not.toContain(EXTERNAL_GROUNDED_INSTRUCTION);
  });

  test('the framing text is charged to the token budget like every other channel', () => {
    const base = { systemPrompt: 's', question: 'q', historyText: '' };
    const framed = computeReservedTokens({ ...base, groundedInstruction: 'x'.repeat(400) });
    expect(framed - computeReservedTokens(base)).toBe(100);
  });
});
