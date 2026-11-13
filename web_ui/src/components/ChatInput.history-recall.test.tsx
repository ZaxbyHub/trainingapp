/**
 * #267 (AC1, frozen check C17): ArrowUp recall — the first press fills the
 * composer with the NEWEST user message; repeated presses step older; it
 * stops at the oldest; the caret lands at the end.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ChatInput } from './ChatInput';

const HISTORY = ['first question', 'second question', 'third question'];

function setup(history: string[] = HISTORY) {
  const onSend = vi.fn();
  render(<ChatInput onSend={onSend} isLoading={false} onCancel={vi.fn()} history={history} />);
  const textarea = screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
  return { textarea, onSend };
}

/**
 * Raw dispatch keeps defaultPrevented readable; the async act flush lands
 * React's controlled-value update (and the caret effect) before assertions.
 */
async function arrowUp(target: HTMLTextAreaElement): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  await act(async () => {});
  return event;
}

describe('ChatInput history recall (#267 AC1)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('the first ArrowUp fills the composer with the NEWEST user message', async () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'my draft' } });
    await arrowUp(textarea);
    expect(textarea.value).toBe('third question');
  });

  it('repeated presses step older and STOP at the oldest', async () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: '' } });
    await arrowUp(textarea);
    expect(textarea.value).toBe('third question');
    await arrowUp(textarea);
    expect(textarea.value).toBe('second question');
    await arrowUp(textarea);
    expect(textarea.value).toBe('first question');
    // Stopped at the oldest: another press keeps the value and lets the
    // native caret move happen (no preventDefault).
    const stopped = await arrowUp(textarea);
    expect(textarea.value).toBe('first question');
    expect(stopped.defaultPrevented).toBe(false);
  });

  it('each recall is preventDefault-ed and moves the caret to the end', async () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'draft' } });
    const recalled = await arrowUp(textarea);
    expect(recalled.defaultPrevented).toBe(true);
    expect(textarea.selectionStart).toBe('third question'.length);
    expect(textarea.selectionEnd).toBe('third question'.length);
  });

  it('recall works from an empty composer (the fresh-turn case)', async () => {
    const { textarea } = setup();
    await arrowUp(textarea);
    expect(textarea.value).toBe('third question');
  });

  it('the recalled text is reported through onDraftChange', async () => {
    const onDraftChange = vi.fn();
    render(
      <ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} history={HISTORY} onDraftChange={onDraftChange} />,
    );
    const textarea = screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
    onDraftChange.mockClear();
    await arrowUp(textarea);
    expect(onDraftChange).toHaveBeenCalledWith('third question');
  });
});
