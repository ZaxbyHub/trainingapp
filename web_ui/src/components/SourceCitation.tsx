/**
 * Source citation pills component.
 * Displays source file paths as compact pills with expand and copy functionality.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

interface SourceCitationProps {
  sources: string[];
  onCopySource?: (source: string) => void;
}

function getBasename(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : fullPath;
}

export const SourceCitation: React.FC<SourceCitationProps> = React.memo(({ sources, onCopySource }) => {
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [copiedSource, setCopiedSource] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(
    async (source: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(source);
        setCopiedSource(source);
        onCopySource?.(source);
        if (copyTimerRef.current !== null) {
          clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = setTimeout(() => {
          setCopiedSource((prev) => (prev === source ? null : prev));
          copyTimerRef.current = null;
        }, 1500);
      } catch {
        // Clipboard API not available
      }
    },
    [onCopySource]
  );

  const handleToggleExpand = useCallback((source: string) => {
    setExpandedSource((prev) => (prev === source ? null : source));
  }, []);

  if (!sources || sources.length === 0) {
    return null;
  }

  const containerStyle: React.CSSProperties = {
    marginTop: 'var(--spacing-sm)',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--spacing-xs)',
  };

  return (
    <div style={containerStyle}>
      {sources.map((source, index) => {
        const filename = getBasename(source);
        const isExpanded = expandedSource === source;
        const isCopied = copiedSource === source;

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

        const filenameStyle: React.CSSProperties = {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        };

        const copyButtonStyle: React.CSSProperties = {
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '0',
          fontSize: 'var(--font-size-caption)',
          color: isCopied ? 'var(--color-text-muted)' : 'var(--color-text-muted)',
          opacity: isCopied ? 0.7 : 0.5,
          transition: 'opacity 0.15s ease',
          flexShrink: 0,
        };

        return (
          <div
            key={`source-${index}-${source}`}
            role="button"
            tabIndex={0}
            style={pillStyle}
            onClick={() => handleToggleExpand(source)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleToggleExpand(source);
              }
            }}
          >
            <span style={filenameStyle} title={source}>
              {filename}
            </span>
            <button
              style={copyButtonStyle}
              onClick={(e) => handleCopy(source, e)}
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
