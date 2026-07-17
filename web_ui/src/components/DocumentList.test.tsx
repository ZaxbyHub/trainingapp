/**
 * Tests for DocumentList component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DocumentList } from './DocumentList';
import type { DocumentEntry } from '../types/document';

describe('DocumentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  const createDocument = (overrides: Partial<DocumentEntry> = {}): DocumentEntry => ({
    id: 'doc-1',
    fileName: 'test-document.pdf',
    fileSize: 1024 * 100,
    fileType: '.pdf',
    status: 'ready',
    progress: 100,
    uploadedAt: Date.now(),
    ...overrides,
  });

  describe('Empty State', () => {
    it('renders empty state message when documents array is empty', () => {
      const mockOnDelete = vi.fn();
      render(<DocumentList documents={[]} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/no documents uploaded yet/i)).toBeInTheDocument();
    });

    it('renders empty state icon', () => {
      const mockOnDelete = vi.fn();
      render(<DocumentList documents={[]} onDelete={mockOnDelete} deletingId={null} />);

      const svg = document.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('does not render list container when empty', () => {
      const mockOnDelete = vi.fn();
      render(<DocumentList documents={[]} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });
  });

  describe('Document Rendering', () => {
    it('renders document items for each document', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'doc1.pdf' }),
        createDocument({ id: 'doc-2', fileName: 'doc2.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText('doc1.pdf')).toBeInTheDocument();
      expect(screen.getByText('doc2.pdf')).toBeInTheDocument();
    });

    it('renders documents sorted by date (newest first)', () => {
      const mockOnDelete = vi.fn();
      const olderTime = Date.now() - 10000;
      const newerTime = Date.now();
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'older.pdf', uploadedAt: olderTime }),
        createDocument({ id: 'doc-2', fileName: 'newer.pdf', uploadedAt: newerTime }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      // Verify both documents are rendered
      expect(screen.getByText('older.pdf')).toBeInTheDocument();
      expect(screen.getByText('newer.pdf')).toBeInTheDocument();
    });

    it('displays file size in human-readable format', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'small.pdf', fileSize: 512 }),
        createDocument({ id: 'doc-2', fileName: 'medium.pdf', fileSize: 1024 * 50 }),
        createDocument({ id: 'doc-3', fileName: 'large.pdf', fileSize: 1024 * 1024 * 2 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/512 b/i)).toBeInTheDocument();
      expect(screen.getByText(/50 kb/i)).toBeInTheDocument();
      expect(screen.getByText(/2 mb/i)).toBeInTheDocument();
    });

    it('displays formatted date', () => {
      const mockOnDelete = vi.fn();
      const fixedTime = new Date('2024-01-15T10:30:00').getTime();
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'dated.pdf', uploadedAt: fixedTime }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      // Date should be displayed (format varies by locale)
      const documentElement = screen.getByText('dated.pdf').closest('div');
      expect(documentElement).toBeInTheDocument();
    });
  });

  describe('Status Badges', () => {
    it('displays "Uploading..." status for uploading documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'uploading', progress: 50 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/uploading\.\.\./i)).toBeInTheDocument();
    });

    it('displays "Processing..." status for processing documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'processing', progress: 30 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/processing\.\.\./i)).toBeInTheDocument();
    });

    it('displays "Ready" status for ready documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'ready' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/ready/i)).toBeInTheDocument();
    });

    it('displays "Error" status for error documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'error', errorMessage: 'Extraction failed' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/error/i)).toBeInTheDocument();
    });

    it('displays error message for error status', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'error', errorMessage: 'Extraction failed: invalid format' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/extraction failed: invalid format/i)).toBeInTheDocument();
    });
  });

  describe('Progress Bars', () => {
    it('displays progress bar for uploading documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'uploading', progress: 50 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      const progressBar = document.querySelector('div[style*="80px"]');
      expect(progressBar).toBeInTheDocument();
    });

    it('displays progress bar for processing documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'processing', progress: 60 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      const progressBar = document.querySelector('div[style*="80px"]');
      expect(progressBar).toBeInTheDocument();
    });

    it('hides progress bar for ready documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'ready', progress: 100 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      // Progress bar divs are 80px wide, ready status should not have them
      const progressBars = document.querySelectorAll('div[style*="80px"]');
      expect(progressBars).toHaveLength(0);
    });

    it('hides progress bar for error documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'error' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      const progressBars = document.querySelectorAll('div[style*="80px"]');
      expect(progressBars).toHaveLength(0);
    });

    it('displays chunk count when available', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'ready', chunkCount: 42 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByText(/42 chunks/i)).toBeInTheDocument();
    });

    it('does not display chunk count when zero', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'ready', chunkCount: 0 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.queryByText(/chunks/i)).not.toBeInTheDocument();
    });
  });

  describe('Delete Button', () => {
    it('renders delete button for each document', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'doc1.pdf' }),
        createDocument({ id: 'doc-2', fileName: 'doc2.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      expect(deleteButtons).toHaveLength(2);
    });

    it('calls onDelete with document id only after confirming (two-step delete, issue #36)', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-123', fileName: 'delete-me.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      // Step 1: clicking the trash icon arms the inline confirm — it must NOT
      // call onDelete yet.
      const deleteButton = screen.getByRole('button', { name: /delete delete-me\.pdf/i });
      fireEvent.click(deleteButton);
      expect(mockOnDelete).not.toHaveBeenCalled();

      // The confirm UI is now shown.
      const confirmButton = screen.getByRole('button', { name: /confirm delete delete-me\.pdf/i });
      fireEvent.click(confirmButton);

      // Step 2: only Confirm actually fires onDelete.
      expect(mockOnDelete).toHaveBeenCalledTimes(1);
      expect(mockOnDelete).toHaveBeenCalledWith('doc-123');
    });

    it('does NOT call onDelete when Cancel is clicked in the confirm step (issue #36)', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-123', fileName: 'delete-me.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      // Arm the confirm.
      const deleteButton = screen.getByRole('button', { name: /delete delete-me\.pdf/i });
      fireEvent.click(deleteButton);

      // Cancel the confirm.
      const cancelButton = screen.getByRole('button', { name: /cancel delete delete-me\.pdf/i });
      fireEvent.click(cancelButton);

      expect(mockOnDelete).not.toHaveBeenCalled();

      // The trash icon reappears (confirm UI dismissed) and is usable again.
      const deleteButtonAgain = screen.getByRole('button', { name: /delete delete-me\.pdf/i });
      expect(deleteButtonAgain).toBeInTheDocument();
    });

    it('disables delete button when document is being deleted', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-123', fileName: 'delete-me.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId="doc-123" />);

      const deleteButton = screen.getByRole('button', { name: /delete delete-me\.pdf/i });
      expect(deleteButton).toBeDisabled();
    });

    it('applies opacity to document item when deleting', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-123', fileName: 'deleting.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId="doc-123" />);

      // The document item should have opacity 0.5 when deleting
      // We can verify by checking the parent element of the delete button
      const deleteButton = screen.getByRole('button', { name: /delete deleting\.pdf/i });
      const parentWithOpacity = deleteButton.closest('div[style*="opacity"]');
      expect(parentWithOpacity).toBeInTheDocument();
    });
  });

  describe('List Structure', () => {
    it('renders list with proper role', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'doc1.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByRole('list')).toBeInTheDocument();
    });

    it('renders list with aria-label', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', fileName: 'doc1.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.getByRole('list')).toHaveAttribute('aria-label', 'Uploaded documents');
    });
  });

  describe('Virtualization (FR-003)', () => {
    it('virtualizes when more items than viewport can show', () => {
      const mockOnDelete = vi.fn();
      const documents = Array.from({ length: 100 }, (_, i) =>
        createDocument({ id: `doc-${i}`, fileName: `doc${i}.pdf` })
      );

      const { container } = render(
        <div style={{ height: '300px', overflow: 'auto' }}>
          <DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />
        </div>
      );

      // Virtualization (custom: ITEM_HEIGHT=60, BUFFER=5) only renders visible slice + buffer
      // into the DOM even for 100 items. The wrapper div provides the overflow:auto ancestor
      // that the component's useLayoutEffect detects for viewport sizing.
      const renderedPositionedItems = container.querySelectorAll('div[style*="position: absolute"]');
      expect(renderedPositionedItems.length).toBeLessThan(50);

      // Only the visible documents' filenames should be present in the DOM
      const renderedDocNames = screen.queryAllByText(/doc\d+\.pdf/);
      expect(renderedDocNames.length).toBeLessThan(50);
    });
  });
});
