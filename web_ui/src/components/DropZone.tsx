/**
 * DropZone component for drag-and-drop file uploads.
 * Supports clicking to open file picker as well.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Icon } from '../ui';
import { cx } from '../ui/cx';
import '../pages/documents.css';

interface DropZoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  disabled?: boolean;
  /**
   * U7a: optional callback invoked with the files dropped on the zone that
   * were rejected by the `accept` filter, so callers can surface rejection
   * feedback (or recognize specific file types — e.g. the ADR-0009 pack
   * gate). When omitted the filter stays silent (preserves existing
   * behavior). Only fires for the drag-and-drop path — the native file picker
   * already enforces `accept` and never offers unsupported files. Callers
   * derive display names via `file.name`.
   */
  onFilesRejected?: (files: File[]) => void;
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
  ({ onFilesSelected, accept, disabled = false, onFilesRejected }) => {
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
        const allDropped = Array.from(e.dataTransfer.files);
        const files = allDropped.filter((f) => matchesAccept(f, accept));
        // U7a: surface the rejected files so callers can show feedback instead
        // of silently dropping them. Silent when the callback isn't provided.
        if (onFilesRejected) {
          const rejected = allDropped.filter((f) => !matchesAccept(f, accept));
          if (rejected.length > 0) {
            onFilesRejected(rejected);
          }
        }
        if (files.length > 0) {
          onFilesSelected(files);
        }
      },
      [disabled, onFilesSelected, accept, onFilesRejected]
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
        className={cx(
          'app-dropzone',
          'ui-focusable',
          isDragOver && 'app-dropzone--active',
          disabled && 'app-dropzone--disabled'
        )}
      >
        {/* Hidden (display:none via the hidden attribute, as before): never
            visually-hidden, which would leave an aria-hidden focusable input. */}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          onChange={handleInputChange}
          disabled={disabled}
          hidden
          aria-hidden="true"
        />

        <Icon name="upload" size={32} className="app-dropzone__icon" />

        <p className="app-dropzone__title">
          {isDragOver
            ? 'Drop files here'
            : 'Drag and drop files here, or click to select'}
        </p>

        <p className="app-dropzone__hint">Supports PDF, DOCX, XLSX, PPTX, TXT, MD</p>
      </div>
    );
  }
);

DropZone.displayName = 'DropZone';
