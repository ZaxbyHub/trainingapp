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
import type { LLMMessage } from '../../types/llm';
import type { EmbeddingVector } from '../../types/embedding';

import { getEmbeddingService, type EmbeddingService } from '../embeddings/embedding-service';
import { getVectorIndex, type VectorIndex } from '../search/vector-index';
import { getKeywordIndex, type KeywordIndex } from '../search/keyword-index';
import { rrfFuse } from '../search/rrf-fusion';
import { getRerankerService, type RerankerService } from '../search/reranker';
import { WebLLMService } from '../llm/web-llm-service';
import { ensureEmbeddingServiceReady, ensureReadinessGateChecked } from '../../hooks/useServiceInitialization';

/**
 * Options for RAG query execution.
 */
export interface RAGQueryOptions {
  /** Number of top results to retrieve from each index (default: 10) */
  topK?: number;
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
  | { type: 'complete'; data: { answer: string; sources: string[]; chunks: SearchResult[] } }
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
 * RAG Orchestrator - Coordinates embedding search, keyword search, RRF fusion,
 * optional reranking, and LLM generation into a single async pipeline.
 */
export class RAGOrchestrator {
  private embeddingService: EmbeddingService;
  private vectorIndex: VectorIndex;
  private keywordIndex: KeywordIndex;
  private rerankerService: RerankerService;
  private llmService: WebLLMService;

  /**
   * Create a new RAGOrchestrator with service references.
   * All services are obtained as singletons via their get* functions.
   */
  constructor() {
    this.embeddingService = getEmbeddingService();
    this.vectorIndex = getVectorIndex();
    this.keywordIndex = getKeywordIndex();
    this.rerankerService = getRerankerService();
    this.llmService = WebLLMService.getInstance();
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
    const doRerank = options.rerank ?? true;
    const streamTokens = options.streamTokens ?? true;
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const maxTokens = options.maxTokens;
    const temperature = options.temperature;
    const signal = options.signal;

    // Ensure lazy services are initialized before the pipeline runs (FR-002)
    await Promise.all([
      ensureEmbeddingServiceReady(),
      ensureReadinessGateChecked(),
    ]);

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    let fusedResults: SearchResult[] = [];
    let rerankedResults: SearchResult[] = [];
    let contextChunks: SearchResult[] = [];
    let sources: string[] = [];
    let fullAnswer = '';

    // Stage 1: Embed the query
    yield { type: 'retrieving', data: { query: question } };

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    let queryEmbedding: EmbeddingVector;
    try {
      const embeddingResult = await this.embeddingService.encodeWithMetadata(question);
      queryEmbedding = embeddingResult.vector;
    } catch (err) {
      yield {
        type: 'error',
        data: {
          stage: 'embedding',
          message: err instanceof Error ? err.message : 'Failed to embed query',
        },
      };
      return;
    }

    // Stage 2 & 3: Search both indexes in parallel
    let vectorResults: SearchResult[] = [];
    let keywordResults: SearchResult[] = [];

    try {
      if (this.vectorIndex.isReady()) {
        vectorResults = await this.vectorIndex.search(queryEmbedding, { k: topK });
      } else {
        console.warn('[RAGOrchestrator] VectorIndex not ready, skipping vector search');
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
    }

    try {
      if (this.keywordIndex.isReady()) {
        keywordResults = this.keywordIndex.search(question, { limit: topK });
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

    // Stage 4: RRF fusion
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

    // Stage 5: Optional reranking
    if (doRerank && fusedResults.length > 0) {
      try {
        if (this.rerankerService.isReady() && this.rerankerService.canRerank(fusedResults.length)) {
          yield { type: 'reranking', data: { count: fusedResults.length } };

          rerankedResults = await this.rerankerService.rerank(question, fusedResults, topK);

          yield { type: 'reranked', data: { results: rerankedResults } };
          contextChunks = rerankedResults;
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

    // Collect unique sources from chunks
    const sourceSet = new Set<string>();
    for (const chunk of contextChunks) {
      if (chunk.docId) {
        sourceSet.add(chunk.docId);
      }
    }
    sources = Array.from(sourceSet);

    // Stage 6: Build context from chunks
    const contextText = this.buildContext(question, contextChunks);
    const contextMessages = this.buildMessages(systemPrompt, question, contextText);

    yield {
      type: 'generating',
      data: { contextLength: contextText.length, sourceCount: sources.length },
    };

    // Stage 7 & 8: Generate answer with streaming
    try {
      if (streamTokens) {
        for await (const token of this.llmService.generate(contextMessages, { maxTokens, temperature, signal })) {
          if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          fullAnswer += token;
          yield { type: 'token', data: token };
        }
      } else {
        fullAnswer = await this.llmService.generateComplete(contextMessages, { maxTokens, temperature, signal });
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

    // Stage 9: Yield final complete event
    yield {
      type: 'complete',
      data: {
        answer: fullAnswer,
        sources,
        chunks: contextChunks,
      },
    };
  }

  /**
   * Build a formatted context string from search results.
   * Each chunk is numbered and includes its text and source metadata.
   */
  private buildContext(question: string, chunks: SearchResult[]): string {
    if (chunks.length === 0) {
      return 'No relevant context found.';
    }

    const contextParts: string[] = [];
    contextParts.push('Context:\n');

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkText = chunk.text ?? `Document chunk from ${chunk.docId}`;
      contextParts.push(`[${i + 1}] ${chunkText}`);
      if (chunk.docId) {
        contextParts.push(`    Source: ${chunk.docId}`);
      }
      contextParts.push('');
    }

    return contextParts.join('\n');
  }

  /**
   * Build message array for LLM generation with system prompt and context.
   */
  private buildMessages(systemPrompt: string, question: string, context: string): LLMMessage[] {
    return [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Context:\n${context}\n\nQuestion: ${question}`,
      },
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
 * Convenience function to create a new RAGOrchestrator instance.
 */
export function getRAGOrchestrator(): RAGOrchestrator {
  return new RAGOrchestrator();
}
