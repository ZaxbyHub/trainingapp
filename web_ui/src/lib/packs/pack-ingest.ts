// pack-ingest.ts — retrieval parity for installed packs in the browser app
// (trace browser-training-parity AC6, plan step 8).
//
// On install the pack's documents are ingested into the browser search
// indexes with their pack identity, so chat retrieval, the Learn panel's
// "where to learn this" links (LearnResult.pack_id) and the pinned-slide
// resolver (slide-doc-resolver.ts) work exactly as on desktop:
//   * keyword index FIRST and immediately — it needs no embedding model, so
//     section resolution and keyword retrieval work before any weights load;
//   * embeddings when the model is ready: in the background right after
//     install if it already is, otherwise on the app's
//     'embedding-service-ready' event; the per-version `embedded` flag in the
//     pack registry makes this resumable across reloads;
//   * every chunk carries `packId` (desktop docs.pack_id) and the doc path as
//     its source, so slide chunks resolve by `docs/slide-<n>-<slideId>.json`.
// The prebuilt index.sqlite a pack may carry is NOT used: the browser embeds
// with its own model (ADR-0009's 768- vs 384-dim mismatch), and doc text is
// derived with the document_processor.py rules (slide docs get the
// `[training-slide] section=… | title=… | slide_id=…` marker line).
import type { DocumentChunk } from '../../types/document';
import { TextChunker } from '../processing/text-chunker';
import { getKeywordIndex } from '../search/keyword-index';
import { getVectorIndex } from '../search/vector-index';
import { getEmbeddingService } from '../embeddings/embedding-service';
import type { PackManifest } from './pack-manifest';
import type { PackVersionRecord } from './pack-store-opfs';

/** The stable search-index document id of one pack document (version-independent). */
export function packDocId(packId: string, docPath: string): string {
  return `pack:${packId}:${docPath}`;
}

const sanitizeMarkerValue = (value: unknown): string => String(value).replace(/\|/g, '/').replace(/\n/g, ' ').trim();

/**
 * The searchable text of one pack document, or null when the browser cannot
 * index it. Mirrors document_processor.py extract_json_document for Storyline
 * slide docs (marker line + on-screen text + transcript) and the desktop
 * extractDocText rule for JSON {text} and text/* docs.
 */
export function packDocText(bytes: Uint8Array, mime: string): string | null {
  if (mime === 'application/json') {
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch {
      return null;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const doc = payload as Record<string, unknown>;
    if (doc.slide_id && doc.slide_title && typeof doc.on_screen_text === 'string') {
      const parts = [
        `[training-slide] section=${sanitizeMarkerValue(doc.section_title || '')} | title=${sanitizeMarkerValue(doc.slide_title)} | slide_id=${sanitizeMarkerValue(doc.slide_id)}`,
      ];
      if (doc.on_screen_text.trim()) parts.push(doc.on_screen_text.trim());
      if (typeof doc.transcript_text === 'string' && doc.transcript_text.trim()) parts.push(doc.transcript_text.trim());
      return parts.join('\n\n');
    }
    return typeof doc.text === 'string' ? doc.text : null;
  }
  if (mime.startsWith('text/')) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  return null;
}

const isSlideDocPath = (path: string): boolean => /^docs\/slide-\d+-.+\.json$/.test(path);

/** Build the search chunks of a pack version (every chunk stamped with packId). */
export function buildPackChunks(manifest: PackManifest, docs: ReadonlyMap<string, Uint8Array>): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const chunker = new TextChunker();
  for (const entry of manifest.docs) {
    const bytes = docs.get(entry.path);
    if (bytes === undefined) continue;
    const text = packDocText(bytes, entry.mime);
    if (text === null || text.trim() === '') continue;
    const docId = packDocId(manifest.id, entry.path);
    if (isSlideDocPath(entry.path)) {
      // A slide is one chunk (its marker line must stay first for the
      // Learn kernel and the pinned-slide resolver).
      chunks.push({ text, source: entry.path, chunkIndex: 0, docId, packId: manifest.id });
      continue;
    }
    for (const piece of chunker.chunkText(text, entry.path)) {
      chunks.push({ ...piece, docId, source: entry.path, packId: manifest.id });
    }
  }
  return chunks;
}

export interface PackIndexTargets {
  keyword: {
    initialize(): Promise<void>;
    isReady(): boolean;
    addDocuments(chunks: DocumentChunk[]): void;
    removeByDocId(docId: string): void;
    save(): Promise<void>;
  };
  vector: {
    initialize(): Promise<void>;
    isReady(): boolean;
    addBatch(entries: Array<{ docId: string; chunkIndex: number; vector: Float32Array | number[]; text?: string; source?: string; packId?: string }>): Promise<void>;
    removeByDocId(docId: string): Promise<void>;
    save(): Promise<void>;
  };
  embedder: {
    isReady(): boolean;
    encodeBatch(texts: string[]): Promise<Array<Float32Array | number[]>>;
  };
}

function defaultTargets(): PackIndexTargets {
  return {
    keyword: getKeywordIndex(),
    vector: getVectorIndex() as unknown as PackIndexTargets['vector'],
    embedder: getEmbeddingService() as unknown as PackIndexTargets['embedder'],
  };
}

/** Keyword-index ingestion (no embedding model needed). */
export async function indexPackKeywords(
  manifest: PackManifest,
  docs: ReadonlyMap<string, Uint8Array>,
  targets: PackIndexTargets = defaultTargets(),
): Promise<DocumentChunk[]> {
  const chunks = buildPackChunks(manifest, docs);
  await targets.keyword.initialize();
  for (const entry of manifest.docs) targets.keyword.removeByDocId(packDocId(manifest.id, entry.path));
  if (chunks.length > 0) targets.keyword.addDocuments(chunks);
  await targets.keyword.save();
  return chunks;
}

/** Vector-index ingestion; returns false (pending) when the model is not ready. */
export async function embedPackChunks(chunks: DocumentChunk[], targets: PackIndexTargets = defaultTargets()): Promise<boolean> {
  if (!targets.embedder.isReady()) return false;
  await targets.vector.initialize();
  if (!targets.vector.isReady()) return false;
  const docIds = [...new Set(chunks.map((c) => c.docId).filter((id): id is string => typeof id === 'string'))];
  for (const docId of docIds) await targets.vector.removeByDocId(docId);
  if (chunks.length === 0) return true;
  const vectors = await targets.embedder.encodeBatch(chunks.map((c) => c.text));
  await targets.vector.addBatch(
    chunks.map((chunk, i) => ({
      docId: chunk.docId ?? '',
      chunkIndex: chunk.chunkIndex,
      vector: vectors[i]!,
      text: chunk.text,
      source: chunk.source,
      ...(chunk.packId !== undefined ? { packId: chunk.packId } : {}),
    })),
  );
  await targets.vector.save();
  return true;
}

/** Remove every indexed chunk of the given pack versions' documents. */
export async function unindexPackDocs(records: ReadonlyArray<Pick<PackVersionRecord, 'packId' | 'docPaths'>>, targets: PackIndexTargets = defaultTargets()): Promise<void> {
  await targets.keyword.initialize();
  for (const record of records) {
    for (const path of record.docPaths) {
      const docId = packDocId(record.packId, path);
      targets.keyword.removeByDocId(docId);
      if (targets.vector.isReady()) await targets.vector.removeByDocId(docId);
    }
  }
  await targets.keyword.save();
  if (targets.vector.isReady()) await targets.vector.save();
}
