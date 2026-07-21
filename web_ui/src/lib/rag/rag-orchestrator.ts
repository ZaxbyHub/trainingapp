/**
 * RAG Orchestrator - Coordinates the full retrieval-augmented generation pipeline.
 *
 * Pipeline flow:
 * 1. Embed query via EmbeddingService
 * 2. Search vector index (topK candidates)
 * 3. Search keyword index (topK candidates)
 * 4. RRF fuse the two result sets
 * 5. Optionally rerank top candidates via RerankerService
 * 6. Build context from top chunks with source metadata
 * 7. Generate answer via WebLLMService with citation instructions
 * 8. Stream tokens as RAGEvent
 *
 * FR-005: Retrieve relevant chunks
 * FR-006: Context assembly
 * FR-007: LLM generation
 * FR-008: Source citations
 */

import type { SearchResult } from '../../types/search';
import type { LLMMessage, LLMService } from '../../types/llm';
import type { EmbeddingVector } from '../../types/embedding';

import { getEmbeddingService, type EmbeddingService } from '../embeddings/embedding-service';
import { getVectorIndex, type VectorIndex } from '../search/vector-index';
import { getKeywordIndex, type KeywordIndex } from '../search/keyword-index';
import { rrfFuse } from '../search/rrf-fusion';
import { getRerankerService, type RerankerService } from '../search/reranker';
import { getLLMService } from '../llm/llm-factory';
import { DEFAULT_N_CTX } from '../llm/wllama-service';
import { ensureEmbeddingServiceReady, ensureReadinessGateChecked } from '../../hooks/useServiceInitialization';

/**
 * Options for RAG query execution.
 */
/** A raw image to pass to a multimodal LLM (ArrayBuffer bytes + mime type). */
export interface RAGImageInput {
  data: ArrayBuffer;
  mimeType?: string;
}

/**
 * Issue #40 RC1: one turn of prior conversation. `role` matches the LLM
 * chat-template convention; `content` is the raw message text (history is
 * text-only — multimodal history is out of scope; only the current turn carries
 * images). Mirrors the {role, content} subset the server's `history` field
 * accepts (api_server.py:187).
 */
export interface RAGHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RAGQueryOptions {
  /** Number of top results to retrieve from each index (default: 10) */
  topK?: number;
  /**
   * Multiplier on topK controlling how many candidates each retrieval leg
   * fetches before fusion + rerank (Issue #37 R2). Both legs fetch
   * `topK * candidateMultiplier` candidates so the cross-encoder can promote a
   * chunk that ranked below topK in ONE leg but is highly relevant overall.
   * `fast` uses 1 (no rerank → no point over-fetching); `balanced` 3; `quality` 4.
   * Default 1 preserves legacy behavior when unset.
   */
  candidateMultiplier?: number;
  /** Whether to apply reranking to results (default: true) */
  rerank?: boolean;
  /** Whether to stream tokens as they are generated (default: true) */
  streamTokens?: boolean;
  /** Custom system prompt override */
  systemPrompt?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Sampling temperature (higher = more creative) */
  temperature?: number;
  /** Nucleus sampling probability threshold */
  topP?: number;
  /** Issue #40 RC2: anti-repetition sampling penalties (forwarded to the engine). */
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** Images to include with the question (multimodal engines only). */
  images?: RAGImageInput[];
  /**
   * Issue #40 RC1: prior conversation turns threaded into the LLM prompt and
   * used to contextualize the retrieval query (RC3). Caller caps at the last N
   * turns; the orchestrator charges history to the token budget so it never
   * starves context. Each turn is plain text.
   */
  history?: RAGHistoryTurn[];
  /** AbortSignal for cancelling the in-progress query */
  signal?: AbortSignal;
}

/**
 * Events emitted during RAG pipeline execution.
 */
export type RAGEvent =
  | { type: 'retrieving'; data: { query: string } }
  | { type: 'retrieved'; data: { vectorResults: SearchResult[]; keywordResults: SearchResult[]; fusedResults: SearchResult[] } }
  | { type: 'reranking'; data: { count: number } }
  | { type: 'reranked'; data: { results: SearchResult[] } }
  | { type: 'generating'; data: { contextLength: number; sourceCount: number } }
  | { type: 'token'; data: string }
  | {
      type: 'complete';
      data: {
        answer: string;
        /** Filenames (deduped from chunk.source, falling back to docId). */
        sources: string[];
        /** The exact contextChunks array passed to buildContext, in order. The
         *  model's [1],[2] citations map onto this array by index. */
        chunks: SearchResult[];
        /** True when the pipeline abstained instead of answering (F2). */
        abstain?: boolean;
        abstainReason?: 'insufficient_evidence' | 'retrieval_degraded';
        /** True when retrieval ran keyword-only (semantic search unavailable) (F4). */
        retrievalDegraded?: boolean;
        /** Number of context chunks dropped to fit the token budget (F11). */
        contextTrimmed?: number;
      };
    }
  | { type: 'error'; data: { stage: RAGStage; message: string } };

/**
 * Stages where errors can occur in the RAG pipeline.
 */
type RAGStage = 'embedding' | 'vector_search' | 'keyword_search' | 'rrf_fusion' | 'reranking' | 'context' | 'generation';

/**
 * Default system prompt. Instructs the model on RAG grounding, citation
 * format, AND output structure (markdown formatting, capitalization,
 * paragraphing) so answers render with ChatGPT/Claude-level polish in the
 * markdown renderer. ~280 tokens (1120 chars) — non-trivial but bounded by
 * MAX_HISTORY_BUDGET_TOKENS so it can't collapse the chunk budget.
 *
 * Gemma 4 E2B-it has a known tendency toward lowercase sentence starts and
 * terse unstructured output; the formatting instructions counteract that.
 */
const DEFAULT_SYSTEM_PROMPT = `You are a knowledgeable assistant answering questions about uploaded documents. Follow these rules carefully:

GROUNDING
- Answer using ONLY the provided Context. Quote or paraphrase faithfully.
- Cite sources inline using [1], [2], [3] notation matching the context numbering.
- If the context does not contain enough information, say so explicitly — never invent facts.
- Use the conversation history to clarify follow-up questions.

FORMATTING (important)
- Always start sentences with a capital letter and end with proper punctuation.
- Use Markdown to structure your answer:
  - Use short paragraphs separated by blank lines for readability.
  - Use **bold** for key terms, field names, and emphasis.
  - Use bullet lists (-) or numbered lists (1.) for steps, options, or enumerations.
  - Use ## headings to separate major sections of a long answer.
- Be thorough and detailed — give complete explanations, not one-line answers.
- When listing steps or procedures, number them in order.
- When comparing options, use a structured list or table.

TONE
- Professional, clear, direct. Write as a helpful expert would.`;

/**
 * Retrieval query instruction. Issue #37 R9: the value is UNCHANGED from the
 * prior BGE configuration. snowflake-arctic-embed-m-v1.5's model card does NOT
 * require a query prefix (it's a non-instruct model), so keeping the prefix is
 * harmless — it adds context to the query text without degrading arctic's
 * retrieval quality. Applied to the QUERY embedding only; passages stay
 * UN-prefixed (F8).
 */
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

/**
 * Relevance floors applied AFTER the rerank/slice branch resolves, so the floor
 * must match the score scale contextChunks actually carries (F3, Issue #37 R3).
 *  - When the cross-encoder reran: scores are sigmoid of the relevance logit
 *    for each [query, passage] pair, in (0, 1). For the prior ms-marco reranker,
 *    relevant pairs typically scored >0.5; irrelevant <0.1. The current ettin
 *    reranker (Issue #37 R9) was trained on different data (MTEB-eng-v2); its
 *    exact score histogram is not yet re-validated against this floor. Floor 0.2
 *    is kept (changing it is a follow-up); it may need re-tuning on real corpora.
 *  - When only RRF ran: scores are sums of 1/(60+rank+1); the minimum POSSIBLE
 *    fused score is 1/(60+topK) ≈ 0.0132 for topK=16, so 0.005 has never
 *    dropped anything. {@link MIN_RRF_SCORE} is kept as a literal floor only;
 *    the real degraded-mode relevance signal is the cosine backstop applied to
 *    vector hits in the no-rerank path (see applyDegradedFloor).
 */
const MIN_CROSS_SCORE = 0.2;
const MIN_RRF_SCORE = 0.005;

/**
 * Cosine-similarity floor applied to VECTOR hits in the degraded no-reranker
 * path (Issue #37 R3). When the reranker did not run (fast preset, or reranker
 * model absent), RRF scores carry no absolute-relevance signal — edgevec
 * returns the k nearest regardless of similarity. Dropping vector hits below
 * this cosine threshold removes low-quality matches before RRF fusion so the
 * context does not fill with irrelevant chunks on out-of-corpus questions.
 *
 * edgevec 0.6 with metric:'cosine' + L2-normalized embeddings returns a
 * similarity score where higher = more similar (verified via the BQRescored
 * docstring and the project's own "sorted by score descending" JSDoc). Empirical
 * range for arctic-embed-m-v1.5 normalized embeddings: in-corpus pairs typically
 * >0.5; unrelated pairs <0.35. 0.4 is a conservative floor that preserves
 * borderline hits while dropping clear non-matches.
 */
const DEGRADED_VECTOR_COSINE_FLOOR = 0.4;

/**
 * Token-budget estimate for keeping the user's question in-prompt under the
 * model context window (F11). No tokenizer is exposed by the LLM service, so a
 * conservative chars-per-token approximation is used with an explicit safety
 * margin. DEFAULT_N_CTX (8192) is sourced from wllama-service — the binding
 * constraint for the default offline engine.
 */
const CHARS_PER_TOKEN = 4;
const TOKEN_SAFETY_MARGIN = 96;
/**
 * Hard cap on the token budget consumed by conversation history. Without this,
 * 6 turns of long answers (up to 1536 tokens each on the quality preset) could
 * saturate the 8192-token context window, collapsing the retrieved-chunk
 * budget to near-zero (swarm-pr-review run-48 PRR48-004). Capping history at
 * 2048 tokens (~25% of n_ctx) bounds the worst case while preserving enough
 * multi-turn context for follow-up questions. The cap is applied to the JOINED
 * history text BEFORE the budget reservation, so only the most recent ~2048
 * tokens of history are charged.
 */
const MAX_HISTORY_BUDGET_TOKENS = 2048;

/**
 * RAG Orchestrator - Coordinates embedding search, keyword search, RRF fusion,
 * optional reranking, and LLM generation into a single async pipeline.
 */
export class RAGOrchestrator {
  private embeddingService: EmbeddingService;
  private vectorIndex: VectorIndex;
  private keywordIndex: KeywordIndex;
  private rerankerService: RerankerService;
  private llmService: LLMService;

  /**
   * Create a new RAGOrchestrator with service references.
   * Retrieval services are singletons; the LLM engine can be injected so callers
   * (e.g. ChatPage) can select wllama vs WebLLM. Defaults to the offline-first
   * engine (wllama) via getLLMService() — WebLLM resolves weights from a CDN and
   * breaks the air-gap guarantee, so it must never be the implicit default (F10).
   */
  constructor(opts?: { llmService?: LLMService }) {
    this.embeddingService = getEmbeddingService();
    this.vectorIndex = getVectorIndex();
    this.keywordIndex = getKeywordIndex();
    this.rerankerService = getRerankerService();
    this.llmService = opts?.llmService ?? getLLMService();
  }

  /**
   * Execute the full RAG pipeline for a query.
   *
   * @param question - The user's question
   * @param options - Optional configuration for the pipeline
   * @yields RAGEvent objects describing pipeline progress
   */
  async *query(
    question: string,
    options: RAGQueryOptions = {}
  ): AsyncGenerator<RAGEvent> {
    const topK = options.topK ?? 10;
    const candidateMultiplier = Math.max(1, options.candidateMultiplier ?? 1);
    const fetchK = topK * candidateMultiplier;
    const doRerank = options.rerank ?? true;
    const streamTokens = options.streamTokens ?? true;
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const maxTokens = options.maxTokens;
    const temperature = options.temperature;
    const topP = options.topP;
    // Issue #40 RC2: anti-repetition sampling params. Forwarded to the engine at
    // the generate() call below — without this forward, the penalty fields added
    // to presets/LLMGenerateOptions die at the orchestrator→service boundary.
    const repeatPenalty = options.repeatPenalty;
    const frequencyPenalty = options.frequencyPenalty;
    const presencePenalty = options.presencePenalty;
    // Issue #40 RC1: prior conversation turns. Threaded into the LLM prompt
    // (buildMessages) and used to contextualize the retrieval query (RC3).
    // PRR48-004: cap the history token budget by dropping oldest whole turns
    // until the joined text fits MAX_HISTORY_BUDGET_TOKENS. This bounds BOTH
    // the budget reservation AND the actual prompt sent to the model (the
    // prior fix only capped the estimate, leaving the messages unbounded).
    const history = capHistoryBudget(options.history ?? [], MAX_HISTORY_BUDGET_TOKENS * CHARS_PER_TOKEN);
    const signal = options.signal;

    // Ensure lazy services are initialized before the pipeline runs (FR-002)
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    // F4: capture the readiness result instead of discarding it. The two
    // ensure*() helpers swallow errors (return false / null), so Promise.all
    // always resolves even when the embedding model failed to load. We must
    // inspect the boolean ourselves to know whether semantic search is
    // available — if not, we degrade to keyword-only retrieval instead of
    // throwing fatally later.
    const [embeddingReady] = await Promise.all([
      ensureEmbeddingServiceReady(),
      ensureReadinessGateChecked(),
    ]);
    const semanticAvailable = embeddingReady === true;

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    let fusedResults: SearchResult[] = [];
    let contextChunks: SearchResult[] = [];
    let fullAnswer = '';
    // True when semantic/vector search was unavailable for any reason; surfaces
    // as a non-blocking "retrieval degraded" indicator in the UI (F4).
    let retrievalDegraded = false;

    // Issue #40 RC3: rewrite a pronoun-heavy / short / continuation follow-up
    // into a self-contained retrieval query using the conversation history.
    // Deterministic heuristic (Option B per the issue) — microseconds, never
    // fails, degrades to the raw question when no rewrite applies. Applied to
    // the EMBEDDING, KEYWORD, and RERANKER inputs (all three consume this
    // variable). The `retrieving` event still emits the raw `question` for UI
    // fidelity — the rewrite is an internal retrieval concern, not something to
    // surface to the user.
    const retrievalQuery = contextualizeRetrievalQuery(question, history);

    // Stage 1: Embed the query
    yield { type: 'retrieving', data: { query: question } };

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    // F4 + F8: embed the query ONLY when semantic search is available, and
    // prepend the retrieval instruction to the query text (passages stay
    // un-prefixed — only the query side changes, F8).
    let queryEmbedding: EmbeddingVector | null = null;
    if (semanticAvailable) {
      try {
        const embeddingResult = await this.embeddingService.encodeWithMetadata(
          QUERY_INSTRUCTION + retrievalQuery
        );
        queryEmbedding = embeddingResult.vector;
      } catch (err) {
        // Embedding failed at runtime even though the gate passed. Degrade
        // rather than abort the whole query (F4).
        console.error('[RAGOrchestrator] Query embedding failed, degrading to keyword-only:', err);
        queryEmbedding = null;
        retrievalDegraded = true;
      }
    } else {
      // Embedding service never came up. Keyword search can still serve a
      // useful (if lower-recall) answer.
      console.warn('[RAGOrchestrator] Embedding service unavailable; using keyword-only retrieval');
      retrievalDegraded = true;
    }

    // Stage 2 & 3: Search both indexes. Vector search is gated on having a
    // query embedding (F4); keyword search runs unconditionally — it is
    // independent of the embedding model and healthy on its own.
    let vectorResults: SearchResult[] = [];

    if (queryEmbedding !== null) {
      try {
        if (this.vectorIndex.isReady()) {
          vectorResults = await this.vectorIndex.search(queryEmbedding, { k: fetchK });
        } else {
          console.warn('[RAGOrchestrator] VectorIndex not ready, skipping vector search');
          retrievalDegraded = true;
        }
      } catch (err) {
        console.error('[RAGOrchestrator] Vector search failed:', err);
        yield {
          type: 'error',
          data: {
            stage: 'vector_search',
            message: err instanceof Error ? err.message : 'Vector search failed',
          },
        };
        retrievalDegraded = true;
      }
    }

    let keywordResults: SearchResult[] = [];
    try {
      if (this.keywordIndex.isReady()) {
        // Issue #40 RC3: search on the contextualized query so pronoun-heavy
        // follow-ups carry topical signal into FlexSearch.
        keywordResults = this.keywordIndex.search(retrievalQuery, { limit: fetchK });
      } else {
        console.warn('[RAGOrchestrator] KeywordIndex not ready, skipping keyword search');
      }
    } catch (err) {
      console.error('[RAGOrchestrator] Keyword search failed:', err);
      yield {
        type: 'error',
        data: {
          stage: 'keyword_search',
          message: err instanceof Error ? err.message : 'Keyword search failed',
        },
      };
    }

    // Stage 4: RRF fusion (harmless with a single non-empty list; no special-case).
    //
    // Issue #37 R3: when the reranker will NOT run (fast preset, or reranker
    // model absent at runtime), apply a cosine backstop to vector hits BEFORE
    // fusion. edgevec returns the k nearest regardless of absolute similarity,
    // so without this filter an out-of-corpus question fills the context with
    // irrelevant chunks that then flood RRF. The backstop is only meaningful
    // when the reranker is off, because the reranker's own sigmoid floor
    // (MIN_CROSS_SCORE) is the stronger relevance signal when present.
    if (!doRerank && vectorResults.length > 0) {
      const before = vectorResults.length;
      vectorResults = vectorResults.filter((r) => r.score >= DEGRADED_VECTOR_COSINE_FLOOR);
      if (vectorResults.length < before) {
        console.info('[RAG] content-gap (degraded vector floor)', {
          query: question,
          droppedByFloor: before - vectorResults.length,
          floor: DEGRADED_VECTOR_COSINE_FLOOR,
        });
      }
    }

    try {
      if (vectorResults.length > 0 || keywordResults.length > 0) {
        fusedResults = rrfFuse([vectorResults, keywordResults], 60);
      } else {
        fusedResults = [];
      }
    } catch (err) {
      console.error('[RAGOrchestrator] RRF fusion failed:', err);
      yield {
        type: 'error',
        data: {
          stage: 'rrf_fusion',
          message: err instanceof Error ? err.message : 'RRF fusion failed',
        },
      };
    }

    yield {
      type: 'retrieved',
      data: { vectorResults, keywordResults, fusedResults },
    };

    // Stage 5: Optional reranking. Track whether the cross-encoder actually ran
    // so the relevance floor is applied on the correct score scale (F3).
    let didRerank = false;
    if (doRerank && fusedResults.length > 0) {
      try {
        if (this.rerankerService.isReady() && this.rerankerService.canRerank(fusedResults.length)) {
          yield { type: 'reranking', data: { count: fusedResults.length } };

          // Issue #40 RC3: rerank on the contextualized query so the
          // cross-encoder scores against a self-contained question.
          const rerankedResults = await this.rerankerService.rerank(retrievalQuery, fusedResults, topK);

          yield { type: 'reranked', data: { results: rerankedResults } };
          contextChunks = rerankedResults;
          didRerank = true;
        } else {
          contextChunks = fusedResults.slice(0, topK);
        }
      } catch (err) {
        console.error('[RAGOrchestrator] Reranking failed, using fused results:', err);
        yield {
          type: 'error',
          data: {
            stage: 'reranking',
            message: err instanceof Error ? err.message : 'Reranking failed',
          },
        };
        contextChunks = fusedResults.slice(0, topK);
      }
    } else {
      contextChunks = fusedResults.slice(0, topK);
    }

    // F3: relevance floor. Pick the floor by the score scale contextChunks
    // actually carries — cross-encoder scores (after rerank) vs RRF scores.
    if (contextChunks.length > 0) {
      const floor = didRerank ? MIN_CROSS_SCORE : MIN_RRF_SCORE;
      const before = contextChunks.length;
      contextChunks = contextChunks.filter((c) => c.score >= floor);
      if (contextChunks.length < before) {
        // Structured content-gap log for future governance consumers (PR-7 #26
        // wires a real store; the format is stable from now). bestScore is the
        // strongest surviving chunk after the floor (null if all were dropped).
        console.info('[RAG] content-gap', {
          query: question,
          bestScore: contextChunks.length > 0 ? contextChunks[0].score : null,
          droppedByFloor: before - contextChunks.length,
          scale: didRerank ? 'cross-encoder' : 'rrf',
        });
      }
    }

    // F11: token budget. Keep the user's question in-prompt by reserving space
    // for the system prompt, the question, and generation, then fitting only as
    // many ranked chunks (highest first) as the remaining budget allows. Drop
    // whole chunks that overflow — never truncate mid-chunk. Applied BEFORE the
    // abstention check so that budget-induced emptiness also abstains.
    //
    // Issue #40 RC1: history is also in the prompt (threaded by buildMessages),
    // so charge it to reservedTokens here. Without this term, history + context
    // could silently overflow DEFAULT_N_CTX. The history array is already
    // token-capped (capHistoryBudget at line ~282 per PRR48-004), so the
    // joined text here is bounded.
    const historyText = history.map((t) => t.content).join('\n');
    const reservedTokens =
      estimateTokens(systemPrompt, CHARS_PER_TOKEN) +
      estimateTokens(question, CHARS_PER_TOKEN) +
      estimateTokens(historyText, CHARS_PER_TOKEN) +
      (maxTokens ?? 512) +
      TOKEN_SAFETY_MARGIN;
    const contextBudgetChars = Math.max(0, (DEFAULT_N_CTX - reservedTokens) * CHARS_PER_TOKEN);
    let usedChars = 0;
    let droppedForBudget = 0;
    const budgeted: SearchResult[] = [];
    for (const chunk of contextChunks) {
      const len = (chunk.text ?? '').length;
      if (usedChars + len <= contextBudgetChars) {
        budgeted.push(chunk);
        usedChars += len;
      } else {
        droppedForBudget++;
      }
    }
    contextChunks = budgeted;

    // F2: abstention. If no chunks survive the floor AND budget, short-circuit
    // BEFORE generation so the model never answers from pretrained knowledge
    // with no source. The UI renders a visually distinct abstention state.
    //
    // U8a: do NOT abstain when the user attached images — a multimodal question
    // like "what's in this screenshot?" on an empty corpus should reach the VLM
    // rather than abstaining. buildMessages (below) already forwards images
    // into the multimodal content array, so falling through here is sufficient.
    if (contextChunks.length === 0 && !(options.images?.length)) {
      yield {
        type: 'complete',
        data: {
          answer: '',
          sources: [],
          chunks: [],
          abstain: true,
          abstainReason:
            retrievalDegraded && keywordResults.length === 0
              ? 'retrieval_degraded'
              : 'insufficient_evidence',
          retrievalDegraded,
          contextTrimmed: droppedForBudget > 0 ? droppedForBudget : undefined,
        },
      };
      return;
    }

    // Collect unique source filenames for the legacy sources field (fall back to
    // docId when a chunk has no filename). The structured citations live in the
    // chunks array (F7).
    const sourceSet = new Set<string>();
    for (const chunk of contextChunks) {
      sourceSet.add(chunk.source ?? chunk.docId);
    }
    const sources = Array.from(sourceSet);

    // Stage 6: Build context from chunks
    const contextText = this.buildContext(contextChunks);
    // Issue #40 RC1: thread history into the message array (between system and
    // the current user turn) so the model has conversational continuity.
    const contextMessages = this.buildMessages(systemPrompt, question, contextText, options.images, history);

    yield {
      type: 'generating',
      data: { contextLength: contextText.length, sourceCount: sources.length },
    };

    // Stage 7 & 8: Generate answer with streaming.
    // Issue #40 RC2 (NR1 critical fix): forward repeatPenalty/frequencyPenalty/
    // presencePenalty here — without this forward, the penalty fields added to
    // presets/LLMGenerateOptions never cross the orchestrator→service boundary
    // and the anti-repetition fix is a silent no-op.
    const generateOptions = { maxTokens, temperature, topP, repeatPenalty, frequencyPenalty, presencePenalty, signal };
    try {
      if (streamTokens) {
        for await (const token of this.llmService.generate(contextMessages, generateOptions)) {
          if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          fullAnswer += token;
          yield { type: 'token', data: token };
        }
      } else {
        fullAnswer = await this.llmService.generateComplete(contextMessages, generateOptions);
        yield { type: 'token', data: fullAnswer };
      }
    } catch (err) {
      console.error('[RAGOrchestrator] Generation failed:', err);
      yield {
        type: 'error',
        data: {
          stage: 'generation',
          message: err instanceof Error ? err.message : 'Generation failed',
        },
      };
      return;
    }

    // Stage 9: Yield final complete event. `chunks` is the exact contextChunks
    // array passed to buildContext, in order — the model's [1],[2] citations map
    // onto it by index (F7 numbering invariant).
    yield {
      type: 'complete',
      data: {
        answer: fullAnswer,
        sources,
        chunks: contextChunks,
        retrievalDegraded,
        contextTrimmed: droppedForBudget > 0 ? droppedForBudget : undefined,
      },
    };
  }

  /**
   * Build a formatted context string from search results. Each chunk is
   * numbered `[i+1]`; the model is instructed to cite using those numbers, and
   * the UI renders citations in the SAME order (F7 numbering invariant).
   *
   * NOTE: this no longer emits a `"Context:\n"` header — `buildMessages` owns
   * the single header (F6 removed the duplicate). It also no longer takes the
   * (unused) `question` parameter.
   */
  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) {
      return '';
    }

    const contextParts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkText = chunk.text;
      // F1 tripwire: after the fix, every chunk reaching here MUST carry real
      // text. A missing/empty text is a regression — emit a clearly-fake
      // sentinel (never the old `Document chunk from <id>` placeholder, which
      // looked like real content) and log loudly. Do not throw, so the user
      // still gets a degraded answer instead of a hard error.
      if (chunkText === undefined || chunkText.length === 0) {
        console.error('[RAGOrchestrator] chunk reached buildContext with no text (F1 regression)', {
          docId: chunk.docId,
          chunkIndex: chunk.chunkIndex,
        });
        contextParts.push(`[${i + 1}] [MISSING CHUNK TEXT — docId ${chunk.docId}]`);
      } else {
        contextParts.push(`[${i + 1}] ${chunkText}`);
      }
      contextParts.push('');
    }

    return contextParts.join('\n');
  }

  /**
   * Build message array for LLM generation with system prompt and context.
   *
   * Issue #40 RC1: prior conversation turns are threaded between the system
   * prompt and the current user turn, so the model has conversational continuity
   * for follow-up questions. History is plain text (multimodal history is out of
   * scope — only the current turn carries images) and is capped + budgeted by
   * the caller. The chat-template sequence is: system, [...history], user.
   */
  private buildMessages(
    systemPrompt: string,
    question: string,
    context: string,
    images?: RAGImageInput[],
    history?: RAGHistoryTurn[]
  ): LLMMessage[] {
    const userText = `Context:\n${context}\n\nQuestion: ${question}`;

    // Text-only: keep the simple string content. With attached images, build a
    // multimodal content array (text first, then image parts) for the VLM.
    const userContent: LLMMessage['content'] =
      images && images.length > 0
        ? [
            { type: 'text', text: userText },
            ...images.map((img) => ({ type: 'image' as const, data: img.data })),
          ]
        : userText;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
    ];
    // Thread prior turns between system and the current turn. Each turn becomes
    // a plain text message in the role it was spoken in.
    if (history && history.length > 0) {
      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  /**
   * Clean up all services held by the orchestrator.
   * The underlying services are singletons, so this only performs any
   * orchestrator-local cleanup if necessary.
   */
  dispose(): void {
    // Services are singletons managed by their own classes.
    // This method exists for future cleanup needs and API completeness.
  }
}

/**
 * Conservative token estimate from character count (F11). The LLM service
 * exposes no tokenizer, so ~chars/4 is used as a lower-bound approximation with
 * an explicit safety margin applied by the caller.
 */
function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil((text?.length ?? 0) / charsPerToken);
}

/**
 * PRR48-004: bound the conversation-history token budget by dropping oldest
 * whole turns until the joined text fits `maxChars`. Dropping whole turns
 * (rather than slicing mid-content) preserves the user/assistant alternation
 * the chat template expects and keeps each turn's content intact. After the
 * drop loop: (a) if the surviving window starts with an assistant turn, drop
 * it too (mirrors history-snapshot's re-anchor — the chat template's
 * user/model alternation expects a user-first history); (b) if a single
 * surviving turn still exceeds maxChars (e.g. user pasted a huge document),
 * tail-truncate it to maxChars so even the degenerate case can't saturate n_ctx.
 */
export function capHistoryBudget(history: RAGHistoryTurn[], maxChars: number): RAGHistoryTurn[] {
  if (history.length === 0) return history;
  const joinedLen = history.map((t) => t.content).join('\n').length;
  if (joinedLen <= maxChars) return history;
  // Drop oldest turns until the remaining text fits. Always keep at least 1 turn.
  let kept = history.slice();
  while (kept.length > 1) {
    const len = kept.map((t) => t.content).join('\n').length;
    if (len <= maxChars) break;
    kept = kept.slice(1);
  }
  // PRR48-004 critic fix 1: re-anchor to user-first (mirrors history-snapshot).
  // The drop loop can leave an assistant-first window when an early user turn
  // is the largest and gets dropped first.
  while (kept.length > 1 && kept[0].role === 'assistant') {
    kept = kept.slice(1);
  }
  // PRR48-004 critic fix 3: tail-truncate a single over-cap surviving turn
  // (e.g. user pasted a 50K-char document). Tail slice keeps the most recent
  // content, which is the most relevant for follow-up contextualization.
  if (kept.length === 1 && kept[0].content.length > maxChars) {
    kept = [{ ...kept[0], content: kept[0].content.slice(-maxChars) }];
  }
  return kept;
}

/**
 * Issue #40 RC3: rewrite a pronoun-heavy / short / continuation follow-up into a
 * self-contained retrieval query using recent conversation history. Deterministic
 * heuristic (Option B per the issue) — runs in microseconds, never fails, and
 * degrades to the original question when no rewrite applies. Applied to the
 * embedding, keyword, and reranker inputs so all three retrieval legs operate on
 * a query with topical signal.
 *
 * Inspired by — but deliberately broader than — the server-side heuristic in
 * rag_engine.py:420-455 (anaphora + short-non-wh + continuation keywords). The
 * browser app is the primary surface and benefits from more aggressive
 * follow-up detection; documented divergences:
 *  - the anaphora set also covers they/them/their + "the second/first/last";
 *  - when no prior USER turn exists it falls back to the last ASSISTANT answer's
 *    first sentence (the server only ever uses last_user_msg).
 * A self-contained question passes through unchanged (preserves first-turn
 * recall — acceptance criterion). Exported for unit testing.
 */
const ANAPHORIC_RE =
  /\b(it|this|that|these|those|they|them|their|the above|the previous|the (?:second|first|last))\b/i;
const FOLLOWUP_WORDS = new Set([
  'more', 'elaborate', 'detail', 'explain', 'expand', 'further',
  'also', 'another', 'compare', 'difference', 'versus', 'vs',
  'similar', 'unlike', 'deeper',
]);
const WH_WORDS = new Set(['what', 'who', 'when', 'where', 'which', 'how', 'why']);

/**
 * Does `question` look like a follow-up that lacks standalone topical signal?
 * Three patterns (mirroring the server's detection, slightly broader):
 *  1. anaphora / pronoun reference (it / this / that / they / ...);
 *  2. very short (<=4 words) AND not starting with a wh-word;
 *  3. continuation keywords (elaborate / more / compare / ...) — but ONLY when
 *     the question does NOT start with a wh-word, so a self-contained comparison
 *     question like "What is X vs Y?" passes through unchanged (a wh-word start
 *     is a strong signal the question is already self-contained, even if it
 *     contains a continuation keyword like "vs").
 */
function isFollowup(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  const ql = q.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const first = (ql.split(/\s+/)[0] ?? '').replace(/[^\w]/g, '');
  const startsWithWh = WH_WORDS.has(first);
  // Pattern 1: anaphora / pronoun reference.
  if (ANAPHORIC_RE.test(ql)) return true;
  // Pattern 2: very short non-wh question.
  if (words.length <= 4 && !startsWithWh) return true;
  // Pattern 3: continuation keywords — only when the question does not start
  // with a wh-word (avoids rewriting self-contained "What is X vs Y?" queries).
  if (
    !startsWithWh &&
    words.some((w) => FOLLOWUP_WORDS.has(w.toLowerCase().replace(/[^\w]/g, '')))
  ) {
    return true;
  }
  return false;
}

/**
 * Issue #40 RC3: produce the retrieval query. Returns the original question
 * unchanged when it is already self-contained or when there is no history to
 * contextualize with. Otherwise prepends the most recent substantive USER turn
 * (preferred — it states the topic directly), falling back to the most recent
 * ASSISTANT answer's first sentence.
 */
export function contextualizeRetrievalQuery(
  question: string,
  history: RAGHistoryTurn[]
): string {
  const q = question.trim();
  if (!q || history.length === 0 || !isFollowup(q)) return question;
  // Prefer the most recent substantive USER turn.
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role === 'user' && t.content.trim()) {
      return `${t.content.trim()} ${question}`;
    }
  }
  // Fall back to the most recent ASSISTANT answer's first sentence.
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role === 'assistant' && t.content.trim()) {
      const firstSentence = t.content.trim().split(/[.!?\n]/)[0];
      if (firstSentence.trim()) return `${firstSentence.trim()} ${question}`;
    }
  }
  return question;
}

/**
 * Convenience function to create a new RAGOrchestrator instance. Uses the
 * offline-first default engine (wllama) via getLLMService() — never WebLLM,
 * which would fetch weights from a CDN and break the air gap (F10).
 */
export function getRAGOrchestrator(): RAGOrchestrator {
  return new RAGOrchestrator({ llmService: getLLMService() });
}
