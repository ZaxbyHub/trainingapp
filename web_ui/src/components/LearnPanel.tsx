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
import type { LearnResult } from '../lib/api/types';
import { Button } from '../ui';
import '../pages/chat.css';

export interface LearnPanelProps {
  learn: LearnResult[];
  /** Navigate into the training player at the given slide. */
  onOpenTraining?: (target: { packId?: string; slideId: string }) => void;
}

export const LearnPanel: React.FC<LearnPanelProps> = React.memo(({ learn, onOpenTraining }) => {
  if (learn.length === 0) return null;
  return (
    <section className="chat-learn" aria-label="Learn panel — where to learn this">
      <h4 className="chat-learn__heading">Learn where this comes from</h4>
      {learn.map((result) => (
        <div key={result.slide_id} className="chat-learn__row">
          <div className="chat-learn__meta">
            <span className="chat-learn__title">
              {result.section ? `${result.section} > ` : ''}
              {result.title}
            </span>
            {result.snippet && <span className="chat-learn__snippet">{result.snippet}</span>}
          </div>
          <Button
            size="sm"
            className="chat-learn__open"
            onClick={() => onOpenTraining?.({ packId: result.pack_id, slideId: result.slide_id })}
            aria-label={`Open in training: ${result.section ? `${result.section} — ` : ''}${result.title}`}
          >
            Open in training
          </Button>
        </div>
      ))}
    </section>
  );
});

LearnPanel.displayName = 'LearnPanel';
