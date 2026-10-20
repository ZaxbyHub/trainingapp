// store/document-surface.ts — the B6 document surface the engine delegates to
// (issue #64).
//
// Bridges the frozen EngineSurface document methods (listDocuments /
// clearDocuments / ingestDirectory / ingestFile / ingestBatch) onto the B5
// store through IngestPipeline. The host owns the store handle and passes
// getStore/setStore accessors so this surface can also perform Clear Cache:
// close the handle, delete the .sqlite/.sqlite-wal/.sqlite-shm files, and
// re-initialize an empty schema at the SAME path (DELETE /documents keeps
// serving without a restart). Clear Cache targets the ACTIVE profile's store
// only — sibling profiles in named mode are untouched.
//
// With no store attached (getStore() === null — the B3 conformance mode), the
// surface preserves the pre-B6 stub semantics verbatim: honest failure with
// the owning-issue message, empty document lists.
import fs from 'node:fs';
import type { StoreHandle } from './sqlite-store.js';
import { openStore } from './sqlite-store.js';
import {
  IngestPipeline,
  type BatchIngestResult,
  type IngestFileInput,
  type IngestProgress,
  type IngestResult,
} from '../ingest/pipeline.js';
import type { EmbeddingSurface } from '../ingest/embedder.js';
import type { IngestConfig, IngestLimits } from '../ingest/config.js';

export interface DocumentSurface {
  listDocuments(): Promise<{ documents: Array<{ id: string; chunk_count: number }>; total: number }>;
  clearDocuments(): Promise<void>;
  ingestDirectory(directory: string): Promise<IngestResult>;
  ingestFile(input?: IngestFileInput): Promise<IngestResult>;
  ingestBatch(inputs?: IngestFileInput[]): Promise<BatchIngestResult>;
  /**
   * The CONFIGURED embedder's id — what this process would use to embed text
   * right now. NOT necessarily what built the stored vectors; see
   * `vectorsEmbeddingModelId` (issue #198).
   */
  readonly embedderModelId: string;
  /**
   * The model that actually BUILT THE STORED VECTORS, read from
   * meta.embedding_model_id. Empty string when no vector has ever been written
   * (the schema seeds the key to ''), so callers must fall back to
   * `embedderModelId` rather than report an empty id.
   *
   * The two diverge exactly when a prebuilt-index pack is installed into an
   * EMPTY store: `importPrebuiltIndex` stamps the SHIPPED index's model into
   * meta, and `readPrebuiltIndex` only refuses a model mix once the store has
   * chunks. Reporting only `embedderModelId` there attributes an eval result
   * to an embedding space that did not produce the vectors.
   *
   * Required rather than optional so no implementation can silently omit it
   * and keep reporting the configured id forever.
   */
  readonly vectorsEmbeddingModelId: string;
}

export interface StoreDocumentSurfaceOptions {
  getStore: () => StoreHandle | null;
  /** Install a replacement handle (Clear Cache re-initialization). */
  setStore: (handle: StoreHandle | null) => void;
  embedder: EmbeddingSurface;
  config: IngestConfig;
  /** Extraction resource caps; omitted limits disable the caps. */
  limits?: IngestLimits;
  /** Schema root for re-initialization; discovered when omitted. */
  repoRoot?: string;
  onProgress?: (event: IngestProgress) => void;
  /** B8 (issue #66, S3): forwarded to the pipeline — the embed phase awaits
   *  this before embed-heavy work while a generation runs (ConcurrencyScheduler
   *  satisfies it structurally). */
  coordination?: {
    waitForGenerationEnd(): Promise<void>;
  };
}

export class StoreDocumentSurface implements DocumentSurface {
  private pipeline: IngestPipeline | null = null;

  constructor(private readonly opts: StoreDocumentSurfaceOptions) {}

  get embedderModelId(): string {
    return this.opts.embedder.modelId;
  }

  /**
   * Read meta.embedding_model_id — the model the stored vectors were actually
   * built with (issue #198). Deliberately NOT `this.opts.embedder.modelId`:
   * those diverge after a prebuilt-index pack lands in an empty store, and the
   * whole point is to report the one that produced the vectors.
   *
   * Returns '' when there is no store or no row, matching the schema's seeded
   * empty value; callers fall back to `embedderModelId`.
   */
  get vectorsEmbeddingModelId(): string {
    const store = this.opts.getStore();
    if (store === null) return '';
    try {
      const row = store.db
        .prepare("SELECT value FROM meta WHERE key = 'embedding_model_id'")
        .get() as { value: string } | undefined;
      return row?.value ?? '';
    } catch {
      // A store without a meta table (pre-schema file mid-migration) reports
      // "unknown" rather than throwing: this is a reporting field, and the
      // caller has a correct fallback.
      return '';
    }
  }

  private getPipeline(store: StoreHandle): IngestPipeline {
    if (this.pipeline === null) {
      this.pipeline = new IngestPipeline({
        store,
        embedder: this.opts.embedder,
        config: this.opts.config,
        ...(this.opts.limits ? { limits: this.opts.limits } : {}),
        onProgress: this.opts.onProgress,
        ...(this.opts.coordination ? { coordination: this.opts.coordination } : {}),
      });
    }
    return this.pipeline;
  }

  async listDocuments(): Promise<{ documents: Array<{ id: string; chunk_count: number }>; total: number }> {
    const store = this.opts.getStore();
    if (store === null) return { documents: [], total: 0 };
    const rows = store.db
      .prepare(
        'SELECT d.path AS path, COUNT(c.id) AS chunk_count FROM docs d LEFT JOIN chunks c ON c.doc_id = d.id ' +
          'GROUP BY d.id ORDER BY d.path',
      )
      .all() as Array<{ path: string; chunk_count: number }>;
    return {
      // The frozen contract documents DocumentInfo.id as the source path;
      // content-hash identity lives in docs.id and is never exposed here.
      documents: rows.map((row) => ({ id: row.path, chunk_count: row.chunk_count })),
      total: rows.length,
    };
  }

  /**
   * Clear Cache: close the handle, delete the store file AND its -wal/-shm
   * sidecars, re-initialize an empty schema at the same path, and install the
   * fresh handle. The host keeps serving from the same path immediately.
   */
  async clearDocuments(): Promise<void> {
    const store = this.opts.getStore();
    if (store === null) return;
    this.opts.setStore(null);
    this.pipeline = null;
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${store.dbPath}${suffix}`, { force: true });
      } catch (err) {
        // openStore does NOT validate sidecar absence, so a failed removal
        // here would leave stale bytes a reopened store could pick up —
        // make it loud instead of silent (PRR-016).
        console.error(
          `[trainingapp-store] clear-cache: failed to remove ${store.dbPath}${suffix}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const fresh = openStore({
      dbPath: store.dbPath,
      dims: store.dims,
      ...(this.opts.repoRoot ? { repoRoot: this.opts.repoRoot } : {}),
    });
    this.opts.setStore(fresh);
  }

  async ingestDirectory(directory: string): Promise<IngestResult> {
    const store = this.opts.getStore();
    if (store === null) return noStoreResult();
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      return { success: false, documents: 0, chunks_added: 0, message: `not a directory: ${directory}` };
    }
    return this.getPipeline(store).ingestDirectory(directory);
  }

  async ingestFile(input?: IngestFileInput): Promise<IngestResult> {
    const store = this.opts.getStore();
    if (store === null) return noStoreResult();
    if (
      input === undefined ||
      typeof input.name !== 'string' ||
      input.name.length === 0 ||
      !(input.data instanceof Uint8Array) ||
      input.data.length === 0
    ) {
      return { success: false, documents: 0, chunks_added: 0, message: 'no file provided' };
    }
    return this.getPipeline(store).ingestFile(input);
  }

  async ingestBatch(inputs?: IngestFileInput[]): Promise<BatchIngestResult> {
    const store = this.opts.getStore();
    if (store === null) {
      return {
        total_files: inputs?.length ?? 0,
        successful: 0,
        failed: inputs?.length ?? 0,
        results: [],
      };
    }
    return this.getPipeline(store).ingestBatch(inputs ?? []);
  }
}

/** Pre-B6 stub semantics, preserved verbatim for the no-store mode. */
function noStoreResult(): IngestResult {
  return {
    success: false,
    documents: 0,
    chunks_added: 0,
    message:
      'Ingestion requires a configured store; no store is attached to this backend host (B6, issue #64).',
  };
}
