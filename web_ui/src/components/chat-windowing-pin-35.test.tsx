/**
 * Frozen acceptance check (trace 35-residuals-chat-ux) for ZaxbyHub/
 * trainingapp#35 residual C5 — first test coverage for the render-only
 * message window.
 *
 * - C7 / AC7 (PRESERVING pin of EXISTING behavior; first coverage for it),
 *   token c7-windowing-pin: with 205 messages in the conversation, the list
 *   renders exactly the LAST 200 message bubbles and shows the indicator
 *   "5 earlier messages hidden (showing the last 200)". This behavior
 *   exists at base (ChatMessageList MAX_RENDERED_MESSAGES = 200) but had
 *   zero running coverage — this pin is GREEN at base and must stay GREEN.
 *
 * useDocumentCount is mocked so the pin stays hermetic (it only feeds the
 * empty-chat welcome state, which is not rendered here).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatMessageList } from './ChatMessageList';
import type { ChatMessage } from '../types/chat';

vi.mock('../hooks/useDocumentCount', () => ({
  useDocumentCount: () => ({
    count: 5,
    loading: false,
    recount: () => Promise.resolve(),
  }),
}));

describe('#35 C5 message windowing pin (frozen acceptance)', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('c7-windowing-pin: 205 messages render only the last 200 bubbles plus the window indicator', () => {
    const messages: ChatMessage[] = Array.from({ length: 205 }, (_, i) => ({
      id: `msg-${i}`,
      role: 'user' as const,
      content: `Window pin message number ${i}.`,
      timestamp: Date.now() - (205 - i) * 1000,
    }));

    const { container } = render(
      <ChatMessageList messages={messages} isStreaming={false} />
    );

    // Exactly the last 200 bubbles render.
    const bubbles = container.querySelectorAll('[data-role]');
    expect(bubbles.length).toBe(200);

    // The indicator names what is hidden and what is shown.
    const note = container.querySelector('.chat-log__window-note');
    expect(note, 'the render-window indicator must be present').not.toBeNull();
    expect(note?.textContent ?? '').toContain('5 earlier messages hidden');
    expect(note?.textContent ?? '').toContain('(showing the last 200)');

    // The window is the TAIL: first rendered message is #5, last is #204,
    // and #0..#4 are not painted at all.
    const text = container.textContent ?? '';
    expect(text).toContain('Window pin message number 5.');
    expect(text).toContain('Window pin message number 204.');
    expect(text).not.toContain('Window pin message number 4.');
    expect(text).not.toContain('Window pin message number 0.');
  });
});
