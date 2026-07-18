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
  /** Images to include with the question (multimodal engines only). */
  images?: RAGImageInput[];
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
 * Default system prompt instructing the LLM to cite sources.
 */
const DEFAULT_SYSTEM_PROMPT = 'Answer the question based on the provided context. Cite sources using [1], [2] notation. If the context doesn\'t contain enough information, say so.';

/**
 * BGE retrieval query instruction. BAAI's bge-small-en-v1.5 model card requires
 * this prefix on the QUERY embedding for short-query→long-passage retrieval
 * (F8). Passages are intentionally left UN-prefixed (only the query side).
 */
const BGE_QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

/**
 * Relevance floors applied AFTER the rerank/slice branch resolves, so the floor
 * must match the score scale contextChunks actually carries (F3, Issue #37 R3).
 *  - When the cross-encoder reran: scores are sigmoid of the relevance logit
 *    for each [query, passage] pair, in (0, 1). ms-marco-MiniLM-L-6-v2
 *    relevant pairs typically score >0.5; irrelevant pairs <0.1. Floor 0.2
 *    drops weakly-relevant noise while keeping borderline-but-useful hits.
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
 * range for bge-small-en-v1.5 normalized embeddings: in-corpus pairs typically
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

    // Stage 1: Embed the query
    yield { type: 'retrieving', data: { query: question } };

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    // F4 + F8: embed the query ONLY when semantic search is available, and
    // prepend the BGE retrieval instruction to the query text (passages stay
    // un-prefixed — only the query side changes, F8).
    let queryEmbedding: EmbeddingVector | null = null;
    if (semanticAvailable) {
      try {
        const embeddingResult = await this.embeddingService.encodeWithMetadata(
          BGE_QUERY_INSTRUCTION + question
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
        keywordResults = this.keywordIndex.search(question, { limit: fetchK });
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

          const rerankedResults = await this.rerankerService.rerank(question, fusedResults, topK);

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
    const reservedTokens =
      estimateTokens(systemPrompt, CHARS_PER_TOKEN) +
      estimateTokens(question, CHARS_PER_TOKEN) +
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
    const contextMessages = this.buildMessages(systemPrompt, question, contextText, options.images);

    yield {
      type: 'generating',
      data: { contextLength: contextText.length, sourceCount: sources.length },
    };

    // Stage 7 & 8: Generate answer with streaming
    try {
      if (streamTokens) {
        for await (const token of this.llmService.generate(contextMessages, { maxTokens, temperature, topP, signal })) {
          if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          fullAnswer += token;
          yield { type: 'token', data: token };
        }
      } else {
        fullAnswer = await this.llmService.generateComplete(contextMessages, { maxTokens, temperature, topP, signal });
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
   */
  private buildMessages(
    systemPrompt: string,
    question: string,
    context: string,
    images?: RAGImageInput[]
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

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];
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
 * Convenience function to create a new RAGOrchestrator instance. Uses the
 * offline-first default engine (wllama) via getLLMService() — never WebLLM,
 * which would fetch weights from a CDN and break the air gap (F10).
 */
export function getRAGOrchestrator(): RAGOrchestrator {
  return new RAGOrchestrator({ llmService: getLLMService() });
}
