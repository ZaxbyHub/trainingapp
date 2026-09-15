/**
 * LearnPanel — the "where to learn this" panel (D6, issue #82).
 *
 * Rendered inside an assistant chat bubble when the response carries
 * learn[] rows: one row per training slide ("Section > Slide title", a
 * one-line snippet, and an "Open in training" button that deep-links into
 * the embedded Storyline player at that slide via TrainingPlayer's
 * jumpToSlide primitive).
 */
import React from 'react';
import type { CSSProperties } from 'react';
import type { LearnResult } from '../lib/api/types';

export interface LearnPanelProps {
  learn: LearnResult[];
  /** Navigate into the training player at the given slide. */
  onOpenTraining?: (target: { packId?: string; slideId: string }) => void;
}

const panelStyle: CSSProperties = {
  marginTop: 'var(--spacing-sm)',
  border: '1px solid var(--color-border, var(--color-text-muted))',
  borderRadius: 'var(--radius-md, 8px)',
  padding: 'var(--spacing-sm)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-xs)',
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--font-size-caption)',
  fontWeight: 600,
  color: 'var(--color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--spacing-sm)',
  padding: 'var(--spacing-xs) 0',
};

const metaStyle: CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
};

const titleStyle: CSSProperties = {
  fontSize: 'var(--font-size-body, 0.9rem)',
  fontWeight: 600,
  color: 'var(--color-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const snippetStyle: CSSProperties = {
  fontSize: 'var(--font-size-caption)',
  color: 'var(--color-text-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const buttonStyle: CSSProperties = {
  flexShrink: 0,
  backgroundColor: 'transparent',
  color: 'var(--color-accent, var(--color-text))',
  border: '1px solid var(--color-accent, var(--color-text-muted))',
  borderRadius: 'var(--radius-sm, 6px)',
  padding: 'var(--spacing-xs) var(--spacing-sm)',
  fontSize: 'var(--font-size-caption)',
  fontFamily: 'var(--font-family)',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

export const LearnPanel: React.FC<LearnPanelProps> = React.memo(({ learn, onOpenTraining }) => {
  if (learn.length === 0) return null;
  return (
    <section style={panelStyle} aria-label="Learn panel — where to learn this">
      <h4 style={headingStyle}>Learn where this comes from</h4>
      {learn.map((result) => (
        <div key={result.slide_id} style={rowStyle}>
          <div style={metaStyle}>
            <span style={titleStyle}>
              {result.section ? `${result.section} > ` : ''}
              {result.title}
            </span>
            {result.snippet && <span style={snippetStyle}>{result.snippet}</span>}
          </div>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => onOpenTraining?.({ packId: result.pack_id, slideId: result.slide_id })}
            aria-label={`Open in training: ${result.section ? `${result.section} — ` : ''}${result.title}`}
          >
            Open in training
          </button>
        </div>
      ))}
    </section>
  );
});

LearnPanel.displayName = 'LearnPanel';
