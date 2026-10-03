/**
 * Tests for DocumentList component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DocumentList, documentKind } from './DocumentList';
import { ITEM_HEIGHT, STACKED_ITEM_HEIGHT, STACKED_MAX_WIDTH } from './documentRowLayout';
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

      // Lumen phase 6: role/value assertions (was an inline width-style string).
      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuenow', String(documents[0].progress));
    });

    it('displays progress bar for processing documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'processing', progress: 60 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      // Lumen phase 6: role/value assertions (was an inline width-style string).
      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuenow', String(documents[0].progress));
    });

    it('hides progress bar for ready documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'ready', progress: 100 }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('hides progress bar for error documents', () => {
      const mockOnDelete = vi.fn();
      const documents = [
        createDocument({ id: 'doc-1', status: 'error' }),
      ];
      render(<DocumentList documents={documents} onDelete={mockOnDelete} deletingId={null} />);

      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
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

      // Lumen phase 6: the dimmed state is the row's deleting modifier class
      // (pages/documents.css sets its opacity), not an inline style string.
      const deleteButton = screen.getByRole('button', { name: /delete deleting\.pdf/i });
      expect(deleteButton.closest('.app-doc')).toHaveClass('app-doc--deleting');
      expect(deleteButton).toBeDisabled();
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

  // Lumen phase 6 review B1: stacked rows are taller, and the virtualization offsets
  // must follow the layout the CSS has active. That layout is an `@container` query
  // on the table, so the height follows the TABLE's width (ResizeObserver), not the
  // viewport (documentRowLayout.test.ts pins the CSS threshold to the same constant).
  describe('Stacked row height follows the table container (critic B1)', () => {
    let width = 1000;
    let observerCallback: ResizeObserverCallback | null = null;
    let rectSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      observerCallback = null;
      rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          const w = this.classList.contains('app-doc-table') ? width : 0; // jsdom loads no CSS: no borders to subtract
          return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        });
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: ResizeObserverCallback) {
            observerCallback = cb;
          }
          observe() {}
          disconnect() {}
          unobserve() {}
        }
      );
    });
    afterEach(() => {
      rectSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    const resizeTo = (next: number) => {
      width = next;
      act(() => {
        observerCallback?.([{ contentRect: { width: next } } as ResizeObserverEntry], {} as ResizeObserver);
      });
    };
    const ids = ['a', 'b'];
    const renderList = (n = 2) =>
      render(
        <div style={{ height: '300px', overflow: 'auto' }} data-testid="scroller">
          <DocumentList
            documents={Array.from({ length: n }, (_, i) => createDocument({ id: ids[i] ?? `d${i}` }))}
            onDelete={vi.fn()}
            deletingId={null}
          />
        </div>
      );
    const tops = (container: HTMLElement): string[] =>
      Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]')).map(
        (el) => el.style.top + '/' + el.style.height
      );

    it('exports the shared constants the CSS rule is pinned to', () => {
      expect(STACKED_MAX_WIDTH).toBe(800);
      expect(ITEM_HEIGHT).toBe(60);
      expect(STACKED_ITEM_HEIGHT).toBe(112);
    });

    it('uses 60px rows above the breakpoint and 112px at or below it', () => {
      width = STACKED_MAX_WIDTH + 1;
      const wide = renderList();
      expect(tops(wide.container)).toEqual(['0px/60px', '60px/60px']);
      wide.unmount();
      width = STACKED_MAX_WIDTH;
      const narrow = renderList();
      expect(tops(narrow.container)).toEqual(['0px/112px', '112px/112px']);
    });

    it('an unmeasured container (0px, e.g. jsdom) keeps the wide height', () => {
      width = 0;
      const { container } = renderList();
      expect(tops(container)).toEqual(['0px/60px', '60px/60px']);
    });

    it('re-evaluates when the container resizes (sidebar toggled, window resized)', () => {
      width = 1000;
      const { container } = renderList();
      expect(tops(container)[1]).toBe('60px/60px');
      resizeTo(700);
      expect(tops(container)[1]).toBe('112px/112px');
      resizeTo(STACKED_MAX_WIDTH + 1);
      expect(tops(container)[1]).toBe('60px/60px');
    });

    it('keeps the same row at the top of the list across a layout switch (index, not pixels)', () => {
      width = 1000;
      const { container, getByTestId } = renderList(40);
      const scroller = getByTestId('scroller');
      scroller.scrollTop = 600; // row 10 at 60px
      resizeTo(700);
      expect(scroller.scrollTop).toBe(10 * STACKED_ITEM_HEIGHT);
      expect(tops(container).some((t) => t.startsWith(`${10 * STACKED_ITEM_HEIGHT}px/`))).toBe(true);
      resizeTo(1000);
      expect(scroller.scrollTop).toBe(10 * ITEM_HEIGHT);
    });
  });

  // Lumen phase 6 review L6/L7: per-type icons and labelled table cells.
  describe('Type icons and cell labels (review L6/L7)', () => {
    it('maps the file extension to a document kind (case-insensitive, unknown = other)', () => {
      expect(documentKind('Handbook.PDF')).toBe('pdf');
      expect(documentKind('memo.docx')).toBe('doc');
      expect(documentKind('budget.xlsx')).toBe('sheet');
      expect(documentKind('deck.pptx')).toBe('slides');
      expect(documentKind('notes.md')).toBe('text');
      expect(documentKind('readme.txt')).toBe('text');
      expect(documentKind('archive.tar.gz')).toBe('other');
      expect(documentKind('no-extension')).toBe('other');
    });

    it('renders a different type icon per kind in each row', () => {
      const documents = [
        createDocument({ id: 'a', fileName: 'a.pdf' }),
        createDocument({ id: 'b', fileName: 'b.docx' }),
        createDocument({ id: 'c', fileName: 'c.xlsx' }),
        createDocument({ id: 'd', fileName: 'd.txt' }),
        createDocument({ id: 'e', fileName: 'e.bin' }),
      ];
      const { container } = render(<DocumentList documents={documents} onDelete={vi.fn()} deletingId={null} />);
      const kinds = Array.from(container.querySelectorAll('.app-doc__icon')).map((el) => el.getAttribute('data-kind'));
      expect(kinds).toEqual(['pdf', 'doc', 'sheet', 'text', 'other']);
      const shapes = new Set(Array.from(container.querySelectorAll('.app-doc__icon svg')).map((svg) => svg.innerHTML));
      expect(shapes.size).toBe(5);
    });

    it('labels the size, chunks and status cells for screen readers, keeping role=list', () => {
      render(
        <DocumentList
          documents={[createDocument({ id: 'a', fileName: 'a.pdf', status: 'ready', chunkCount: 42 })]}
          onDelete={vi.fn()}
          deletingId={null}
        />
      );
      expect(screen.getByRole('list')).toBeInTheDocument();
      const item = screen.getByRole('listitem');
      expect(item).toHaveTextContent(/Size:\s*\S+/);
      expect(item).toHaveTextContent('Chunks: 42 chunks');
      expect(item).toHaveTextContent('Status: Ready');
    });

    it('adds no "Chunks:" label when there is no chunk count', () => {
      render(
        <DocumentList
          documents={[createDocument({ id: 'a', fileName: 'a.pdf', status: 'error', chunkCount: 0 })]}
          onDelete={vi.fn()}
          deletingId={null}
        />
      );
      expect(screen.queryByText(/chunks/i)).not.toBeInTheDocument();
    });
  });
});
