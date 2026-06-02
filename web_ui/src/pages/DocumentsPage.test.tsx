/**
 * Tests for DocumentsPage - integration of all components and file processing pipeline
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock dependencies BEFORE importing DocumentsPage
vi.mock('../lib/storage/document-store', () => ({
  loadDocuments: vi.fn().mockResolvedValue([]),
  saveDocuments: vi.fn().mockResolvedValue(undefined),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn().mockResolvedValue({
    fullText: 'This is extracted text content',
    pages: [{ pageNumber: 1, text: 'This is extracted text content' }],
  }),
  SUPPORTED_EXTENSIONS: ['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md'],
}));

// Import DocumentsPage after mocks are set up
import { DocumentsPage } from './DocumentsPage';
import * as documentStore from '../lib/storage/document-store';
import * as extractorFactory from '../lib/processing/extractor-factory';

describe('DocumentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Initial Loading', () => {
    it('shows loading state while fetching documents', async () => {
      (documentStore.loadDocuments as any).mockImplementation(() => new Promise(() => {})); // Never resolves

      render(<DocumentsPage />);

      expect(screen.getByText(/loading documents\.\.\./i)).toBeInTheDocument();
    });

    it('loads documents from IndexedDB on mount', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(documentStore.loadDocuments).toHaveBeenCalled();
      });
    });

    it('renders DropZone after loading', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /drop files here or click to select/i })).toBeInTheDocument();
      });
    });

    it('renders DocumentList after loading', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByText(/no documents uploaded yet/i)).toBeInTheDocument();
      });
    });
  });

  describe('Header', () => {
    it('displays Documents heading', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /documents/i })).toBeInTheDocument();
      });
    });

    it('shows supported file count badge when documents exist', async () => {
      const docs = [{
        id: 'doc-1',
        fileName: 'test.pdf',
        fileSize: 1024,
        fileType: '.pdf',
        status: 'ready' as const,
        progress: 100,
        uploadedAt: Date.now(),
      }];
      (documentStore.loadDocuments as any).mockResolvedValue(docs);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByText(/1 supported file/i)).toBeInTheDocument();
      });
    });

    it('shows plural form for multiple files', async () => {
      const docs = [
        { id: 'doc-1', fileName: 'test1.pdf', fileSize: 1024, fileType: '.pdf', status: 'ready' as const, progress: 100, uploadedAt: Date.now() },
        { id: 'doc-2', fileName: 'test2.pdf', fileSize: 1024, fileType: '.pdf', status: 'ready' as const, progress: 100, uploadedAt: Date.now() },
      ];
      (documentStore.loadDocuments as any).mockResolvedValue(docs);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByText(/2 supported files/i)).toBeInTheDocument();
      });
    });

    it('does not show badge when no supported documents', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.queryByText(/supported file/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('File Processing Pipeline', () => {
    it('adds new document when files are selected', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (extractorFactory.extractDocument as any).mockResolvedValue({
        fullText: 'test content',
        pages: [],
      });

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.queryByText(/no documents uploaded yet/i)).toBeInTheDocument();
      });

      // Simulate file selection via DropZone
      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });

      const mockFile = new File(['content'], 'new-doc.pdf', { type: 'application/pdf' });
      const mockDataTransfer = {
        files: [mockFile],
        items: [{ kind: 'file', getAsFile: () => mockFile }],
      };

      fireEvent.drop(dropZone, { dataTransfer: mockDataTransfer });

      await waitFor(() => {
        expect(screen.getByText('new-doc.pdf')).toBeInTheDocument();
      });
    });

    it('updates status to processing after extraction starts', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (extractorFactory.extractDocument as any).mockResolvedValue({
        fullText: 'test content',
        pages: [],
      });

      render(<DocumentsPage />);

      await waitFor(() => {});

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      const mockFile = new File(['content'], 'processing-doc.pdf', { type: 'application/pdf' });

      fireEvent.drop(dropZone, { dataTransfer: { files: [mockFile], items: [{ kind: 'file', getAsFile: () => mockFile }] } });

      await waitFor(() => {
        expect(screen.getByText(/processing\.\.\./i)).toBeInTheDocument();
      });
    });

    it('sets status to ready after successful processing', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (extractorFactory.extractDocument as any).mockResolvedValue({
        fullText: 'This is the extracted text content',
        pages: [{ pageNumber: 1, text: 'This is the extracted text content' }],
      });

      render(<DocumentsPage />);

      await waitFor(() => {});

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      const mockFile = new File(['content'], 'ready-doc.pdf', { type: 'application/pdf' });

      fireEvent.drop(dropZone, { dataTransfer: { files: [mockFile], items: [{ kind: 'file', getAsFile: () => mockFile }] } });

      await waitFor(() => {
        expect(screen.getByText(/ready/i)).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('sets status to error when extraction fails', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (extractorFactory.extractDocument as any).mockRejectedValue(new Error('Extraction failed'));

      render(<DocumentsPage />);

      await waitFor(() => {});

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      const mockFile = new File(['content'], 'error-doc.pdf', { type: 'application/pdf' });

      fireEvent.drop(dropZone, { dataTransfer: { files: [mockFile], items: [{ kind: 'file', getAsFile: () => mockFile }] } });

      await waitFor(() => {
        expect(screen.getByText(/error/i)).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('saves documents to IndexedDB after processing', async () => {
      (documentStore.loadDocuments as any).mockResolvedValue([]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (extractorFactory.extractDocument as any).mockResolvedValue({ fullText: 'test', pages: [] });

      render(<DocumentsPage />);

      await waitFor(() => {});

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      const mockFile = new File(['content'], 'save-test.pdf', { type: 'application/pdf' });

      fireEvent.drop(dropZone, { dataTransfer: { files: [mockFile], items: [{ kind: 'file', getAsFile: () => mockFile }] } });

      // Wait for debounced save
      await waitFor(() => {
        expect(documentStore.saveDocuments).toHaveBeenCalled();
      }, { timeout: 3000 });
    });
  });

  describe('Document Deletion', () => {
    it('deletes document when delete button is clicked', async () => {
      const docs = [{
        id: 'doc-to-delete',
        fileName: 'delete-me.pdf',
        fileSize: 1024,
        fileType: '.pdf',
        status: 'ready' as const,
        progress: 100,
        uploadedAt: Date.now(),
      }];
      (documentStore.loadDocuments as any).mockResolvedValue(docs);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (documentStore.deleteDocument as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByText('delete-me.pdf')).toBeInTheDocument();
      });

      const deleteButton = screen.getByRole('button', { name: /delete delete-me\.pdf/i });
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(documentStore.deleteDocument).toHaveBeenCalledWith('doc-to-delete');
      });
    });

    it('removes document from UI after deletion', async () => {
      const docs = [{
        id: 'doc-to-delete',
        fileName: 'delete-me.pdf',
        fileSize: 1024,
        fileType: '.pdf',
        status: 'ready' as const,
        progress: 100,
        uploadedAt: Date.now(),
      }];
      (documentStore.loadDocuments as any).mockResolvedValue([...docs]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (documentStore.deleteDocument as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByText('delete-me.pdf')).toBeInTheDocument();
      });

      const deleteButton = screen.getByRole('button', { name: /delete delete-me\.pdf/i });
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(screen.queryByText('delete-me.pdf')).not.toBeInTheDocument();
      });
    });

    it('shows empty state when last document is deleted', async () => {
      const docs = [{
        id: 'doc-to-delete',
        fileName: 'last-doc.pdf',
        fileSize: 1024,
        fileType: '.pdf',
        status: 'ready' as const,
        progress: 100,
        uploadedAt: Date.now(),
      }];
      (documentStore.loadDocuments as any).mockResolvedValue([...docs]);
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);
      (documentStore.deleteDocument as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        expect(screen.getByText('last-doc.pdf')).toBeInTheDocument();
      });

      const deleteButton = screen.getByRole('button', { name: /delete last-doc\.pdf/i });
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByText(/no documents uploaded yet/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('handles loadDocuments error gracefully', async () => {
      (documentStore.loadDocuments as any).mockRejectedValue(new Error('Failed to load'));
      (documentStore.saveDocuments as any).mockResolvedValue(undefined);

      render(<DocumentsPage />);

      await waitFor(() => {
        // Should still render DropZone and DocumentList even on load error
        expect(screen.getByRole('button', { name: /drop files here or click to select/i })).toBeInTheDocument();
      });
    });

    it('handles saveDocuments error gracefully', async () => {
      const docs = [{
        id: 'doc-1',
        fileName: 'doc1.pdf',
        fileSize: 1024,
        fileType: '.pdf',
        status: 'ready' as const,
        progress: 100,
        uploadedAt: Date.now(),
      }];
      (documentStore.loadDocuments as any).mockResolvedValue(docs);
      (documentStore.saveDocuments as any).mockRejectedValue(new Error('Failed to save'));

      render(<DocumentsPage />);

      await waitFor(() => {});

      // Should not throw - errors are caught and logged
      expect(screen.getByText('doc1.pdf')).toBeInTheDocument();
    });
  });
});
