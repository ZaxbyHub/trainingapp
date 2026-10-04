/**
 * Source citation pills component.
 *
 * Two render modes:
 *  - Structured (F7): `citations` carries per-chunk metadata (filename, page,
 *    text). Pills are numbered [1], [2], ... in the SAME order the model was
 *    shown the context, so a model-emitted "[2]" resolves to citations[1].
 *    Clicking a pill opens a popover with the chunk's source text.
 *  - Legacy: `sources` is a string array of paths/IDs (older persisted
 *    messages). Pills show the basename with copy/expand, as before.
 */

import React, { useState, useCallback, useRef, useEffect, useId } from 'react';
import type { CitationRef } from '../types/chat';
import { Button, Icon } from '../ui';
import '../pages/chat.css';

interface SourceCitationProps {
  /** Legacy: bare source path/id strings. */
  sources?: string[];
  /** Structured per-chunk citations aligned with the model's [1],[2] order. */
  citations?: CitationRef[];
  onCopySource?: (source: string) => void;
}

function getBasename(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : fullPath;
}

export const SourceCitation: React.FC<SourceCitationProps> = React.memo(({ sources, citations, onCopySource }) => {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Close the open popover on outside click or Escape (at the document level
  // so the keydown works regardless of focus location).
  useEffect(() => {
    if (expandedKey === null) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpandedKey(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpandedKey(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [expandedKey]);

  const handleCopy = useCallback(
    async (key: string, text: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        setCopiedKey(key);
        onCopySource?.(text);
        if (copyTimerRef.current !== null) {
          clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = setTimeout(() => {
          setCopiedKey((prev) => (prev === key ? null : prev));
          copyTimerRef.current = null;
        }, 1500);
      } catch {
        // Clipboard API not available
      }
    },
    [onCopySource]
  );

  const handleToggleExpand = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  }, []);

  // Pill keyboard contract (unchanged): Enter/Space toggle the popover, Escape closes it.
  const pillKeyDown = (key: string) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggleExpand(key);
    }
    if (e.key === 'Escape') {
      setExpandedKey(null);
    }
  };

  // ---- Structured citation mode (F7) ----
  if (citations && citations.length > 0) {
    return (
      <CitationGroup containerRef={containerRef} listId={listId} count={citations.length}>
        {citations.map((cite, index) => {
          const key = `cite-${index}-${cite.docId}-${cite.chunkIndex}`;
          const label = cite.source ? getBasename(cite.source) : cite.docId;
          const pageSuffix = typeof cite.page === 'number' ? ` (p. ${cite.page})` : '';
          // C7 (issue #74): pack provenance — `<pack> v<version>` for chunks
          // attributed to a knowledge pack (mirrored into the accessible
          // label and the hover title so screen readers get the provenance).
          const packSuffix =
            cite.packId && cite.packVersion ? ` — ${cite.packId} v${cite.packVersion}` : '';
          const isExpanded = expandedKey === key;
          const isCopied = copiedKey === key;
          const popoverId = `${listId}-pop-${index}`;

          // The pill and its Copy button are SIBLINGS inside the chip (a button
          // nested in a role="button" is an axe nested-interactive violation).
          return (
            <div key={key} className="chat-cite" data-expanded={isExpanded || undefined}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={isExpanded && cite.text ? popoverId : undefined}
                aria-label={`Source ${index + 1}: ${label}${pageSuffix}${packSuffix}`}
                className="chat-cite__pill ui-focusable"
                onClick={() => handleToggleExpand(key)}
                onKeyDown={pillKeyDown(key)}
              >
                <span className="chat-cite__num">[{index + 1}]</span>
                <span className="chat-cite__label" title={`${label}${pageSuffix}${packSuffix}`}>
                  {label}
                  {pageSuffix}
                  {packSuffix && <span className="chat-cite__pack">{packSuffix}</span>}
                </span>
              </div>
              {cite.text && (
                <button
                  className="chat-cite__copy ui-focusable"
                  onClick={(e) => handleCopy(key, cite.text ?? '', e)}
                  aria-label={isCopied ? 'Copied' : 'Copy source text'}
                  type="button"
                >
                  {isCopied ? '✓' : 'Copy'}
                </button>
              )}
              {isExpanded && cite.text && (
                <div id={popoverId} className="chat-cite__popover" onClick={(e) => e.stopPropagation()}>
                  {cite.text}
                </div>
              )}
            </div>
          );
        })}
      </CitationGroup>
    );
  }

  // ---- Legacy mode (string sources) ----
  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <CitationGroup containerRef={containerRef} listId={listId} count={sources.length}>
      {sources.map((source, index) => {
        const filename = getBasename(source);
        const key = `source-${index}-${source}`;
        const isExpanded = expandedKey === key;
        const isCopied = copiedKey === key;
        const popoverId = `${listId}-pop-${index}`;

        return (
          <div key={key} className="chat-cite chat-cite--legacy" data-expanded={isExpanded || undefined}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              aria-controls={isExpanded ? popoverId : undefined}
              aria-label={`Source ${index + 1}: ${filename}`}
              className="chat-cite__pill ui-focusable"
              onClick={() => handleToggleExpand(key)}
              onKeyDown={pillKeyDown(key)}
            >
              <span className="chat-cite__label" title={source}>
                {filename}
              </span>
            </div>
            <button
              className="chat-cite__copy ui-focusable"
              onClick={(e) => handleCopy(key, source, e)}
              aria-label={isCopied ? 'Copied' : 'Copy source path'}
              type="button"
            >
              {isCopied ? '✓' : 'Copy'}
            </button>
            {isExpanded && (
              <div id={popoverId} className="chat-cite__popover chat-cite__popover--path" onClick={(e) => e.stopPropagation()}>
                {source}
              </div>
            )}
          </div>
        );
      })}
    </CitationGroup>
  );
});

/**
 * Wrapper shared by both modes. At <= 500px (design-language.md section 3.5) the
 * chips collapse behind a count chip ("2 sources"); the toggle and the collapse are
 * CSS-driven (chat.css), so wider layouts never show the toggle.
 */
function CitationGroup({
  containerRef,
  listId,
  count,
  children,
}: {
  containerRef: React.RefObject<HTMLDivElement>;
  listId: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div ref={containerRef} className="chat-cites">
      <Button
        size="sm"
        className="chat-cites__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        {count} {count === 1 ? 'source' : 'sources'}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
      </Button>
      <div id={listId} className="chat-cites__list" data-collapsed={open ? 'false' : 'true'}>
        {children}
      </div>
    </div>
  );
}

SourceCitation.displayName = 'SourceCitation';
