/**
 * DropZone component for drag-and-drop file uploads.
 * Supports clicking to open file picker as well.
 */

import React, { useCallback, useRef, useState } from 'react';

interface DropZoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  disabled?: boolean;
}

/**
 * F15: check whether a file matches an `accept` filter. The native file picker
 * (<input type="file" accept>) applies this automatically, but the drag-and-
 * drop path previously forwarded every dropped file regardless of `accept`.
 * This shared helper normalizes both paths. `accept` is a comma-separated list
 * of extensions (e.g. ".pdf,.docx,.txt") and/or MIME types; an undefined/empty
 * accept matches everything.
 */
export function matchesAccept(file: File, accept?: string): boolean {
  if (!accept || accept.trim().length === 0) {
    return true;
  }
  const tokens = accept
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }
  const name = file.name.toLowerCase();
  const mime = (file.type ?? '').toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith('.')) {
      return name.endsWith(token);
    }
    // MIME token — allow prefix matches like "text/*".
    if (token.endsWith('/*')) {
      return mime.startsWith(token.slice(0, -1));
    }
    return mime === token;
  });
}

export const DropZone: React.FC<DropZoneProps> = React.memo(
  ({ onFilesSelected, accept, disabled = false }) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [isDragOver, setIsDragOver] = useState(false);

    const handleDragOver = useCallback(
      (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) {
          setIsDragOver(true);
        }
      },
      [disabled]
    );

    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
    }, []);

    const handleDrop = useCallback(
      (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        if (disabled) {
          return;
        }

        // F15: apply the same accept filter the native file picker uses, so
        // unsupported files dropped via drag-and-drop are filtered out instead
        // of reaching the extractor and failing later.
        const files = Array.from(e.dataTransfer.files).filter((f) => matchesAccept(f, accept));
        if (files.length > 0) {
          onFilesSelected(files);
        }
      },
      [disabled, onFilesSelected, accept]
    );

    const handleClick = useCallback(() => {
      if (!disabled && inputRef.current) {
        inputRef.current.click();
      }
    }, [disabled]);

    const handleInputChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0) {
          onFilesSelected(files);
        }
        // Reset input so same file can be selected again
        e.target.value = '';
      },
      [onFilesSelected]
    );

    return (
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Drop files here or click to select"
        aria-disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--spacing-xxl)',
          border: `2px dashed ${
            isDragOver
              ? 'var(--color-primary)'
              : disabled
              ? 'var(--color-text-muted)'
              : 'var(--color-bubble-system)'
          }`,
          borderRadius: '12px',
          backgroundColor: isDragOver
            ? 'rgba(var(--color-primary-rgb), 0.1)'
            : 'transparent',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'all 0.2s ease',
          minHeight: '200px',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          onChange={handleInputChange}
          disabled={disabled}
          style={{ display: 'none' }}
          aria-hidden="true"
        />

        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke={disabled ? 'var(--color-text-muted)' : 'var(--color-primary)'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ marginBottom: 'var(--spacing-md)' }}
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>

        <p
          style={{
            fontSize: 'var(--font-size-body)',
            fontFamily: 'var(--font-family)',
            color: disabled ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
            marginBottom: 'var(--spacing-xs)',
            textAlign: 'center',
          }}
        >
          {isDragOver
            ? 'Drop files here'
            : 'Drag and drop files here, or click to select'}
        </p>

        <p
          style={{
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
            color: 'var(--color-text-muted)',
            textAlign: 'center',
          }}
        >
          Supports PDF, DOCX, XLSX, PPTX, TXT, MD
        </p>
      </div>
    );
  }
);

DropZone.displayName = 'DropZone';
