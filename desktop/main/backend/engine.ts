// Documented stub engine for the Electron backend host (issue #61).
//
// ISSUE SCOPE (B3): this host certifies WIRING and CONTRACT CONFORMANCE only.
// Real inference is B4 (#62), retrieval B7 (#65), ingestion/persistence B6
// (#64), shared store schema B5 (#63). Every capability below is a STUB that
// mirrors the response SHAPES of api_server.py (the conformance reference)
// with deterministic, model-free data. Each stub names its owning issue.
import type {
  BatchIngestResult,
  EngineQueryOptions,
  EngineQueryResult,
  EngineSurface,
  IngestFileInput,
  IngestResult,
  RetrievalSurface,
} from './types.js';

// Settings defaults mirror config.py's RAGSettings field defaults so the
// desktop settings surface stays number-compatible with the Python reference.
// INTERNAL storage uses the rag_* request-model keys (SettingsUpdateRequest
// names); responseSettings() maps them to the SettingsResponse names.
const DEFAULT_SETTINGS = {
  rag_chunk_size: 1000,
  rag_chunk_overlap: 100,
  rag_n_results: 4,
  rag_min_similarity: 0.3,
  rag_temperature: 0.3,
  rag_max_tokens: 512,
  rag_hybrid_search: true,
  rag_reranking_enabled: false,
  rag_context_truncation: 20000,
  rag_retrieval_window: 1,
  rag_initial_retrieval_top_k: 12,
  rag_rerank_top_k: 4,
} as const;

// SettingsUpdateRequest bounds (api_server.py SettingsUpdateRequest).
const SETTING_BOUNDS = {
  rag_chunk_size: { min: 128, max: 8192, type: 'int' },
  rag_chunk_overlap: { min: 0, max: Number.POSITIVE_INFINITY, type: 'int' },
  rag_n_results: { min: 1, max: 10, type: 'int' },
  rag_min_similarity: { min: 0, max: 1, type: 'float' },
  rag_temperature: { min: 0, max: 2, type: 'float' },
  rag_max_tokens: { min: 256, max: 4096, type: 'int' },
  rag_hybrid_search: { type: 'bool' },
  rag_reranking_enabled: { type: 'bool' },
  rag_context_truncation: { min: 1, max: Number.POSITIVE_INFINITY, type: 'int' },
  rag_retrieval_window: { min: 0, max: Number.POSITIVE_INFINITY, type: 'int' },
  rag_initial_retrieval_top_k: { min: 1, max: 50, type: 'int' },
  rag_rerank_top_k: { min: 1, max: 20, type: 'int' },
} as const;

const RAG_TO_RESPONSE: Record<string, string> = {
  rag_chunk_size: 'chunk_size',
  rag_chunk_overlap: 'chunk_overlap',
  rag_n_results: 'n_results',
  rag_min_similarity: 'min_similarity',
  rag_temperature: 'temperature',
  rag_max_tokens: 'max_tokens',
  rag_hybrid_search: 'hybrid_search',
  rag_reranking_enabled: 'reranking_enabled',
  rag_context_truncation: 'context_truncation',
  rag_retrieval_window: 'retrieval_window',
  rag_initial_retrieval_top_k: 'initial_retrieval_top_k',
  rag_rerank_top_k: 'rerank_top_k',
};

/** The stub streams a short deterministic token sequence (suite-shaped). */
const STUB_TOKENS = ['Desktop ', 'stub ', 'answer.'];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * STUB backend state (in-memory, per-host). B5/B6 replace this with the
 * shared SQLite store; B7 binds real retrieval. Nothing here persists.
 */
export class StubEngine implements EngineSurface {
  private settings: Record<string, number | string | boolean> = { ...DEFAULT_SETTINGS };

  /**
   * B7 (issue #65): late-bound hybrid retrieval surface. The host attaches it
   * after the store opens; null restores the deterministic B3 behavior (the
   * frozen conformance/dev mode). The `desktop-stub` row literal is retained
   * as the DETACHED-state fallback by contract.
   */
  private retrievalSurface: RetrievalSurface | null = null;

  attachRetrievalSurface(surface: RetrievalSurface | null): void {
    this.retrievalSurface = surface;
  }

  /**
   * B7 (issue #65): the retrieval step shared by query() here and by
   * LlamaEngine.query() (which retrieves before grounding its prompt).
   * Returns null when no surface is attached or retrieval yields nothing —
   * callers keep their pre-B7 behavior in that case.
   */
  async retrieveContext(
    question: string,
    nResults?: number,
  ): Promise<{ sources: string[]; contextLength: number; texts: string[] } | null> {
    if (this.retrievalSurface === null) return null;
    const n = nResults ?? (Number(this.settings.rag_n_results) || 4);
    const rows = await this.retrievalSurface.search(question, n);
    if (rows.length === 0) return null;
    const sources: string[] = [];
    for (const row of rows) {
      if (!sources.includes(row.source)) sources.push(row.source);
    }
    return {
      sources,
      contextLength: rows.reduce((total, row) => total + row.text.length, 0),
      texts: rows.map((row) => row.text),
    };
  }

  async query(question: string, opts: EngineQueryOptions = {}): Promise<EngineQueryResult> {
    const started = Date.now();
    const cancellation = opts.cancellationEvent;
    // B7 (issue #65): when a retrieval surface is attached, /ask carries real
    // retrieval — sources and context_length come from the hybrid pipeline
    // (rank order, deduped) instead of the empty stub values.
    const context = await this.retrieveContext(question, opts.nResults);
    for (const token of STUB_TOKENS) {
      if (cancellation?.isSet()) {
        return { answer: '', sources: [], context_length: 0, inference_time: (Date.now() - started) / 1000, cancelled: true };
      }
      opts.streamCallback?.(token);
      await delay(1);
    }
    return {
      // STUB answer text is deliberately explicit that this is not real
      // inference yet (B4 #62); the wire shape is what B3 certifies.
      answer: 'This desktop backend is not yet backed by real inference (B4, issue #62); wiring and contract conformance only (issue #61).',
      sources: context?.sources ?? [],
      context_length: context?.contextLength ?? 0,
      inference_time: (Date.now() - started) / 1000,
    };
  }

  // B7 (issue #65): the attached hybrid retrieval surface serves /search
  // (vec0 UNION FTS5 -> RRF -> recency hook -> optional worker reranker ->
  // calibrated floor). Detached (null), the deterministic B3 row remains.
  async search(query: string, nResults = 5): Promise<Array<{ text: string; source: string; similarity: number }>> {
    if (this.retrievalSurface !== null) {
      return this.retrievalSurface.search(query, nResults);
    }
    return [{ text: `Stub retrieval result for "${query}" (B7, issue #65).`, source: 'desktop-stub', similarity: 0.5 }];
  }

  // B4 (issue #62): the stub is always ready — real engines use this hook to
  // surface a missing model BEFORE any response byte is written.
  async preflight(): Promise<void> {}

  // STUB: the document store arrives with B5/B6 (#63/#64).
  async listDocuments(): Promise<{ documents: Array<{ id: string; chunk_count: number }>; total: number }> {
    return { documents: [], total: 0 };
  }

  // STUB: the document store (and clearing it) arrives with B6 (#64).
  async clearDocuments(): Promise<void> {}

  async getStats(): Promise<{ document_count: number; chunk_count: number; embedding_model: string; llm_backend: string | null; documents: string[] }> {
    return {
      document_count: 0,
      chunk_count: 0,
      embedding_model: 'desktop-stub (B5 #63)',
      llm_backend: null,
      documents: [],
    };
  }

  /**
   * Apply a rag_* patch with the frozen bounds. Returns the 400 message for
   * the cross-field rule (overlap >= size), mirroring api_server.py:1088.
   */
  applySettingsPatch(patch: Record<string, unknown>): { ok: true } | { ok: false; status: 400 | 422; detail: string; errors?: string[] } {
    const errors: string[] = [];
    const applied: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(patch)) {
      // OWN-PROPERTY lookup only: an unguarded index resolves inherited keys
      // ("toString", "constructor", ...) to truthy built-ins and would skip
      // the unknown-setting rejection entirely, letting a request that must
      // 422 silently mutate the settings store instead.
      const boundsTable = SETTING_BOUNDS as Record<string, { min?: number; max?: number; type?: string }>;
      const bounds = Object.prototype.hasOwnProperty.call(boundsTable, key) ? boundsTable[key] : undefined;
      if (!bounds) {
        errors.push(`${key}: unknown setting`);
        continue;
      }
      if (bounds.type === 'bool') {
        if (typeof value !== 'boolean') errors.push(`${key}: expected a boolean`);
        else applied[key] = value;
        continue;
      }
      const num = typeof value === 'number' ? value : Number.NaN;
      if (!Number.isFinite(num)) {
        errors.push(`${key}: expected a finite number`);
        continue;
      }
      if (bounds.type === 'int' && !Number.isInteger(num)) {
        errors.push(`${key}: expected an integer`);
        continue;
      }
      if (bounds.min !== undefined && num < bounds.min) {
        errors.push(`${key}: must be >= ${bounds.min}`);
        continue;
      }
      if (bounds.max !== undefined && num > bounds.max) {
        errors.push(`${key}: must be <= ${bounds.max}`);
        continue;
      }
      applied[key] = num;
    }
    if (errors.length > 0) return { ok: false, status: 422, detail: 'Request validation failed', errors };
    const nextOverlap = applied.rag_chunk_overlap ?? this.settings.rag_chunk_overlap;
    const nextSize = applied.rag_chunk_size ?? this.settings.rag_chunk_size;
    if (Number(nextOverlap) >= Number(nextSize)) {
      return { ok: false, status: 400, detail: 'rag_chunk_overlap must be less than rag_chunk_size' };
    }
    Object.assign(this.settings, applied);
    return { ok: true };
  }

  responseSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [ragKey, responseKey] of Object.entries(RAG_TO_RESPONSE)) {
      const value = this.settings[ragKey];
      out[responseKey] = value;
    }
    return out;
  }

  // STUB: directory ingestion is B6 (#64). Honest stub: reports failure with
  // the owning issue in the message rather than pretending success.
  async ingestDirectory(_directory: string): Promise<IngestResult> {
    return {
      success: false,
      documents: 0,
      chunks_added: 0,
      message: 'Directory ingestion is not implemented in the desktop backend yet (B6, issue #64); wiring and contract conformance only (issue #61).',
    };
  }

  async ingestFile(_input?: IngestFileInput): Promise<IngestResult> {
    return {
      success: false,
      documents: 0,
      chunks_added: 0,
      message: 'File ingestion is not implemented in the desktop backend yet (B6, issue #64); wiring and contract conformance only (issue #61).',
    };
  }

  // STUB: multipart batch parsing/persistence arrives with B6 (#64). The
  // frozen BatchIngestResponse shape has no not-implemented slot, so honesty
  // here is bounded: every provided file counts as failed with no per-file
  // results until a real store-backed surface is attached.
  async ingestBatch(inputs?: IngestFileInput[]): Promise<BatchIngestResult> {
    const count = inputs?.length ?? 0;
    return {
      total_files: count,
      successful: 0,
      failed: count,
      results: [],
    };
  }
}

export type { EngineQueryOptions, EngineQueryResult, EngineSurface };
