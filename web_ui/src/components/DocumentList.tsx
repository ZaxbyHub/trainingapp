/**
 * DocumentList component displays uploaded documents with status and actions.
 */

import React, { useCallback, useState, useRef, useLayoutEffect } from 'react';
import type { DocumentEntry } from '../types/document';

interface DocumentListProps {
  documents: DocumentEntry[];
  onDelete: (docId: string) => void;
  deletingId: string | null;
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

function getStatusColor(status: DocumentEntry['status']): string {
  switch (status) {
    case 'uploading':
      return 'var(--color-info)';
    case 'processing':
      return 'var(--color-warning)';
    case 'ready':
      return 'var(--color-success)';
    case 'error':
      return 'var(--color-danger)';
    default:
      return 'var(--color-text-muted)';
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

const ITEM_HEIGHT = 60;
const BUFFER = 5;

const DocumentItem = React.memo<{
  doc: DocumentEntry;
  onDelete: (docId: string) => void;
  isDeleting: boolean;
}>(({ doc, onDelete, isDeleting }) => {
  const handleDelete = useCallback(() => {
    if (!isDeleting) {
      onDelete(doc.id);
    }
  }, [doc.id, onDelete, isDeleting]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-md)',
        padding: 'var(--spacing-md)',
        borderBottom: '1px solid var(--color-bubble-system)',
        backgroundColor: 'var(--color-bubble-assistant)',
        opacity: isDeleting ? 0.5 : 1,
        transition: 'opacity 0.2s ease',
        height: '60px',
        boxSizing: 'border-box',
      }}
    >
      {/* File icon */}
      <div
        style={{
          width: '40px',
          height: '40px',
          borderRadius: '8px',
          backgroundColor: 'var(--color-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-text-on-primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>

      {/* Document info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: 'var(--font-size-body)',
            fontFamily: 'var(--font-family)',
            color: 'var(--color-text-on-bubble-assistant)',
            fontWeight: 500,
            marginBottom: '2px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={doc.fileName}
        >
          {doc.fileName}
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-sm)',
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
          }}
        >
          <span style={{ color: 'var(--color-text-muted)' }}>
            {formatFileSize(doc.fileSize)}
          </span>
          <span style={{ color: 'var(--color-text-muted)' }}>•</span>
          <span style={{ color: 'var(--color-text-muted)' }}>
            {formatDate(doc.uploadedAt)}
          </span>
          {doc.chunkCount !== undefined && doc.chunkCount > 0 && (
            <>
              <span style={{ color: 'var(--color-text-muted)' }}>•</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {doc.chunkCount} chunks
              </span>
            </>
          )}
        </div>
      </div>

      {/* Status badge */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 'var(--spacing-xs)',
        }}
      >
        <span
          style={{
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
            color: getStatusColor(doc.status),
            fontWeight: 500,
          }}
        >
          {getStatusLabel(doc.status)}
        </span>

        {/* Progress bar for uploading/processing */}
        {(doc.status === 'uploading' || doc.status === 'processing') && (
          <div
            style={{
              width: '80px',
              height: '4px',
              backgroundColor: 'var(--color-bubble-system)',
              borderRadius: '2px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${doc.progress}%`,
                height: '100%',
                backgroundColor: getStatusColor(doc.status),
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        )}

        {/* Error message */}
        {doc.status === 'error' && doc.errorMessage && (
          <span
            style={{
              fontSize: 'var(--font-size-small)',
              fontFamily: 'var(--font-family)',
              color: 'var(--color-danger)',
              maxWidth: '200px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={doc.errorMessage}
          >
            {doc.errorMessage}
          </span>
        )}
      </div>

      {/* Delete button */}
      <button
        type="button"
        onClick={handleDelete}
        disabled={isDeleting}
        aria-label={`Delete ${doc.fileName}`}
        style={{
          width: '32px',
          height: '32px',
          border: 'none',
          borderRadius: '6px',
          backgroundColor: 'transparent',
          cursor: isDeleting ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: 'var(--color-text-muted)',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          if (!isDeleting) {
            e.currentTarget.style.backgroundColor = 'var(--color-danger)';
            e.currentTarget.style.color = 'var(--color-text-on-primary)';
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
          e.currentTarget.style.color = 'var(--color-text-muted)';
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
  );
});

DocumentItem.displayName = 'DocumentItem';

export const DocumentList: React.FC<DocumentListProps> = React.memo(
  ({ documents, onDelete, deletingId }) => {
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(300);
    const listRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);

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
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--spacing-xxl)',
            color: 'var(--color-text-muted)',
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ marginBottom: 'var(--spacing-md)', opacity: 0.5 }}
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <p
            style={{
              fontSize: 'var(--font-size-body)',
              fontFamily: 'var(--font-family)',
              textAlign: 'center',
            }}
          >
            No documents uploaded yet
          </p>
        </div>
      );
    }

    const totalItems = documents.length;
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
    const endIndex = Math.min(
      totalItems,
      Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + BUFFER
    );
    const visibleDocuments = documents.slice(startIndex, endIndex);
    const totalHeight = totalItems * ITEM_HEIGHT;

    return (
      <div
        ref={listRef}
        role="list"
        aria-label="Uploaded documents"
        style={{
          border: '1px solid var(--color-bubble-system)',
          borderRadius: '12px',
          overflow: 'hidden',
        }}
      >
        {/* Placeholder div maintains the full scroll height for the scrollbar */}
        <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
          {visibleDocuments.map((doc, i) => {
            const index = startIndex + i;
            return (
              <div
                key={doc.id}
                style={{
                  position: 'absolute',
                  top: `${index * ITEM_HEIGHT}px`,
                  left: 0,
                  right: 0,
                  height: `${ITEM_HEIGHT}px`,
                }}
              >
                <DocumentItem
                  doc={doc}
                  onDelete={onDelete}
                  isDeleting={deletingId === doc.id}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);

DocumentList.displayName = 'DocumentList';
