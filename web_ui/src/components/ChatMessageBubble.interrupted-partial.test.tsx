/**
 * ChatMessageBubble.interrupted-partial.test.tsx — issue #269 AC12 (claim 6).
 *
 * WHEN an assistant message with non-empty content carries `interrupted: true`
 * and is not `stopped`, THE SYSTEM SHALL render its content together with the
 * "response was interrupted" note.
 *
 * Base defect: a checkpointed partial (AC5) survives a reload with non-empty
 * content and nothing distinguishes it from a finished answer. The
 * `interrupted` field does not exist on ChatMessage at base (the AC5
 * production change adds it), hence the local intersection type.
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatMessageBubble } from './ChatMessageBubble';
import type { ChatMessage } from '../types/chat';

const INTERRUPTED_NOTE = 'Response was interrupted. Use Regenerate to try again.';

describe('ChatMessageBubble interrupted partial (#269 AC12)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a checkpointed partial together with the interrupted note', () => {
    const message: ChatMessage & { interrupted?: boolean } = {
      id: 'a-interrupted-partial',
      role: 'assistant',
      content: 'CHECKPOINTED-PARTIAL-ANSWER',
      timestamp: Date.now(),
      interrupted: true,
    };

    render(<ChatMessageBubble message={message} />);

    // The partial content still renders...
    expect(screen.getByText(/CHECKPOINTED-PARTIAL-ANSWER/)).toBeInTheDocument();
    // ...together with the interrupted note (absent at base).
    expect(screen.getByText(INTERRUPTED_NOTE)).toBeInTheDocument();
  });
});
