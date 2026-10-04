/**
 * DocumentList component displays uploaded documents with status and actions.
 *
 * Lumen phase 6: rows are built from the Lumen primitives (StatusPill,
 * ProgressBar, Button, IconButton) and styled by pages/documents.css. The only
 * inline styles left are the virtualization's positional ones (row offsets and
 * the full scroll height), which are computed per render.
 */

import React, { useCallback, useState, useRef, useLayoutEffect } from 'react';
import type { DocumentEntry } from '../types/document';
import { Button, Icon, IconButton, ProgressBar, StatusPill, type IconName } from '../ui';
import { cx } from '../ui/cx';
import { ITEM_HEIGHT, STACKED_ITEM_HEIGHT, STACKED_MAX_WIDTH } from './documentRowLayout';
import '../pages/documents.css';

interface DocumentListProps {
  documents: DocumentEntry[];
  /**
   * B9 (issue #67): optional. When omitted (Electron mode — the frozen
   * contract only exposes clear-all, rendered by the page header), the
   * per-document delete button is not rendered at all.
   */
  onDelete?: (docId: string) => void;
  deletingId: string | null;
  /**
   * U2: optional per-document indexing-cancel handler. When provided, the
   * processing row renders a small Cancel button that aborts in-flight indexing.
   */
  onCancelIndexing?: (docId: string) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Lumen phase 6: status is a StatusPill (icon + text, never color alone). */
function getStatusTone(status: DocumentEntry['status']): 'info' | 'success' | 'danger' {
  switch (status) {
    case 'ready':
      return 'success';
    case 'error':
      return 'danger';
    default:
      return 'info';
  }
}

function getStatusLabel(status: DocumentEntry['status']): string {
  switch (status) {
    case 'uploading':
      return 'Uploading...';
    case 'processing':
      return 'Processing...';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Error';
    default:
      return status;
  }
}

/**
 * Lumen phase 6 (design-language section 5 "type icon"): the document type,
 * from the file name's extension (the stored fileType differs between the
 * browser pipeline and desktop rows, the name does not). Decorative: the name
 * next to it already carries the extension.
 */
type DocKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'text' | 'other';
const KIND_BY_EXTENSION: Record<string, DocKind> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  txt: 'text',
  md: 'text',
};
const KIND_ICON: Record<DocKind, IconName> = {
  pdf: 'file-pdf',
  doc: 'file-type',
  sheet: 'file-spreadsheet',
  slides: 'presentation',
  text: 'file-text',
  other: 'file',
};
export function documentKind(fileName: string): DocKind {
  const dot = fileName.lastIndexOf('.');
  const extension = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
  return KIND_BY_EXTENSION[extension] ?? 'other';
}

/** Content-box width of `el` in CSS px, fractional like the `@container` query
 *  measures it (clientWidth rounds, so it is derived from the border box). */
function contentWidth(el: HTMLElement): number {
  const style = window.getComputedStyle(el);
  const sides = ['borderLeftWidth', 'borderRightWidth', 'paddingLeft', 'paddingRight'] as const;
  const inset = sides.reduce((sum, side) => sum + (parseFloat(style[side]) || 0), 0);
  return el.getBoundingClientRect().width - inset;
}

/**
 * Row height for the layout the CSS has active. The table is a size container
 * (`@container (max-width: STACKED_MAX_WIDTH px)` in pages/documents.css), so the
 * hook measures that SAME element's content width with a ResizeObserver and
 * applies the same threshold: the 60px / 112px virtualization heights cannot
 * disagree with the layout. An unmeasured (0px) container keeps the wide height.
 */
function useItemHeight(tableRef: React.RefObject<HTMLElement | null>, active: boolean): number {
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const el = tableRef.current;
    if (!active || el === null) return undefined;
    const apply = (width: number) => setStacked(width > 0 && width <= STACKED_MAX_WIDTH);
    apply(contentWidth(el));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) apply(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [tableRef, active]);
  return stacked ? STACKED_ITEM_HEIGHT : ITEM_HEIGHT;
}
const BUFFER = 5;

/** Distance from the top of the scroller's content to the top of the list (the
 *  wide layout shows a table head above it; the stacked layout does not). */
function measureListOffset(scroller: HTMLElement, listEl: HTMLElement): number {
  return listEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

const DocumentItem = React.memo<{
  doc: DocumentEntry;
  onDelete?: (docId: string) => void;
  isDeleting: boolean;
  onCancelIndexing?: (docId: string) => void;
  /** Fired right after Confirm calls onDelete, so the list can move focus off this
   *  row (its Confirm button is about to be replaced) before the row goes away. */
  onDeleteConfirmed?: (docId: string) => void;
}>(({ doc, onDelete, isDeleting, onCancelIndexing, onDeleteConfirmed }) => {
  // U5: two-step delete confirmation. First click of the trash icon arms the
  // inline confirm (reusing the SidebarConversationItem idiom); Confirm fires
  // onDelete, Cancel reverts. Keeps the virtualized 60px row height by showing
  // the confirm controls in place of the status badge + delete button.
  const [isConfirming, setIsConfirming] = useState(false);
  // Focus management for the swap between the trash button and the Confirm/Cancel
  // pair (review LOW-A/LOW-B). Each step removes the control that has focus, and a
  // removed element drops focus to <body> without a blur event, so the next control
  // is focused explicitly once the swapped markup has committed:
  //   arm     -> Cancel (the safe default; Confirm is one Tab away)
  //   cancel  -> back on this row's trash button
  //   confirm -> handled by the list (onDeleteConfirmed moves it to a neighbour)
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<'cancel' | 'trash' | null>(null);

  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-doc-action="${target === 'cancel' ? 'cancel-delete' : 'delete'}"]`)
      ?.focus();
  }, [isConfirming]);

  const handleDelete = useCallback(() => {
    if (!isDeleting) {
      pendingFocusRef.current = 'cancel';
      setIsConfirming(true);
    }
  }, [isDeleting]);

  const handleConfirmDelete = useCallback(() => {
    pendingFocusRef.current = null;
    setIsConfirming(false);
    onDelete?.(doc.id);
    onDeleteConfirmed?.(doc.id);
  }, [doc.id, onDelete, onDeleteConfirmed]);

  const handleCancelDelete = useCallback(() => {
    pendingFocusRef.current = 'trash';
    setIsConfirming(false);
  }, []);

  const kind = documentKind(doc.fileName);
  return (
    <div ref={rootRef} className={cx('app-doc', isDeleting && 'app-doc--deleting')}>
      {/* Table cells (Lumen phase 6): one cell per value, placed by CSS grid areas
          (pages/documents.css), so narrow widths reflow them instead of duplicating. */}
      <div className={`app-doc__icon app-doc__icon--${kind}`} data-kind={kind}>
        <Icon name={KIND_ICON[kind]} />
      </div>
      <p className="app-doc__name" title={doc.fileName}>
        {doc.fileName}
      </p>
      <span className="app-doc__meta">
        <span className="app-doc__date">{formatDate(doc.uploadedAt)}</span>
        <span className="app-doc__size">
          <span className="ui-visually-hidden">Size: </span>
          {formatFileSize(doc.fileSize)}
        </span>
        <span className="app-doc__chunks">
          {doc.chunkCount !== undefined && doc.chunkCount > 0 ? (
            <>
              <span className="ui-visually-hidden">Chunks: </span>
              {`${doc.chunkCount} chunks`}
            </>
          ) : null}
        </span>
      </span>

      {/* Status (collapsed during delete-confirmation to make room). */}
      {!isConfirming && (
        <div aria-live="polite" className="app-doc__status">
          <span className="ui-visually-hidden">Status: </span>
          <StatusPill status={getStatusTone(doc.status)}>{getStatusLabel(doc.status)}</StatusPill>

          {/* Progress bar for uploading/processing */}
          {(doc.status === 'uploading' || doc.status === 'processing') && (
            <ProgressBar
              className="app-doc__progress"
              label={`${getStatusLabel(doc.status)}: ${Math.round(doc.progress)}%`}
              value={Math.round(doc.progress)}
            />
          )}

          {/* U2: per-document indexing Cancel button. Only rendered during the
              processing stage and only when the host wires the cancel handler. */}
          {doc.status === 'processing' && onCancelIndexing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onCancelIndexing(doc.id)}
              aria-label={`Cancel indexing ${doc.fileName}`}
            >
              Cancel
            </Button>
          )}

          {/* Error message */}
          {doc.status === 'error' && doc.errorMessage && (
            <span className="app-doc__error" title={doc.errorMessage}>
              {doc.errorMessage}
            </span>
          )}
        </div>
      )}

      {/* U5: two-step delete confirmation (inline alert, SidebarConversationItem idiom).
          Confirm/Cancel buttons replace the status badge + trash icon when armed.
          Disabled controls stay NATIVELY disabled (and also carry aria-disabled for
          the Lumen disabled look). */}
      {isConfirming ? (
        <div role="alert" aria-label={`Delete ${doc.fileName}?`} className="app-doc__confirm">
          <span className="app-doc__confirm-text" title={`Delete ${doc.fileName}?`}>Delete {doc.fileName}?</span>
          <Button
            size="sm"
            variant="danger"
            onClick={handleConfirmDelete}
            disabled={isDeleting}
            aria-disabled={isDeleting || undefined}
            aria-label={`Confirm delete ${doc.fileName}`}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleCancelDelete}
            disabled={isDeleting}
            aria-disabled={isDeleting || undefined}
            aria-label={`Cancel delete ${doc.fileName}`}
            data-doc-action="cancel-delete"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="app-doc__actions">
          {onDelete ? (
            /* Delete trigger button (arms the inline confirm). Not rendered in
               B9 Electron mode (no per-document delete in the frozen contract). */
            <IconButton
              icon="trash"
              size="sm"
              className="app-doc__delete"
              onClick={handleDelete}
              disabled={isDeleting}
              aria-disabled={isDeleting || undefined}
              aria-label={`Delete ${doc.fileName}`}
              data-doc-action="delete"
            />
          ) : null}
        </div>
      )}
    </div>
  );
});

DocumentItem.displayName = 'DocumentItem';

export const DocumentList: React.FC<DocumentListProps> = React.memo(
  ({ documents, onDelete, deletingId, onCancelIndexing }) => {
    const [containerHeight, setContainerHeight] = useState(300);
    const listRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    const tableRef = useRef<HTMLDivElement>(null);
    const itemHeight = useItemHeight(tableRef, documents.length > 0);
    // The scroll position is stored with the row height it was measured at, so a
    // layout switch can re-derive the same ROW at the top (see below).
    const [scroll, setScroll] = useState({ top: 0, height: itemHeight });
    // Last scroll position and list offset seen under the CURRENT layout. A layout
    // switch must never read scroller.scrollTop after the commit: the new row
    // height has already resized the placeholder and the browser has clamped it.
    const lastScrollTopRef = useRef(0);
    const listOffsetRef = useRef(0);
    const previousHeightRef = useRef(itemHeight);
    // The document whose row holds keyboard focus. Keyed by id (not index) so it
    // survives a layout switch; that row is always kept mounted (see below).
    const [focusedId, setFocusedId] = useState<string | null>(null);
    // Kept current so handleDeleteConfirmed can stay referentially stable (the memoized
    // rows must not re-render on every list update).
    const documentsRef = useRef(documents);
    documentsRef.current = documents;
    const emptyRef = useRef<HTMLDivElement>(null);
    const emptyFocusPendingRef = useRef(false);

    const findRow = (id: string): HTMLElement | undefined =>
      Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-doc-id]') ?? []).find(
        (el) => el.dataset.docId === id
      );

    // Confirm removes the focused Confirm button (and, once the delete lands, the row):
    // hand focus to the next row's delete button, else the previous one, else the list
    // itself (and the empty state if that was the last document), never <body>.
    const handleDeleteConfirmed = useCallback((docId: string) => {
      const docs = documentsRef.current;
      const index = docs.findIndex((doc) => doc.id === docId);
      const neighbour = docs[index + 1] ?? docs[index - 1];
      const listEl = listRef.current;
      const target =
        neighbour === undefined
          ? undefined
          : Array.from(listEl?.querySelectorAll<HTMLElement>('[data-doc-id]') ?? [])
              .find((el) => el.dataset.docId === neighbour.id)
              ?.querySelector<HTMLElement>('[data-doc-action="delete"]');
      if (target) {
        target.focus();
      } else if (listEl) {
        emptyFocusPendingRef.current = neighbour === undefined;
        listEl.focus();
      }
    }, []);

    // After the last document is gone the list is replaced by the empty state: carry
    // the pending focus over to it.
    useLayoutEffect(() => {
      if (documents.length === 0 && emptyFocusPendingRef.current) {
        emptyFocusPendingRef.current = false;
        emptyRef.current?.focus();
      }
    }, [documents.length]);

    // A pin must never outlive the focus it protects. A removed focused element fires
    // no blur (an armed row's Confirm/Cancel swap, a deleted document), so onBlur alone
    // can leave `focusedId` set and keep that row and its neighbours mounted forever.
    // Verified on every commit: if the pinned row is gone or no longer contains the
    // active element, drop the pin (review LOW-A, NIT-2).
    useLayoutEffect(() => {
      if (focusedId === null) return;
      const row = findRow(focusedId);
      if (row === undefined || !row.contains(document.activeElement)) setFocusedId(null);
    });
    // A layout switch changes the row height: keep the same ROW at the top of the
    // list (scroll position by item index, not by pixels). The list does not start
    // at the scroller's top (the wide layout shows a table head above it), so the
    // offset is subtracted before and re-added after the conversion.
    useLayoutEffect(() => {
      const previous = previousHeightRef.current;
      previousHeightRef.current = itemHeight;
      const scroller = scrollContainerRef.current;
      const listEl = listRef.current;
      if (previous === itemHeight || scroller === null || listEl === null) return;
      const row = (lastScrollTopRef.current - listOffsetRef.current) / previous;
      const offset = measureListOffset(scroller, listEl);
      // At the very top (the table head still showing) stay at 0: re-adding the wide
      // layout's head offset would scroll the head out of view. Otherwise round (a
      // truncating assignment lands up to 1px short of the row boundary).
      const atTop = lastScrollTopRef.current <= listOffsetRef.current;
      scroller.scrollTop = atTop ? 0 : Math.round(offset + row * itemHeight);
      // Keep the focused control on screen (WCAG 2.4.11): the row-index conversion
      // can leave it outside the scroll area even though it is still mounted.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== scroller && listEl.contains(active)) {
        const view = scroller.getBoundingClientRect();
        const box = active.getBoundingClientRect();
        if (box.top < view.top || box.bottom > view.bottom) active.scrollIntoView({ block: 'nearest' });
      }
      lastScrollTopRef.current = scroller.scrollTop;
      listOffsetRef.current = offset;
      setScroll({ top: scroller.scrollTop, height: itemHeight });
    }, [itemHeight]);

    useLayoutEffect(() => {
      if (documents.length === 0) {
        return;
      }

      const listEl = listRef.current;
      if (!listEl) {
        return;
      }

      // Find nearest ancestor that is the scroll container (the one providing the viewport)
      // This preserves original layout for small lists (list box sizes to content)
      // while enabling virtualization when list grows taller than viewport.
      let scroller: HTMLElement | null = listEl.parentElement;
      while (scroller) {
        const style = window.getComputedStyle(scroller);
        const overflowY = style.overflowY;
        const overflow = style.overflow;
        if (overflowY === 'auto' || overflowY === 'scroll' || overflow === 'auto' || overflow === 'scroll') {
          break;
        }
        scroller = scroller.parentElement;
      }
      if (!scroller) {
        console.warn('DocumentList: No scrollable ancestor found. Virtualization disabled. Wrap DocumentList in a container with overflow:auto or overflow:scroll.');
        scroller = listEl;
      }
      scrollContainerRef.current = scroller;

      const handleScroll = () => {
        lastScrollTopRef.current = scroller!.scrollTop;
        setScroll({ top: scroller!.scrollTop, height: previousHeightRef.current });
        setContainerHeight(scroller!.clientHeight);
      };

      // Initialize with current scroll position and viewport height
      lastScrollTopRef.current = scroller.scrollTop;
      listOffsetRef.current = measureListOffset(scroller, listEl);
      setScroll({ top: scroller.scrollTop, height: previousHeightRef.current });
      setContainerHeight(scroller.clientHeight || 300);

      scroller.addEventListener('scroll', handleScroll, { passive: true });

      const handleResize = () => {
        const current = scrollContainerRef.current;
        if (current) {
          setContainerHeight(current.clientHeight);
        }
      };
      window.addEventListener('resize', handleResize);

      return () => {
        const current = scrollContainerRef.current;
        if (current) {
          current.removeEventListener('scroll', handleScroll);
        }
        window.removeEventListener('resize', handleResize);
      };
    }, [documents.length]);

    if (documents.length === 0) {
      // ui-empty layout with a <p> title: a heading here would collide with the
      // page's "Documents" heading.
      return (
        <div ref={emptyRef} tabIndex={-1} className="ui-empty app-doc-list__empty">
          <Icon name="file-text" size={32} className="ui-empty__icon" />
          <p className="app-doc-list__empty-title">No documents uploaded yet</p>
        </div>
      );
    }

    // Between a layout switch committing and its layout effect re-aiming the
    // scroller, `scroll` still holds the old row height: render the rows around the
    // same index so a focused row is never unmounted (focus would fall to body).
    const scrollTop = scroll.height === itemHeight ? scroll.top : (scroll.top / scroll.height) * itemHeight;
    const totalItems = documents.length;
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - BUFFER);
    const endIndex = Math.min(
      totalItems,
      Math.ceil((scrollTop + containerHeight) / itemHeight) + BUFFER
    );
    // The focused row (and its neighbours, so Tab / Shift+Tab still reach the next
    // and previous rows) stays mounted wherever the window is: unmounting a focused
    // control drops focus to <body>. Rendered in index order to keep tab order.
    const focusedIndex = focusedId === null ? -1 : documents.findIndex((doc) => doc.id === focusedId);
    const renderedSet = new Set<number>();
    for (let i = startIndex; i < endIndex; i++) renderedSet.add(i);
    if (focusedIndex >= 0) {
      for (let i = Math.max(0, focusedIndex - 1); i <= Math.min(totalItems - 1, focusedIndex + 1); i++) {
        renderedSet.add(i);
      }
    }
    const renderedIndices = Array.from(renderedSet).sort((a, b) => a - b);
    const totalHeight = totalItems * itemHeight;

    return (
      <div ref={tableRef} className="app-doc-table">
        {/* Column headings: decorative only (aria-hidden; labels drawn from
            data-label by CSS, so they add no text). Each row's cells carry their
            own self-describing text ("117.2 KB", "12 chunks", the status pill). */}
        <div className="app-doc-table__head" aria-hidden="true">
          <span />
          <span data-label="Name" />
          <span data-label="Size" />
          <span data-label="Chunks" />
          <span data-label="Status" />
          <span />
        </div>
      <div
        ref={listRef}
        role="list"
        aria-label="Uploaded documents"
        className="app-doc-list"
        tabIndex={-1}
        onBlur={(event) => {
          if (event.target === event.currentTarget) emptyFocusPendingRef.current = false;
        }}
      >
        {/* Placeholder div maintains the full scroll height for the scrollbar.
            Positional inline styles only: virtualization computes them per render. */}
        <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
          {renderedIndices.map((index) => {
            const doc = documents[index]!;
            return (
              <div
                key={doc.id}
                role="listitem"
                // Pinned rows make the mounted set non-contiguous: say where each sits.
                aria-setsize={totalItems}
                aria-posinset={index + 1}
                data-doc-id={doc.id}
                className="app-doc-list__item"
                onFocus={() => setFocusedId(doc.id)}
                onBlur={(event) => {
                  // Focus moving to another control in the same row keeps it pinned.
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setFocusedId((current) => (current === doc.id ? null : current));
                  }
                }}
                style={{
                  position: 'absolute',
                  top: `${index * itemHeight}px`,
                  left: 0,
                  right: 0,
                  height: `${itemHeight}px`,
                }}
              >
                <DocumentItem
                  doc={doc}
                  onDelete={onDelete}
                  isDeleting={deletingId === doc.id}
                  onCancelIndexing={onCancelIndexing}
                  onDeleteConfirmed={handleDeleteConfirmed}
                />
              </div>
            );
          })}
        </div>
      </div>
      </div>
    );
  }
);

DocumentList.displayName = 'DocumentList';
