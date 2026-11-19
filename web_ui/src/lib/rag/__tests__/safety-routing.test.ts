// FROZEN CHECK C1 (issue #365 AC1) - token: safety-routing.
// Clinical safety routing: the deterministic classifier + the orchestrator
// safety branch. The safety branch must yield the refusal as a token event +
// a safety-labeled complete WITHOUT touching embedding, retrieval, reranking,
// or generation; an in-scope question must flow through the normal pipeline
// untouched (no-regression control).
//
// Scaffolding copies the proven c5-orchestrator-grounding.test.ts module
// boundary (the real RAGOrchestrator under jsdom with the service getters
// mocked), so these legs execute the REAL orchestrator code.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResult } from '../../../types/search';
import type { EmbeddingVector } from '../../../types/embedding';
import {
  classifyTopic,
  SAFETY_RULES,
} from '../safety-classifier';
import { SAFETY_REFUSAL_TEXT } from '../safety-notice';

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

const createMockLLMService = () =>
  ({
    generate: vi.fn(),
    generateComplete: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    getInferenceMode: vi.fn().mockReturnValue('browser-local'),
    getModelInfo: vi.fn().mockReturnValue(null),
    interrupt: vi.fn(),
    dispose: vi.fn(),
  }) as unknown as import('../../../types/llm').LLMService;

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
  dedupeNearDuplicates: vi.fn((results: unknown[]) => results),
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

async function collect(gen: AsyncGenerator<{ type: string; data: unknown }>) {
  const events: Array<{ type: string; data: unknown }> = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('safety-routing: classifier (issue #365 AC1)', () => {
  test('every PROPOSED rule matches its positive example and not its negative example (safety-routing)', () => {
    for (const rule of SAFETY_RULES) {
      const hit = classifyTopic(rule.positiveExample);
      expect(hit.outOfScope, `positive example must match ${rule.id}: ${rule.positiveExample}`).toBe(true);
      expect(hit.matchedRules, `positive example must match ${rule.id}`).toContain(rule.id);
      expect(hit.category).toBe('clinical');
      const miss = classifyTopic(rule.negativeExample);
      expect(miss.outOfScope, `negative example must NOT match ${rule.id}: ${rule.negativeExample}`).toBe(false);
      expect(miss.matchedRules).toEqual([]);
      expect(miss.category).toBeNull();
    }
  });

  test('named medications outside the vocabulary list still fire; non-clinical take does not (safety-routing)', () => {
    // Review round 2: the context condition must not silently drop
    // named-medication advice (amoxicillin via the -cillin suffix shape).
    // Review round 3 (fail-toward-refusal): the bare personal-take shape
    // decides - an unlisted drug name (warfarin carries NO vocabulary word
    // and NO suffix shape) still refuses, the in-scope idiom list is the
    // only escape, and an idiom does NOT suppress when a clinical signal
    // co-occurs.
    const hit = classifyTopic('Should I take amoxicillin?');
    expect(hit.outOfScope).toBe(true);
    expect(hit.matchedRules).toContain('dosing-personal-take');
    // The reviewer's named regression: warfarin is outside the vocabulary
    // list and outside every suffix shape - the bare shape must still fire.
    const warfarin = classifyTopic('Should I take warfarin?');
    expect(warfarin.outOfScope).toBe(true);
    expect(warfarin.matchedRules).toContain('dosing-personal-take');
    // The in-scope idiom escape (no clinical signal).
    const miss = classifyTopic('Can I take a look at the training document before the session?');
    expect(miss.outOfScope).toBe(false);
    expect(miss.matchedRules).toEqual([]);
    const slides = classifyTopic('Can I take the training course slides?');
    expect(slides.outOfScope).toBe(false);
    expect(slides.matchedRules).toEqual([]);
    // The idiom does NOT win over a clinical signal.
    const override = classifyTopic('Should I take a look at my insulin dosage?');
    expect(override.outOfScope).toBe(true);
    expect(override.matchedRules).toContain('dosing-personal-take');
  });

  test('empty/whitespace/non-string inputs are in scope (safety-routing)', () => {
    expect(classifyTopic('').outOfScope).toBe(false);
    expect(classifyTopic('   ').outOfScope).toBe(false);
    expect(classifyTopic(undefined as unknown as string).outOfScope).toBe(false);
    expect(classifyTopic(42 as unknown as string).outOfScope).toBe(false);
  });
});

describe('safety-routing: orchestrator safety branch (issue #365 AC1)', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockLlmService: ReturnType<typeof createMockLLMService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingService = createMockEmbeddingService();
    mockVectorIndex = createMockVectorIndex();
    mockKeywordIndex = createMockKeywordIndex();
    mockRerankerService = createMockRerankerService();
    mockLlmService = createMockLLMService();

    (getEmbeddingService as ReturnType<typeof vi.fn>).mockReturnValue(mockEmbeddingService);
    (getVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockVectorIndex);
    (getKeywordIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockKeywordIndex);
    (getRerankerService as ReturnType<typeof vi.fn>).mockReturnValue(mockRerankerService);
    (getLLMService as ReturnType<typeof vi.fn>).mockReturnValue(mockLlmService);
    (ensureEmbeddingServiceReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ensureReadinessGateChecked as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: true });
    (rrfFuse as ReturnType<typeof vi.fn>).mockImplementation((lists: SearchResult[][]) => {
      const combined: SearchResult[] = [];
      for (const list of lists) combined.push(...list);
      return combined;
    });
    mockEmbeddingService.encodeWithMetadata.mockResolvedValue(createMockEmbedding());
    mockVectorIndex.search.mockResolvedValue([]);
    mockKeywordIndex.search.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('clinical question yields the refusal as token+complete with safety metadata (safety-routing)', async () => {
    const orchestrator = new RAGOrchestrator({ llmService: mockLlmService });
    const events = await collect(orchestrator.query('Should I take 500 mg of metformin?'));

    expect(events.map((e) => e.type)).toEqual(['token', 'complete']);
    expect(events[0].data).toBe(SAFETY_REFUSAL_TEXT);
    const complete = events[1].data as {
      answer: string;
      sources: string[];
      chunks: unknown[];
      grounding: string;
      abstain: boolean;
      safety?: { category: string; matchedRules: string[] };
    };
    expect(complete.answer).toBe(SAFETY_REFUSAL_TEXT);
    expect(complete.sources).toEqual([]);
    expect(complete.chunks).toEqual([]);
    expect(complete.abstain).toBe(false);
    expect(complete.safety).toBeDefined();
    expect(complete.safety?.category).toBe('clinical');
    expect(complete.safety?.matchedRules).toContain('dosing-personal-take');
  });

  test('clinical question touches NO embedding/retrieval/rerank/generation call (safety-routing)', async () => {
    const orchestrator = new RAGOrchestrator({ llmService: mockLlmService });
    await collect(orchestrator.query('Do I have lupus based on these symptoms?'));

    expect(mockEmbeddingService.encodeWithMetadata).not.toHaveBeenCalled();
    expect(mockEmbeddingService.encodeBatch).not.toHaveBeenCalled();
    expect(mockVectorIndex.search).not.toHaveBeenCalled();
    expect(mockKeywordIndex.search).not.toHaveBeenCalled();
    expect(mockRerankerService.rerank).not.toHaveBeenCalled();
    expect(mockLlmService.generate).not.toHaveBeenCalled();
    expect(mockLlmService.generateComplete).not.toHaveBeenCalled();
  });

  test('in-scope document question still flows through retrieval (safety-routing negative control)', async () => {
    const orchestrator = new RAGOrchestrator({ llmService: mockLlmService });
    const events = await collect(
      orchestrator.query('What do the packs say about metformin dosing schedules?'),
    );

    // Normal pipeline: retrieval ran (keyword search consulted), no safety metadata.
    expect(mockKeywordIndex.search).toHaveBeenCalled();
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect((complete?.data as { safety?: unknown }).safety).toBeUndefined();
    // The empty-corpus control reaches the ordinary abstain path (F2), not the refusal.
    expect((complete?.data as { abstain?: boolean }).abstain).toBe(true);
  });
});
