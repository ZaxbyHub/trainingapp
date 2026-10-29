// @vitest-environment node
/**
 * Acceptance spec for #153-3 (W3) — history budget cap in the RAG
 * orchestrator (batch-153-35-rag-quality, AC3). AMENDMENT ROUND: retention
 * tests rewritten for the REDESIGNED capHistoryToBudget retention rule, plus
 * a charge==render pin (the capped history is what reaches the LLM).
 *
 * NEW-SURFACE: `capHistoryToBudget` does not exist at the trace base commit
 * (7f397fb6) — every test below fails there (the import binds to undefined /
 * query() force-abstains), which is the expected base signature.
 *
 * Redesigned retention rule under test (per the plan critic's amendment):
 *   1. newest turns fit the budget (tail-truncating a kept turn if needed);
 *      the walk STOPS at the first older turn that does not fit — the kept
 *      window is CONTIGUOUS, never spliced around a skipped middle turn
 *      (AMENDMENT ROUND 5: an over-budget middle turn TRUNCATES the window,
 *      it must never be silently skipped while older turns are kept);
 *   2. IF the kept window has no user turn, the newest USER turn is forcibly
 *      included (tail-truncated);
 *   3. leading assistant turns are dropped while length > 1;
 *   4. the returned window is chronological.
 *   Default budget ~2048 tokens by the chars/4 estimator.
 *
 * Charge==render: RAGOrchestrator.query() applies the cap BEFORE charging
 * history to reservedTokens AND threads the CAPPED turns into the LLM
 * message array — the orchestrator leg captures generateComplete's messages
 * and asserts the history portion EQUALS capHistoryToBudget's output for
 * the same input (computed via the exported function in this test).
 *
 * Mock conventions mirror rag-orchestrator.test.ts exactly, with two
 * additions so the file stays green after the sibling seams land:
 *   - the llm-factory mock also exports getPreferredBrowserEngine;
 *   - the rrf-fusion mock also exports dedupeNearDuplicates (pass-through),
 *     since the C1 seam wires it into the orchestrator.
 *
 * All test names embed the 'history budget cap' token — the check driver
 * filters on it (vitest -t 'history budget cap').
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResult } from '../../types/search';
import type { EmbeddingVector } from '../../types/embedding';
import type { LLMMessage } from '../../types/llm';

// --- Mock Implementations (mirrored from rag-orchestrator.test.ts) ---

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
  canRerank: vi.fn().mockReturnValue(false),
  rerank: vi.fn().mockResolvedValue([]),
});

const createMockWebLLMService = () => ({
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

// The C1 seam adds dedupeNearDuplicates to this module and wires it into the
// orchestrator; export a pass-through here so the mock stays complete after
// that lands (this spec's fixtures contain no near-duplicates).
vi.mock('../search/rrf-fusion', () => ({
  rrfFuse: vi.fn(),
  dedupeNearDuplicates: vi.fn(),
}));

vi.mock('../search/reranker', () => ({
  getRerankerService: vi.fn(),
}));

vi.mock('../llm/web-llm-service', () => ({
  WebLLMService: {
    getInstance: vi.fn(),
  },
}));

// F10: the orchestrator resolves its default engine via getLLMService(). The
// factory also exports getPreferredBrowserEngine — include it so the mock
// covers the full factory surface.
vi.mock('../llm/llm-factory', () => ({
  getLLMService: vi.fn(),
  getPreferredBrowserEngine: vi.fn().mockReturnValue('wllama'),
}));

// F4: readiness helpers drive semantic availability; default ready so the
// full pipeline (both retrieval legs) is exercised.
vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn().mockResolvedValue(true),
  ensureReadinessGateChecked: vi.fn().mockResolvedValue({ ready: true }),
}));

// Import types and class AFTER mocks are set up
import { RAGOrchestrator, capHistoryToBudget } from './rag-orchestrator';
import type { RAGHistoryTurn } from './rag-orchestrator';

// Import mocked modules for setting up returns
import { getEmbeddingService } from '../embeddings/embedding-service';
import { getVectorIndex } from '../search/vector-index';
import { getKeywordIndex } from '../search/keyword-index';
import { getRerankerService } from '../search/reranker';
import { rrfFuse, dedupeNearDuplicates } from '../search/rrf-fusion';
import { getLLMService } from '../llm/llm-factory';
import { ensureEmbeddingServiceReady, ensureReadinessGateChecked } from '../../hooks/useServiceInitialization';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The repo's chars-per-4 token estimator (same convention as the module). */
const est = (text: string): number => Math.ceil(text.length / 4);

const createMockEmbedding = (): EmbeddingVector => new Float32Array(768).fill(0.1);

/** Joined text of the capped window (array of turns). */
function joinedOf(out: unknown): string {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return (out as Array<{ content?: string }>).map((t) => t.content ?? '').join('\n');
  }
  return '';
}

/** The capped window as turns (the redesign returns a turn array). */
function turnsOf(out: unknown): RAGHistoryTurn[] {
  expect(Array.isArray(out), 'capHistoryToBudget must return an array of turns').toBe(true);
  return out as RAGHistoryTurn[];
}

/**
 * Assert a kept window is a valid conversation shape under the redesigned
 * rule: user-first when length > 1, strictly alternating roles, and any
 * present markers appear in chronological (input) order.
 */
function assertConversationShape(windowed: RAGHistoryTurn[], markersInInputOrder: string[]): void {
  if (windowed.length > 1) {
    expect(windowed[0]!.role, 'leading assistant turns must be dropped (user-first)').toBe('user');
  }
  for (let i = 1; i < windowed.length; i++) {
    expect(windowed[i]!.role, 'roles must strictly alternate (chronological return)').not.toBe(windowed[i - 1]!.role);
  }
  const joined = joinedOf(windowed);
  let prev = -1;
  for (const m of markersInInputOrder) {
    const idx = joined.indexOf(m);
    if (idx !== -1) {
      expect(idx, `marker ${m} must appear in chronological order`).toBeGreaterThan(prev);
      prev = idx;
    }
  }
}

/**
 * Six alternating turns of ~20k chars each (role-marked heads so retention
 * is assertable): joined text is ~120k chars ~ 30k estimated tokens — far
 * above any sane history budget, reproducing the browser-path shape that
 * collapses the context budget at base.
 */
function makeOversizedHistory(): RAGHistoryTurn[] {
  return [
    { role: 'user', content: `marker-u0 ${'h'.repeat(20000)}` },
    { role: 'assistant', content: `marker-a0 ${'h'.repeat(20000)}` },
    { role: 'user', content: `marker-u1 ${'h'.repeat(20000)}` },
    { role: 'assistant', content: `marker-a1 ${'h'.repeat(20000)}` },
    { role: 'user', content: `marker-u2 ${'h'.repeat(20000)}` },
    { role: 'assistant', content: `marker-a2 ${'h'.repeat(20000)}` },
  ];
}

// ---------------------------------------------------------------------------
// Unit tests: capHistoryToBudget (redesigned retention rule)
// ---------------------------------------------------------------------------

describe('capHistoryToBudget (#153-3 / AC3)', () => {
  it('history budget cap: surface exists — capHistoryToBudget is an exported function', () => {
    // Base signature anchor: at the base commit this fails with
    // "expected 'undefined' to be 'function'".
    expect(typeof capHistoryToBudget).toBe('function');
  });

  it('history budget cap: oversized history is trimmed so the joined text fits the explicit token budget', () => {
    const out = capHistoryToBudget(makeOversizedHistory(), 2048);

    const windowed = turnsOf(out);
    expect(windowed.length).toBeGreaterThanOrEqual(1);
    expect(est(joinedOf(windowed))).toBeLessThanOrEqual(2048);
    assertConversationShape(windowed, ['marker-u0', 'marker-a0', 'marker-u1', 'marker-a1', 'marker-u2', 'marker-a2']);
  });

  it('history budget cap: the newest USER turn survives even when the newest assistant answer alone exceeds the budget', () => {
    // The critic's probe shape: the newest turn is a HUGE assistant answer;
    // a naive newest-fit window would carry only (part of) that answer with
    // NO user turn at all. The redesigned rule forcibly includes the newest
    // USER turn (tail-truncated) so the follow-up keeps its question.
    const history: RAGHistoryTurn[] = [
      { role: 'user', content: `marker-u0 ${'p'.repeat(280)}` },
      { role: 'assistant', content: `marker-a0 ${'p'.repeat(280)}` },
      { role: 'user', content: `marker-u1 ${'p'.repeat(280)}` },
      { role: 'assistant', content: `marker-a1 ${'z'.repeat(60000)}` },
    ];

    const out = capHistoryToBudget(history, 512); // 2048 chars — less than the 60k answer
    const windowed = turnsOf(out);

    // (ii) budget fit — always.
    expect(est(joinedOf(windowed))).toBeLessThanOrEqual(512);

    // (i) the newest USER turn is present (head of it — truncation drops
    // tails, never the head of a forcibly-included turn).
    expect(joinedOf(windowed)).toContain('marker-u1');

    // The oldest turns were dropped to fit.
    expect(joinedOf(windowed)).not.toContain('marker-u0');
    expect(joinedOf(windowed)).not.toContain('marker-a0');

    // (iii)+(iv) user-first, alternating, chronological.
    assertConversationShape(windowed, ['marker-u0', 'marker-a0', 'marker-u1', 'marker-a1']);
  });

  it('history budget cap: the newest-fit walk keeps a CONTIGUOUS window (an over-budget middle turn truncates the window, never splices)', () => {
    // Swarm-review round 5: the PRE-FIX newest-fit walk SKIPPED the
    // over-budget middle turn and kept walking older, splicing a
    // non-contiguous window. Verified against the pre-fix code shape (the
    // committed walk had no break at the first non-fitting older turn):
    // on this exact input the pre-fix walk kept a1 (fits), skipped u1
    // (~10000 est > 512), then kept a0 and u0 (each ~50 est fits) and
    // returned [u0, a0, a1] — CONSECUTIVE ASSISTANT turns (a0/a1 adjacent,
    // the newest question u1 silently dropped while OLDER turns u0/a0
    // survived) — the malformed shape third-party jinja chat templates
    // reject. The shipped walk BREAKS at the first over-budget older turn:
    // window [a1] alone -> no user turn -> the forced-user rule pulls u1's
    // HEAD back in (tail-truncated to half the budget) -> EXACTLY
    // [u1(head-truncated), a1]. RED pre-fix (strict alternation fails on
    // a0/a1; u1 absent) / GREEN post-fix.
    const history: RAGHistoryTurn[] = [
      { role: 'user', content: `marker-u0 ${'p'.repeat(190)}` },      // ~200 chars (~50 est)
      { role: 'assistant', content: `marker-a0 ${'p'.repeat(190)}` }, // ~200 chars (~50 est)
      { role: 'user', content: `marker-u1 ${'z'.repeat(39990)}` },    // 40000 chars (~10000 est) — over any tested budget
      { role: 'assistant', content: `marker-a1 ${'p'.repeat(190)}` }, // ~200 chars (~50 est)
    ];

    const out = capHistoryToBudget(history, 512);
    const windowed = turnsOf(out);

    // EXACTLY the newest exchange: the over-budget u1 (head-truncated) + a1.
    expect(windowed).toHaveLength(2);
    expect(windowed[0]!.role).toBe('user');
    expect(windowed[0]!.content.startsWith('marker-u1')).toBe(true); // head survives the truncation
    expect(windowed[0]!.content.length).toBeLessThan(history[2]!.content.length); // truncated, not the whole 40k turn
    expect(windowed[1]!.role).toBe('assistant');
    expect(windowed[1]!.content).toContain('marker-a1');

    // The turns the pre-fix walk spliced in AROUND the skipped u1 are absent.
    const joined = joinedOf(windowed);
    expect(joined).not.toContain('marker-u0');
    expect(joined).not.toContain('marker-a0');

    // Roles strictly alternate (user-first, chronological) and the budget fit holds.
    assertConversationShape(windowed, ['marker-u0', 'marker-a0', 'marker-u1', 'marker-a1']);
    expect(est(joined)).toBeLessThanOrEqual(512);
  });

  it('history budget cap: the window never begins with an orphan assistant turn (user-first retention)', () => {
    // Small alternating turns where a naive most-recent-N slice lands
    // assistant-first: [u0,a0,u1,a1,u2,a2].slice(-5) = [a0,u1,a1,u2,a2].
    const mk = (role: 'user' | 'assistant', i: number): RAGHistoryTurn => ({
      role,
      content: `marker-${role[0]}${i} ${'p'.repeat(190)}`,
    });
    const history: RAGHistoryTurn[] = [
      mk('user', 0), mk('assistant', 0), mk('user', 1),
      mk('assistant', 1), mk('user', 2), mk('assistant', 2),
    ];

    const out = capHistoryToBudget(history, 250);
    const windowed = turnsOf(out);
    expect(windowed.length).toBeGreaterThanOrEqual(2);

    // (iii) the leading orphan assistant turn is dropped; (ii) still fits.
    expect(windowed[0]!.role).toBe('user');
    expect(est(joinedOf(windowed))).toBeLessThanOrEqual(250);

    // (iv) chronological: newest content retained, oldest dropped, order kept.
    assertConversationShape(windowed, history.map((t) => t.content.split(' ')[0]!));
    expect(joinedOf(windowed)).toContain('marker-a2');
    expect(joinedOf(windowed)).not.toContain('marker-u0');
  });

  it('history budget cap: a single oversized turn is tail-truncated, keeping its head within budget', () => {
    const history: RAGHistoryTurn[] = [
      { role: 'user', content: `HEADMARK ${'z'.repeat(40000)}` }, // ~10002 est
    ];

    const out = capHistoryToBudget(history, 512);
    const windowed = turnsOf(out);
    expect(windowed.length).toBeGreaterThanOrEqual(1);
    expect(est(joinedOf(windowed))).toBeLessThanOrEqual(512);

    // Truncation drops the TAIL; the head of the turn survives so the most
    // recent user intent stays in the window.
    expect(windowed[0]!.content.startsWith('HEADMARK')).toBe(true);
  });

  it('history budget cap: within-budget history passes through unchanged', () => {
    const history: RAGHistoryTurn[] = [
      { role: 'user', content: 'short user turn about medication ordering' },
      { role: 'assistant', content: 'short assistant turn about permissions' },
    ];

    const out = capHistoryToBudget(history, 2048);
    const windowed = turnsOf(out);
    expect(windowed).toHaveLength(2);
    expect(joinedOf(windowed)).toBe(history.map((t) => t.content).join('\n'));
  });

  it('history budget cap: the default budget caps an oversized history (no explicit budget needed)', () => {
    // Default budget is ~2048 tokens per the contract. Assert against a
    // tolerant ceiling (2048 + 25%) so a default of 2000/2048/2560 all
    // pass while an unbounded default (30k est) fails loudly.
    const out = capHistoryToBudget(makeOversizedHistory());
    const windowed = turnsOf(out);
    expect(windowed.length).toBeGreaterThanOrEqual(1);
    expect(est(joinedOf(windowed))).toBeLessThanOrEqual(2560);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator: the cap is applied before the charge AND rendered into the
// prompt (charge == render).
// ---------------------------------------------------------------------------

describe('RAGOrchestrator history budget (#153-3 / AC3)', () => {
  let mockEmbeddingService: ReturnType<typeof createMockEmbeddingService>;
  let mockVectorIndex: ReturnType<typeof createMockVectorIndex>;
  let mockKeywordIndex: ReturnType<typeof createMockKeywordIndex>;
  let mockRerankerService: ReturnType<typeof createMockRerankerService>;
  let mockWebLLMService: ReturnType<typeof createMockWebLLMService>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEmbeddingService = createMockEmbeddingService();
    mockVectorIndex = createMockVectorIndex();
    mockKeywordIndex = createMockKeywordIndex();
    mockRerankerService = createMockRerankerService();
    mockWebLLMService = createMockWebLLMService();

    (getEmbeddingService as ReturnType<typeof vi.fn>).mockReturnValue(mockEmbeddingService);
    (getVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockVectorIndex);
    (getKeywordIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockKeywordIndex);
    (getRerankerService as ReturnType<typeof vi.fn>).mockReturnValue(mockRerankerService);
    (getLLMService as ReturnType<typeof vi.fn>).mockReturnValue(mockWebLLMService);

    // Semantic search available: BOTH retrieval legs run and return the
    // evidence chunk (the exact-key duplicate is fused to one entry).
    (ensureEmbeddingServiceReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ensureReadinessGateChecked as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: true });

    // Real-fusion-shaped mock: concatenate the legs and collapse exact
    // `${docId}:${chunkIndex}` keys (what rrfFuse does to identical hits).
    (rrfFuse as ReturnType<typeof vi.fn>).mockImplementation((lists: SearchResult[][]) => {
      const seen = new Set<string>();
      const fused: SearchResult[] = [];
      for (const list of lists) {
        for (const r of list) {
          const key = `${r.docId}:${r.chunkIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            fused.push(r);
          }
        }
      }
      return fused;
    });

    // C1 seam pass-through (this spec has no near-duplicates).
    (dedupeNearDuplicates as ReturnType<typeof vi.fn>).mockImplementation(
      (results: SearchResult[]) => results
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('history budget cap: 4 oversized history turns with live evidence do NOT force abstention, and the CAPPED history is what reaches the LLM', async () => {
    const question = 'What does the audit protocol require?';
    const evidence: SearchResult = {
      docId: 'evidence-doc',
      chunkIndex: 0,
      score: 0.9, // above the no-rerank degraded cosine floor (0.4) and the RRF floor
      text: 'The audit protocol requires quarterly record retention reviews and signed compliance reports.',
      source: 'evidence.pdf',
    };

    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: createMockEmbedding(),
      text: question,
      dimensions: 768,
    });
    // Both retrieval legs return the same evidence chunk.
    mockVectorIndex.search.mockResolvedValue([evidence]);
    mockKeywordIndex.search.mockReturnValue([evidence]);

    // Deterministic path: no reranking (option + canRerank false).
    mockRerankerService.canRerank.mockReturnValue(false);

    // Browser-path shape: 4 prior turns of ~20k chars each, uncapped
    // upstream (ChatPage threads up to 6 turns with no per-turn char cap).
    const history: RAGHistoryTurn[] = [
      { role: 'user', content: `marker-u0 ${'h'.repeat(20000)}` },
      { role: 'assistant', content: `marker-a0 ${'h'.repeat(20000)}` },
      { role: 'user', content: `marker-u1 ${'h'.repeat(20000)}` },
      { role: 'assistant', content: `marker-a1 ${'h'.repeat(20000)}` },
    ];

    // Capture the messages the LLM actually receives (charge == render).
    let capturedMessages: LLMMessage[] | null = null;
    mockWebLLMService.generateComplete.mockImplementation(async (messages: LLMMessage[]) => {
      capturedMessages = messages;
      return 'The protocol requires quarterly reviews [1].';
    });

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: any }> = [];
    for await (const event of orchestrator.query(question, {
      history,
      rerank: false,
      streamTokens: false,
    })) {
      events.push(event);
    }

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();

    // On base the joined history (~20k estimated tokens) drives
    // contextBudgetChars to 0, the evidence chunk is dropped, and the query
    // abstains with insufficient_evidence. With the cap applied BEFORE the
    // charge, the evidence fits and the query stays grounded.
    expect(complete!.data.abstain).not.toBe(true);
    expect(complete!.data.chunks.length).toBeGreaterThanOrEqual(1);
    expect(complete!.data.chunks[0].docId).toBe('evidence-doc');
    expect(complete!.data.grounding).toBe('grounded');

    // The LLM actually answered from the evidence (not a short-circuit).
    expect(mockWebLLMService.generateComplete).toHaveBeenCalledTimes(1);
    expect(complete!.data.answer).toContain('quarterly reviews');

    // ---- charge == render pin ----
    // The history threaded into the prompt must be exactly the CAPPED window
    // (computed here via the same exported function), never the oversized
    // input. Message layout: [system, ...history, user(current)].
    expect(capturedMessages).not.toBeNull();
    const messages = capturedMessages as unknown as LLMMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[messages.length - 1]!.role).toBe('user');

    const expected = capHistoryToBudget(history); // default budget, same input
    const expectedTurns = turnsOf(expected);
    expect(est(joinedOf(expectedTurns))).toBeLessThanOrEqual(2560); // the cap actually capped

    const historyMsgs = messages.slice(1, -1);
    expect(historyMsgs).toHaveLength(expectedTurns.length);
    expect(historyMsgs.map((m) => ({ role: m.role, content: m.content }))).toEqual(
      expectedTurns.map((t) => ({ role: t.role as LLMMessage['role'], content: t.content }))
    );
    // And the oversized raw turn text never reaches the prompt.
    const joinedPromptHistory = historyMsgs.map((m) => m.content).join('\n');
    expect(joinedPromptHistory.length).toBeLessThanOrEqual(2560 * 4 + historyMsgs.length + 1);
  });
});
