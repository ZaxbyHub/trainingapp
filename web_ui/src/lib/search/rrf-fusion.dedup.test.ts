// @vitest-environment node
/**
 * Acceptance spec for #35-B2 — near-duplicate chunk suppression after RRF
 * fusion (batch-153-35-rag-quality, AC1). AMENDMENT ROUND: covers the
 * REDESIGNED dedup predicate + a Stage-4 orchestrator wiring leg.
 *
 * NEW-SURFACE: asserts the fixed behavior of `dedupeNearDuplicates` exported
 * from rrf-fusion.ts. The function does not exist at the trace base commit
 * (7f397fb6) — the pure tests fail there (the import binds to undefined) and
 * the wiring test fails there (the pair survives into the final context),
 * which is the expected base signature.
 *
 * Redesigned predicate under test (plan Revision 3, critic round-2 redesign):
 *   - Adjacency arm — same docId AND adjacent (|chunkIndex diff| == 1)
 *     candidates are near-duplicates iff the LONGEST ORDERED
 *     suffix-of-one === prefix-of-the-other word run (element-wise exact
 *     word-sequence equality at the seam, BOTH directions tested — document
 *     order is not fusion order) is at least `minOverlapWords` (default 20),
 *     capped at the construction maximum (chunkOverlap = 100; the split path
 *     carries <= 50). A TRUE longest-overlap computation — no enumerated
 *     windows, no Jaccard.
 *   - PLUS an exact-duplicate arm: normalized full-text equality collapses a
 *     pair regardless of docId.
 *   Keep-first (higher-ranked) occurrence; order preserved.
 *   Disclosed residual (accepted by the plan): adjacent chunks sharing a
 *   >=20-word exact ordered EDGE run of repeated boilerplate are
 *   indistinguishable from overlap twins at this boundary and ARE deduped;
 *   the high-boilerplate leg below pins the PREFIX-positioned boilerplate
 *   shape (no edge-aligned seam), which must stay KEPT.
 *
 * All test names embed the 'near-dup dedup' token — the check driver filters
 * on it (vitest -t 'near-dup dedup'). A missed match exits 0 with 0 executed,
 * so the token is the guard.
 *
 * The wiring describe must use the REAL rrf-fusion module (no vi.mock for
 * it) so the test proves the orchestrator itself collapses the pair — with
 * every retrieval/LLM dependency mocked, mirroring
 * rag-orchestrator.historybudget.test.ts conventions.
 */

import { describe, it, expect, test, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResult } from '../../types/search';
import type { EmbeddingVector } from '../../types/embedding';

// ---------------------------------------------------------------------------
// Fixture helpers (shared by the pure tests and the wiring leg)
// ---------------------------------------------------------------------------

/** 10-word vocabulary used to build ordered overlap regions. */
const OVERLAP_PATTERN = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo',
  'foxtrot', 'golf', 'hotel', 'india', 'juliet',
];

/** The shared ordered overlap region: pattern repeated `repeats` times. */
function overlapRegion(repeats: number): string[] {
  const words: string[] = [];
  for (let r = 0; r < repeats; r++) words.push(...OVERLAP_PATTERN);
  return words;
}

/** Unique filler words (each appears exactly once in the whole fixture). */
function uniqueWords(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

function makeResult(
  docId: string,
  chunkIndex: number,
  words: string[],
  score: number
): SearchResult {
  return { docId, chunkIndex, score, text: words.join(' ') };
}

/**
 * Adjacent overlap pair with the production accumulate-path shape: two
 * 256-word bodies sharing exactly a `sharedWords`-word ORDERED seam region
 * (first entry's trailing words === second entry's leading words, verbatim
 * word sequence). Under seam-length semantics the longest ordered
 * suffix/prefix run is exactly `sharedWords` (the filler vocabularies are
 * disjoint), so the pair duplicates iff sharedWords >= minOverlapWords.
 */
function makeOverlapPair(
  docId = 'doc-ov',
  sharedWords = 100
): { first: SearchResult; second: SearchResult } {
  const repeats = Math.max(1, Math.round(sharedWords / 10));
  const bodyLen = 256 - repeats * 10;
  const bodyA = [...uniqueWords('aword', bodyLen), ...overlapRegion(repeats)];
  const bodyB = [...overlapRegion(repeats), ...uniqueWords('bword', bodyLen)];
  return {
    first: makeResult(docId, 0, bodyA, 0.9),
    second: makeResult(docId, 1, bodyB, 0.8),
  };
}

/**
 * Build an adjacent same-doc pair sharing an EXACT ordered seam of
 * `seamWords` distinct realistic words at the boundary (A's trailing
 * `seamWords` words === B's leading `seamWords` words, verbatim sequence).
 * Disjoint unique filler on both sides, so the longest ordered seam run is
 * exactly `seamWords`.
 */
function makeSeamPair(
  docId: string,
  seamWords: string[],
  fillerWords = 180
): { first: SearchResult; second: SearchResult } {
  const bodyA = [...uniqueWords(`f${docId}a`, fillerWords), ...seamWords];
  const bodyB = [...seamWords, ...uniqueWords(`f${docId}b`, fillerWords)];
  return {
    first: makeResult(docId, 0, bodyA, 0.9),
    second: makeResult(docId, 1, bodyB, 0.8),
  };
}

/** A realistic 60-word sentence used as an exact ordered seam run (length self-checked in the test). */
const REAL_SEAM_60 = (
  'the quarterly compliance review verifies that every archived training ' +
  'record was countersigned by the designated facility supervisor before ' +
  'the retention deadline expired and that escalated reconciliation ' +
  'failures were reported through the governance channel without delay ' +
  'so the audit committee can certify that the archive remains complete ' +
  'and accurate for the entire retention period under the custody policy ' +
  'required by regulation'
).split(' ');

/** Topic vocabulary shared by the over-merge guard fixtures. */
const TOPIC_WORDS = [
  'training', 'protocol', 'compliance', 'audit',
  'records', 'retention', 'policy', 'procedure',
];

/**
 * 256-word body about the same topic as a sibling call, but with NO shared
 * ordered run: every 4th word is a topic word (8 distinct, shared), the rest
 * are unique per body.
 */
function topicalBody(prefix: string, topicSeed: number, words: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(i % 4 === 3 ? TOPIC_WORDS[(topicSeed + i) % TOPIC_WORDS.length] : `${prefix}${i}`);
  }
  return out;
}

/**
 * 90 words of NON-periodic boilerplate (all distinct) — the shared header
 * both chunks carry verbatim, but positioned as a PREFIX of both bodies so
 * the ordered suffix/prefix comparison cannot match it.
 */
function boilerplate(): string[] {
  return Array.from({ length: 90 }, (_, i) => `boilerheaderphrase${i}`);
}

// ---------------------------------------------------------------------------
// Pure tests: the redesigned dedupeNearDuplicates predicate
// ---------------------------------------------------------------------------

describe('rrf-fusion near-duplicate dedup (#35-B2 / AC1)', () => {
  it('near-dup dedup: surface exists — dedupeNearDuplicates is an exported function', () => {
    // Base signature anchor: at the base commit this fails with
    // "expected 'undefined' to be 'function'".
    expect(typeof dedupeNearDuplicates).toBe('function');
  });

  it('near-dup dedup: adjacent same-doc chunks sharing a 100-word ordered overlap region collapse to the first entry', () => {
    const { first, second } = makeOverlapPair('doc-ov', 100);

    const out = dedupeNearDuplicates([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]!.docId).toBe(first.docId);
    expect(out[0]!.chunkIndex).toBe(first.chunkIndex);
    expect(out[0]!.text).toBe(first.text);
  });

  it('near-dup dedup: adjacent same-doc chunks sharing a 50-word ordered overlap region (split-path shape) collapse to the first entry', () => {
    // The chunker's long-sentence split loop re-injects
    // floor(chunkOverlap/2) = 50 trailing words into the next piece, so an
    // adjacent pair sharing exactly a 50-word ordered region is a real
    // production duplicate shape that the seam-length predicate (run 50 >=
    // 20) must catch.
    const { first, second } = makeOverlapPair('doc-split', 50);

    const out = dedupeNearDuplicates([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]!.docId).toBe('doc-split');
    expect(out[0]!.chunkIndex).toBe(first.chunkIndex);
  });

  it('near-dup dedup: two unrelated chunks both survive (no false positive)', () => {
    const unrelatedA = makeResult('doc-u1', 0, uniqueWords('unobody1', 256), 0.9);
    const unrelatedB = makeResult('doc-u2', 0, uniqueWords('unobody2', 256), 0.8);

    const out = dedupeNearDuplicates([unrelatedA, unrelatedB]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.docId)).toEqual(['doc-u1', 'doc-u2']);
  });

  it('near-dup dedup: surviving entries preserve input order and keep the first occurrence', () => {
    const { first, second } = makeOverlapPair('doc-ov', 100);
    const unrelated1 = makeResult('doc-x1', 0, uniqueWords('xbody1', 256), 0.95);
    const unrelated2 = makeResult('doc-x2', 0, uniqueWords('xbody2', 256), 0.7);

    const out = dedupeNearDuplicates([unrelated1, first, second, unrelated2]);

    expect(out.map((r) => r.docId)).toEqual(['doc-x1', 'doc-ov', 'doc-x2']);
    const kept = out.find((r) => r.docId === 'doc-ov');
    expect(kept!.chunkIndex).toBe(first.chunkIndex);
    expect(kept!.text).toBe(first.text);
  });

  it('near-dup dedup: same-topic chunks without a shared leading/trailing run are NOT merged (no over-merge)', () => {
    const topicA = makeResult('doc-t1', 0, topicalBody('pone', 0, 256), 0.9);
    const topicB = makeResult('doc-t2', 0, topicalBody('ptwo', 3, 256), 0.8);

    const out = dedupeNearDuplicates([topicA, topicB]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.docId)).toEqual(['doc-t1', 'doc-t2']);
  });

  it('near-dup dedup: high-boilerplate adjacent pair with distinct tails is KEPT (no edge-aligned seam)', () => {
    // Both same-doc adjacent bodies carry the same 90-word boilerplate
    // header verbatim, but each ends with its own 10-word tail. The
    // boilerplate sits at the PREFIX of both bodies, so no
    // suffix-of-one === prefix-of-the-other seam exists (A's suffix is its
    // own tail + boilerplate end; B's prefix is the boilerplate start) —
    // the longest ordered seam run is 0 and the pair must be KEPT. (The
    // plan's DISCLOSED RESIDUAL is the different, edge-ALIGNED boilerplate
    // shape — a repeated header that lands verbatim at one chunk's end and
    // the next chunk's start — which IS deduped and is not pinned KEPT
    // here.) If this prefix-positioned pair gets merged, the predicate has
    // widened beyond the contract and this pin forces a re-discussion.
    const boiler = boilerplate();
    const bodyA = [...boiler, ...uniqueWords('hwtail1', 10)];
    const bodyB = [...boiler, ...uniqueWords('hwtail2', 10)];
    const highBoilerA = makeResult('doc-hb', 0, bodyA, 0.9);
    const highBoilerB = makeResult('doc-hb', 1, bodyB, 0.8);

    const out = dedupeNearDuplicates([highBoilerA, highBoilerB]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.chunkIndex)).toEqual([0, 1]);
  });

  it('near-dup dedup: a 60-word exact ordered seam run between adjacent chunks (real sentence-overlap shape) collapses to the first entry', () => {
    // The critic's production shape: the real TextChunker produces adjacent
    // chunks sharing one ~60-word SENTENCE verbatim (sentence-level overlap
    // from calculateOverlap). Built directly as two 240-word chunks with the
    // 60-word sentence at the seam, this scores <= 0.667 under ANY
    // enumerated-window scheme (window 100 Jaccard = 60/(100+100-60) =
    // 0.625) and would be missed — but the TRUE longest ordered seam run is
    // exactly 60 >= minOverlapWords, so the pair must be deduped.
    expect(REAL_SEAM_60).toHaveLength(60);
    const { first, second } = makeSeamPair('doc-seam60', REAL_SEAM_60, 180);

    const out = dedupeNearDuplicates([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]!.docId).toBe('doc-seam60');
    expect(out[0]!.chunkIndex).toBe(0);
    expect(out[0]!.text).toBe(first.text);
  });

  it('near-dup dedup: seam-length boundary — a 19-word run is KEPT, a 20-word run is deduped (minimum inclusive)', () => {
    // The documented minimum is minOverlapWords = 20, INCLUSIVE ("at least
    // minOverlapWords", plan Revision 3). Distinct-word seams with disjoint
    // fillers pin both sides of the boundary: the longest seam run is
    // exactly the seam size.
    const seam19 = uniqueWords('swnineteen', 19);
    const seam20 = uniqueWords('swtwenty', 20);
    expect(new Set(seam19).size).toBe(19);
    expect(new Set(seam20).size).toBe(20);

    const { first: f19, second: s19 } = makeSeamPair('doc-b19', seam19, 100);
    const kept = dedupeNearDuplicates([f19, s19]);
    expect(kept).toHaveLength(2); // 19 < 20: below the documented minimum

    const { first: f20, second: s20 } = makeSeamPair('doc-b20', seam20, 100);
    const deduped = dedupeNearDuplicates([f20, s20]);
    expect(deduped).toHaveLength(1); // 20 >= 20: at the minimum, inclusive
    expect(deduped[0]!.chunkIndex).toBe(0);
  });

  it('near-dup dedup: options surface — minOverlapWords controls the minimum seam length', () => {
    // Contract (plan Revision 3 amendment): the options surface pins
    // `minOverlapWords`. With the minimum at the default 20 the 60-word
    // seam pair dedups; raising the minimum above the actual seam length
    // keeps it — proving the option actually drives the boundary.
    expect(REAL_SEAM_60).toHaveLength(60);
    const { first, second } = makeSeamPair('doc-opt60', REAL_SEAM_60, 180);

    const atDefault = dedupeNearDuplicates([first, second], { minOverlapWords: 20 });
    expect(atDefault).toHaveLength(1);

    const raised = dedupeNearDuplicates([first, second], { minOverlapWords: 61 });
    expect(raised).toHaveLength(2);
  });

  it('near-dup dedup: cross-document identical text collapses via the exact-duplicate arm; a one-word difference does not', () => {
    const words = [...uniqueWords('xdoc', 200), ...overlapRegion(5)];
    const crossA = makeResult('doc-cx1', 0, words, 0.9);
    const crossB = makeResult('doc-cx2', 0, words, 0.8); // identical text, different docId
    const crossC = makeResult('doc-cx3', 0, [...words.slice(0, -1), 'onerift'], 0.7); // one word differs

    // Identical text (normalized full-text equality) collapses across docs.
    const deduped = dedupeNearDuplicates([crossA, crossB]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.docId).toBe('doc-cx1');

    // A one-word difference defeats the exact arm; different docIds also
    // defeat the adjacency arm -> both kept.
    const kept = dedupeNearDuplicates([crossA, crossC]);
    expect(kept).toHaveLength(2);
  });

  it('near-dup dedup: non-adjacent same-doc chunks with an overlap-shaped region are KEPT (adjacency required)', () => {
    // Same ordered 100-word suffix/prefix shape as the positive case, but
    // chunkIndex 0 vs 2 (|diff| == 2): the adjacency requirement fails, so
    // the pair must survive (non-adjacent chunks are legitimately distinct
    // evidence even when they share an overlap region).
    const { first, second } = makeOverlapPair('doc-gap', 100);
    const shifted: SearchResult = { ...second, chunkIndex: 2 };

    const out = dedupeNearDuplicates([first, shifted]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.chunkIndex)).toEqual([0, 2]);
  });

  it('near-dup dedup: reordered-word overlap (same word bag, no ordered run) is KEPT', () => {
    // B's leading region contains exactly A's trailing region's words but in
    // REVERSE order: identical word BAG, but the ordered seam run — read in
    // the SAME direction (A's last k words vs B's first k words, element
    // wise) — is 1 word ('juliet'), far below any minimum. The ordered-seam
    // requirement must keep both; bag-of-words similarity alone is not the
    // adjacent-overlap shape.
    const region = overlapRegion(5); // 50 ordered words
    const bodyA = [...uniqueWords('rword', 206), ...region];
    const bodyB = [...[...region].reverse(), ...uniqueWords('sword', 206)];
    const pairA = makeResult('doc-rw', 0, bodyA, 0.9);
    const pairB = makeResult('doc-rw', 1, bodyB, 0.8);

    const out = dedupeNearDuplicates([pairA, pairB]);
    expect(out).toHaveLength(2);
  });

  it('near-dup dedup: entries with missing or empty text are KEPT, never treated as duplicates', () => {
    // No-text entries must pass through untouched (identity-key metadata can
    // still be consumed downstream) and must never crash the comparator nor
    // match anything — including another no-text entry of the same doc.
    const noTextA: SearchResult = { docId: 'doc-m1', chunkIndex: 0, score: 0.9 };
    const noTextB: SearchResult = { docId: 'doc-m1', chunkIndex: 1, score: 0.8 };
    const emptyText = makeResult('doc-m2', 0, ['', ''], 0.7); // joined -> ''
    const withText = makeResult('doc-m3', 0, uniqueWords('mword', 50), 0.6);

    const out = dedupeNearDuplicates([noTextA, noTextB, emptyText, withText]);
    expect(out).toHaveLength(4);
    expect(out.map((r) => r.docId)).toEqual(['doc-m1', 'doc-m1', 'doc-m2', 'doc-m3']);
  });
});

// ---------------------------------------------------------------------------
// Stage-4 wiring leg: the ORCHESTRATOR applies the dedup after fusion,
// before rerank/selection. The REAL rrf-fusion module is used here (no
// vi.mock for it) so the test proves the production wiring, not the mock.
// ---------------------------------------------------------------------------

// Mock every orchestrator dependency EXCEPT rrf-fusion (mirrors
// rag-orchestrator.historybudget.test.ts conventions).
vi.mock('../embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(),
}));

vi.mock('../search/vector-index', () => ({
  getVectorIndex: vi.fn(),
}));

vi.mock('../search/keyword-index', () => ({
  getKeywordIndex: vi.fn(),
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
  getPreferredBrowserEngine: vi.fn().mockReturnValue('wllama'),
}));

vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn().mockResolvedValue(true),
  ensureReadinessGateChecked: vi.fn().mockResolvedValue({ ready: true }),
}));

import { dedupeNearDuplicates } from './rrf-fusion';
import { RAGOrchestrator } from '../rag/rag-orchestrator';
import { getEmbeddingService } from '../embeddings/embedding-service';
import { getVectorIndex } from '../search/vector-index';
import { getKeywordIndex } from '../search/keyword-index';
import { getRerankerService } from '../search/reranker';
import { getLLMService } from '../llm/llm-factory';

describe('Stage-4 wiring: orchestrator collapses overlap pairs after fusion (#35-B2 / AC1)', () => {
  let mockEmbeddingService: { encodeWithMetadata: ReturnType<typeof vi.fn>; encodeBatch: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn> };
  let mockVectorIndex: { isReady: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> };
  let mockKeywordIndex: { isReady: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> };
  let mockRerankerService: { isReady: ReturnType<typeof vi.fn>; canRerank: ReturnType<typeof vi.fn>; rerank: ReturnType<typeof vi.fn> };
  let mockWebLLMService: { generate: ReturnType<typeof vi.fn>; generateComplete: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockEmbeddingService = {
      encodeWithMetadata: vi.fn(),
      encodeBatch: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    };
    mockVectorIndex = { isReady: vi.fn().mockReturnValue(true), search: vi.fn() };
    mockKeywordIndex = { isReady: vi.fn().mockReturnValue(true), search: vi.fn() };
    mockRerankerService = {
      isReady: vi.fn().mockReturnValue(true),
      canRerank: vi.fn().mockReturnValue(false),
      rerank: vi.fn().mockResolvedValue([]),
    };
    mockWebLLMService = {
      generate: vi.fn(),
      generateComplete: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    };

    (getEmbeddingService as ReturnType<typeof vi.fn>).mockReturnValue(mockEmbeddingService);
    (getVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockVectorIndex);
    (getKeywordIndex as ReturnType<typeof vi.fn>).mockReturnValue(mockKeywordIndex);
    (getRerankerService as ReturnType<typeof vi.fn>).mockReturnValue(mockRerankerService);
    (getLLMService as ReturnType<typeof vi.fn>).mockReturnValue(mockWebLLMService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('near-dup dedup: Stage-4 wiring — an overlap duplicate pair from both retrieval legs reaches the LLM context as ONE chunk', async () => {
    const question = 'What does the protocol require?';
    // Adjacent same-doc pair with the production 100-word ordered overlap.
    // Both retrieval legs return BOTH entries (each leg scores the pair
    // highly for the same evidence — the B2 defect shape). Vector leg scores
    // the FIRST entry higher so real RRF fusion ranks it first.
    const { first, second } = makeOverlapPair('doc-ov', 100);
    mockEmbeddingService.encodeWithMetadata.mockResolvedValue({
      vector: new Float32Array(768).fill(0.1) as EmbeddingVector,
      text: question,
      dimensions: 768,
    });
    mockVectorIndex.search.mockResolvedValue([
      { ...first, score: 0.95 },
      { ...second, score: 0.80 },
    ]);
    mockKeywordIndex.search.mockReturnValue([
      { ...first, score: 0.90 },
      { ...second, score: 0.70 },
    ]);
    mockRerankerService.canRerank.mockReturnValue(false);
    mockWebLLMService.generateComplete.mockResolvedValue('grounded answer [1]');

    const orchestrator = new RAGOrchestrator();
    const events: Array<{ type: string; data?: any }> = [];
    for await (const event of orchestrator.query(question, {
      rerank: false,
      streamTokens: false,
    })) {
      events.push(event);
    }

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();

    // Fusion alone (base behavior) keeps both entries — different
    // `${docId}:${chunkIndex}` keys. The wired dedup must collapse the pair
    // BEFORE selection so only the higher-ranked (chunkIndex 0) twin reaches
    // the context and the complete event.
    expect(complete!.data.chunks).toHaveLength(1);
    expect(complete!.data.chunks[0].docId).toBe('doc-ov');
    expect(complete!.data.chunks[0].chunkIndex).toBe(0);
    expect(complete!.data.sources).toEqual(['doc-ov']);
    expect(mockWebLLMService.generateComplete).toHaveBeenCalledTimes(1);
  });
});
