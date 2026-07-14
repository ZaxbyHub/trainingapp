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
import { getEmbeddingService } from '../lib/embeddings/embedding-service';
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
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Load documents from IndexedDB on mount
  useEffect(() => {
    async function load() {
      try {
        const docs = await loadDocuments();
        setDocuments(docs);
      } catch (error) {
        console.error('Failed to load documents:', error);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  // Save documents to IndexedDB when they change (debounced)
  useEffect(() => {
    if (isLoading) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveDocuments(documents);
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

  // Process a single file and update document state
  const processFile = useCallback(async (file: File, docId: string) => {
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

      // Compute embeddings and add to VectorIndex
      const embeddingService = getEmbeddingService();
      const vectorIndex = getVectorIndex();
      const keywordIndex = getKeywordIndex();

      // Vector index: embed and add. Pass the chunk's already-present text,
      // source (filename) and page so vector search results carry real text and
      // citation metadata (F1/F7). NOTE: this minimal metadata capture overlaps
      // with PR-4 (#23), which owns broader ingestion work.
      if (embeddingService.isReady() && vectorIndex.isReady()) {
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
  }, []);

  // Handle file selection from DropZone
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      const newEntries: DocumentEntry[] = files.map((file) => ({
        id: generateId(),
        fileName: file.name,
        fileSize: file.size,
        fileType: file.name.slice(file.name.lastIndexOf('.')).toLowerCase(),
        status: 'uploading' as const,
        progress: 0,
        uploadedAt: Date.now(),
      }));

      // Add new entries to state
      setDocuments((prev) => [...newEntries, ...prev]);

      // Process each file
      for (let i = 0; i < newEntries.length; i++) {
        const entry = newEntries[i];
        const file = files[i];
        if (file) {
          await processFile(file, entry.id);
        }
      }
    },
    [processFile]
  );

  // Handle document deletion
  const handleDelete = useCallback(async (docId: string) => {
    setDeletingId(docId);

    try {
      // Remove from IndexedDB
      await deleteDocumentFromStore(docId);

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
