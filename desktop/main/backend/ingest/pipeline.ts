// ingest/pipeline.ts — extract -> chunk -> embed -> write (issue #64, B6).
//
// The production writer for the B5 store (contracts/store.schema.sql).
// Identity is CONTENT-derived, never path-derived (the stale-chunk defect
// class this pipeline eradicates — see 04-root-cause.md):
//   doc id   = sha256(source file bytes)
//   chunk id = sha256(doc sha256 + ':' + chunk_index + ':' + normalized_text)
// where normalized() byte-matches contracts/tests/store-interop/run_interop.py
// (CRLF -> LF, per-line trailing whitespace stripped) so both runtimes derive
// identical ids from identical content.
//
// Write rules (frozen by the acceptance checks):
//   - content SHA-dedupe FIRST: bytes already in docs -> no-op success;
//   - then DELETE-BEFORE-REINGEST: a different revision at the same path
//     value has its doc + chunks + embeddings + fts rows removed inside the
//     same transaction that inserts the new revision;
//   - per-document writes are single BEGIN IMMEDIATE..COMMIT transactions;
//   - all DB work serializes on one queue (v1: one writer per store file).
// Embeddings are sized to store.dims and validated per batch — a model whose
// output width contradicts the store fails loud instead of corrupting vec0.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoreHandle } from '../store/sqlite-store.js';
import { isSupportedFile, extractDocumentFromFile, type ExtractionPage } from './extractors.js';
import type { EmbeddingSurface } from './embedder.js';
import type { IngestConfig } from './config.js';
import { TextChunker } from './text-chunker.js';

export interface IngestFileInput {
  name: string;
  data: Uint8Array;
}

export interface IngestResult {
  success: boolean;
  documents: number;
  chunks_added: number;
  message: string | null;
}

export interface BatchIngestResult {
  total_files: number;
  successful: number;
  failed: number;
  results: Array<{ filename: string; success: boolean; chunks_added?: number; error?: string }>;
}

export type IngestPhase = 'extract' | 'chunk' | 'embed' | 'write' | 'done';

export interface IngestProgress {
  docId: string;
  phase: IngestPhase;
  percent: number;
}

export interface IngestPipelineOptions {
  store: StoreHandle;
  embedder: EmbeddingSurface;
  config: IngestConfig;
  onProgress?: (event: IngestProgress) => void;
}

/** Byte-matches run_interop.py's normalized(): CRLF->LF, trailing space strip. */
export function normalizedText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Structural subset of better-sqlite3's statement the pipeline uses. */
interface Statement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function stmt(db: StoreHandle['db'], sql: string): Statement {
  return db.prepare(sql) as Statement;
}

export class IngestPipeline {
  private readonly chunker: TextChunker;
  private queue: Promise<unknown> = Promise.resolve();
  private modelIdRecorded = false;

  constructor(private readonly opts: IngestPipelineOptions) {
    this.chunker = new TextChunker(opts.config.chunkWordCount, opts.config.chunkOverlapWords);
  }

  private get db(): StoreHandle['db'] {
    return this.opts.store.db;
  }

  private emit(docId: string, phase: IngestPhase, percent: number): void {
    this.opts.onProgress?.({ docId, phase, percent });
  }

  /** Serialize every write behind one promise chain (single-writer invariant). */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  async ingestFile(input: IngestFileInput): Promise<IngestResult> {
    return this.enqueue(() => this.ingestOne(input));
  }

  async ingestBatch(inputs: IngestFileInput[]): Promise<BatchIngestResult> {
    const results: BatchIngestResult['results'] = [];
    let successful = 0;
    let failed = 0;
    for (const input of inputs) {
      try {
        const outcome = await this.enqueue(() => this.ingestOne(input));
        if (outcome.success) {
          successful += 1;
          results.push({ filename: input.name, success: true, chunks_added: outcome.chunks_added });
        } else {
          failed += 1;
          results.push({ filename: input.name, success: false, error: outcome.message ?? 'ingest failed' });
        }
      } catch (err) {
        failed += 1;
        results.push({ filename: input.name, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { total_files: inputs.length, successful, failed, results };
  }

  async ingestDirectory(directory: string): Promise<IngestResult> {
    let entries: string[];
    try {
      // recursive readdir yields paths relative to `directory`
      entries = (await fs.promises.readdir(directory, { recursive: true })) as string[];
    } catch (err) {
      return {
        success: false,
        documents: 0,
        chunks_added: 0,
        message: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const files = entries
      .filter((name) => isSupportedFile(name))
      .map((name) => path.join(directory, name))
      .sort();

    if (files.length === 0) {
      return { success: true, documents: 0, chunks_added: 0, message: null };
    }

    let documents = 0;
    let chunksAdded = 0;
    const failures: string[] = [];
    let cursor = 0;
    const limit = Math.max(1, this.opts.config.maxConcurrentFiles);
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const file = files[cursor];
        cursor += 1;
        if (file === undefined) break;
        try {
          const data = await fs.promises.readFile(file);
          const outcome = await this.enqueue(() =>
            this.ingestOne({ name: file, data: new Uint8Array(data) }),
          );
          if (outcome.success) {
            documents += outcome.documents;
            chunksAdded += outcome.chunks_added;
          } else if (outcome.message !== null) {
            failures.push(`${path.basename(file)}: ${outcome.message}`);
          }
        } catch (err) {
          // Per-file failure isolation: one unreadable file never fails the
          // directory walk — it is reported in the aggregate message.
          failures.push(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));

    if (failures.length > 0 && documents === 0 && chunksAdded === 0) {
      return { success: false, documents: 0, chunks_added: 0, message: failures.slice(0, 5).join('; ') };
    }
    return {
      success: true,
      documents,
      chunks_added: chunksAdded,
      message: failures.length > 0 ? failures.slice(0, 5).join('; ') : null,
    };
  }

  /**
   * Ingest one document: extract -> chunk -> embed -> write, emitting progress
   * per phase. Returns success:false (never throws) for per-file failures.
   */
  private async ingestOne(input: IngestFileInput): Promise<IngestResult> {
    const docId = sha256Hex(Buffer.from(input.data));
    this.emit(docId, 'extract', 5);

    // Write the uploaded/modified bytes through so extraction reads the exact
    // content being identified, then extract from the temp file (extractors
    // are path-based and library-backed).
    const extension = path.extname(input.name).toLowerCase();
    let extracted: { text: string; pages?: ExtractionPage[] };
    try {
      extracted = await this.extractFromBytes(input.data, extension);
    } catch (err) {
      return {
        success: false,
        documents: 0,
        chunks_added: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (extracted.text.trim().length === 0) {
      return { success: false, documents: 0, chunks_added: 0, message: 'no extractable text' };
    }

    this.emit(docId, 'chunk', 30);
    const chunks = this.chunker.chunkText(extracted.text, path.basename(input.name), extracted.pages);
    if (chunks.length === 0) {
      return { success: false, documents: 0, chunks_added: 0, message: 'no chunks produced' };
    }

    this.emit(docId, 'embed', 55);
    let vectors: number[][];
    try {
      vectors = await this.opts.embedder.embed(chunks.map((c) => c.text));
    } catch (err) {
      return {
        success: false,
        documents: 0,
        chunks_added: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (vectors.length !== chunks.length) {
      return {
        success: false,
        documents: 0,
        chunks_added: 0,
        message: `embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      };
    }
    const dims = this.opts.store.dims;
    for (const vector of vectors) {
      if (vector.length !== dims) {
        return {
          success: false,
          documents: 0,
          chunks_added: 0,
          message: `embedding width ${vector.length} does not match store dims ${dims}`,
        };
      }
    }

    this.emit(docId, 'write', 80);
    const inserted = this.writeDocument(docId, input.name, extracted, chunks, vectors);
    this.emit(docId, 'done', 100);
    return inserted;
  }

  /** Materialize bytes to a temp file of the right extension and extract. */
  private async extractFromBytes(data: Uint8Array, extension: string): Promise<{ text: string; pages?: ExtractionPage[] }> {
    if (extension === '.txt' || extension === '.md') {
      return { text: Buffer.from(data).toString('utf8') };
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b6-ingest-'));
    let tempFile: string | null = null;
    try {
      tempFile = path.join(tempDir, `source${extension || '.bin'}`);
      fs.writeFileSync(tempFile, data);
      return await extractDocumentFromFile(tempFile);
    } finally {
      try {
        if (tempFile !== null) fs.rmSync(tempFile, { force: true });
        fs.rmdirSync(tempDir);
      } catch {
        // best-effort cleanup; the temp dir lives under the process dir
      }
    }
  }

  /**
   * Transactional write: content dedupe -> path-collision delete -> insert.
   * Returns documents:1/chunks_added:N for a new doc, documents:0 for a
   * content-dedupe no-op.
   */
  private writeDocument(
    docId: string,
    docPath: string,
    extracted: { text: string; pages?: ExtractionPage[] },
    chunks: Array<{ text: string; chunkIndex: number; page?: number }>,
    vectors: number[][],
  ): IngestResult {
    const db = this.db;
    const existing = db
      .prepare('SELECT id FROM docs WHERE sha256 = ?')
      .get(docId) as { id: string } | undefined;
    if (existing !== undefined) {
      // Content dedupe: identical bytes are already in the corpus. First-seen
      // path provenance wins; re-ingesting identical bytes is a no-op.
      return { success: true, documents: 0, chunks_added: 0, message: null };
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      // DELETE-BEFORE-REINGEST: an older revision of the same path must not
      // retain chunks. Cascades manually (FKs are not enforced on vec0/fts5).
      const staleDocs = stmt(db, 'SELECT id FROM docs WHERE path = ? AND id != ?').all(docPath, docId) as Array<{
        id: string;
      }>;
      for (const doc of staleDocs) {
        const chunkIds = stmt(db, 'SELECT id FROM chunks WHERE doc_id = ?').all(doc.id) as Array<{ id: string }>;
        for (const chunk of chunkIds) {
          stmt(db, 'DELETE FROM embeddings WHERE chunk_id = ?').run(chunk.id);
          stmt(db, 'DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunk.id);
        }
        stmt(db, 'DELETE FROM chunks WHERE doc_id = ?').run(doc.id);
        stmt(db, 'DELETE FROM docs WHERE id = ?').run(doc.id);
      }

      stmt(db, "INSERT INTO docs (id, source_class, path, sha256) VALUES (?, 'general', ?, ?)").run(
        docId,
        docPath,
        docId,
      );

      const insertChunk = stmt(
        db,
        'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
      );
      const insertVector = stmt(db, 'INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');
      const insertFts = stmt(db, 'INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
      for (const chunk of chunks) {
        const normalized = normalizedText(chunk.text);
        const chunkId = sha256Hex(`${docId}:${chunk.chunkIndex}:${normalized}`);
        insertChunk.run(chunkId, docId, chunk.chunkIndex, chunk.text, sha256Hex(normalized));
        insertVector.run(chunkId, JSON.stringify(vectors[chunk.chunkIndex] ?? []));
        insertFts.run(chunkId, chunk.text);
      }

      if (!this.modelIdRecorded) {
        stmt(db, "UPDATE meta SET value = ? WHERE key = 'embedding_model_id'").run(this.opts.embedder.modelId);
        this.modelIdRecorded = true;
      }

      db.exec('COMMIT');
      return { success: true, documents: 1, chunks_added: chunks.length, message: null };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The connection is unusable after some failures; surface the cause.
      }
      return {
        success: false,
        documents: 0,
        chunks_added: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
