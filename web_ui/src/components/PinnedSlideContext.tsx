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
 * present as a live one (Lumen phase 5: dashed border + secondary text, styled
 * in pages/chat.css; the text marker stays the non-color cue).
 */
import React from 'react';
import { Button, IconButton } from '../ui';
import { cx } from '../ui/cx';
import '../pages/chat.css';

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

/** Section > Title — section only when a non-blank string; never a bare " > ".
 *  A blank slideTitle falls back to the slideId so the banner/injection can
 *  never render an empty label (the player protocol always sends one, but the
 *  payload is external input). */
export function pinnedSlideLabel(
  pinned: Pick<PinnedSlide, 'slideId' | 'section' | 'slideTitle'>
): string {
  const section = pinned.section?.trim();
  const title = pinned.slideTitle.trim() || pinned.slideId;
  return section ? `${section} > ${title}` : title;
}

export const PinnedSlideContext: React.FC<PinnedSlideContextProps> = React.memo(
  ({ pinnedSlide, onDismiss, onExplainThisStep }) => {
    const stale = pinnedSlide.stale === true;
    return (
      <section
        data-testid="pinned-slide-context"
        data-stale={stale ? 'true' : undefined}
        role="status"
        className={cx('chat-pin', stale && 'chat-pin--stale')}
        aria-label={`Currently viewing: ${pinnedSlideLabel(pinnedSlide)}${stale ? ' (stale)' : ''}`}
      >
        <span className="chat-pin__label">
          Currently viewing:{' '}
          <strong>{pinnedSlideLabel(pinnedSlide)}</strong>
          {stale && ' — stale (player session moved on; not attached to questions)'}
        </span>
        <span className="chat-pin__actions">
          {!stale && (
            <Button
              size="sm"
              onClick={onExplainThisStep}
              data-testid="pinned-slide-explain"
            >
              Explain this step
            </Button>
          )}
          <IconButton
            icon="x"
            size="sm"
            onClick={onDismiss}
            data-testid="pinned-slide-dismiss"
            aria-label="Dismiss pinned slide"
          />
        </span>
      </section>
    );
  },
);

PinnedSlideContext.displayName = 'PinnedSlideContext';
