/**
 * PinnedSlideContext — the "Ask about this slide" banner (D7, issue #83).
 *
 * Rendered by ChatPage above the message list while the user has a training
 * slide pinned from the embedded Storyline player. Shows "Currently viewing:
 * Section > Slide title" (title-only when no section resolved), a dismiss
 * control, and an "Explain this step" control that submits a canned question
 * carrying the pin.
 *
 * Staleness (issue #83 AC5): a pin whose player session can no longer vouch
 * for it (pack switched, see App's staleness producer) is marked `stale` —
 * the banner then carries data-stale="true" AND a visible stale marker, and
 * ChatPage never attaches a stale pin to a question. A stale pin may never
 * present as a live one.
 */
import React from 'react';
import type { CSSProperties } from 'react';

export interface PinnedSlide {
  slideId: string;
  slideTitle: string;
  /** Resolved from the ingested slide-doc chunk; absent when unresolved. */
  section?: string;
  /** AC5 staleness flag — a stale pin is never silently reused. */
  stale?: boolean;
  /** Pack the slide was captured from; feeds App's pack-switch staleness. */
  packId?: string;
  /** Resolved on-screen text; included in the injected pinnedContext. */
  text?: string;
}

export interface PinnedSlideContextProps {
  pinnedSlide: PinnedSlide;
  onDismiss: () => void;
  onExplainThisStep?: () => void;
}

const bannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--spacing-sm)',
  margin: 'var(--spacing-xs) var(--spacing-lg)',
  padding: 'var(--spacing-xs) var(--spacing-sm)',
  border: '1px solid var(--color-border, var(--color-text-muted))',
  borderRadius: 'var(--radius-sm, 6px)',
  backgroundColor: 'var(--color-surface)',
  fontFamily: 'var(--font-family)',
  fontSize: 'var(--font-size-caption)',
};

const staleBannerStyle: CSSProperties = {
  ...bannerStyle,
  borderStyle: 'dashed',
  opacity: 0.75,
};

const labelStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--color-text)',
};

const staleLabelStyle: CSSProperties = {
  ...labelStyle,
  color: 'var(--color-text-muted)',
};

const buttonStyle: CSSProperties = {
  flexShrink: 0,
  backgroundColor: 'transparent',
  color: 'var(--color-accent, var(--color-text))',
  border: '1px solid var(--color-accent, var(--color-text-muted))',
  borderRadius: 'var(--radius-sm, 6px)',
  padding: '2px var(--spacing-sm)',
  fontSize: 'var(--font-size-caption)',
  fontFamily: 'var(--font-family)',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

const dismissButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: 'none',
  color: 'var(--color-text-muted)',
  fontSize: 'var(--font-size-body)',
  lineHeight: 1,
  padding: '2px var(--spacing-xs)',
};

/** Section > Title — section only when a non-blank string; never a bare " > ". */
export function pinnedSlideLabel(pinned: Pick<PinnedSlide, 'section' | 'slideTitle'>): string {
  const section = pinned.section?.trim();
  return section ? `${section} > ${pinned.slideTitle}` : pinned.slideTitle;
}

export const PinnedSlideContext: React.FC<PinnedSlideContextProps> = React.memo(
  ({ pinnedSlide, onDismiss, onExplainThisStep }) => {
    const stale = pinnedSlide.stale === true;
    return (
      <section
        data-testid="pinned-slide-context"
        data-stale={stale ? 'true' : undefined}
        style={stale ? staleBannerStyle : bannerStyle}
        aria-label={`Currently viewing: ${pinnedSlideLabel(pinnedSlide)}${stale ? ' (stale)' : ''}`}
      >
        <span style={stale ? staleLabelStyle : labelStyle}>
          Currently viewing:{' '}
          <strong>{pinnedSlideLabel(pinnedSlide)}</strong>
          {stale && ' — stale (player session moved on; not attached to questions)'}
        </span>
        <span style={{ display: 'flex', gap: 'var(--spacing-xs)', flexShrink: 0 }}>
          {!stale && (
            <button
              type="button"
              style={buttonStyle}
              onClick={onExplainThisStep}
              data-testid="pinned-slide-explain"
            >
              Explain this step
            </button>
          )}
          <button
            type="button"
            style={dismissButtonStyle}
            onClick={onDismiss}
            data-testid="pinned-slide-dismiss"
            aria-label="Dismiss pinned slide"
          >
            ×
          </button>
        </span>
      </section>
    );
  },
);

PinnedSlideContext.displayName = 'PinnedSlideContext';
