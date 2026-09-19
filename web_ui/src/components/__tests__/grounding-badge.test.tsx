// grounding-badge.test.tsx — C1 browser leg (issue #72): the assistant bubble
// renders the grounded provenance badge when the message carries
// grounding="grounded". Frozen check driver repro/check-c1.sh runs this file.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessageBubble } from '../ChatMessageBubble';
import type { ChatMessage } from '../../types/chat';

function messageWith(grounding: ChatMessage['grounding']): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'Meals are capped at 50 per day.',
    grounding,
    timestamp: Date.now(),
  };
}

describe('GroundingBadge render in ChatMessageBubble', () => {
  it('renders the grounded badge for grounding="grounded"', () => {
    render(<ChatMessageBubble message={messageWith('grounded')} />);
    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.textContent).toContain('Grounded in your documents');
  });

  it('renders the general badge for grounding="general"', () => {
    render(<ChatMessageBubble message={messageWith('general')} />);
    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.textContent).toContain('General knowledge');
  });
});
