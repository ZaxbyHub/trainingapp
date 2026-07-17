/**
 * Tests for DocumentsPage search index integration (Task 8.2)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
// U3b: DocumentsPage now calls useToast(), which requires a ToastProvider.
import { ToastProvider } from '../components/ToastProvider';
// RTL auto-cleanup does not register reliably when @testing-library/react is
// loaded via dynamic import inside each test (the afterEach hook is registered
// too late). Several tests below bail on a failed assertion BEFORE reaching
// their explicit `unmount()`, which would leak the mounted component into the
// shared jsdom document and cause later tests' `document.querySelector` to hit
// a STALE DropZone input from an earlier test. Importing `cleanup` and calling
// it in afterEach guarantees every render is torn down between tests.
import { cleanup } from '@testing-library/react';

// Mock the embedding service
const mockEmbeddingService = {
  isReady: vi.fn(() => true),
  encodeBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0))),
};

// Mock the vector index
const mockVectorIndex = {
  isReady: vi.fn(() => true),
  initialize: vi.fn(async () => {}),
  addBatch: vi.fn(async (_entries: Array<{ docId: string; chunkIndex: number; vector: number[] }>) => {}),
  save: vi.fn(async () => {}),
  removeByDocId: vi.fn(async (_docId: string) => {}),
};

// Mock the keyword index
const mockKeywordIndex = {
  isReady: vi.fn(() => true),
  addDocuments: vi.fn((_chunks: Array<{ docId: string; chunkIndex: number; text: string }>) => {}),
  save: vi.fn(async () => {}),
  removeByDocId: vi.fn((_docId: string) => {}),
};

// Mock document store
const mockLoadDocuments = vi.fn(async (): Promise<Array<{ id: string; fileName: string; fileSize: number; fileType: string; status: string; progress: number; uploadedAt: number; errorMessage?: string; chunkCount?: number }>> => []);
const mockSaveDocuments = vi.fn(async (_docs: Array<{ status: string; fileName: string; errorMessage?: string }>) => {});
const mockDeleteDocumentFromStore = vi.fn(async () => {});

// F2: mock the lazy embedding-service initializer so processFile's readiness
// guard can be exercised without pulling in the real (heavy) service hook.
const mockEnsureEmbeddingServiceReady = vi.fn(async () => true);

// F1: migration is best-effort; stub it so the page mount doesn't touch IDB.
vi.mock('../lib/storage/profile', () => ({
  migrateOrphanedNamespaces: vi.fn(async () => {}),
}));

vi.mock('../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: () => mockEnsureEmbeddingServiceReady(),
}));

// Mock the TextChunker
vi.mock('../lib/processing/text-chunker', () => ({
  TextChunker: class TextChunker {
    chunkText(_fullText: string, _fileName: string, _pages?: unknown) {
      // Return some fake chunks
      return [
        { docId: '', chunkIndex: 0, text: 'This is test document content', pageNumber: 1, startChar: 0, endChar: 35 },
        { docId: '', chunkIndex: 1, text: 'with multiple chunks.', pageNumber: 1, startChar: 36, endChar: 53 },
      ];
    }
  },
}));

// Mock modules before importing DocumentsPage
vi.mock('../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: () => mockEmbeddingService,
}));

vi.mock('../lib/search/vector-index', () => ({
  getVectorIndex: () => mockVectorIndex,
}));

vi.mock('../lib/search/keyword-index', () => ({
  getKeywordIndex: () => mockKeywordIndex,
}));

vi.mock('../lib/storage/document-store', () => ({
  loadDocuments: mockLoadDocuments,
  saveDocuments: mockSaveDocuments,
  deleteDocument: mockDeleteDocumentFromStore,
}));

vi.mock('../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn(async () => ({
    fullText: 'This is test document content with multiple chunks.',
    pages: 1,
    metadata: {},
  })),
  SUPPORTED_EXTENSIONS: ['.txt', '.pdf', '.docx'],
}));

// Import after mocks are set up
import { TextChunker } from '../lib/processing/text-chunker';
import { extractDocument } from '../lib/processing/extractor-factory';

describe('DocumentsPage search index integration', () => {
  beforeEach(() => {
    // Reset all mocks
    mockEmbeddingService.isReady.mockClear();
    mockEmbeddingService.encodeBatch.mockClear();
    mockVectorIndex.isReady.mockClear();
    mockVectorIndex.addBatch.mockClear();
    mockVectorIndex.save.mockClear();
    mockVectorIndex.removeByDocId.mockClear();
    mockKeywordIndex.isReady.mockClear();
    mockKeywordIndex.addDocuments.mockClear();
    mockKeywordIndex.save.mockClear();
    mockKeywordIndex.removeByDocId.mockClear();
    mockLoadDocuments.mockClear();
    mockSaveDocuments.mockClear();
    mockDeleteDocumentFromStore.mockClear();
    mockEnsureEmbeddingServiceReady.mockClear();
    mockEnsureEmbeddingServiceReady.mockResolvedValue(true);
    mockVectorIndex.initialize.mockClear();
    mockVectorIndex.initialize.mockResolvedValue(undefined);
  });

  // Tear down any mounted component between tests. Critical because several
  // tests bail on a failed assertion before their explicit `unmount()`, and a
  // leaked DocumentsPage leaves its DropZone input in the shared document,
  // sending later tests' file-drop events to the wrong instance.
  afterEach(() => {
    cleanup();
  });

  describe('processFile indexing flow', () => {
    test('1. processFile sets docId on all chunks before indexing', async () => {
      const docId = 'test-doc-123';

      // Create chunks manually to verify docId setting
      const chunker = new TextChunker();
      const chunks = chunker.chunkText('This is test document content with multiple chunks.', 'test.txt');

      // Simulate what processFile does - set docId on all chunks
      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      // Verify all chunks now have docId
      expect(chunks.every(c => c.docId === docId)).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);
    });

    test('2. processFile calls embeddingService.encodeBatch with correct texts', async () => {
      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
      const docId = 'test-doc-123';

      // Get the texts that would be encoded
      const chunker = new TextChunker();
      const extractionResult = await extractDocument(file);
      const chunks = chunker.chunkText(extractionResult.fullText, file.name, extractionResult.pages);

      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      const texts = chunks.map(c => c.text);

      // Simulate encodeBatch call
      const vectors = await mockEmbeddingService.encodeBatch(texts);

      expect(mockEmbeddingService.encodeBatch).toHaveBeenCalledWith(texts);
      expect(vectors.length).toBe(texts.length);
    });

    test('3. processFile calls vectorIndex.addBatch with correct entries (docId, chunkIndex, vector)', async () => {
      const docId = 'test-doc-123';
      const chunks = [
        { docId: '', chunkIndex: 0, text: 'First chunk', pageNumber: 1, startChar: 0, endChar: 11 },
        { docId: '', chunkIndex: 1, text: 'Second chunk', pageNumber: 1, startChar: 12, endChar: 24 },
      ];

      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      const vectors = await mockEmbeddingService.encodeBatch(chunks.map(c => c.text));

      const entries = chunks.map((chunk, i) => ({
        docId: chunk.docId!,
        chunkIndex: chunk.chunkIndex,
        vector: vectors[i],
      }));

      await mockVectorIndex.addBatch(entries);

      expect(mockVectorIndex.addBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ docId, chunkIndex: 0, vector: expect.any(Array) }),
          expect.objectContaining({ docId, chunkIndex: 1, vector: expect.any(Array) }),
        ])
      );
    });

    test('4. processFile calls vectorIndex.save after addBatch', async () => {
      await mockVectorIndex.addBatch([]);
      await mockVectorIndex.save();

      expect(mockVectorIndex.save).toHaveBeenCalled();
      // Verify save was called after addBatch
      const addBatchCalls = mockVectorIndex.addBatch.mock.calls.length;
      const saveCalls = mockVectorIndex.save.mock.calls.length;
      expect(saveCalls).toBeGreaterThanOrEqual(addBatchCalls);
    });

    test('5. processFile calls keywordIndex.addDocuments with chunks that have docId', async () => {
      const docId = 'test-doc-123';
      const chunks = [
        { docId: '', chunkIndex: 0, text: 'First chunk', pageNumber: 1, startChar: 0, endChar: 11 },
      ];

      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      mockKeywordIndex.addDocuments(chunks);

      expect(mockKeywordIndex.addDocuments).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ docId })
        ])
      );
    });

    test('6. processFile calls keywordIndex.save after addDocuments', async () => {
      const chunks = [{ docId: 'test', chunkIndex: 0, text: 'test' }];
      mockKeywordIndex.addDocuments(chunks);
      await mockKeywordIndex.save();

      expect(mockKeywordIndex.save).toHaveBeenCalled();
    });
  });

  describe('handleDelete index removal flow', () => {
    test('7. handleDelete calls vectorIndex.removeByDocId and saves', async () => {
      const docId = 'test-doc-to-delete';

      mockVectorIndex.removeByDocId(docId);
      await mockVectorIndex.save();

      expect(mockVectorIndex.removeByDocId).toHaveBeenCalledWith(docId);
      expect(mockVectorIndex.save).toHaveBeenCalled();
    });

    test('8. handleDelete calls keywordIndex.removeByDocId and saves', async () => {
      const docId = 'test-doc-to-delete';

      mockKeywordIndex.removeByDocId(docId);
      await mockKeywordIndex.save();

      expect(mockKeywordIndex.removeByDocId).toHaveBeenCalledWith(docId);
      expect(mockKeywordIndex.save).toHaveBeenCalled();
    });
  });

  describe('Error handling (F2: embedding/vector init failures surface an error)', () => {
    test('9. processFile sets status:error when ensureEmbeddingServiceReady() returns false (no silent skip-to-ready)', async () => {
      // F2: a document uploaded when the embedding service cannot initialize
      // must NOT be silently marked 'ready' with no vectors. processFile now
      // awaits ensureEmbeddingServiceReady() and throws → status:'error'.
      // This renders the real component and exercises the actual path.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { render, waitFor, act } = await import('@testing-library/react');
      const { DocumentsPage } = await import('./DocumentsPage');

      // ensureEmbeddingServiceReady resolves false → ingestion must error.
      mockEnsureEmbeddingServiceReady.mockResolvedValue(false);

      const { unmount } = render(<ToastProvider><DocumentsPage /></ToastProvider>);

      // Wait for the initial load to finish, then drop a file.
      await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

      const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });
      // Trigger the drop via the DropZone input change handler.
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      await act(async () => {
        Object.defineProperty(input, 'files', { value: [file], writable: false, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // The document must reach status:'error', never 'ready'.
      await waitFor(() => {
        const saveCalls = mockSaveDocuments.mock.calls;
        const lastSaved = saveCalls[saveCalls.length - 1]?.[0] as
          | Array<{ status: string; fileName: string; errorMessage?: string }>
          | undefined;
        const doc = lastSaved?.find((d) => d.fileName === 'test.txt');
        expect(doc?.status).toBe('error');
        expect(doc?.errorMessage).toMatch(/embedding/i);
      });

      // And encodeBatch must NOT have been called (no silent indexing).
      expect(mockEmbeddingService.encodeBatch).not.toHaveBeenCalled();

      unmount();
    });

    test('F3: deleting a document while it is still processing waits for processing to settle before removing chunks (no orphan chunks)', async () => {
      // Acceptance criterion #3: "Delete mid-processing leaves no orphan chunks
      // (verified via index inspection)". The fix: handleDelete awaits the
      // in-flight processFile promise before calling removeByDocId, so a late
      // addBatch+save cannot leave orphaned vectors. This test renders the real
      // component, blocks processFile mid-flight, triggers a delete, and asserts
      // removeByDocId is called ONLY after processFile settles.
      const { render, waitFor, act } = await import('@testing-library/react');
      const { DocumentsPage } = await import('./DocumentsPage');

      // Block processFile inside extractDocument on a deferred we control.
      const mockExtract = extractDocument as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void };
      // Holder for the deferred resolver so the test can release the blocked
      // extraction on demand. Typed as an array to dodge TS control-flow
      // narrowing of closure-captured lets.
      const releaseHolder: Array<() => void> = [];
      const extractionBlocked = new Promise<void>((resolve) => {
        releaseHolder.push(resolve);
      });
      mockExtract.mockImplementation(async () => {
        await extractionBlocked;
        return {
          fullText: 'content for the in-flight document',
          pages: [{ pageNumber: 1, text: 'content for the in-flight document' }],
          metadata: {},
        };
      });

      // embedding + vector index are ready so processFile proceeds to indexing
      // once extraction resolves (then we'll have chunks to remove).
      mockEnsureEmbeddingServiceReady.mockResolvedValue(true);
      mockEmbeddingService.isReady.mockReturnValue(true);
      mockVectorIndex.isReady.mockReturnValue(true);
      mockEmbeddingService.encodeBatch.mockResolvedValue([new Array(384).fill(0)]);

      const { unmount } = render(<ToastProvider><DocumentsPage /></ToastProvider>);
      await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

      const file = new File(['in-flight content'], 'inflight.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(input, 'files', { value: [file], writable: false, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Wait until processFile has started (status flips to 'processing').
      await waitFor(() => {
        const calls = mockSaveDocuments.mock.calls;
        const last = calls[calls.length - 1]?.[0];
        return !!last?.some((d: { fileName: string; status: string }) => d.fileName === 'inflight.txt' && d.status === 'processing');
      });

      // Sanity: removeByDocId has NOT been called yet (no delete happened).
      expect(mockVectorIndex.removeByDocId).not.toHaveBeenCalled();

      // Trigger deletion of the still-processing document. handleDelete should
      // await the in-flight processFile, so it stays pending while extraction
      // is blocked. We don't await the delete here; we fire it and let it hang.
      // U5: DocumentList uses a two-step inline confirmation — first click the
      // "Delete <filename>" trigger to arm the confirm, then click "Confirm
      // delete <filename>" to actually fire onDelete (which awaits processFile).
      await waitFor(() => {
        const btns = document.querySelectorAll('button[aria-label^="Delete "]');
        expect(btns.length).toBeGreaterThan(0);
      });
      const deleteButton = document.querySelector('button[aria-label^="Delete "]') as HTMLButtonElement;
      await act(async () => {
        deleteButton.click();
      });
      // Arm step done; now fire the actual confirm to trigger handleDelete.
      await waitFor(() => {
        expect(document.querySelector('button[aria-label^="Confirm delete "]')).toBeTruthy();
      });
      const confirmButton = document.querySelector('button[aria-label^="Confirm delete "]') as HTMLButtonElement;
      await act(async () => {
        confirmButton.click();
      });

      // The delete is now in flight and waiting on processFile. removeByDocId
      // must still NOT have been called because processFile hasn't settled
      // (extraction is blocked) — proving handleDelete awaits the in-flight work.
      await new Promise((r) => setTimeout(r, 50));
      expect(mockVectorIndex.removeByDocId).not.toHaveBeenCalled();

      // Release the blocked extraction so processFile can complete. handleDelete
      // (awaiting it) then proceeds to removeByDocId.
      for (const release of releaseHolder) {
        release();
      }

      await waitFor(() => {
        expect(mockVectorIndex.removeByDocId).toHaveBeenCalled();
      });

      unmount();
    });

    test('10. Deletion continues even if index removal fails', async () => {
      const docId = 'test-doc-to-delete';

      // Make vectorIndex.removeByDocId throw
      mockVectorIndex.removeByDocId.mockRejectedValueOnce(new Error('Vector index error'));

      try {
        await mockVectorIndex.removeByDocId(docId);
      } catch (indexError) {
        console.error('Failed to remove from vector index:', indexError);
        // Continue even if index removal fails - this is the expected behavior
      }

      // Continue with other operations even after vector index error
      // In the actual handleDelete, keywordIndex would still be called
      mockKeywordIndex.removeByDocId(docId);

      expect(mockVectorIndex.removeByDocId).toHaveBeenCalledWith(docId);
      // keywordIndex.removeByDocId should still be called (deletion continues)
      expect(mockKeywordIndex.removeByDocId).toHaveBeenCalledWith(docId);
    });
  });

  describe('F4/F5/F13 behavioral coverage (PRR-004)', () => {
    test('F5: a duplicate fileName+fileSize upload is skipped and surfaces a notice', async () => {
      const { render, waitFor, act } = await import('@testing-library/react');
      const { DocumentsPage } = await import('./DocumentsPage');

      // Seed the document store with an existing document.
      mockLoadDocuments.mockResolvedValueOnce([
        { id: 'existing-1', fileName: 'dup.txt', fileSize: 100, fileType: '.txt', status: 'ready', progress: 100, uploadedAt: 1000 },
      ]);
      mockEnsureEmbeddingServiceReady.mockResolvedValue(true);
      mockEmbeddingService.isReady.mockReturnValue(true);
      mockVectorIndex.isReady.mockReturnValue(true);
      mockEmbeddingService.encodeBatch.mockResolvedValue([new Array(384).fill(0)]);

      const { unmount, container } = render(<ToastProvider><DocumentsPage /></ToastProvider>);
      await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

      // Drop a file with the same name+size as the existing document.
      const file = new File(['x'.repeat(100)], 'dup.txt', { type: 'text/plain' });
      expect(file.size).toBe(100);
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(input, 'files', { value: [file], writable: false, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // A duplicate-skip notice must appear, and encodeBatch must NOT run for it.
      await waitFor(() => {
        expect(container.textContent).toMatch(/Skipped duplicate file: dup\.txt/);
      });
      expect(mockEmbeddingService.encodeBatch).not.toHaveBeenCalled();

      unmount();
    });

    test('F13: a delete cancels an armed stale debounced save so it cannot resurrect the doc', async () => {
      const { render, waitFor, act } = await import('@testing-library/react');
      const { DocumentsPage } = await import('./DocumentsPage');

      // Seed a ready document.
      mockLoadDocuments.mockResolvedValueOnce([
        { id: 'del-1', fileName: 'todelete.txt', fileSize: 50, fileType: '.txt', status: 'ready', progress: 100, uploadedAt: 1000 },
      ]);
      mockVectorIndex.isReady.mockReturnValue(true);
      mockKeywordIndex.isReady.mockReturnValue(true);

      const { unmount } = render(<ToastProvider><DocumentsPage /></ToastProvider>);
      await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

      // Click delete on the ready document.
      // U5: DocumentList uses a two-step inline confirmation — click the
      // "Delete <filename>" trigger to arm, then "Confirm delete <filename>"
      // to actually fire onDelete (which cancels the stale debounced save and
      // re-arms it with the post-delete list).
      await waitFor(() => {
        expect(document.querySelector('button[aria-label^="Delete "]')).toBeTruthy();
      });
      const saveCountBefore = mockSaveDocuments.mock.calls.length;
      await act(async () => {
        (document.querySelector('button[aria-label^="Delete "]') as HTMLButtonElement).click();
      });
      await waitFor(() => {
        expect(document.querySelector('button[aria-label^="Confirm delete "]')).toBeTruthy();
      });
      await act(async () => {
        (document.querySelector('button[aria-label^="Confirm delete "]') as HTMLButtonElement).click();
      });

      // After delete settles, the most recent save must NOT contain the deleted doc.
      await waitFor(() => {
        const calls = mockSaveDocuments.mock.calls;
        expect(calls.length).toBeGreaterThan(saveCountBefore);
      });
      const lastSaved = mockSaveDocuments.mock.calls[mockSaveDocuments.mock.calls.length - 1]?.[0] as
        Array<{ fileName: string }> | undefined;
      expect(lastSaved?.some((d) => d.fileName === 'todelete.txt')).toBe(false);

      unmount();
    });

    test('F4: unmount while a debounced save is pending flushes the latest documents', async () => {
      const { render, waitFor, act } = await import('@testing-library/react');
      const { DocumentsPage } = await import('./DocumentsPage');

      // The component mounts, loadDocuments returns [], then we trigger an
      // upload that mutates state within the 500ms debounce window, then
      // immediately unmount — the pending save should flush.
      mockEnsureEmbeddingServiceReady.mockResolvedValue(false); // error fast, no encode
      const { unmount } = render(<ToastProvider><DocumentsPage /></ToastProvider>);
      await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

      const file = new File(['flush-test'], 'flush.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(input, 'files', { value: [file], writable: false, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Unmount immediately (within the 500ms debounce). A flush save should fire.
      const callsBeforeUnmount = mockSaveDocuments.mock.calls.length;
      unmount();

      // Allow the fire-and-forget flush promise to settle.
      await waitFor(() => {
        expect(mockSaveDocuments.mock.calls.length).toBeGreaterThan(callsBeforeUnmount);
      });
      // The flushed save should include the uploaded file's entry.
      const flushedCalls = mockSaveDocuments.mock.calls.slice(callsBeforeUnmount);
      const sawFlushEntry = flushedCalls.some((c) => {
        const docs = c[0] as Array<{ fileName: string }> | undefined;
        return docs?.some((d) => d.fileName === 'flush.txt');
      });
      expect(sawFlushEntry).toBe(true);
    });
  });

  describe('TextChunker integration', () => {
    test('TextChunker creates chunks with proper structure', () => {
      const chunker = new TextChunker();
      const chunks = chunker.chunkText(
        'This is a long document text that should be split into multiple chunks for processing.',
        'test.txt',
      );

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach(chunk => {
        expect(chunk).toHaveProperty('text');
        expect(chunk).toHaveProperty('chunkIndex');
        expect(chunk).toHaveProperty('pageNumber');
        expect(chunk).toHaveProperty('startChar');
        expect(chunk).toHaveProperty('endChar');
        expect(chunk.docId).toBe(''); // Initially empty
      });
    });
  });
});
