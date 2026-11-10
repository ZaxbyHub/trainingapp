/**
 * ChatMessageBubble.error-partial.test.tsx — issue #269 AC9 (claim 8).
 *
 * WHEN an assistant message has an error and non-empty streamed content, THE
 * SYSTEM SHALL render that content in addition to the error banner.
 *
 * Base defect: ChatPage's onError keeps the streamed partial
 * (`{ ...msg, error, isStreaming: false }`) and persists it, but the bubble's
 * error branch renders only the danger Banner and its
 * `.chat-msg__error-detail` string — never `message.content` — so the partial
 * answer the user already watched stream in disappears behind the error card.
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatMessageBubble } from './ChatMessageBubble';
import type { ChatMessage } from '../types/chat';

describe('ChatMessageBubble error branch keeps the streamed partial (#269 AC9)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the streamed partial content in addition to the error banner', () => {
    const message: ChatMessage = {
      id: 'a-error-partial',
      role: 'assistant',
      content: 'PARTIAL-ANSWER-BEFORE-FAILURE',
      timestamp: Date.now(),
      error: 'generation failed mid-stream',
    };

    const { container } = render(<ChatMessageBubble message={message} />);

    // The error banner still renders (unchanged contract)...
    expect(screen.getByText('Something went wrong while answering.')).toBeInTheDocument();
    expect(container.querySelector('.chat-msg__error-detail')).toHaveTextContent('generation failed mid-stream');

    // ...AND the streamed partial is visible alongside it (absent at base).
    const partialEl = screen.getByText(/PARTIAL-ANSWER-BEFORE-FAILURE/);
    expect(partialEl).toBeInTheDocument();

    // AMENDED (critic required revision 4): the partial must be rendered as
    // message content, NOT folded into the error card. It must sit outside
    // the danger banner and outside its `.chat-msg__error-detail` string...
    const banner = container.querySelector('.ui-banner');
    const detail = container.querySelector('.chat-msg__error-detail');
    expect(banner, 'the error banner element must render').not.toBeNull();
    expect(detail, 'the error detail element must render').not.toBeNull();
    expect(
      (banner as HTMLElement).contains(partialEl),
      'the streamed partial must not be rendered inside the error banner'
    ).toBe(false);
    expect(
      (detail as HTMLElement).contains(partialEl),
      'the streamed partial must not be rendered inside .chat-msg__error-detail'
    ).toBe(false);
    // ...and it must appear ABOVE the banner (earlier in DOM order).
    expect(
      partialEl.compareDocumentPosition(banner as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the streamed partial must precede (render above) the error banner in DOM order'
    ).toBeTruthy();
  });
});
