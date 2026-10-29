/**
 * Review-round F5 pin (delta re-review): the Copy-source affordance must be
 * shape-gated — absent on plain-prose assistant messages, present when the
 * content carries markdown shapes (the frozen C2 battery pins only the
 * markdown side; this spec pins the negative half).
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatMessageBubble } from './ChatMessageBubble';
import type { ChatMessage } from '../types/chat';

const assistant = (content: string): ChatMessage => ({
  id: 'a-gate',
  role: 'assistant',
  content,
  timestamp: Date.now(),
});

describe('#35 review F5: Copy source shape gate', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it('plain-prose assistant message renders NO Copy source action', () => {
    render(<ChatMessageBubble message={assistant('Yes, the policy was updated in March.')} />);
    expect(screen.queryByRole('button', { name: /copy source/i })).toBeNull();
    // The default Copy affordance stays reachable.
    expect(screen.getByRole('button', { name: /copy message/i })).toBeInTheDocument();
  });

  it('markdown-shaped assistant message renders the Copy source action', () => {
    render(<ChatMessageBubble message={assistant('Policy **15 days** per year [1].')} />);
    expect(screen.getByRole('button', { name: /copy source/i })).toBeInTheDocument();
  });
});
