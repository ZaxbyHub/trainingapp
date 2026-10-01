// Documented stub engine for the Electron backend host (issue #61).
//
// ISSUE SCOPE (B3): this host certifies WIRING and CONTRACT CONFORMANCE only.
// Real inference is B4 (#62), retrieval B7 (#65), ingestion/persistence B6
// (#64), shared store schema B5 (#63). Every capability below is a STUB that
// mirrors the response SHAPES of api_server.py (the conformance reference)
// with deterministic, model-free data. Each stub names its owning issue.
import type {
  BatchIngestResult,
  CitedChunk,
  DocumentSurface,
  EngineQueryOptions,
  EngineQueryResult,
  EngineSurface,
  Grounding,
  IngestFileInput,
  IngestResult,
  LearnAssembler,
  ModelStatus,
  RetrievalSurface,
} from './types.js';
import type { PackManager } from './store/pack-manager.js';
import { DEFAULT_RETRIEVAL_CONFIG } from './retrieval/config.js';

// STORED defaults mirror config.py's RAGSettings field defaults so the
// desktop keyspace and its PUT bounds stay number-compatible with the Python
// reference. INTERNAL storage uses the rag_* request-model keys
// (SettingsUpdateRequest names); responseSettings() maps them to the
// SettingsResponse names. The REPORTED flat values are not a mirror of
// config.py (settings-wiring-honesty): GET /settings reports what the next
// desktop query uses, so max_tokens/temperature follow the inference profile
// and reranking_enabled the retrieval env default (and reranker
// availability) unless the user explicitly set them — they differ from the
// Python backend's flat defaults by design.
export const DEFAULT_SETTINGS = {
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
  // C4 (issue #71): mirror config.py RAGSettings defaults.
  rag_packs_recency_half_life_months: 9,
  rag_packs_recency_floor_months: 18,
  rag_packs_recency_floor: 0.85,
} as const;

// SettingsUpdateRequest bounds (api_server.py SettingsUpdateRequest).
export const SETTING_BOUNDS = {
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
  // C4 (issue #71): mirror api_server.py SettingsUpdateRequest bounds
  // (ge=1 on the month fields, no upper bound; floor within [0, 1]).
  rag_packs_recency_half_life_months: {
    min: 1,
    max: Number.POSITIVE_INFINITY,
    type: 'int',
  },
  rag_packs_recency_floor_months: {
    min: 1,
    max: Number.POSITIVE_INFINITY,
    type: 'int',
  },
  rag_packs_recency_floor: { min: 0, max: 1, type: 'float' },
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
  // C4 (issue #71): packs_recency_* per the OpenAPI SettingsResponse.
  rag_packs_recency_half_life_months: 'packs_recency_half_life_months',
  rag_packs_recency_floor_months: 'packs_recency_floor_months',
  rag_packs_recency_floor: 'packs_recency_floor',
};

/**
 * settings-wiring-honesty: the keyspace keys a desktop query READS at query
 * time. Retrieval (every engine with a retrieval surface) reads the result
 * count and the per-query rerank flag; an engine that generates (LlamaEngine)
 * additionally reads the generation keys. Every other keyspace key is stored
 * and validated but has no desktop reader, and GET /settings reports it in
 * `not_applied` (derived from SETTING_BOUNDS minus these sets).
 */
const RETRIEVAL_READ_KEYS: readonly string[] = ['rag_n_results', 'rag_reranking_enabled'];
export const GENERATION_READ_KEYS: readonly string[] = ['rag_max_tokens', 'rag_temperature'];

/** Effective generation values an engine falls back to when not explicitly set. */
export interface GenerationDefaults {
  maxTokens: number;
  temperature: number;
}

type SettingsResult = { ok: true } | { ok: false; status: 400 | 422; detail: string; errors?: string[] };

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
   * settings-wiring-honesty: the rag_* keys a client explicitly set — every
   * key committed by an accepted applySettingsPatch (boot replay of the
   * persisted sidecar and every accepted PUT /settings), minus keys a
   * `reset` directive cleared. Precedence for the generation and rerank keys:
   * an explicit value wins; otherwise the inference-profile (generation) or
   * retrieval env (rerank) default applies.
   */
  private readonly explicitKeys = new Set<string>();

  /**
   * B7 (issue #65): late-bound hybrid retrieval surface. The host attaches it
   * after the store opens; null restores the deterministic B3 behavior (the
   * frozen conformance/dev mode). The `desktop-stub` row literal is retained
   * as the DETACHED-state fallback by contract.
   */
  private retrievalSurface: RetrievalSurface | null = null;
  private documentSurface: DocumentSurface | null = null;
  private learnAssembler: LearnAssembler | null = null;

  /**
   * D6 (issue #82): late-bound learn assembler. The host attaches it after
   * the store opens; query() then populates EngineQueryResult.learn from the
   * retrieval-cited chunk ids. Attaching null detaches (host stop).
   */
  attachLearnAssembler(assembler: LearnAssembler | null): void {
    this.learnAssembler = assembler;
  }

  attachRetrievalSurface(surface: RetrievalSurface | null): void {
    this.retrievalSurface = surface;
  }

  /**
   * B9 (issue #67): the store-backed document surface (B6) can attach to the
   * stub exactly like the retrieval surface — with the deterministic hash
   * embedder the dev/CI fixture becomes a full RAG pipeline (real ingest,
   * real hybrid retrieval) without any LLM weights. Without an attached
   * surface the honest not-implemented stub answers stay.
   */
  attachDocumentSurface(surface: DocumentSurface | null): void {
    this.documentSurface = surface;
  }

  /**
   * C3 (issue #70): the store-backed pack lifecycle attaches exactly like the
   * document surface — the host start path owns construction, the engine is
   * the surface consumers read (b3 duck-type pin keeps host prototypes at
   * start/stop only).
   */
  attachPackManager(manager: PackManager | null): void {
    this.packManager = manager;
  }

  /** The attached pack lifecycle (null until the host start path attaches). */
  get attachedPackManager(): PackManager | null {
    return this.packManager;
  }

  private packManager: PackManager | null = null;

  /**
   * B7 (issue #65): the retrieval step shared by query() here and by
   * LlamaEngine.query() (which retrieves before grounding its prompt).
   * Returns null when no surface is attached or retrieval yields nothing —
   * callers keep their pre-B7 behavior in that case.
   */
  async retrieveContext(
    question: string,
    nResults?: number,
  ): Promise<{
    sources: string[];
    contextLength: number;
    texts: string[];
    cited: CitedChunk[];
    /** C5 (issue #72): whether the returned scores were gated by the
     *  calibrated relevance floor (reranker path live). Custom surfaces
     *  without the flag count as qualified (pre-C5 behavior). */
    floorActive: boolean;
  } | null> {
    if (this.retrievalSurface === null) return null;
    const n = nResults ?? (Number(this.settings.rag_n_results) || 4);
    // settings-wiring-honesty: the REQUESTED rerank flag rides each query, so
    // a stored rag_reranking_enabled takes effect without a surface rebuild.
    const rerank = this.requestedRerank();
    const rows = await this.retrievalSurface.search(question, n, { rerank });
    if (rows.length === 0) return null;
    const sources: string[] = [];
    for (const row of rows) {
      if (!sources.includes(row.source)) sources.push(row.source);
    }
    return {
      sources,
      contextLength: rows.reduce((total, row) => total + row.text.length, 0),
      texts: rows.map((row) => row.text),
      // Per-query (issue #72 contract): a rerank-off query skipped the
      // reranker, so its scores were never floor-gated.
      floorActive: this.retrievalSurface.floorActive !== false && rerank,
      // D6 (issue #82): cited chunk ids + scores for the learn assembler
      // (rows whose surface predates chunkId are simply absent from cited).
      cited: rows
        .filter((row): row is typeof row & { chunkId: string } => typeof row.chunkId === 'string')
        .map((row) => ({
          chunkId: row.chunkId,
          score: row.similarity,
          source: row.source,
          // C4 (issue #71): pack attribution rides the cited chunk so the
          // server can serialize citations without re-querying the store.
          packId: row.packId ?? null,
          packVersion: row.packVersion ?? null,
          packPublishedAt: row.packPublishedAt ?? null,
        })),
    };
  }

  async query(question: string, opts: EngineQueryOptions = {}): Promise<EngineQueryResult> {
    const started = Date.now();
    const cancellation = opts.cancellationEvent;
    // B7 (issue #65): when a retrieval surface is attached, /ask carries real
    // retrieval — sources and context_length come from the hybrid pipeline
    // (rank order, deduped) instead of the empty stub values.
    const context = await this.retrieveContext(question, opts.nResults);
    // Issue #67: TRAININGAPP_STUB_TOKEN_DELAY_MS widens the inter-token gap so
    // the Playwright-under-Electron suite can click Cancel mid-stream
    // (deterministically). Default 1ms keeps conformance instant; the knob is
    // a dev/CI fixture, never set in production.
    const tokenDelayMs = Math.min(Math.max(Number(process.env.TRAININGAPP_STUB_TOKEN_DELAY_MS ?? 1) || 1, 1), 5000);
    for (const token of STUB_TOKENS) {
      if (cancellation?.isSet()) {
        return { answer: '', sources: [], context_length: 0, inference_time: (Date.now() - started) / 1000, cancelled: true };
      }
      opts.streamCallback?.(token);
      await delay(tokenDelayMs);
    }
    // C5 (issue #72): "grounded" requires FLOOR-QUALIFIED evidence — at
    // least one chunk of the final set scored at/above the active relevance
    // floor. hybridRetrieve applies that floor only on the reranker path, so
    // the floorActive flag (false when rerank is disabled, no reranker is
    // attached, or the failure latch degraded the surface) forces "general"
    // rather than letting raw-RRF results claim a relevance decision that
    // was never made.
    const grounding: Grounding =
      context !== null && context.cited.length > 0 && context.floorActive
        ? 'grounded'
        : 'general';
    return {
      // STUB answer text is deliberately explicit that this is not real
      // inference yet (B4 #62); the wire shape is what B3 certifies.
      answer: 'This desktop backend is not yet backed by real inference (B4, issue #62); wiring and contract conformance only (issue #61).',
      sources: context?.sources ?? [],
      context_length: context?.contextLength ?? 0,
      inference_time: (Date.now() - started) / 1000,
      grounding,
      // C4 (issue #71): cited chunks ride the internal result so the server
      // serializes pack-attributed citations (never serialized verbatim).
      ...(context !== null ? { cited: context.cited } : {}),
      // D6 (issue #82): learn rows when the assembler is attached and
      // retrieval produced cited chunks; the assembler's null (store closed)
      // and the assembler-less fixtures both omit the field. C5: the
      // grounding value rides along so "general" suppresses learn to [].
      ...(context !== null && context.cited.length > 0 && this.learnAssembler !== null
        ? (() => {
            const learn = this.learnAssembler(context.cited, grounding);
            return learn === null ? {} : { learn };
          })()
        : {}),
    };
  }

  // B7 (issue #65): the attached hybrid retrieval surface serves /search
  // (vec0 UNION FTS5 -> RRF -> recency hook -> optional worker reranker ->
  // calibrated floor). Detached (null), the deterministic B3 row remains.
  async search(query: string, nResults = 5): Promise<Array<{ text: string; source: string; similarity: number }>> {
    if (this.retrievalSurface !== null) {
      return this.retrievalSurface.search(query, nResults, { rerank: this.requestedRerank() });
    }
    return [{ text: `Stub retrieval result for "${query}" (B7, issue #65).`, source: 'desktop-stub', similarity: 0.5 }];
  }

  // B4 (issue #62): the stub is always ready — real engines use this hook to
  // surface a missing model BEFORE any response byte is written.
  async preflight(): Promise<void> {}

  /**
   * B9 (issue #67): the stub fixture answers /ask WITHOUT weights, so its
   * status reports engine 'stub' with nothing present — the renderer's
   * first-run gate keys off the engine discriminator and must NOT block this
   * engine (it is dev/CI only; production is 'llama.cpp').
   */
  modelStatus(): ModelStatus {
    return {
      engine: 'stub',
      profile: 'auto',
      models: { quality: { present: false }, fast: { present: false } },
      // #133: the stub never loads a model — chat must stay enabled in
      // dev/CI (idle, not loading).
      resident: { state: 'idle', profile: null, loadStartedAt: null },
    };
  }

  /** #133: no-op — the stub has nothing to warm up. */
  async warmup(): Promise<void> {}

  async listDocuments(): Promise<{ documents: Array<{ id: string; chunk_count: number }>; total: number }> {
    if (this.documentSurface !== null) return this.documentSurface.listDocuments();
    return { documents: [], total: 0 };
  }

  // STUB: the document store (and clearing it) arrives with B6 (#64).
  async clearDocuments(): Promise<void> {
    if (this.documentSurface !== null) return this.documentSurface.clearDocuments();
  }

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
  /**
   * settings-wiring-honesty: the rerank flag the next query requests — the
   * explicit rag_reranking_enabled when set, else the attached surface's
   * configured default (TRAININGAPP_RETRIEVAL_RERANK), else the retrieval
   * default. typeof guards: a custom surface may not carry rerankDefault.
   */
  requestedRerank(): boolean {
    if (this.explicitKeys.has('rag_reranking_enabled')) return this.settings.rag_reranking_enabled === true;
    const surfaceDefault = this.retrievalSurface?.rerankDefault;
    return typeof surfaceDefault === 'boolean' ? surfaceDefault : DEFAULT_RETRIEVAL_CONFIG.rerank;
  }

  /**
   * Whether a reranker can run right now: a surface is attached and its
   * reranker path is live (floorActive is false when no reranker was built at
   * boot, rerank is env-disabled, or the failure latch degraded it).
   */
  rerankingAvailable(): boolean {
    if (this.retrievalSurface === null) return false;
    const live = this.retrievalSurface.floorActive;
    return typeof live === 'boolean' ? live : true;
  }

  /** Explicitly set generation values (omitted keys follow the profile). */
  generationOverrides(): { maxTokens?: number; temperature?: number } {
    const out: { maxTokens?: number; temperature?: number } = {};
    if (this.explicitKeys.has('rag_max_tokens')) out.maxTokens = Number(this.settings.rag_max_tokens);
    if (this.explicitKeys.has('rag_temperature')) out.temperature = Number(this.settings.rag_temperature);
    return out;
  }

  /**
   * settings-wiring-honesty: the PUT /settings `reset` directive. Restores
   * each named key's stored default and drops it from the explicit set, so
   * it follows the profile/env default again. All-or-nothing: an unknown key
   * is a 422 and a reset that would break overlap < size is a 400, with
   * nothing committed in either case.
   */
  resetSettings(keys: unknown): SettingsResult {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
      return { ok: false, status: 422, detail: 'Request validation failed', errors: ['reset: expected an array of setting keys'] };
    }
    const errors = (keys as string[])
      .filter((key) => !Object.prototype.hasOwnProperty.call(SETTING_BOUNDS, key))
      .map((key) => `reset: ${key}: unknown setting`);
    if (errors.length > 0) return { ok: false, status: 422, detail: 'Request validation failed', errors };
    // Every SETTING_BOUNDS key has a DEFAULT_SETTINGS entry (validated above).
    const defaults: Record<string, number | boolean> = DEFAULT_SETTINGS;
    const next = { ...this.settings };
    for (const key of keys as string[]) next[key] = defaults[key] as number | boolean;
    if (Number(next.rag_chunk_overlap) >= Number(next.rag_chunk_size)) {
      return { ok: false, status: 400, detail: 'rag_chunk_overlap must be less than rag_chunk_size' };
    }
    this.settings = next;
    for (const key of keys as string[]) this.explicitKeys.delete(key);
    return { ok: true };
  }

  applySettingsPatch(patch: Record<string, unknown>): SettingsResult {
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
    // Marked only on this commit path: a rejected patch (400/422 above)
    // leaves the explicit set unchanged.
    for (const key of Object.keys(applied)) this.explicitKeys.add(key);
    return { ok: true };
  }

  /**
   * GET /settings body. Flat keys keep their SettingsResponse names but carry
   * EFFECTIVE values (what the next query uses); the optional
   * settings-wiring-honesty properties report the explicit key set, the
   * requested (explicit or null) and effective preset values, reranker
   * availability, and every keyspace key with no desktop reader. An engine
   * that generates passes its profile generation defaults.
   */
  responseSettings(generationDefaults?: GenerationDefaults): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [ragKey, responseKey] of Object.entries(RAG_TO_RESPONSE)) {
      const value = this.settings[ragKey];
      out[responseKey] = value;
    }
    const explicitOrNull = (key: string) => (this.explicitKeys.has(key) ? this.settings[key] : null);
    const generated = (key: string, fallback: number | undefined) =>
      this.explicitKeys.has(key) || fallback === undefined ? this.settings[key] : fallback;
    const available = this.rerankingAvailable();
    const effective = {
      n_results: this.settings.rag_n_results,
      reranking_enabled: available && this.requestedRerank(),
      max_tokens: generated('rag_max_tokens', generationDefaults?.maxTokens),
      temperature: generated('rag_temperature', generationDefaults?.temperature),
    };
    const readers = new Set([...RETRIEVAL_READ_KEYS, ...(generationDefaults !== undefined ? GENERATION_READ_KEYS : [])]);
    return {
      ...out,
      ...effective,
      explicit_keys: [...this.explicitKeys].sort(),
      requested: {
        n_results: explicitOrNull('rag_n_results'),
        reranking_enabled: explicitOrNull('rag_reranking_enabled'),
        max_tokens: explicitOrNull('rag_max_tokens'),
        temperature: explicitOrNull('rag_temperature'),
      },
      effective,
      reranking_available: available,
      not_applied: Object.keys(SETTING_BOUNDS).filter((key) => !readers.has(key)),
    };
  }

  // B9 (issue #67): with a store-backed document surface attached, the stub
  // delegates ALL document operations to it (real ingest/list/clear over the
  // SQLite store); without one, the honest not-implemented answers stay.
  async ingestDirectory(directory: string): Promise<IngestResult> {
    if (this.documentSurface !== null) return this.documentSurface.ingestDirectory(directory);
    return {
      success: false,
      documents: 0,
      chunks_added: 0,
      message: 'Directory ingestion is not implemented in the desktop backend yet (B6, issue #64); wiring and contract conformance only (issue #61).',
    };
  }

  async ingestFile(input?: IngestFileInput): Promise<IngestResult> {
    if (this.documentSurface !== null) return this.documentSurface.ingestFile(input);
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
    if (this.documentSurface !== null) return this.documentSurface.ingestBatch(inputs);
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
