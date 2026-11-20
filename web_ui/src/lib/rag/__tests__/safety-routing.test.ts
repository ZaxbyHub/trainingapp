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
    // Review round 4 [critical]: the escape is PER-SENTENCE-UNIT and
    // PER-OCCURRENCE. A compound question cannot lend one clause's idiom to
    // another clause's unlisted-medication decision...
    const compound = classifyTopic('Should I take warfarin? Can I take a look at the document?');
    expect(compound.outOfScope).toBe(true);
    expect(compound.matchedRules).toContain('dosing-personal-take');
    // ...and a syntactically overlapping phrase cannot hide inside an
    // idiom-shaped head (course is clinically ambiguous: "course of
    // warfarin")...
    const overlapping = classifyTopic('Should I take the course of warfarin?');
    expect(overlapping.outOfScope).toBe(true);
    expect(overlapping.matchedRules).toContain('dosing-personal-take');
    const mixed = classifyTopic('Should I take warfarin and can I take a look at the document?');
    expect(mixed.outOfScope).toBe(true);
    expect(mixed.matchedRules).toContain('dosing-personal-take');
    // ...while the ordinary study idiom stays in scope.
    const trainingPack = classifyTopic('Can I take the training pack before the session?');
    expect(trainingPack.outOfScope).toBe(false);
    expect(trainingPack.matchedRules).toEqual([]);
    // The idiom escape is occurrence-anchored, so a DOCUMENT question about
    // an unlisted drug stays in scope (no advice shape), and the modifier
    // form ("still take") fires on the bare shape.
    const monograph = classifyTopic('Can I take a look at the warfarin monograph?');
    expect(monograph.outOfScope).toBe(false);
    expect(monograph.matchedRules).toEqual([]);
    const stillForm = classifyTopic('Should I still take warfarin?');
    expect(stillForm.outOfScope).toBe(true);
    expect(stillForm.matchedRules).toContain('dosing-personal-take');
    // Review round 5 [critical]: a DECIMAL POINT is not a sentence boundary.
    // The weight-and-dose shape spans the decimal in the original whole-text
    // behavior and must keep matching.
    const decimalWeight = classifyTopic('I weigh 72.5 kg, what dose is right for me?');
    expect(decimalWeight.outOfScope).toBe(true);
    expect(decimalWeight.matchedRules).toContain('dosing-personal-amount');
    const decimalDose = classifyTopic('Should I take 0.5 mg of digoxin?');
    expect(decimalDose.outOfScope).toBe(true);
    expect(decimalDose.matchedRules).toContain('dosing-personal-take');
    // Review round 6 [critical]: rules WITHOUT an idiom escape evaluate on
    // the WHOLE question, so a clinical shape that intentionally spans
    // sentences keeps matching ("I weigh N kg. What dose ... for me?").
    const crossSentence = classifyTopic('I weigh 72 kg. What dose is right for me?');
    expect(crossSentence.outOfScope).toBe(true);
    expect(crossSentence.matchedRules).toContain('dosing-personal-amount');
    // Review round 7 (final-critic): `over` and bare `part` were clinically
    // ambiguous idiom heads exactly like course/pack - overdose thresholds,
    // over-the-counter phrasing (\b matches at the hyphen), and part-of-a-
    // pill forms all suppressed the decision. They are removed; only the
    // unambiguous "part in" participates form survives.
    const overdose = classifyTopic('Can I take over 4 Tylenol a day?');
    expect(overdose.outOfScope).toBe(true);
    expect(overdose.matchedRules).toContain('dosing-personal-take');
    const otc = classifyTopic('Can I take over-the-counter naproxen with my warfarin?');
    expect(otc.outOfScope).toBe(true);
    expect(otc.matchedRules).toContain('dosing-personal-take');
    const partOf = classifyTopic('Should I take part of the warfarin tonight?');
    expect(partOf.outOfScope).toBe(true);
    expect(partOf.matchedRules).toContain('dosing-personal-take');
    const partIn = classifyTopic('Can I take part in the training session?');
    expect(partIn.outOfScope).toBe(false);
    expect(partIn.matchedRules).toEqual([]);
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
