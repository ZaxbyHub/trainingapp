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

    // Review LOW-A / LOW-B: every step of arm -> cancel/confirm removes the focused
    // control, which drops focus to <body> unless it is moved on purpose.
    describe('focus management', () => {
      const threeDocs = () => [
        createDocument({ id: 'a', fileName: 'a.pdf' }),
        createDocument({ id: 'b', fileName: 'b.pdf' }),
        createDocument({ id: 'c', fileName: 'c.pdf' }),
      ];
      const arm = (name: string) => {
        const trash = screen.getByRole('button', { name: `Delete ${name}` });
        trash.focus();
        fireEvent.click(trash);
      };

      it('arming the confirm moves focus to Cancel (the safe default), not <body>', () => {
        render(<DocumentList documents={threeDocs()} onDelete={vi.fn()} deletingId={null} />);
        arm('b.pdf');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel delete b.pdf' }));
      });

      it('cancelling returns focus to that row\'s trash button', () => {
        render(<DocumentList documents={threeDocs()} onDelete={vi.fn()} deletingId={null} />);
        arm('b.pdf');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel delete b.pdf' }));
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete b.pdf' }));
      });

      it('confirming moves focus to the next row\'s delete button', () => {
        render(<DocumentList documents={threeDocs()} onDelete={vi.fn()} deletingId={null} />);
        arm('a.pdf');
        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete a.pdf' }));
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete b.pdf' }));
      });

      it('confirming the last row moves focus to the previous row\'s delete button', () => {
        render(<DocumentList documents={threeDocs()} onDelete={vi.fn()} deletingId={null} />);
        arm('c.pdf');
        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete c.pdf' }));
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete b.pdf' }));
      });

      it('confirming the only row focuses the list, then the empty state once it is gone', () => {
        const only = [createDocument({ id: 'a', fileName: 'a.pdf' })];
        const { rerender } = render(<DocumentList documents={only} onDelete={vi.fn()} deletingId={null} />);
        arm('a.pdf');
        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete a.pdf' }));
        expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Uploaded documents' }));
        rerender(<DocumentList documents={[]} onDelete={vi.fn()} deletingId={null} />);
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement?.className).toContain('app-doc-list__empty');
      });

      // Review NIT-2: clicking plain row text must not land focus on the list.
      it('gives the list a tabindex only while focus has to land on it', () => {
        const only = [createDocument({ id: 'a', fileName: 'a.pdf' })];
        render(<DocumentList documents={only} onDelete={vi.fn()} deletingId={null} />);
        const list = screen.getByRole('list', { name: 'Uploaded documents' });
        expect(list.hasAttribute('tabindex')).toBe(false);
        arm('a.pdf');
        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete a.pdf' }));
        expect(document.activeElement).toBe(list);
        expect(list.getAttribute('tabindex')).toBe('-1');
        act(() => list.blur());
        expect(list.hasAttribute('tabindex')).toBe(false);
      });

      it('a failed delete that leaves the list alone does not hijack focus later', () => {
        const only = [createDocument({ id: 'a', fileName: 'a.pdf' })];
        const { rerender } = render(<DocumentList documents={only} onDelete={vi.fn()} deletingId={null} />);
        arm('a.pdf');
        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete a.pdf' }));
        // The user moves on (focus leaves the list), the delete never lands.
        act(() => (document.activeElement as HTMLElement).blur());
        rerender(<DocumentList documents={[]} onDelete={vi.fn()} deletingId={null} />);
        expect(document.activeElement).toBe(document.body);
      });
    });

    // Review NIT-1: pinned rows make the exposed list non-contiguous.
    it('exposes each row\'s position in the full list (aria-posinset / aria-setsize)', () => {
      const documents = [
        createDocument({ id: 'a', fileName: 'a.pdf' }),
        createDocument({ id: 'b', fileName: 'b.pdf' }),
        createDocument({ id: 'c', fileName: 'c.pdf' }),
      ];
      render(<DocumentList documents={documents} onDelete={vi.fn()} deletingId={null} />);
      const rows = screen.getAllByRole('listitem');
      expect(rows.map((row) => row.getAttribute('aria-posinset'))).toEqual(['1', '2', '3']);
      expect(rows.map((row) => row.getAttribute('aria-setsize'))).toEqual(['3', '3', '3']);
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

    // Review B-1. A real browser clamps scrollTop to scrollHeight - clientHeight the
    // moment the placeholder shrinks, so a layout effect that reads scrollTop after
    // the commit has already lost the position. This models that clamp, a 37px table
    // head that exists only in the wide layout, and a focused row control.
    describe('scroll position survives the browser clamp (review B-1)', () => {
      const HEAD = 37;
      const CLIENT_HEIGHT = 300;
      const names = Array.from({ length: 80 }, (_, i) => `Doc-${String(i).padStart(3, '0')}.pdf`);

      const setup = (initialWidth: number) => {
        width = initialWidth;
        let raw = 0;
        const view = render(
          <div style={{ height: '300px', overflow: 'auto' }} data-testid="scroller">
            <DocumentList
              documents={names.map((fileName, i) => createDocument({ id: `d${i}`, fileName }))}
              onDelete={vi.fn()}
              deletingId={null}
            />
          </div>
        );
        const scroller = view.getByTestId('scroller');
        const head = () => (width > STACKED_MAX_WIDTH ? HEAD : 0);
        const maxScroll = () => {
          const placeholder = scroller.querySelector<HTMLElement>('[role="list"] > div');
          return head() + parseFloat(placeholder?.style.height ?? '0') - CLIENT_HEIGHT;
        };
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => CLIENT_HEIGHT });
        Object.defineProperty(scroller, 'scrollTop', {
          configurable: true,
          // The clamp is applied on every read, like a browser does at layout.
          get: () => Math.min(Math.max(raw, 0), Math.max(maxScroll(), 0)),
          set: (value: number) => {
            raw = value;
          },
        });
        rectSpy.mockImplementation(function (this: HTMLElement) {
          const w = this.classList.contains('app-doc-table') ? width : 0;
          const top = this.getAttribute('role') === 'list' ? head() - scroller.scrollTop : 0;
          return { width: w, height: 0, top, left: 0, right: w, bottom: top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
        });
        return { ...view, scroller };
      };
      const deleteLabels = (container: HTMLElement): string[] =>
        Array.from(container.querySelectorAll('[role="listitem"] [aria-label^="Delete "]')).map(
          (el) => el.getAttribute('aria-label') ?? ''
        );

      it('keeps row 60 of 80 at the top across stacked -> wide -> stacked', () => {
        const { container, scroller } = setup(700);
        scroller.scrollTop = 60 * STACKED_ITEM_HEIGHT; // 6720, past the wide-layout maximum
        fireEvent.scroll(scroller);
        resizeTo(1000);
        expect(scroller.scrollTop).toBe(HEAD + 60 * ITEM_HEIGHT);
        resizeTo(700);
        expect(scroller.scrollTop).toBe(60 * STACKED_ITEM_HEIGHT);
        expect(deleteLabels(container)).toContain('Delete Doc-060.pdf');
      });

      it('keeps keyboard focus on the same row control across the switch', () => {
        const { scroller } = setup(700);
        scroller.scrollTop = 70 * STACKED_ITEM_HEIGHT;
        fireEvent.scroll(scroller);
        const trigger = screen.getByRole('button', { name: 'Delete Doc-070.pdf' });
        trigger.focus();
        expect(document.activeElement).toBe(trigger);
        resizeTo(1000);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Doc-070.pdf' }));
        resizeTo(700);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Doc-070.pdf' }));
      });

      // Review (focus blocker): the window follows the scroll position, so a focused
      // row far outside it used to unmount and drop focus to <body>.
      it('keeps the focused row (and its neighbours) rendered when the window moves away', () => {
        const { scroller, container } = setup(700);
        scroller.scrollTop = 70 * STACKED_ITEM_HEIGHT;
        fireEvent.scroll(scroller);
        const trigger = screen.getByRole('button', { name: 'Delete Doc-070.pdf' });
        trigger.focus();
        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
        expect(screen.getByRole('button', { name: 'Delete Doc-070.pdf' })).toBe(trigger);
        expect(document.activeElement).toBe(trigger);
        // Tab / Shift+Tab can still reach the next and previous rows, in index order.
        const labels = deleteLabels(container);
        expect(labels).toContain('Delete Doc-069.pdf');
        expect(labels).toContain('Delete Doc-071.pdf');
        expect(labels).not.toContain('Delete Doc-072.pdf');
        expect(labels).toEqual([...labels].sort());
        const pinned = Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]')).find((el) =>
          el.contains(trigger)
        );
        expect(pinned?.style.top).toBe(`${70 * STACKED_ITEM_HEIGHT}px`);
        // Once focus leaves the list, the row is virtualized away again.
        act(() => trigger.blur());
        expect(deleteLabels(container)).not.toContain('Delete Doc-070.pdf');
      });

      // Review LOW-A. An armed row keeps focus (on Cancel), so it stays pinned and mounted
      // while it is scrolled out of sight: a focused control must not vanish (WCAG 2.4.3).
      // That is intentional. What must not happen is the pin outliving the focus: the moment
      // focus leaves, the row (and its neighbours) is virtualized away and its armed state
      // goes with it, so an armed "Delete X?" never lingers un-focused off screen.
      it('keeps an armed row pinned only while it holds focus, then drops it and its armed state', () => {
        const { scroller, container } = setup(700);
        scroller.scrollTop = 70 * STACKED_ITEM_HEIGHT;
        fireEvent.scroll(scroller);
        const trash = screen.getByRole('button', { name: 'Delete Doc-070.pdf' });
        trash.focus();
        fireEvent.click(trash);
        const cancel = screen.getByRole('button', { name: 'Cancel delete Doc-070.pdf' });
        expect(document.activeElement).toBe(cancel);

        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
        expect(screen.getByRole('button', { name: 'Cancel delete Doc-070.pdf' })).toBe(cancel);
        expect(document.activeElement).toBe(cancel);
        expect(deleteLabels(container)).toContain('Delete Doc-069.pdf');

        act(() => cancel.blur());
        expect(screen.queryByRole('button', { name: 'Cancel delete Doc-070.pdf' })).toBeNull();
        expect(deleteLabels(container)).not.toContain('Delete Doc-069.pdf');
        expect(deleteLabels(container)).not.toContain('Delete Doc-071.pdf');

        scroller.scrollTop = 70 * STACKED_ITEM_HEIGHT;
        fireEvent.scroll(scroller);
        expect(screen.getByRole('button', { name: 'Delete Doc-070.pdf' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel delete Doc-070.pdf' })).toBeNull();
      });

      // Review NIT-2 (and the LOW-A mechanism): removing a focused element fires no blur,
      // so a deleted document used to leave focusedId set and its neighbours pinned.
      it('clears the pin when the focused document is removed from the list', () => {
        const documents = names.map((fileName, i) => createDocument({ id: `d${i}`, fileName }));
        const { scroller, container, rerender } = setup(700);
        scroller.scrollTop = 70 * STACKED_ITEM_HEIGHT;
        fireEvent.scroll(scroller);
        screen.getByRole('button', { name: 'Delete Doc-070.pdf' }).focus();
        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
        expect(deleteLabels(container)).toContain('Delete Doc-069.pdf');

        rerender(
          <div style={{ height: '300px', overflow: 'auto' }} data-testid="scroller">
            <DocumentList
              documents={documents.filter((doc) => doc.id !== 'd70')}
              onDelete={vi.fn()}
              deletingId={null}
            />
          </div>
        );
        expect(deleteLabels(container)).not.toContain('Delete Doc-069.pdf');
        expect(deleteLabels(container)).not.toContain('Delete Doc-071.pdf');

        // The stale id must be gone, not just harmless while the document is absent: if the
        // same document comes back (re-upload, failed delete refresh) it must not re-pin.
        rerender(
          <div style={{ height: '300px', overflow: 'auto' }} data-testid="scroller">
            <DocumentList documents={documents} onDelete={vi.fn()} deletingId={null} />
          </div>
        );
        expect(deleteLabels(container)).not.toContain('Delete Doc-069.pdf');
        expect(deleteLabels(container)).not.toContain('Delete Doc-070.pdf');
        expect(deleteLabels(container)).not.toContain('Delete Doc-071.pdf');
      });

      // Review LOW-A mechanism: a focused control that is REMOVED (here the processing
      // row's "Cancel indexing" button, gone once indexing finishes) fires no blur, so
      // onBlur alone left the row and its neighbours pinned for good.
      // (No onDelete here: the host exposes no per-document delete, so there is no control to
      // hand focus to and it really is lost.)
      const rowNames = (container: HTMLElement): string[] =>
        Array.from(container.querySelectorAll('.app-doc__name')).map((el) => el.textContent ?? '');
      it('clears the pin when the focused control disappears without a blur', () => {
        const documents = (status: 'processing' | 'ready') =>
          names.map((fileName, i) => createDocument({ id: `d${i}`, fileName, status: i === 70 ? status : 'ready' }));
        const tree = (status: 'processing' | 'ready') => (
          <div style={{ height: '300px', overflow: 'auto' }} data-testid="scroller">
            <DocumentList documents={documents(status)} onCancelIndexing={vi.fn()} deletingId={null} />
          </div>
        );
        const { scroller, container, rerender } = setup(700);
        rerender(tree('processing'));
        scroller.scrollTop = 70 * STACKED_ITEM_HEIGHT;
        fireEvent.scroll(scroller);
        const cancelIndexing = screen.getByRole('button', { name: 'Cancel indexing Doc-070.pdf' });
        cancelIndexing.focus();
        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
        expect(rowNames(container)).toContain('Doc-069.pdf');

        rerender(tree('ready'));
        expect(document.activeElement).toBe(document.body);
        expect(rowNames(container)).not.toContain('Doc-069.pdf');
        expect(rowNames(container)).not.toContain('Doc-070.pdf');
        expect(rowNames(container)).not.toContain('Doc-071.pdf');
      });

      // Review NIT-1: when indexing finishes the focused "Cancel indexing" button is removed;
      // focus goes to that row's delete button rather than <body>.
      it('moves focus to the row delete button when the focused Cancel indexing control goes away', () => {
        const documents = (status: 'processing' | 'ready') =>
          names.map((fileName, i) => createDocument({ id: `d${i}`, fileName, status: i === 3 ? status : 'ready' }));
        const tree = (status: 'processing' | 'ready') => (
          <div style={{ height: '300px', overflow: 'auto' }} data-testid="scroller">
            <DocumentList documents={documents(status)} onDelete={vi.fn()} onCancelIndexing={vi.fn()} deletingId={null} />
          </div>
        );
        const { rerender } = setup(700);
        rerender(tree('processing'));
        screen.getByRole('button', { name: 'Cancel indexing Doc-003.pdf' }).focus();
        rerender(tree('ready'));
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Doc-003.pdf' }));
      });

      it('leaves focus alone when the user already moved off Cancel indexing before it finished', () => {
        const documents = (status: 'processing' | 'ready') =>
          names.map((fileName, i) => createDocument({ id: `d${i}`, fileName, status: i === 3 ? status : 'ready' }));
        const tree = (status: 'processing' | 'ready') => (
          <div style={{ height: '300px', overflow: 'auto' }} data-testid="scroller">
            <DocumentList documents={documents(status)} onDelete={vi.fn()} onCancelIndexing={vi.fn()} deletingId={null} />
          </div>
        );
        const { rerender } = setup(700);
        rerender(tree('processing'));
        screen.getByRole('button', { name: 'Cancel indexing Doc-003.pdf' }).focus();
        const other = screen.getByRole('button', { name: 'Delete Doc-004.pdf' });
        other.focus();
        rerender(tree('ready'));
        expect(document.activeElement).toBe(other);
      });

      // Review LOW-3: the wide layout's table head is above the list, so converting the
      // top of the list must land on scrollTop 0, not on the head offset.
      it('shows the table head when switching stacked -> wide at the very top', () => {
        const { scroller } = setup(700);
        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
        resizeTo(1000);
        expect(scroller.scrollTop).toBe(0);
        resizeTo(700);
        expect(scroller.scrollTop).toBe(0);
      });

      it('rounds (not truncates) the converted scrollTop', () => {
        const { scroller } = setup(700);
        scroller.scrollTop = 3380; // row 30.18 of 112px rows
        fireEvent.scroll(scroller);
        resizeTo(1000);
        // 37 + 30.18 * 60 = 1847.71: truncating would land on 1847.
        expect(scroller.scrollTop).toBe(1848);
      });

      // Review LOW-2 (WCAG 2.4.11): a focused control left outside the scroll area by
      // the conversion is scrolled back into view, minimally.
      describe('focused control visibility after a layout switch', () => {
        const scrollIntoView = vi.fn();
        beforeEach(() => {
          scrollIntoView.mockClear();
          Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
        });
        afterEach(() => {
          delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
        });
        const placeControl = (top: number) => {
          const base = rectSpy.getMockImplementation()!;
          rectSpy.mockImplementation(function (this: HTMLElement) {
            const rect = (t: number, b: number) =>
              ({ width: 0, height: b - t, top: t, left: 0, right: 0, bottom: b, x: 0, y: t, toJSON: () => ({}) }) as DOMRect;
            if (this.getAttribute('aria-label') === 'Delete Doc-070.pdf') return rect(top, top + 28);
            if (this.dataset.testid === 'scroller') return rect(0, CLIENT_HEIGHT);
            return base.call(this);
          });
        };

        it('scrolls a focused control that ended up below the scroll area into view (block: nearest)', () => {
          const { scroller } = setup(1000);
          scroller.scrollTop = HEAD + 70 * ITEM_HEIGHT;
          fireEvent.scroll(scroller);
          screen.getByRole('button', { name: 'Delete Doc-070.pdf' }).focus();
          placeControl(CLIENT_HEIGHT + 100);
          resizeTo(700);
          expect(scrollIntoView).toHaveBeenCalledTimes(1);
          expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
        });

        it('leaves the scroll position alone when the focused control is already visible', () => {
          const { scroller } = setup(1000);
          scroller.scrollTop = HEAD + 70 * ITEM_HEIGHT;
          fireEvent.scroll(scroller);
          screen.getByRole('button', { name: 'Delete Doc-070.pdf' }).focus();
          placeControl(100);
          resizeTo(700);
          expect(scrollIntoView).not.toHaveBeenCalled();
        });
      });
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
