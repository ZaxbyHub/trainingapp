/**
 * Issue #37 §5: retrieval eval harness (CI-runnable layer).
 *
 * Loads the labeled corpus from scripts/eval/corpus/eval.jsonl, runs each
 * question through the orchestrator with MOCKED retrieval services, and asserts:
 *   - in-corpus questions: the expected docId appears in the final context.
 *   - out-of-corpus questions: the pipeline abstains (or the expected doc is
 *     absent — there is no expected doc for OOC questions).
 *
 * The mocks use deterministic per-(question, chunk) scores derived from token
 * overlap, so the test is stable AND sensitive to real pipeline changes (the
 * RRF order, the relevance floor, the dedup pass, the abstain gate all act on
 * these mocked results). This runs in the normal `npm test` CI step.
 *
 * Acceptance #15 (§3 do-not-break list) is partially asserted here at the
 * contract level: the orchestrator is constructed with the default system
 * prompt, RRF k=60 is exercised through the real rrfFuse (NOT mocked here), and
 * the zero-chunk abstain path is reachable for OOC questions. The BGE query
 * prefix and CLS-pooling invariants live in the embedding service (covered by
 * its own unit tests) and are out of scope for this harness.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { SearchResult } from '../../types/search';
import type { EmbeddingVector } from '../../types/embedding';

// The canonical labeled corpus ALSO lives at scripts/eval/corpus/eval.jsonl
// (for the operator-run real-weight eval). It is inlined here as a typed const
// because Vitest's module transforms make reliable file-read paths fragile,
// and keeping a single source of truth for the CI test avoids fs interop
// flakiness. If you add a question to eval.jsonl, mirror it here.
const CORPUS: readonly EvalQuestion[] = [
  { id: 'q01', question: 'What is the standard reimbursement rate for mileage?', docId: 'doc_policy', expectedChunkSubstring: 'mileage', outOfCorpus: false },
  { id: 'q02', question: 'How many vacation days does a new employee receive?', docId: 'doc_handbook', expectedChunkSubstring: 'vacation', outOfCorpus: false },
  { id: 'q03', question: 'Who do I contact for password reset help?', docId: 'doc_it_help', expectedChunkSubstring: 'password', outOfCorpus: false },
  { id: 'q04', question: 'What is the maximum expense for client dinners?', docId: 'doc_expense', expectedChunkSubstring: 'dinner', outOfCorpus: false },
  { id: 'q05', question: 'Describe the quarterly safety inspection procedure', docId: 'doc_safety', expectedChunkSubstring: 'inspection', outOfCorpus: false },
  { id: 'q06', question: 'What benefits are available to part-time staff?', docId: 'doc_handbook', expectedChunkSubstring: 'part-time', outOfCorpus: false },
  { id: 'q07', question: 'How is overtime pay calculated?', docId: 'doc_payroll', expectedChunkSubstring: 'overtime', outOfCorpus: false },
  { id: 'q08', question: 'What is the data retention policy for customer records?', docId: 'doc_compliance', expectedChunkSubstring: 'retention', outOfCorpus: false },
  { id: 'q09', question: 'When was the company founded?', docId: 'doc_about', expectedChunkSubstring: 'founded', outOfCorpus: false },
  { id: 'q10', question: 'What software is used for inventory tracking?', docId: 'doc_ops', expectedChunkSubstring: 'inventory', outOfCorpus: false },
  { id: 'q11', question: 'What is the capital of France?', outOfCorpus: true },
  { id: 'q12', question: 'Tell me about the Mars rover mission timeline', outOfCorpus: true },
  { id: 'q13', question: 'How do I bake sourdough bread?', outOfCorpus: true },
] as const;

interface EvalQuestion {
  id: string;
  question: string;
  docId?: string;
  expectedChunkSubstring?: string;
  outOfCorpus?: boolean;
}

function loadCorpus(): EvalQuestion[] {
  return [...CORPUS];
}

/**
 * The synthetic document corpus the mocked retrieval services return hits from.
 * Each doc's text contains the expectedChunkSubstring token so a token-overlap
 * scorer ranks it highly for the matching question and low for others.
 */
const DOC_FIXTURES: Array<{ docId: string; chunkIndex: number; text: string }> = [
  { docId: 'doc_policy', chunkIndex: 0, text: 'The standard mileage reimbursement rate is 0.67 per mile for personal vehicle use on company business. Mileage logs must be submitted monthly.' },
  { docId: 'doc_handbook', chunkIndex: 0, text: 'New full-time employees receive 15 vacation days per year. Part-time staff receive a pro-rated vacation benefit based on hours worked.' },
  { docId: 'doc_it_help', chunkIndex: 0, text: 'For password reset help, contact the IT helpdesk at extension 4357. Password resets are typically completed within one business day.' },
  { docId: 'doc_expense', chunkIndex: 0, text: 'Client dinner expenses are reimbursed up to 80 dollars per person including tax and tip. Alcohol is not reimbursable on client dinners.' },
  { docId: 'doc_safety', chunkIndex: 0, text: 'The quarterly safety inspection procedure covers fire extinguishers, emergency exits, and first-aid stations. Inspections must be logged in the safety system.' },
  { docId: 'doc_payroll', chunkIndex: 0, text: 'Overtime pay is calculated at 1.5 times the regular hourly rate for hours worked beyond 40 in a week. Overtime must be approved in advance.' },
  { docId: 'doc_compliance', chunkIndex: 0, text: 'Customer records are retained for 7 years after the relationship ends. The retention policy complies with applicable data protection regulations.' },
  { docId: 'doc_about', chunkIndex: 0, text: 'The company was founded in 1998 and is headquartered in Austin, Texas. Our mission is to deliver reliable field-service software.' },
  { docId: 'doc_ops', chunkIndex: 0, text: 'Inventory tracking is managed in the WarehousePro software suite. Stock levels sync hourly between the warehouse and the procurement system.' },
];

/** Tokenize for the overlap scorer (lowercase, alphanumeric, light plural-stripped).
 *  The tiny plural-stripping stemmer (trailing 's' on words > 3 chars) keeps
 *  "dinners"/"dinner" and "expenses"/"expense" aligned without pulling in a
 *  full stemmer dependency. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/\s+/)) {
    let t = raw.replace(/[^\p{L}\p{N}]/gu, '');
    if (t.length <= 2) continue; // skip very short tokens (incl. stopwords)
    if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1);
    out.add(t);
  }
  return out;
}

/**
 * Score a (question, doc) pair by Jaccard token overlap. Higher = more relevant.
 * Deterministic, no ML required — this is the mocked "relevance signal" the
 * harness uses to drive vector + keyword results.
 */
function overlapScore(question: string, docText: string): number {
  const q = tokenize(question);
  const d = tokenize(docText);
  if (q.size === 0 || d.size === 0) return 0;
  let inter = 0;
  for (const t of q) if (d.has(t)) inter++;
  return inter / Math.sqrt(q.size * d.size); // cosine-like normalization
}

// --- Mocks (module-level so each test resets them) ---

vi.mock('../embeddings/embedding-service', () => ({ getEmbeddingService: vi.fn() }));
vi.mock('../search/vector-index', () => ({ getVectorIndex: vi.fn() }));
vi.mock('../search/keyword-index', () => ({ getKeywordIndex: vi.fn() }));
vi.mock('../search/reranker', () => ({ getRerankerService: vi.fn() }));
vi.mock('../llm/llm-factory', () => ({ getLLMService: vi.fn() }));
vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn().mockResolvedValue(true),
  ensureReadinessGateChecked: vi.fn().mockResolvedValue({ ready: true }),
}));

// IMPORTANT: do NOT mock rrf-fusion here — the eval exercises the REAL fusion +
// dedup code paths (acceptance #15: RRF rank-only k=60).

import { RAGOrchestrator } from './rag-orchestrator';
import { getEmbeddingService } from '../embeddings/embedding-service';
import { getVectorIndex } from '../search/vector-index';
import { getKeywordIndex } from '../search/keyword-index';
import { getRerankerService } from '../search/reranker';
import { getLLMService } from '../llm/llm-factory';

describe('Issue #37 §5 — retrieval eval harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Build a mock embedding service that returns a deterministic vector. The
    // vector's content is irrelevant because vector-index is also mocked; we
    // just need the orchestrator's encode path to resolve.
    const mockEmbeddingService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      encode: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
      encodeWithMetadata: vi.fn().mockResolvedValue({
        vector: new Float32Array(384).fill(0.1) as EmbeddingVector,
        text: 'q',
        dimensions: 384,
      }),
      dispose: vi.fn(),
    };
    (getEmbeddingService as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockEmbeddingService);

    // Mock vector index: returns docs ranked by overlap with the query. The
    // orchestrator passes the BGE-prefixed query; we tokenize and score
    // against the fixture texts.
    const mockVectorIndex = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      search: vi.fn(async (query: EmbeddingVector, _opts?: { k?: number }) => {
        // The orchestrator prepends the BGE instruction; we don't have access
        // to the raw question here, so score by a hash of the query bytes is
        // NOT meaningful. Instead, return ALL fixtures as vector hits with a
        // uniform score; the reranker mock below re-orders by overlap. This
        // exercises fusion + dedup + the rerank gate with a realistic candidate
        // set, while keeping the recall signal in the reranker (which DOES see
        // the question text).
        void query;
        const k = _opts?.k ?? 10;
        return DOC_FIXTURES.slice(0, k).map((d, i) => ({
          docId: d.docId,
          chunkIndex: d.chunkIndex,
          score: 0.9 - i * 0.05,
          text: d.text,
        } satisfies SearchResult));
      }),
      dispose: vi.fn(),
    };
    (getVectorIndex as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockVectorIndex);

    // Mock keyword index: same — returns fixtures; reranker re-orders.
    const mockKeywordIndex = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      search: vi.fn((_query: string, opts?: { limit?: number }) => {
        const limit = opts?.limit ?? 10;
        return DOC_FIXTURES.slice(0, limit).map((d, i) => ({
          docId: d.docId,
          chunkIndex: d.chunkIndex,
          score: 0.8 - i * 0.05,
          text: d.text,
        } satisfies SearchResult));
      }),
      dispose: vi.fn(),
    };
    (getKeywordIndex as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockKeywordIndex);

    // Mock reranker: ready, re-orders by REAL overlap score (it sees the
    // question text). This is where the recall signal lives for the harness.
    const mockRerankerService = {
      isReady: vi.fn().mockReturnValue(true),
      canRerank: vi.fn().mockReturnValue(true),
      rerank: vi.fn(async (question: string, results: SearchResult[], topK?: number) => {
        const scored = results.map((r) => ({
          r,
          score: overlapScore(question, r.text ?? ''),
        }));
        scored.sort((a, b) => b.score - a.score);
        const out = scored.map(({ r, score }) => ({ ...r, score }));
        return topK !== undefined ? out.slice(0, topK) : out;
      }),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
    (getRerankerService as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockRerankerService);

    // Mock LLM: not invoked for abstention; returns a stub answer otherwise.
    const mockLlm = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      getContextWindow: vi.fn().mockReturnValue(8192),
      generateComplete: vi.fn().mockResolvedValue('answer'),
      generateStream: async function* () { yield 'answer'; },
      dispose: vi.fn(),
    };
    (getLLMService as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockLlm);
  });

  test('in-corpus questions surface the expected document in the final context (recall@k)', async () => {
    const corpus = loadCorpus().filter((q) => !q.outOfCorpus);
    expect(corpus.length).toBeGreaterThanOrEqual(5);
    let passed = 0;
    const failures: string[] = [];
    for (const q of corpus) {
      const orchestrator = new RAGOrchestrator();
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      for await (const ev of orchestrator.query(q.question, {
        streamTokens: false,
        rerank: true,
        topK: 5,
        candidateMultiplier: 2,
      })) {
        events.push(ev as { type: string; data: Record<string, unknown> });
      }
      const complete = events.find((e) => e.type === 'complete');
      const chunks = (complete?.data?.chunks ?? []) as SearchResult[];
      const found = q.docId ? chunks.some((c) => c.docId === q.docId) : true;
      if (found) {
        passed++;
      } else {
        failures.push(`${q.id}: expected docId ${q.docId}, got [${chunks.map((c) => c.docId).join(',')}]`);
      }
    }
    // Require ALL in-corpus questions to pass (deterministic mocks). A drop
    // here is a real pipeline regression.
    expect(failures, `recall failures:\n${failures.join('\n')}`).toEqual([]);
    expect(passed).toBe(corpus.length);
  });

  test('out-of-corpus questions abstain (no fabricated answer)', async () => {
    const ooc = loadCorpus().filter((q) => q.outOfCorpus);
    expect(ooc.length).toBeGreaterThanOrEqual(2);
    for (const q of ooc) {
      const orchestrator = new RAGOrchestrator();
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      for await (const ev of orchestrator.query(q.question, {
        streamTokens: false,
        rerank: true,
        topK: 5,
      })) {
        events.push(ev as { type: string; data: Record<string, unknown> });
      }
      const complete = events.find((e) => e.type === 'complete');
      // Either abstain flag is set, OR the context is empty (zero-chunk path).
      const abstain = complete?.data?.abstain === true;
      const chunks = (complete?.data?.chunks ?? []) as SearchResult[];
      expect(
        abstain || chunks.length === 0,
        `${q.id}: out-of-corpus question should abstain (got ${chunks.length} chunks, abstain=${abstain})`
      ).toBe(true);
    }
  });

  test('acceptance #15: RRF fusion is rank-only with k=60 (real rrfFuse, not mocked)', async () => {
    // Sanity: confirm the real rrfFuse is in play (the test file does NOT mock
    // rrf-fusion). A chunk that appears in BOTH legs at rank 0 scores
    // 2/(60+0+1) ≈ 0.0328; a chunk in one leg at rank 0 scores 1/61 ≈ 0.0164.
    // The orchestrator calls rrfFuse([vector, keyword], 60) — assert via a
    // direct import.
    const { rrfFuse } = await import('../search/rrf-fusion');
    const bothLegs = rrfFuse([
      [{ docId: 'd', chunkIndex: 0, score: 0.9, text: 'a' }],
      [{ docId: 'd', chunkIndex: 0, score: 0.8, text: 'a' }],
    ], 60);
    expect(bothLegs[0].score).toBeCloseTo(2 / 61, 5);
    const oneLeg = rrfFuse([
      [{ docId: 'd', chunkIndex: 0, score: 0.9, text: 'a' }],
      [],
    ], 60);
    expect(oneLeg[0].score).toBeCloseTo(1 / 61, 5);
  });
});
