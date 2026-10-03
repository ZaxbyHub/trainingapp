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

const DocumentItem = React.memo<{
  doc: DocumentEntry;
  onDelete?: (docId: string) => void;
  isDeleting: boolean;
  onCancelIndexing?: (docId: string) => void;
}>(({ doc, onDelete, isDeleting, onCancelIndexing }) => {
  // U5: two-step delete confirmation. First click of the trash icon arms the
  // inline confirm (reusing the SidebarConversationItem idiom); Confirm fires
  // onDelete, Cancel reverts. Keeps the virtualized 60px row height by showing
  // the confirm controls in place of the status badge + delete button.
  const [isConfirming, setIsConfirming] = useState(false);

  const handleDelete = useCallback(() => {
    if (!isDeleting) {
      setIsConfirming(true);
    }
  }, [isDeleting]);

  const handleConfirmDelete = useCallback(() => {
    setIsConfirming(false);
    onDelete?.(doc.id);
  }, [doc.id, onDelete]);

  const handleCancelDelete = useCallback(() => {
    setIsConfirming(false);
  }, []);

  const kind = documentKind(doc.fileName);
  return (
    <div className={cx('app-doc', isDeleting && 'app-doc--deleting')}>
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
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(300);
    const listRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    const tableRef = useRef<HTMLDivElement>(null);
    const itemHeight = useItemHeight(tableRef, documents.length > 0);
    // A layout switch changes the row height: keep the same ROW at the top of the
    // list (scroll position by item index, not by pixels).
    const previousHeightRef = useRef(itemHeight);
    useLayoutEffect(() => {
      const previous = previousHeightRef.current;
      previousHeightRef.current = itemHeight;
      const scroller = scrollContainerRef.current;
      if (previous === itemHeight || scroller === null) return;
      const next = (scroller.scrollTop / previous) * itemHeight;
      scroller.scrollTop = next;
      setScrollTop(scroller.scrollTop);
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
        setScrollTop(scroller!.scrollTop);
        setContainerHeight(scroller!.clientHeight);
      };

      // Initialize with current scroll position and viewport height
      setScrollTop(scroller.scrollTop);
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
        <div className="ui-empty app-doc-list__empty">
          <Icon name="file-text" size={32} className="ui-empty__icon" />
          <p className="app-doc-list__empty-title">No documents uploaded yet</p>
        </div>
      );
    }

    const totalItems = documents.length;
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - BUFFER);
    const endIndex = Math.min(
      totalItems,
      Math.ceil((scrollTop + containerHeight) / itemHeight) + BUFFER
    );
    const visibleDocuments = documents.slice(startIndex, endIndex);
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
      <div ref={listRef} role="list" aria-label="Uploaded documents" className="app-doc-list">
        {/* Placeholder div maintains the full scroll height for the scrollbar.
            Positional inline styles only: virtualization computes them per render. */}
        <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
          {visibleDocuments.map((doc, i) => {
            const index = startIndex + i;
            return (
              <div
                key={doc.id}
                role="listitem"
                className="app-doc-list__item"
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
