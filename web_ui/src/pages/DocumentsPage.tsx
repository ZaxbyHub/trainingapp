/**
 * Documents page with drag-and-drop upload, document list, and IndexedDB persistence.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { DropZone } from '../components/DropZone';
import { DocumentList } from '../components/DocumentList';
import type { DocumentEntry } from '../types/document';
import { extractDocument, SUPPORTED_EXTENSIONS } from '../lib/processing/extractor-factory';
import { TextChunker } from '../lib/processing/text-chunker';
import { loadDocuments, saveDocuments, deleteDocument as deleteDocumentFromStore } from '../lib/storage/document-store';
import { migrateOrphanedNamespaces } from '../lib/storage/profile';
import { getEmbeddingService } from '../lib/embeddings/embedding-service';
import { ensureEmbeddingServiceReady } from '../hooks/useServiceInitialization';
import { getVectorIndex } from '../lib/search/vector-index';
import { getKeywordIndex } from '../lib/search/keyword-index';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // F9: one-time banner when the embedding model was upgraded and the stored
  // vector index was discarded as incompatible (see VECTOR_INDEX_VERSION).
  const [showReindexNotice, setShowReindexNotice] = useState(false);
  // F5: transient notice shown when a duplicate file upload is skipped.
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // F4/F13: latest documents mirror so the debounced save reads CURRENT state
  // at fire-time (not the schedule-time snapshot) and the unmount flush can
  // capture the newest state.
  const latestDocumentsRef = useRef<DocumentEntry[]>([]);
  // F3: in-flight processFile promises keyed by docId, so handleDelete can wait
  // for processing to settle before removing chunks (avoids orphan chunks).
  const processingPromisesRef = useRef<Map<string, Promise<void>>>(new Map());

  // F9: surface the re-index requirement once. The flag is set by VectorIndex
  // on version mismatch; cleared here on dismiss so the user sees it once.
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('rag-reindex-required') === '1') {
        setShowReindexNotice(true);
      }
    } catch {
      /* private mode / storage disabled */
    }
  }, []);

  const dismissReindexNotice = useCallback(() => {
    setShowReindexNotice(false);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('rag-reindex-required');
      }
    } catch {
      /* private mode / storage disabled */
    }
  }, []);

  // Load documents from IndexedDB on mount.
  // F1: run the one-time orphan-namespace migration before loading so any
  // documents left in a legacy per-session namespace are folded into the
  // current stable profile first. Migration is best-effort and never throws.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        await migrateOrphanedNamespaces();
        if (cancelled) return;
        const docs = await loadDocuments();
        if (cancelled) return;
        setDocuments(docs);
      } catch (error) {
        console.error('Failed to load documents:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the latest-documents ref in sync so the debounced save and the unmount
  // flush always read CURRENT state (F4/F13).
  useEffect(() => {
    latestDocumentsRef.current = documents;
  }, [documents]);

  // Save documents to IndexedDB when they change (debounced).
  // F13: the save callback reads latestDocumentsRef.current at FIRE TIME rather
  // than closing over the schedule-time `documents` snapshot, so a stale armed
  // timer cannot resurrect a just-deleted document via clear-and-rewrite-all.
  useEffect(() => {
    if (isLoading) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveDocuments(latestDocumentsRef.current);
      } catch (error) {
        console.error('Failed to save documents:', error);
      }
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [documents, isLoading]);

  // F4: flush the pending debounced save on unmount so navigating away within
  // the 500ms debounce window does not lose the latest document-list change.
  // This is best-effort: SPA navigation keeps the IndexedDB transaction alive,
  // but a hard tab close / bfcache eviction may abort it (documented residual).
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        void saveDocuments(latestDocumentsRef.current).catch((error) => {
          console.error('Failed to flush documents on unmount:', error);
        });
      }
    };
  }, []);

  // Process a single file and update document state.
  // F3: the in-flight promise is registered in processingPromisesRef so
  // handleDelete can await it (delete-while-processing would otherwise leave
  // orphan chunks). Registered immediately and cleared in a finally.
  const processFile = useCallback(async (file: File, docId: string) => {
    const run = async () => {
      const chunker = new TextChunker();

    try {
      // Update status to processing
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId ? { ...doc, status: 'processing', progress: 30 } : doc
        )
      );

      // Extract text from document
      const extractionResult = await extractDocument(file);

      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId ? { ...doc, progress: 60 } : doc
        )
      );

      // Chunk the extracted text
      const chunks = chunker.chunkText(
        extractionResult.fullText,
        file.name,
        extractionResult.pages
      );

      // Set docId on all chunks before indexing
      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      // Update progress to show indexing phase
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId ? { ...doc, progress: 75 } : doc
        )
      );

      // F2: ensure BOTH the embedding service and the vector index are ready
      // before deciding whether to vector-index. The embedding model is
      // deferred to first use (useServiceInitialization), and the vector index
      // initializes on boot — awaiting both resolves any boot/first-use race
      // so a document uploaded before the first chat query is actually indexed
      // (previously it was silently skipped and marked 'ready' with no vectors).
      // Show a "loading model" progress stage so the UI isn't silent during the
      // (one-time) model load.
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId
            ? { ...doc, status: 'processing', progress: 78 }
            : doc
        )
      );
      const embeddingOk = await ensureEmbeddingServiceReady();
      const vectorIndex = getVectorIndex();
      try {
        await vectorIndex.initialize(); // idempotent
      } catch (initError) {
        console.error('Vector index initialization failed:', initError);
      }
      const embeddingService = getEmbeddingService();
      const keywordIndex = getKeywordIndex();

      // F2: if the embedding model could not initialize, surface a clear error
      // instead of silently marking the document ready (which left it invisible
      // to semantic search forever).
      if (!embeddingOk || !embeddingService.isReady() || !vectorIndex.isReady()) {
        throw new Error(
          'Could not initialize the embedding search model. The document was added but is not searchable by semantic search. Reload the page and try again.'
        );
      }

      // Vector index: embed and add. Pass the chunk's already-present text,
      // source (filename) and page so vector search results carry real text and
      // citation metadata (F1/F7). NOTE: this minimal metadata capture overlaps
      // with PR-4 (#23), which owns broader ingestion work.
      try {
        const texts = chunks.map((c) => c.text);
        const vectors = await embeddingService.encodeBatch(texts);
        const entries = chunks.map((chunk, i) => ({
          docId: chunk.docId!,
          chunkIndex: chunk.chunkIndex,
          vector: vectors[i],
          text: chunk.text,     // F1: real chunk text for grounded context
          source: chunk.source, // F7: filename for citations
          page: chunk.page,     // F7: page number for citations
        }));
        await vectorIndex.addBatch(entries);
        await vectorIndex.save();
      } catch (indexError) {
        console.error('Failed to add to vector index:', indexError);
        // Continue so keyword indexing can proceed
      }

      // Keyword index: add text chunks
      if (keywordIndex.isReady()) {
        try {
          keywordIndex.addDocuments(chunks);
          await keywordIndex.save();
        } catch (indexError) {
          console.error('Failed to add to keyword index:', indexError);
          // Continue so document is still marked as processed
        }
      }

      // Update progress to 90 after indexing
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId ? { ...doc, progress: 90 } : doc
        )
      );

      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId
            ? {
                ...doc,
                status: 'ready',
                progress: 100,
                chunkCount: chunks.length,
              }
            : doc
        )
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'error' in error
          ? String((error as Record<string, unknown>).error)
          : 'Unknown error occurred';
      console.error('Failed to process document:', error);

      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId
            ? { ...doc, status: 'error', errorMessage }
            : doc
        )
      );
    }
    }; // end run()

    const p = run();
    processingPromisesRef.current.set(docId, p);
    try {
      await p;
    } finally {
      // Only delete our entry if it still points at this promise (a later call
      // for the same docId may have replaced it).
      if (processingPromisesRef.current.get(docId) === p) {
        processingPromisesRef.current.delete(docId);
      }
    }
  }, []);

  // Handle file selection from DropZone.
  // F5: skip files that duplicate an existing document by fileName + fileSize
  // (re-uploading previously created a second independent set of chunks in both
  // indexes). Skipped files surface a transient notice.
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      const existing = latestDocumentsRef.current;
      const accepted: { file: File; entry: DocumentEntry }[] = [];
      const skipped: string[] = [];

      for (const file of files) {
        const isDuplicate = existing.some(
          (doc) => doc.fileName === file.name && doc.fileSize === file.size
        );
        if (isDuplicate) {
          skipped.push(file.name);
          continue;
        }
        accepted.push({
          file,
          entry: {
            id: generateId(),
            fileName: file.name,
            fileSize: file.size,
            fileType: file.name.slice(file.name.lastIndexOf('.')).toLowerCase(),
            status: 'uploading' as const,
            progress: 0,
            uploadedAt: Date.now(),
          },
        });
      }

      if (skipped.length > 0) {
        setDuplicateNotice(
          skipped.length === 1
            ? `Skipped duplicate file: ${skipped[0]}`
            : `Skipped ${skipped.length} duplicate files`
        );
      }

      if (accepted.length === 0) {
        return;
      }

      // Add new entries to state
      setDocuments((prev) => [...accepted.map((a) => a.entry), ...prev]);

      // Process each accepted file
      for (const { file, entry } of accepted) {
        await processFile(file, entry.id);
      }
    },
    [processFile]
  );

  // Auto-dismiss the duplicate notice after a few seconds.
  useEffect(() => {
    if (!duplicateNotice) return;
    const t = setTimeout(() => setDuplicateNotice(null), 4000);
    return () => clearTimeout(t);
  }, [duplicateNotice]);

  // Handle document deletion.
  // F3: if the document is still being processed, await the in-flight
  // processFile first so its addBatch/save either completes (and is then
  // removed) or the delete sees the terminal state — preventing permanent
  // orphan chunks from a delete-while-processing race. processFile never
  // rejects (top-level try/catch), so this resolves even on extraction failure.
  // F13: cancel any pending debounced save so a stale snapshot can't resurrect
  // the deleted document; the state update below re-arms the debounce with the
  // post-delete list (read from the ref at fire time).
  const handleDelete = useCallback(async (docId: string) => {
    setDeletingId(docId);

    try {
      // F3: wait for in-flight processing to settle.
      const inFlight = processingPromisesRef.current.get(docId);
      if (inFlight) {
        await inFlight;
      }

      // Remove from IndexedDB
      await deleteDocumentFromStore(docId);

      // F13: cancel any armed debounced save so it cannot fire with a stale
      // snapshot that still includes this document.
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      // Remove from search indexes
      try {
        const vectorIndex = getVectorIndex();
        if (vectorIndex.isReady()) {
          await vectorIndex.removeByDocId(docId);
          await vectorIndex.save();
        }
      } catch (indexError) {
        console.error('Failed to remove from vector index:', indexError);
        // Continue even if index removal fails
      }

      try {
        const keywordIndex = getKeywordIndex();
        if (keywordIndex.isReady()) {
          keywordIndex.removeByDocId(docId);
          await keywordIndex.save();
        }
      } catch (indexError) {
        console.error('Failed to remove from keyword index:', indexError);
        // Continue even if index removal fails
      }

      // Remove from state
      setDocuments((prev) => prev.filter((doc) => doc.id !== docId));
    } catch (error) {
      console.error('Failed to delete document:', error);
    } finally {
      setDeletingId(null);
    }
  }, []);

  // Count supported documents
  const supportedCount = documents.filter((doc) =>
    SUPPORTED_EXTENSIONS.includes(doc.fileType)
  ).length;

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: 'var(--spacing-xxl)',
        }}
      >
        <p
          style={{
            fontSize: 'var(--font-size-body)',
            fontFamily: 'var(--font-family)',
            color: 'var(--color-text-muted)',
          }}
        >
          Loading documents...
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 'var(--spacing-lg)',
        gap: 'var(--spacing-lg)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <h1
          style={{
            fontSize: 'var(--font-size-h1)',
            fontFamily: 'var(--font-family)',
            color: 'var(--color-text-on-bubble-assistant)',
            margin: 0,
          }}
        >
          Documents
        </h1>
        {supportedCount > 0 && (
          <span
            style={{
              fontSize: 'var(--font-size-small)',
              fontFamily: 'var(--font-family)',
              color: 'var(--color-text-muted)',
              backgroundColor: 'var(--color-bubble-system)',
              padding: 'var(--spacing-xs) var(--spacing-sm)',
              borderRadius: '12px',
            }}
          >
            {supportedCount} supported file{supportedCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* F9: one-time re-index notice after an embedding-model upgrade. */}
      {showReindexNotice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--spacing-sm)',
            padding: 'var(--spacing-sm) var(--spacing-md)',
            borderRadius: '8px',
            backgroundColor: 'var(--color-bubble-system)',
            color: 'var(--color-text-muted)',
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
            flexShrink: 0,
          }}
        >
          <span>
            The search index was upgraded. Re-add your documents to rebuild the index and restore full retrieval quality.
          </span>
          <button
            type="button"
            onClick={dismissReindexNotice}
            aria-label="Dismiss notice"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-muted)',
              fontSize: 'var(--font-size-body)',
              padding: '0 var(--spacing-xs)',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* F5: transient duplicate-upload notice. */}
      {duplicateNotice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: 'var(--spacing-xs) var(--spacing-sm)',
            borderRadius: '8px',
            backgroundColor: 'var(--color-bubble-system)',
            color: 'var(--color-text-muted)',
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
            flexShrink: 0,
          }}
        >
          {duplicateNotice}
        </div>
      )}

      {/* Drop zone */}
      <div style={{ flexShrink: 0 }}>
        <DropZone
          onFilesSelected={handleFilesSelected}
          accept={SUPPORTED_EXTENSIONS.join(',')}
        />
      </div>

      {/* Document list */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <DocumentList
          documents={documents}
          onDelete={handleDelete}
          deletingId={deletingId}
        />
      </div>
    </div>
  );
}
