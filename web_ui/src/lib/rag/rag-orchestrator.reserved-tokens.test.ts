/**
 * Guardrail unit test for the prompt reserved-token sum (issue #83, Phase 4.2).
 *
 * Defect class: "a prompt-context channel that is not charged to the token
 * budget". computeReservedTokens is the extracted single sum every prompt
 * channel must appear in; this test pins that the pinnedContext term is
 * included (the C3(ii)/(iii) frozen checks pin the behavioral consequence in
 * both directions — inject-without-charge and truncate-to-fake-charge both
 * fail).
 */
import { describe, test, expect, vi } from 'vitest';
import { computeReservedTokens } from './rag-orchestrator';
import { DEFAULT_N_CTX } from '../llm/wllama-service';

// Strip the heavy service singletons from the import chain (vector-index
// pulls the native edgevec build, which cannot load under vitest) — this test
// exercises the pure budget arithmetic only. Same mock set as the other
// rag-orchestrator suites.
vi.mock('../search/vector-index', () => ({ getVectorIndex: vi.fn() }));
vi.mock('../search/keyword-index', () => ({ getKeywordIndex: vi.fn() }));
vi.mock('../search/reranker', () => ({ getRerankerService: vi.fn() }));
vi.mock('../search/rrf-fusion', () => ({ rrfFuse: vi.fn() }));
vi.mock('../embeddings/embedding-service', () => ({ getEmbeddingService: vi.fn() }));
vi.mock('../llm/llm-factory', () => ({ getLLMService: vi.fn() }));
vi.mock('../llm/web-llm-service', () => ({ WebLLMService: { getInstance: vi.fn() } }));
vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn(),
  ensureReadinessGateChecked: vi.fn(),
}));

const BASE = {
  systemPrompt: 'system prompt',
  question: 'explain this step',
  historyText: 'prior turn',
};

describe('computeReservedTokens (issue #83 guardrail)', () => {
  test('includes the pinnedContext term: the sum grows with the pin', () => {
    const withoutPin = computeReservedTokens({ ...BASE });
    const withPin = computeReservedTokens({ ...BASE, pinnedContext: 'x'.repeat(400) });
    // 400 chars / 4 = 100 tokens charged.
    expect(withPin - withoutPin).toBe(100);
  });

  test('charges by the same chars/4 ceiling as every other channel (no NaN)', () => {
    const withoutPin = computeReservedTokens({ ...BASE });
    const blank = '   ';
    const blankPin = computeReservedTokens({ ...BASE, pinnedContext: blank });
    // estimateTokens is the shared ceil(len/4) — a 3-char pin costs 1 token,
    // exactly like a 3-char history turn would. NaN would break the budget.
    expect(blankPin - withoutPin).toBe(Math.ceil(blank.length / 4));
    expect(Number.isFinite(blankPin)).toBe(true);
  });

  test('defaults maxTokens to 512 when omitted', () => {
    const sum = computeReservedTokens(BASE);
    const explicit = computeReservedTokens({ ...BASE, maxTokens: 512 });
    expect(sum).toBe(explicit);
  });

  test('maxTokens changes propagate into the reservation', () => {
    expect(computeReservedTokens({ ...BASE, maxTokens: 1024 })).toBe(
      computeReservedTokens({ ...BASE, maxTokens: 512 }) + 512
    );
  });

  test('guardrail scenario: pin + long history + long context stay within DEFAULT_N_CTX', () => {
    // The C3 scenario's arithmetic, asserted through the extracted helper.
    const reserved = computeReservedTokens({
      systemPrompt: 's'.repeat(370),
      question: 'explain this step',
      historyText: 'h'.repeat(8000),
      pinnedContext: 'p'.repeat(16090),
      maxTokens: 512,
    });
    const contextBudgetChars = Math.max(0, (DEFAULT_N_CTX - reserved) * 4);
    // With the pin charged, at most one 3000-char chunk fits (budget < 2 chunks).
    expect(contextBudgetChars).toBeLessThan(6000);
    expect(contextBudgetChars).toBeGreaterThanOrEqual(0);
  });
});
