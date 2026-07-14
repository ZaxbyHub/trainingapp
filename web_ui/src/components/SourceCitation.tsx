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

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { CitationRef } from '../types/chat';

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

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

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

  // ---- Structured citation mode (F7) ----
  if (citations && citations.length > 0) {
    return (
      <div
        style={{
          marginTop: 'var(--spacing-sm)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--spacing-xs)',
        }}
      >
        {citations.map((cite, index) => {
          const key = `cite-${index}-${cite.docId}-${cite.chunkIndex}`;
          const label = cite.source ? getBasename(cite.source) : cite.docId;
          const pageSuffix = typeof cite.page === 'number' ? ` (p. ${cite.page})` : '';
          const isExpanded = expandedKey === key;
          const isCopied = copiedKey === key;

          const pillStyle: React.CSSProperties = {
            backgroundColor: 'var(--color-source-pill-bg)',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: 'var(--font-size-small)',
            color: 'var(--color-text-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            maxWidth: '240px',
            cursor: 'pointer',
            position: 'relative',
          };

          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              aria-label={`Source ${index + 1}: ${label}${pageSuffix}`}
              style={pillStyle}
              onClick={() => handleToggleExpand(key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleToggleExpand(key);
                }
              }}
            >
              <span style={{ fontWeight: 600 }}>[{index + 1}]</span>
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`${label}${pageSuffix}`}
              >
                {label}
                {pageSuffix}
              </span>
              {cite.text && (
                <button
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0',
                    fontSize: 'var(--font-size-caption)',
                    color: 'var(--color-text-muted)',
                    opacity: isCopied ? 0.7 : 0.5,
                    transition: 'opacity 0.15s ease',
                    flexShrink: 0,
                  }}
                  onClick={(e) => handleCopy(key, cite.text ?? '', e)}
                  aria-label={isCopied ? 'Copied' : 'Copy source text'}
                  type="button"
                >
                  {isCopied ? '✓' : 'Copy'}
                </button>
              )}
              {isExpanded && cite.text && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: '4px',
                    backgroundColor: 'var(--color-bubble-assistant)',
                    color: 'var(--color-text-on-bubble-assistant)',
                    padding: 'var(--spacing-sm)',
                    borderRadius: '4px',
                    fontSize: 'var(--font-size-caption)',
                    zIndex: 10,
                    maxWidth: '360px',
                    whiteSpace: 'normal',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    lineHeight: 'var(--line-height-body)',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {cite.text}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ---- Legacy mode (string sources) ----
  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        marginTop: 'var(--spacing-sm)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--spacing-xs)',
      }}
    >
      {sources.map((source, index) => {
        const filename = getBasename(source);
        const key = `source-${index}-${source}`;
        const isExpanded = expandedKey === key;
        const isCopied = copiedKey === key;

        const pillStyle: React.CSSProperties = {
          backgroundColor: 'var(--color-source-pill-bg)',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: 'var(--font-size-small)',
          color: 'var(--color-text-muted)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          maxWidth: '200px',
          cursor: 'pointer',
          position: 'relative',
        };

        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            style={pillStyle}
            onClick={() => handleToggleExpand(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleToggleExpand(key);
              }
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={source}>
              {filename}
            </span>
            <button
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '0',
                fontSize: 'var(--font-size-caption)',
                color: 'var(--color-text-muted)',
                opacity: isCopied ? 0.7 : 0.5,
                transition: 'opacity 0.15s ease',
                flexShrink: 0,
              }}
              onClick={(e) => handleCopy(key, source, e)}
              aria-label={isCopied ? 'Copied' : 'Copy source path'}
              type="button"
            >
              {isCopied ? '✓' : 'Copy'}
            </button>
            {isExpanded && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: '4px',
                  backgroundColor: 'var(--color-bubble-assistant)',
                  color: 'var(--color-text-on-bubble-assistant)',
                  padding: 'var(--spacing-xs)',
                  borderRadius: '4px',
                  fontSize: 'var(--font-size-caption)',
                  zIndex: 10,
                  whiteSpace: 'nowrap',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {source}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

SourceCitation.displayName = 'SourceCitation';
