// frozen-check C7 leg (a) — #364 AC2: the browser diagnostics surface
// labels its budget numbers as estimated.
//
// FROZEN SPEC — authored by the independent check author at base
// 1cfde07b73b52fa906da7bd3f316d7805b638e2f. The implementer must make this
// pass WITHOUT editing it; canonical copy dropped byte-identical at
// web_ui/src/lib/rag/rag-orchestrator.token-label.test.ts.
//
// Mock layout mirrors src/lib/rag/rag-orchestrator.pinned-context.test.ts /
// rag-orchestrator.test.ts (all service modules mocked at their boundaries;
// no network, no models).
//
// FROZEN OBSERVABLE (declared so the implementer cannot dodge it):
//   - When the orchestrator's chars/4 budget DROPS at least one retrieved
//     chunk, it emits a browser-side budget diagnostics record via
//     console.info whose first argument is a string containing '[RAG]' and
//     'budget' (desktop-twin parity: desktop's drop-conditional
//     '[RAG] budget' record in main/backend/engine.ts), and whose object
//     payload:
//       * carries `estimated: true` (boolean) — the label that marks every
//         token/budget NUMBER in the record as an ESTIMATE (the browser has
//         no tokenizer; per the issue the estimate stays, labeled), and
//       * carries the NAMED budget fields with EXACT independently-derived
//         values (PC-09/PC2-04 — no bounds-only or constant dodge):
//         `reservedTokens` === computeReservedTokens({systemPrompt:
//         SPEC_SYSTEM_PROMPT, question, historyText, pinnedContext,
//         groundedInstruction: undefined, maxTokens: 512}) and
//         `contextBudgetChars` === (DEFAULT_N_CTX - reservedTokens) * 4,
//         plus `droppedForBudget` === the complete event's contextTrimmed.
//   - Twin parity on conditionality: a query where NOTHING is dropped for
//     budget emits NO such record (the desktop record is drop-only; the
//     browser twin must not spam it unconditionally).
//   - Arithmetic preservation is NOT re-pinned here: it stays pinned by the
//     existing specs this check's driver also runs
//     (rag-orchestrator.reserved-tokens.test.ts,
//      rag-orchestrator.historybudget.test.ts).
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
  dedupeNearDuplicates: vi.fn((results: unknown[]) => results),
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

import { RAGOrchestrator, computeReservedTokens, type RAGEvent } from './rag-orchestrator';
import { DEFAULT_N_CTX } from '../llm/wllama-service';

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

// Pinned system prompt: passed through options so the spec can reconstruct
// the exact channel set computeReservedTokens charges (PC2-04).
const SPEC_SYSTEM_PROMPT = 'You are a training assistant. C7-pinned prompt.';

/** A budget-diagnostics record per the frozen observable, or undefined. */
function budgetRecord(
  info: ReturnType<typeof vi.spyOn>,
): { payload: Record<string, unknown> } | undefined {
  for (const call of info.mock.calls) {
    const tag = call[0];
    const payload = call[1];
    if (
      typeof tag === 'string' &&
      tag.includes('[RAG]') &&
      tag.includes('budget') &&
      payload !== null &&
      typeof payload === 'object'
    ) {
      return { payload: payload as Record<string, unknown> };
    }
  }
  return undefined;
}

describe('token-label (#364 AC2): browser budget diagnostics label their numbers as estimated', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockLLMService: ReturnType<typeof createMockLLMService>;

  async function collect(orch: RAGOrchestrator, question: string, options: Record<string, unknown>) {
    const events: RAGEvent[] = [];
    for await (const event of orch.query(question, options as never)) {
      events.push(event);
    }
    return events;
  }

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

  test('a budget-dropping query emits a labeled record: estimated true plus a positive numeric budget value (token-label)', async () => {
    // Budget-pressure scenario (mirrors rag-orchestrator.pinned-context
    // test (ii)): pin + history reserve nearly the whole window, so of the
    // three 3000-char chunks at least one is dropped for budget.
    const pinnedText = `${'[C7-PIN]'.padEnd(10, 'x')} The user is viewing slide "Welcome". ` + 'p'.repeat(16000);
    const history = [
      { role: 'user' as const, content: 'h'.repeat(4000) },
      { role: 'assistant' as const, content: 'a'.repeat(4000) },
    ];
    const chunks: SearchResult[] = [
      { docId: 'keep-or-drop-1', chunkIndex: 0, score: 0.9, text: 'c'.repeat(3000) },
      { docId: 'keep-or-drop-2', chunkIndex: 0, score: 0.8, text: 'c'.repeat(3000) },
      { docId: 'keep-or-drop-3', chunkIndex: 0, score: 0.7, text: 'c'.repeat(3000) },
    ];
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);
    mockLLMService.generateComplete.mockResolvedValue('answer');

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const orch = new RAGOrchestrator();
      const events = await collect(orch, 'explain this step', {
        systemPrompt: SPEC_SYSTEM_PROMPT,
        pinnedContext: pinnedText,
        history,
        maxTokens: 512,
        streamTokens: false,
        rerank: false,
      });

      // Scenario sanity: the budget really dropped something (guards a
      // vacuous pass — if nothing dropped, the record's absence below must
      // fail loudly, not silently pass).
      const complete = completeOf(events);
      expect(complete.abstain).not.toBe(true);
      expect(complete.contextTrimmed ?? 0).toBeGreaterThanOrEqual(1);

      const record = budgetRecord(info);
      expect(record, 'expected a [RAG] ... budget diagnostics record on a budget-dropping query').toBeDefined();
      expect(
        record!.payload['estimated'],
        'the record must label its numbers as estimated (estimated: true)',
      ).toBe(true);
      // PC2-04: EXACT independently-derived values, not bounds (a
      // constant-emitting logger must fail here). The system prompt is
      // pinned via options.systemPrompt so the spec reconstructs the same
      // channel set; the history fixture is within the cap so the capped
      // text equals the joined contents.
      const historyText = history.map((t) => t.content).join('\n');
      const expectedReserved = computeReservedTokens({
        systemPrompt: SPEC_SYSTEM_PROMPT,
        question: 'explain this step',
        historyText,
        pinnedContext: pinnedText,
        groundedInstruction: undefined,
        maxTokens: 512,
      });
      const expectedBudget = Math.max(0, (DEFAULT_N_CTX - expectedReserved) * 4);
      const reserved = record!.payload['reservedTokens'];
      expect(reserved, 'reservedTokens must equal the independent computeReservedTokens derivation').toBe(expectedReserved);
      const budgetChars = record!.payload['contextBudgetChars'];
      expect(budgetChars, 'contextBudgetChars must equal (DEFAULT_N_CTX - reserved) * CHARS_PER_TOKEN').toBe(expectedBudget);
      expect(expectedBudget, 'fixture must actually pressure the budget (scenario sanity)').toBeLessThan(3 * 3000);
      expect(
        record!.payload['droppedForBudget'],
        'droppedForBudget must equal the complete event contextTrimmed (single source of truth)',
      ).toBe(complete.contextTrimmed);
    } finally {
      info.mockRestore();
    }
  });

  test('a query where nothing is dropped for budget emits NO budget record (desktop-twin conditionality) (token-label)', async () => {
    const chunks: SearchResult[] = [
      { docId: 'solo-1', chunkIndex: 0, score: 0.9, text: 'tiny context chunk' },
    ];
    mockVectorIndex.search.mockResolvedValue(chunks);
    mockKeywordIndex.search.mockReturnValue([]);
    (rrfFuse as ReturnType<typeof vi.fn>).mockReturnValue(chunks);
    mockLLMService.generateComplete.mockResolvedValue('answer');

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const orch = new RAGOrchestrator();
      const events = await collect(orch, 'explain this step', {
        streamTokens: false,
        rerank: false,
      });
      const complete = completeOf(events);
      expect(complete.abstain).not.toBe(true);
      expect(complete.contextTrimmed ?? 0).toBe(0);
      expect(budgetRecord(info), 'no-drop query must not emit the budget record').toBeUndefined();
    } finally {
      info.mockRestore();
    }
  });
});
