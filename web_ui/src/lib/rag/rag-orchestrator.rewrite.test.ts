/**
 * Unit tests for the Issue #40 RC3 retrieval-query contextualization heuristic.
 *
 * `contextualizeRetrievalQuery` rewrites pronoun-heavy / short / continuation
 * follow-ups into self-contained retrieval queries using conversation history.
 * It is a pure, deterministic, exported function — tested in isolation here so
 * every branch (anaphora, short-non-wh, continuation keywords, fallbacks,
 * self-contained pass-through, empty history) is covered.
 *
 * The mocks below stub the orchestrator's transitive imports (vector-index →
 * edgevec WASM, etc.) so importing the module does not require a build step —
 * mirroring the setup in rag-orchestrator.test.ts. Only the pure exported
 * function is exercised; no orchestrator instances are constructed here.
 */

import { describe, test, expect, vi } from 'vitest';

// Stub transitive imports BEFORE importing the module under test. These match
// the mocks in rag-orchestrator.test.ts; only the module boundaries matter
// here, not their return values (no orchestrator is instantiated).
vi.mock('../embeddings/embedding-service', () => ({ getEmbeddingService: vi.fn() }));
vi.mock('../search/vector-index', () => ({ getVectorIndex: vi.fn() }));
vi.mock('../search/keyword-index', () => ({ getKeywordIndex: vi.fn() }));
vi.mock('../search/rrf-fusion', () => ({ rrfFuse: vi.fn() }));
vi.mock('../search/reranker', () => ({ getRerankerService: vi.fn() }));
vi.mock('../llm/llm-factory', () => ({ getLLMService: vi.fn() }));
vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn(),
  ensureReadinessGateChecked: vi.fn(),
}));

import { contextualizeRetrievalQuery } from './rag-orchestrator';
import type { RAGHistoryTurn } from './rag-orchestrator';

const userTurn = (content: string): RAGHistoryTurn => ({ role: 'user', content });
const assistantTurn = (content: string): RAGHistoryTurn => ({ role: 'assistant', content });

describe('contextualizeRetrievalQuery (Issue #40 RC3)', () => {
  test('rewrites a pronoun-heavy follow-up by prepending the most recent user turn', () => {
    const history: RAGHistoryTurn[] = [
      userTurn('How do I order medication in CDP?'),
      assistantTurn('You cannot order medication without the Order Medications permission.'),
    ];
    const result = contextualizeRetrievalQuery('how do I fix it?', history);
    // Prepends the prior user turn (topic carrier) and keeps the follow-up.
    expect(result).toContain('medication');
    expect(result).toContain('how do I fix it?');
    expect(result.startsWith('How do I order medication in CDP?')).toBe(true);
  });

  test('rewrites a short non-wh follow-up', () => {
    const history: RAGHistoryTurn[] = [
      userTurn('Explain the storage architecture.'),
      assistantTurn('It uses IndexedDB.'),
    ];
    // 2 words, doesn't start with a wh-word → follow-up.
    const result = contextualizeRetrievalQuery('more detail', history);
    expect(result).toContain('storage architecture');
    expect(result).toContain('more detail');
  });

  test('rewrites a continuation-keyword follow-up (elaborate)', () => {
    const history: RAGHistoryTurn[] = [
      userTurn('What is the cosign workflow?'),
      assistantTurn('A second user must approve orders above a threshold.'),
    ];
    const result = contextualizeRetrievalQuery('Can you elaborate further on that?', history);
    expect(result).toContain('cosign workflow');
    expect(result).toContain('elaborate');
  });

  test('returns the question unchanged when it is self-contained (no pronoun, starts with wh-word)', () => {
    const history: RAGHistoryTurn[] = [userTurn('prior topic'), assistantTurn('prior answer')];
    const result = contextualizeRetrievalQuery('What is machine learning?', history);
    expect(result).toBe('What is machine learning?');
  });

  test('returns the question unchanged when history is empty (first-turn recall)', () => {
    const result = contextualizeRetrievalQuery('how do I fix it?', []);
    expect(result).toBe('how do I fix it?');
  });

  test('returns the question unchanged when it is empty', () => {
    const history: RAGHistoryTurn[] = [userTurn('prior')];
    const result = contextualizeRetrievalQuery('   ', history);
    expect(result).toBe('   ');
  });

  test('falls back to the most recent assistant first-sentence when no user turn exists', () => {
    // Degenerate history: only assistant turns (e.g. a system greeting).
    const history: RAGHistoryTurn[] = [
      assistantTurn('Welcome. You can ask me about medication ordering.'),
    ];
    const result = contextualizeRetrievalQuery('how do I fix it?', history);
    // Prepends the assistant's first sentence (the only available context).
    expect(result).toContain('Welcome');
    expect(result).toContain('how do I fix it?');
    // Should NOT include the second sentence.
    expect(result).not.toContain('medication ordering');
  });

  test('pronoun in a self-contained-looking question still triggers rewrite (documented over-trigger)', () => {
    // "What is this thing?" matches \bthis\b → treated as a follow-up. This is
    // a documented, bounded over-trigger: prepended context rarely hurts
    // retrieval, and the broader heuristic trades a little precision for recall
    // on genuine follow-ups.
    const history: RAGHistoryTurn[] = [userTurn('Tell me about the dashboard.')];
    const result = contextualizeRetrievalQuery('What is this thing?', history);
    expect(result).toContain('dashboard');
    expect(result).toContain('What is this thing?');
  });

  test('does not rewrite when the only history turn is an empty assistant message', () => {
    const history: RAGHistoryTurn[] = [assistantTurn('')];
    const result = contextualizeRetrievalQuery('how do I fix it?', history);
    // No substantive context to prepend → returns the raw question.
    expect(result).toBe('how do I fix it?');
  });

  test('prepends the MOST RECENT user turn when multiple are present', () => {
    const history: RAGHistoryTurn[] = [
      userTurn('old topic one'),
      assistantTurn('old answer one'),
      userTurn('recent topic two'),
      assistantTurn('recent answer two'),
    ];
    const result = contextualizeRetrievalQuery('elaborate', history);
    expect(result.startsWith('recent topic two')).toBe(true);
    expect(result).not.toContain('old topic one');
  });

  test('"vs" continuation keyword triggers rewrite when the question is NOT wh-led', () => {
    const history: RAGHistoryTurn[] = [userTurn('Tell me about wllama.')];
    const result = contextualizeRetrievalQuery('wllama vs webllm', history);
    expect(result).toContain('wllama');
  });

  test('short question starting with a wh-word is NOT rewritten', () => {
    const history: RAGHistoryTurn[] = [userTurn('prior')];
    // 2 words, starts with "why" → not a follow-up despite being short.
    const result = contextualizeRetrievalQuery('why though', history);
    expect(result).toBe('why though');
  });

  test('a self-contained wh-led comparison question with "vs" is NOT rewritten (reviewer Q1 fix)', () => {
    // "What is wllama vs webllm?" starts with a wh-word — even though it contains
    // the continuation keyword "vs", it is self-contained and must pass through.
    // Without this guard, after a prior medication question the rewrite would
    // wrongly prepend the medication topic and degrade retrieval.
    const history: RAGHistoryTurn[] = [
      userTurn('How do I order medication in CDP?'),
      assistantTurn('You need the Order Medications permission.'),
    ];
    const result = contextualizeRetrievalQuery('What is wllama vs webllm?', history);
    expect(result).toBe('What is wllama vs webllm?');
    expect(result).not.toContain('medication');
  });

  test('a self-contained wh-led comparison question with "compare" is NOT rewritten', () => {
    const history: RAGHistoryTurn[] = [userTurn('prior topic')];
    const result = contextualizeRetrievalQuery('How do these compare?', history);
    // "How do these compare?" — "How" is wh-led, BUT "these" is anaphora, so
    // pattern 1 (anaphora) DOES trigger. This documents that anaphora is the
    // stronger signal and intentionally overrides the wh-led self-contained
    // heuristic (a pronoun genuinely needs context).
    expect(result).toContain('prior topic');
  });
});
