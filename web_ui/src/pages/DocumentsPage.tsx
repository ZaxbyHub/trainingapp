/**
 * Documents page with drag-and-drop upload, document list, and IndexedDB persistence.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { DropZone } from '../components/DropZone';
import { DocumentList } from '../components/DocumentList';
import { useToast } from '../components/ToastProvider';
import type { DocumentEntry } from '../types/document';
import { extractDocument, SUPPORTED_EXTENSIONS } from '../lib/processing/extractor-factory';
import { TextChunker } from '../lib/processing/text-chunker';
import { loadDocuments, saveDocuments, deleteDocument as deleteDocumentFromStore } from '../lib/storage/document-store';
import { migrateOrphanedNamespaces } from '../lib/storage/profile';
import { REINDEX_FLAG_KEY } from '../lib/storage/persisted-keys';
import { getEmbeddingService } from '../lib/embeddings/embedding-service';
import { ensureEmbeddingServiceReady } from '../hooks/useServiceInitialization';
import { getVectorIndex } from '../lib/search/vector-index';
import { getKeywordIndex } from '../lib/search/keyword-index';
import { isElectron, useDesktopSession } from '../lib/desktop-session';
import { PacksPanel } from '../components/PacksPanel';
import { usePackClient } from '../lib/packs/pack-client';
import type { DocumentInfo } from '../lib/api';
import { Badge, Banner, Button, Icon, IconButton, PageHeader, Skeleton, Tabs } from '../ui';
import './documents.css';

const DOCUMENTS_DESCRIPTION = 'Add files and knowledge packs that Chat can search and cite.';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * B9 (issue #67): map the frozen contract's DocumentInfo (id = source PATH,
 * see document-surface.ts) to the page's display row. The server store is the
 * authoritative source in Electron mode; fileSize is unknown server-side and
 * intentionally 0 (never displayed from the server row).
 */
function serverDocToEntry(doc: DocumentInfo): DocumentEntry {
  const fileName = doc.id.split(/[\/]/).pop() ?? doc.id;
  const fileType = (fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '').toLowerCase();
  return {
    id: doc.id,
    fileName,
    fileSize: 0,
    fileType,
    status: 'ready' as const,
    progress: 100,
    chunkCount: doc.chunk_count,
    uploadedAt: Date.now(),
  };
}

export function DocumentsPage() {
  // U3b: surface user-facing failures (and delete success) as toasts.
  const { showToast } = useToast();
  // B9 (issue #67): inside Electron the desktop backend store is authoritative.
  // Uploads go through apiClient (/ingest/file), listing through GET /documents,
  // and deletion is the contract's clear-all (no per-document delete exists in
  // the frozen contract) behind an explicit confirm. Browser-local behavior is
  // byte-identical when the preload bridge is absent.
  const { session: desktopSession } = useDesktopSession();
  const electronMode = isElectron() && desktopSession !== null;
  const [clearAllConfirming, setClearAllConfirming] = useState(false);
  // F3: true while a clear-all request is in flight — uploads started in this
  // window are skipped so they cannot re-add documents after the clear lands.
  const clearInFlightRef = useRef(false);
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // F9: one-time banner when the embedding model was upgraded and the stored
  // vector index was discarded as incompatible (see VECTOR_INDEX_VERSION).
  const [showReindexNotice, setShowReindexNotice] = useState(false);
  // F5: transient notice shown when a duplicate file upload is skipped.
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);
  // browser-training-parity (ADR-0012, superseding ADR-0009's gate): both
  // apps install knowledge/training packs through the same PackClient seam —
  // the desktop loopback pack API in Electron, the origin-private browser
  // pack store otherwise.
  const packClient = usePackClient();
  // Lumen phase 6 ("Documents | Training packs" tabs, identical in both apps).
  const [activeTab, setActiveTab] = useState<'documents' | 'training'>('documents');
  // Tab slots the single, always-mounted PacksPanel portals into: its knowledge
  // section in the Documents tab, its training-class rows in the Training packs
  // tab (one instance: one install input, one set of toasts). The Tabs primitive
  // mounts only the active panel, so the inactive slot is null.
  const [knowledgePacksSlot, setKnowledgePacksSlot] = useState<HTMLDivElement | null>(null);
  const [trainingPacksSlot, setTrainingPacksSlot] = useState<HTMLDivElement | null>(null);
  // Bumped after installs this page makes itself (DropZone .zip), so the panel
  // re-lists in the desktop app too (its pack client has no change subscription).
  const [packsRefreshToken, setPacksRefreshToken] = useState(0);
  // The header Upload action opens the DropZone's own file input. From the
  // Training packs tab the DropZone is not mounted yet: switch tabs, then open
  // it once the zone registered (still inside the click's user activation).
  const openDocumentPickerRef = useRef<(() => void) | null>(null);
  const pendingUploadRef = useRef(false);
  useEffect(() => {
    if (activeTab !== 'documents' || !pendingUploadRef.current) return;
    const open = openDocumentPickerRef.current;
    if (open === null) return;
    pendingUploadRef.current = false;
    open();
  });
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // F4/F13: latest documents mirror so the debounced save reads CURRENT state
  // at fire-time (not the schedule-time snapshot) and the unmount flush can
  // capture the newest state.
  const latestDocumentsRef = useRef<DocumentEntry[]>([]);
  // F3: in-flight processFile promises keyed by docId, so handleDelete can wait
  // for processing to settle before removing chunks (avoids orphan chunks).
  const processingPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  // U2: per-document AbortControllers keyed by docId. processFile arms one at
  // start and checks controller.signal between stages; the UI Cancel button
  // calls controller.abort() so the next check throws (caught -> terminal error).
  const cancelControllersRef = useRef<Map<string, AbortController>>(new Map());

  // F9: surface the re-index requirement once. The flag is set by VectorIndex
  // on version mismatch; cleared here on dismiss so the user sees it once.
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(REINDEX_FLAG_KEY) === '1') {
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
        localStorage.removeItem(REINDEX_FLAG_KEY);
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
      // B9: server-backed listing in Electron mode (no IndexedDB, no migration).
      if (electronMode && desktopSession) {
        try {
          const listing = await desktopSession.apiClient.listDocuments();
          if (cancelled) return;
          setDocuments(listing.documents.map(serverDocToEntry));
        } catch (error) {
          console.error('Failed to load documents from the desktop backend:', error);
          showToast('Failed to load documents from the desktop backend.', 'error');
        } finally {
          if (!cancelled) setIsLoading(false);
        }
        return;
      }
      try {
        await migrateOrphanedNamespaces();
        if (cancelled) return;
        const docs = await loadDocuments();
        if (cancelled) return;
        // PRR-007: a browser/tab close during processing leaves documents
        // persisted with a non-terminal status ('processing'/'uploading') and
        // no in-flight promise to resume them. Reset any such stale documents
        // to 'error' so they don't render stuck forever; the user can delete
        // and re-add them.
        const recovered = docs.map((doc) =>
          doc.status === 'processing' || doc.status === 'uploading'
            ? {
                ...doc,
                status: 'error' as const,
                errorMessage: 'Processing was interrupted. Please delete and re-add this document.',
              }
            : doc
        );
        setDocuments(recovered);
      } catch (error) {
        console.error('Failed to load documents:', error);
        showToast('Failed to load documents. Please reload the page.', 'error');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [electronMode, desktopSession, showToast]);

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
    if (isLoading || electronMode) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveDocuments(latestDocumentsRef.current);
      } catch (error) {
        console.error('Failed to save documents:', error);
        showToast('Failed to save document changes. They may not persist after reload.', 'error');
      }
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [documents, isLoading, electronMode]);

  // F4: flush the pending debounced save on unmount so navigating away within
  // the 500ms debounce window does not lose the latest document-list change.
  // This is best-effort: SPA navigation keeps the IndexedDB transaction alive,
  // but a hard tab close / bfcache eviction may abort it (documented residual).
  useEffect(() => {
    return () => {
      if (electronMode) return;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        void saveDocuments(latestDocumentsRef.current).catch((error) => {
          console.error('Failed to flush documents on unmount:', error);
        });
      }
    };
  }, [electronMode]);

  // Process a single file and update document state.
  // F3: the in-flight promise is registered in processingPromisesRef so
  // handleDelete can await it (delete-while-processing would otherwise leave
  // orphan chunks). Registered immediately and cleared in a finally.
  const processFile = useCallback(async (file: File, docId: string) => {
    const run = async () => {
      const chunker = new TextChunker();

      // U2: arm a per-document AbortController so the UI Cancel button can stop
      // indexing before the next batch. Replaced on every processFile invocation.
      const controller = new AbortController();
      cancelControllersRef.current.set(docId, controller);
      // Helper: if the user cancelled, mark the doc terminal and throw so the
      // outer catch records a single 'Indexing cancelled' error.
      const throwIfCancelled = () => {
        if (controller.signal.aborted) {
          throw new Error('Indexing cancelled');
        }
      };

    try {
      // Update status to processing
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId ? { ...doc, status: 'processing', progress: 30 } : doc
        )
      );

      // Extract text from document
      const extractionResult = await extractDocument(file);
      throwIfCancelled(); // U2: check cancel after extraction

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
      throwIfCancelled(); // U2: check cancel before model init

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
      //
      // U2: the embedding loop is the long pole. encodeBatch already supports an
      // onProgress callback (embedding-service.ts:225), so map its (processed,
      // total) onto the indexing band of the progress bar. Earlier milestones
      // reserved 30 (start) / 60 (extracted) / 75 (chunked) / 78 (model ready).
      // Embedding runs the bar from 78 up to 95; the post-embedding keyword +
      // finalize stages fill 90-100 below. Stage label is surfaced via the
      // existing errorMessage field (used creatively as in-flight status text)
      // WITHOUT changing the DocumentEntry type; cleared on success.
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId
            ? { ...doc, errorMessage: 'Generating embeddings\u2026' }
            : doc
        )
      );
      try {
        const texts = chunks.map((c) => c.text);
        const vectors = await embeddingService.encodeBatch(texts, (processed, total) => {
          if (total <= 0) return;
          // Map embedding progress onto the 78 -> 95 band.
          const embeddingProgress = 78 + Math.round((processed / total) * 17);
          setDocuments((prev) =>
            prev.map((doc) =>
              doc.id === docId ? { ...doc, progress: embeddingProgress } : doc
            )
          );
        });
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
        // U2: a cancel surfaces here as an abort; rethrow so the outer handler
        // records the terminal 'Indexing cancelled' state rather than silently
        // continuing to keyword indexing.
        if (controller.signal.aborted) throw indexError;
        showToast('Failed to index document for semantic search.', 'error');
        // Continue so keyword indexing can proceed
      }

      // Keyword index: add text chunks
      if (keywordIndex.isReady()) {
        // U2: stage label for the keyword-indexing phase (reuses errorMessage
        // creatively; cleared on success below).
        setDocuments((prev) =>
          prev.map((doc) =>
            doc.id === docId
              ? { ...doc, errorMessage: 'Indexing keywords\u2026' }
              : doc
          )
        );
        try {
          keywordIndex.addDocuments(chunks);
          await keywordIndex.save();
        } catch (indexError) {
          console.error('Failed to add to keyword index:', indexError);
          // Continue so document is still marked as processed
        }
      }
      throwIfCancelled(); // U2: check cancel before finalize

      // Update progress to 90 after indexing and clear the in-flight status text.
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId
            ? { ...doc, progress: 90, errorMessage: undefined }
            : doc
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
                errorMessage: undefined,
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
      const wasCancelled = controller.signal.aborted;
      console.error('Failed to process document:', error);

      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === docId
            ? { ...doc, status: 'error', errorMessage }
            : doc
        )
      );
      // U3b: surface indexing/quota/init failures as a toast. Cancellation is
      // user-initiated, so it stays silent here (the doc already shows the
      // terminal 'Indexing cancelled' state).
      if (!wasCancelled) {
        showToast(`Failed to process "${file.name}": ${errorMessage}`, 'error');
      }
    } finally {
      // U2: drop this run's AbortController unless a newer run replaced it.
      if (cancelControllersRef.current.get(docId) === controller) {
        cancelControllersRef.current.delete(docId);
      }
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
  const processSelectedFiles = useCallback(
    async (files: File[]) => {
      // B9 (issue #67): Electron mode uploads through the desktop backend
      // (/ingest/file) — extraction, chunking, embedding and indexing all
      // happen server-side. The browser-local pipeline below is untouched.
      if (electronMode && desktopSession) {
        // C7 (issue #74): a dropped .zip is a knowledge pack — route it to
        // the pack install API instead of the document pipeline. Plain files
        // keep the existing upload path unchanged (C3 preserving).
        const zipFiles = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
        const docFiles = files.filter((f) => !f.name.toLowerCase().endsWith('.zip'));
        for (const zip of zipFiles) {
          try {
            const result = await desktopSession.apiClient.installPack(zip);
            showToast(`Installed ${result.packId} v${result.version}`, 'success');
            setPacksRefreshToken((n) => n + 1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showToast(`Failed to install pack "${zip.name}": ${message}`, 'error');
          }
        }
        if (docFiles.length === 0) return;
        // F5 parity: same fileName+fileSize dedupe as the browser-local branch.
        const existing = latestDocumentsRef.current;
        const accepted: { file: File; entry: DocumentEntry }[] = [];
        const skipped: string[] = [];
        for (const file of docFiles) {
          const isDuplicate =
            existing.some((doc) => doc.fileName === file.name && doc.fileSize === file.size) ||
            accepted.some((a) => a.entry.fileName === file.name && a.entry.fileSize === file.size);
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
              progress: 30,
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
        // F3: a clear-all in flight wins — don't start uploads that would
        // re-add documents the user just cleared (server-side race).
        for (const { file, entry } of accepted) {
          if (clearInFlightRef.current) {
            showToast(`Skipped "${file.name}": clear-all is in progress.`, 'error');
            continue;
          }
          setDocuments((prev) => [entry, ...prev]);
          try {
            const result = await desktopSession.apiClient.uploadFile(file);
            setDocuments((prev) =>
              prev.map((doc) =>
                doc.id === entry.id
                  ? {
                      ...doc,
                      status: 'ready',
                      progress: 100,
                      chunkCount: result.chunks_added,
                      errorMessage: undefined,
                    }
                  : doc
              )
            );
            // C-7: tell useDocumentCount (chat empty-state badge) to recount.
            window.dispatchEvent(new CustomEvent('documents-changed'));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setDocuments((prev) =>
              prev.map((doc) =>
                doc.id === entry.id ? { ...doc, status: 'error', errorMessage: message } : doc
              )
            );
            showToast(`Failed to upload "${file.name}": ${message}`, 'error');
          }
        }
        return;
      }

      // Browser app (ADR-0012): a dropped or picked .zip is a knowledge pack,
      // exactly as in the desktop branch above — it installs through the
      // browser pack store (every archive guard, manifest gate and signature
      // policy applies) and never reaches the document pipeline.
      if (!electronMode) {
        const zipFiles = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
        const docFiles = files.filter((f) => !f.name.toLowerCase().endsWith('.zip'));
        for (const zip of zipFiles) {
          if (packClient === null) break;
          try {
            const result = await packClient.installPack(zip);
            showToast(`Installed ${result.packId} v${result.version}`, 'success');
            setPacksRefreshToken((n) => n + 1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showToast(`Failed to install pack "${zip.name}": ${message}`, 'error');
          }
        }
        if (docFiles.length === 0) {
          return;
        }
        files = docFiles;
      }

      const existing = latestDocumentsRef.current;
      const accepted: { file: File; entry: DocumentEntry }[] = [];
      const skipped: string[] = [];

      for (const file of files) {
        // F5/PRR-010: dedup against both the existing documents AND any entries
        // already accepted in THIS batch, so two identical files dropped together
        // don't both create independent chunk sets.
        const isDuplicate =
          existing.some((doc) => doc.fileName === file.name && doc.fileSize === file.size) ||
          accepted.some((a) => a.entry.fileName === file.name && a.entry.fileSize === file.size);
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
    [processFile, electronMode, desktopSession, packClient, showToast]
  );

  // Phase-6 review L5: a training pack that appears DURING a drop (a mixed
  // bulk drop installs its .zip packs first, then uploads the documents) must
  // not swap the Documents tab away mid-upload. The switch waits until every
  // in-flight drop has finished.
  const dropsInFlightRef = useRef(0);
  const deferredTrainingSwitchRef = useRef(false);
  // Latest tab, read by the (stable) pack callbacks: a pack that appears while the
  // Training packs tab is already showing needs no switch and no deferral.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  // A MANUAL tab change (tab click or the header Upload action) supersedes a
  // pending deferred switch: the user already chose where to be, and a stale
  // deferral would later yank the tab with no announcement or focus handling
  // (the PacksPanel signal is consumed by the first Training-tab mount).
  const selectTab = useCallback((tab: 'documents' | 'training') => {
    deferredTrainingSwitchRef.current = false;
    setActiveTab(tab);
  }, []);
  const handleTrainingPackAdded = useCallback(() => {
    if (activeTabRef.current === 'training') return;
    if (dropsInFlightRef.current > 0) {
      deferredTrainingSwitchRef.current = true;
      return;
    }
    setActiveTab('training');
  }, []);
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      dropsInFlightRef.current += 1;
      try {
        await processSelectedFiles(files);
      } finally {
        dropsInFlightRef.current -= 1;
        if (dropsInFlightRef.current === 0 && deferredTrainingSwitchRef.current) {
          deferredTrainingSwitchRef.current = false;
          setActiveTab('training');
        }
      }
    },
    [processSelectedFiles]
  );

  // Auto-dismiss the duplicate notice after a few seconds.
  useEffect(() => {
    if (!duplicateNotice) return;
    const t = setTimeout(() => setDuplicateNotice(null), 4000);
    return () => clearTimeout(t);
  }, [duplicateNotice]);

  // F6 (issue #67 review): a hidden-then-reshown confirm button must never
  // stay armed — reset when there is nothing left to clear.
  useEffect(() => {
    if (documents.length === 0) setClearAllConfirming(false);
  }, [documents.length]);

  // U2: per-document indexing cancel. Aborts the AbortController armed in
  // processFile; the next throwIfCancelled() checkpoint (or the embedding batch
  // boundary) records the terminal 'Indexing cancelled' state. No-op if the
  // document isn't currently being indexed.
  const handleCancelIndexing = useCallback((docId: string) => {
    const controller = cancelControllersRef.current.get(docId);
    if (controller) {
      controller.abort();
    }
  }, []);

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
    // B9 (issue #67): Electron mode hides the per-document delete (the frozen
    // contract only exposes clear-all) — the button is not rendered at all,
    // so reaching here means a stale caller; keep it a safe no-op.
    if (electronMode) return;
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
      // U3b: confirm the deletion to the user.
      showToast('Document deleted', 'success');
    } catch (error) {
      console.error('Failed to delete document:', error);
      showToast('Failed to delete document. Please try again.', 'error');
    } finally {
      setDeletingId(null);
    }
  }, [electronMode]);

  // B9 (issue #67): Electron-mode clear-all (the contract's DELETE /documents).
  // Two-step confirm because it removes EVERY document on the backend.
  const handleClearAll = useCallback(async () => {
    if (!electronMode || !desktopSession) return;
    if (!clearAllConfirming) {
      setClearAllConfirming(true);
      return;
    }
    setClearAllConfirming(false);
    clearInFlightRef.current = true;
    try {
      await desktopSession.apiClient.clearDocuments();
      const listing = await desktopSession.apiClient.listDocuments();
      setDocuments(listing.documents.map(serverDocToEntry));
      // C-7: same-tab count refresh (see upload branch).
      window.dispatchEvent(new CustomEvent('documents-changed'));
      showToast('All documents cleared from the desktop library', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`Failed to clear documents: ${message}`, 'error');
    } finally {
      clearInFlightRef.current = false;
    }
  }, [electronMode, desktopSession, clearAllConfirming, showToast]);

  // Count supported documents
  const supportedCount = documents.filter((doc) =>
    SUPPORTED_EXTENSIONS.includes(doc.fileType)
  ).length;

  if (isLoading) {
    return (
      <div className="app-page">
        <PageHeader title="Documents" description={DOCUMENTS_DESCRIPTION} />
        <div className="app-docs__loading" role="status" aria-busy="true" aria-label="Loading documents">
          <Skeleton height={60} />
          <Skeleton height={60} />
          <Skeleton height={60} />
        </div>
      </div>
    );
  }

  // "Documents" tab body: the knowledge-packs panel (it also owns the training
  // rows, portaled into the other tab), the dropzone and the document table.
  const documentsBody = (
    <>
      {/* Knowledge Packs panel — both apps (C7 issue #74; browser parity
          ADR-0012): the same panel over the PackClient seam. Mounted above
          the document drop zone. */}
      {packClient !== null && <div className="app-docs__panel-fixed" ref={setKnowledgePacksSlot} />}

      {/* Drop zone */}
      <div className="app-docs__panel-fixed">
        <DropZone
          onFilesSelected={handleFilesSelected}
          accept={[...SUPPORTED_EXTENSIONS, '.zip'].join(',')}
          openPickerRef={openDocumentPickerRef}
          onFilesRejected={async (rejectedFiles) => {
            // U7a: surface skipped filenames so the user knows files were
            // discarded (previously DropZone filtered silently). Pack zips
            // are accepted (and installed) in both apps, so they never land
            // here.
            const unsupportedNames = rejectedFiles.map((file) => file.name);
            if (unsupportedNames.length > 0) {
              const preview = unsupportedNames.slice(0, 3).join(', ');
              const extra = unsupportedNames.length > 3 ? ` and ${unsupportedNames.length - 3} more` : '';
              showToast(`Unsupported file type: ${preview}${extra}`, 'error');
            }
          }}
        />
      </div>

      {/* Document table: its own scroll region (the list virtualizes against it). */}
      <div className="app-docs__list-region">
        <DocumentList
          documents={documents}
          onDelete={electronMode ? undefined : handleDelete}
          deletingId={deletingId}
          onCancelIndexing={electronMode ? undefined : handleCancelIndexing}
        />
      </div>
    </>
  );

  return (
    <div className="app-page">
      {/* Header (Lumen phases 3 and 6): title, the supported-file count, the
          Electron-only two-step Clear all, and Upload (opens the dropzone's own
          file input, so there is still exactly one document file input). */}
      <PageHeader
        title="Documents"
        description={DOCUMENTS_DESCRIPTION}
        actions={
          <>
            {supportedCount > 0 && (
              <Badge>
                {supportedCount} supported file{supportedCount !== 1 ? 's' : ''}
              </Badge>
            )}
            {electronMode && documents.length > 0 && (
              <Button
                size="sm"
                variant={clearAllConfirming ? 'danger' : 'secondary'}
                onClick={handleClearAll}
                aria-label={clearAllConfirming ? 'Confirm clear all documents' : 'Clear all documents'}
              >
                {clearAllConfirming ? 'Click again to clear ALL documents' : 'Clear all'}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const open = openDocumentPickerRef.current;
                if (activeTab === 'documents' && open !== null) {
                  open();
                  return;
                }
                pendingUploadRef.current = true;
                selectTab('documents');
              }}
            >
              <Icon name="upload" size={16} />
              Upload
            </Button>
          </>
        }
      />
      <div className="app-docs">
        {/* F9: one-time re-index notice after an embedding-model upgrade. */}
        {showReindexNotice && (
          <Banner
            tone="info"
            className="app-docs__fixed"
            action={<IconButton icon="x" size="sm" aria-label="Dismiss notice" onClick={dismissReindexNotice} />}
          >
            The search index was upgraded. Re-add your documents to rebuild the index and restore full retrieval quality.
          </Banner>
        )}

        {/* F5: transient duplicate-upload notice. */}
        {duplicateNotice && (
          <Banner tone="info" className="app-docs__fixed">
            {duplicateNotice}
          </Banner>
        )}

        {packClient !== null ? (
          <Tabs
            label="Library sections"
            className="app-docs__tabs"
            value={activeTab}
            onChange={(id) => selectTab(id === 'training' ? 'training' : 'documents')}
            items={[
              { id: 'documents', label: 'Documents', panel: documentsBody },
              {
                id: 'training',
                label: 'Training packs',
                // PacksPanel portals the training-class rows in here.
                panel: <div className="app-docs__training" ref={setTrainingPacksSlot} />,
              },
            ]}
          />
        ) : (
          <div className="app-docs__single">{documentsBody}</div>
        )}

        {/* The pack owner: always mounted (after the tabs, so the DropZone's
            input stays the first file input in DOM order). In place it renders
            only the hidden pack-install-input; its sections portal into the
            mounted tab slot. */}
        {packClient !== null && (
          <PacksPanel
            client={packClient}
            slots={{ knowledge: knowledgePacksSlot, training: trainingPacksSlot }}
            // A training pack that appears (installed here, by the dropzone, or
            // elsewhere in this tab) is shown where it lives.
            onTrainingPackAdded={handleTrainingPackAdded}
            refreshToken={packsRefreshToken}
          />
        )}
      </div>
    </div>
  );
}
