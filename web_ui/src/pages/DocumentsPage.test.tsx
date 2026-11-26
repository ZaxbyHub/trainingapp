/**
 * Tests for DocumentsPage - integration of all components and file processing pipeline
 * (issue #348 quarantine discharge).
 *
 * Harness and mock set adopted from the green sibling
 * DocumentsPage.delete-order.test.tsx: the page pulls native-ESM / heavyweight
 * seams (vector-index -> edgevec, embedding model, chunker, extractor) that
 * cannot run in jsdom, plus the ToastProvider context. Deletion is the
 * two-step inline confirm (Delete <file> -> Confirm delete <file>).
 *
 * The three header count-badge cases that used to live here are covered
 * (still green) by src/pages/__tests__/documents-count-boundaries.test.tsx
 * (singular/plural/zero rows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// vi.hoisted: the vi.mock factories below are hoisted above every const, so
// the shared mock handles must be hoisted with them (the spec keeps static
// imports of the page under test).
const {
  showToastSpy,
  mockEmbeddingService,
  mockVectorIndex,
  mockKeywordIndex,
  mockLoadDocuments,
  mockSaveDocuments,
  mockDeleteDocumentFromStore,
  mockUpsertDocument,
  mockOnDocumentsRemoteChange,
  mockEnsureEmbeddingServiceReady,
} = vi.hoisted(() => {
  const showToastSpy = vi.fn();
  const mockEmbeddingService = {
    isReady: vi.fn(() => true),
    encodeBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(0))),
  };
  const mockVectorIndex = {
    isReady: vi.fn(() => true),
    initialize: vi.fn(async () => {}),
    addBatch: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    removeByDocId: vi.fn(async (_docId: string) => {}),
  };
  const mockKeywordIndex = {
    isReady: vi.fn(() => true),
    addDocuments: vi.fn((_chunks: unknown[]) => {}),
    save: vi.fn(async () => {}),
    removeByDocId: vi.fn(async (_docId: string) => {}),
  };
  const mockLoadDocuments = vi.fn(async () => [] as Array<{ id: string; fileName: string; status: string; uploadedAt: number; progress: number; fileSize: number; fileType: string }>);
  const mockSaveDocuments = vi.fn(async () => {});
  const mockDeleteDocumentFromStore = vi.fn(async () => {});
  const mockUpsertDocument = vi.fn(async () => {});
  const mockOnDocumentsRemoteChange = vi.fn((_cb: () => void) => () => {});
  const mockEnsureEmbeddingServiceReady = vi.fn(async () => true);
  return {
    showToastSpy,
    mockEmbeddingService,
    mockVectorIndex,
    mockKeywordIndex,
    mockLoadDocuments,
    mockSaveDocuments,
    mockDeleteDocumentFromStore,
    mockUpsertDocument,
    mockOnDocumentsRemoteChange,
    mockEnsureEmbeddingServiceReady,
  };
});

vi.mock('../components/ToastProvider', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useToast: () => ({ showToast: showToastSpy }),
}));

vi.mock('../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: () => mockEnsureEmbeddingServiceReady(),
}));
vi.mock('../lib/processing/text-chunker', () => ({
  TextChunker: class TextChunker {
    chunkText(_fullText: string, _fileName: string, _pages?: unknown) {
      return [
        { docId: '', chunkIndex: 0, text: 'This is test document content', pageNumber: 1, startChar: 0, endChar: 35 },
        { docId: '', chunkIndex: 1, text: 'with multiple chunks.', pageNumber: 1, startChar: 36, endChar: 53 },
      ];
    }
  },
}));
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
  upsertDocument: mockUpsertDocument,
  deleteDocument: mockDeleteDocumentFromStore,
  onDocumentsRemoteChange: mockOnDocumentsRemoteChange,
}));
vi.mock('../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn(async () => ({
    fullText: 'This is test document content with multiple chunks.',
    pages: 1,
    metadata: {},
  })),
  SUPPORTED_EXTENSIONS: ['.txt', '.pdf', '.docx'],
}));

// Import DocumentsPage after mocks are set up
import { DocumentsPage } from './DocumentsPage';
import { ToastProvider } from '../components/ToastProvider';
import { extractDocument } from '../lib/processing/extractor-factory';
import type { DocumentEntry } from '../types/document';

function readyDoc(id: string, fileName: string): DocumentEntry {
  return {
    id,
    fileName,
    fileSize: 1024,
    fileType: '.pdf',
    status: 'ready' as const,
    progress: 100,
    uploadedAt: Date.now(),
  };
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <DocumentsPage />
    </ToastProvider>
  );
}

/** Drop a file onto the DropZone (the drag-and-drop upload path). */
function dropFile(fileName: string): void {
  const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
  const file = new File(['content'], fileName, { type: 'application/pdf' });
  fireEvent.drop(dropZone, {
    dataTransfer: { files: [file], items: [{ kind: 'file', getAsFile: () => file }] },
  });
}

/** Wait until the page leaves the loading branch (DropZone mounted). */
async function waitForLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /drop files here or click to select/i })).toBeInTheDocument();
  });
}

/** The two-step inline confirm delete (DocumentList). */
async function confirmDelete(fileName: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: `Delete ${fileName}` }));
  const confirmButton = await screen.findByRole('button', { name: `Confirm delete ${fileName}` });
  await act(async () => {
    fireEvent.click(confirmButton);
  });
}

describe('DocumentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    // Re-prime defaults: clearAllMocks keeps implementations, so a
    // never-resolving loadDocuments (loading-state test) or a gated
    // extractDocument (processing test) must not leak into later suites.
    mockLoadDocuments.mockImplementation(async () => []);
    vi.mocked(extractDocument).mockImplementation(async () => ({
      fullText: 'This is test document content with multiple chunks.',
      pages: [{ pageNumber: 1, text: 'This is test document content with multiple chunks.' }],
      metadata: { fileName: 'test.pdf', pageCount: 1, fileSize: 1024, extractedAt: 0 },
    }));
    mockSaveDocuments.mockImplementation(async () => {});
    mockDeleteDocumentFromStore.mockImplementation(async () => {});
    mockEnsureEmbeddingServiceReady.mockResolvedValue(true);
    mockEmbeddingService.isReady.mockReturnValue(true);
    mockVectorIndex.isReady.mockReturnValue(true);
    mockKeywordIndex.isReady.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Initial Loading', () => {
    it('shows loading state while fetching documents', () => {
      mockLoadDocuments.mockImplementation(() => new Promise(() => {})); // Never resolves

      renderPage();

      // Loading branch: the status region replaces the old
      // "Loading documents..." text.
      expect(screen.getByRole('status', { name: 'Loading documents' })).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });

    it('loads documents from IndexedDB on mount', async () => {
      renderPage();

      await waitFor(() => {
        expect(mockLoadDocuments).toHaveBeenCalled();
      });
    });

    it('renders DropZone after loading', async () => {
      renderPage();

      await waitForLoaded();
    });

    it('renders DocumentList after loading', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no documents uploaded yet/i)).toBeInTheDocument();
      });
    });
  });

  describe('Header', () => {
    it('displays Documents heading', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
      });
    });
  });

  describe('File Processing Pipeline', () => {
    it('adds new document when files are selected', async () => {
      renderPage();
      await waitForLoaded();

      dropFile('new-doc.pdf');

      await waitFor(() => {
        expect(screen.getByText('new-doc.pdf')).toBeInTheDocument();
      });
    });

    it('updates status to processing after extraction starts', async () => {
      // Hold extraction open so the Processing status is observable, not a
      // microtask-blip between mocked stages.
      let releaseExtraction!: (value: Awaited<ReturnType<typeof extractDocument>>) => void;
      vi.mocked(extractDocument).mockImplementation(
        () => new Promise((resolve) => { releaseExtraction = resolve; })
      );

      renderPage();
      await waitForLoaded();

      dropFile('processing-doc.pdf');

      await waitFor(() => {
        expect(screen.getByText(/processing\.\.\./i)).toBeInTheDocument();
      });
      releaseExtraction({
        fullText: 'test content',
        pages: [{ pageNumber: 1, text: 'test content' }],
        metadata: { fileName: 'processing-doc.pdf', pageCount: 1, fileSize: 12, extractedAt: 0 },
      });
      await waitFor(() => {
        expect(screen.getByText('processing-doc.pdf')).toBeInTheDocument();
      });
    });

    it('sets status to ready after successful processing', async () => {
      renderPage();
      await waitForLoaded();

      dropFile('ready-doc.pdf');

      await waitFor(() => {
        expect(screen.getByText('Ready')).toBeInTheDocument();
      }, { timeout: 5000 });
    });

    it('sets status to error when extraction fails', async () => {
      vi.mocked(extractDocument).mockRejectedValue(new Error('Extraction failed'));

      renderPage();
      await waitForLoaded();

      dropFile('error-doc.pdf');

      await waitFor(() => {
        expect(screen.getByText('Error')).toBeInTheDocument();
      }, { timeout: 5000 });
    });

    it('saves documents to IndexedDB after processing', async () => {
      renderPage();
      await waitForLoaded();

      dropFile('save-test.pdf');

      // Wait for the 500ms debounced bulk save (the terminal row is also
      // persisted per-document through upsertDocument).
      await waitFor(() => {
        expect(mockSaveDocuments).toHaveBeenCalled();
      }, { timeout: 5000 });
    });
  });

  describe('Document Deletion', () => {
    it('deletes document when delete button is clicked', async () => {
      mockLoadDocuments.mockResolvedValue([readyDoc('doc-to-delete', 'delete-me.pdf')]);

      renderPage();
      await waitFor(() => {
        expect(screen.getByText('delete-me.pdf')).toBeInTheDocument();
      });

      await confirmDelete('delete-me.pdf');

      await waitFor(() => {
        expect(mockDeleteDocumentFromStore).toHaveBeenCalledWith('doc-to-delete');
      });
    });

    it('removes document from UI after deletion', async () => {
      mockLoadDocuments.mockResolvedValue([readyDoc('doc-to-delete', 'delete-me.pdf')]);

      renderPage();
      await waitFor(() => {
        expect(screen.getByText('delete-me.pdf')).toBeInTheDocument();
      });

      await confirmDelete('delete-me.pdf');

      await waitFor(() => {
        expect(screen.queryByText('delete-me.pdf')).not.toBeInTheDocument();
      });
    });

    it('shows empty state when last document is deleted', async () => {
      mockLoadDocuments.mockResolvedValue([readyDoc('doc-to-delete', 'last-doc.pdf')]);

      renderPage();
      await waitFor(() => {
        expect(screen.getByText('last-doc.pdf')).toBeInTheDocument();
      });

      await confirmDelete('last-doc.pdf');

      await waitFor(() => {
        expect(screen.getByText(/no documents uploaded yet/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('handles loadDocuments error gracefully', async () => {
      mockLoadDocuments.mockRejectedValue(new Error('Failed to load'));

      renderPage();

      // Should still render DropZone and DocumentList even on load error
      await waitForLoaded();
      expect(screen.getByText(/no documents uploaded yet/i)).toBeInTheDocument();
    });

    it('handles saveDocuments error gracefully', async () => {
      mockLoadDocuments.mockResolvedValue([readyDoc('doc-1', 'doc1.pdf')]);
      mockSaveDocuments.mockRejectedValue(new Error('Failed to save'));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('doc1.pdf')).toBeInTheDocument();
      });

      // Should not throw - errors are caught and logged (surfaced as a
      // toast through the mocked provider).
      await waitFor(() => {
        expect(showToastSpy.mock.calls.some(([, type]) => type === 'error')).toBe(true);
      });
    });
  });
});
