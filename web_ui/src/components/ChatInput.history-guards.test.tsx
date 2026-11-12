/**
 * #267 (AC3, frozen check C19): the recall guard matrix — modifiers, IME
 * composition, non-collapsed selections, multi-line carets, and an empty
 * history leave the value unchanged WITHOUT preventDefault; editing ends
 * browse mode.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ChatInput } from './ChatInput';

const HISTORY = ['first question', 'second question', 'third question'];

function setup(history: string[] = HISTORY) {
  render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} history={history} />);
  return screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
}

async function key(
  target: HTMLTextAreaElement,
  k: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, 'isComposing', { value: init.isComposing === true });
  target.dispatchEvent(event);
  // Raw dispatch keeps defaultPrevented readable; the async act flush lands
  // React's controlled-value update before assertions.
  await act(async () => {});
  return event;
}

describe('ChatInput history guards (#267 AC3)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('modifier-held arrows leave the value unchanged and un-prevented', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'kept draft' } });
    for (const init of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      const up = await key(textarea, 'ArrowUp', init);
      expect(textarea.value).toBe('kept draft');
      expect(up.defaultPrevented).toBe(false);
      const down = await key(textarea, 'ArrowDown', init);
      expect(textarea.value).toBe('kept draft');
      expect(down.defaultPrevented).toBe(false);
    }
  });

  it('IME composition arrows are left to the input method', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'こんにちは' } });
    const composing = await key(textarea, 'ArrowUp', { isComposing: true } as KeyboardEventInit);
    expect(textarea.value).toBe('こんにちは');
    expect(composing.defaultPrevented).toBe(false);
  });

  it('a non-collapsed selection is not hijacked (selection extension wins)', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'some text' } });
    textarea.setSelectionRange(0, 4);
    const up = await key(textarea, 'ArrowUp');
    expect(textarea.value).toBe('some text');
    expect(up.defaultPrevented).toBe(false);
  });

  it('ArrowUp from a middle line of a multi-line draft does not blow the draft away', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'line one\nline two' } });
    // Caret on the SECOND line (after the newline).
    textarea.setSelectionRange('line one\n'.length, 'line one\n'.length);
    const up = await key(textarea, 'ArrowUp');
    expect(textarea.value).toBe('line one\nline two');
    expect(up.defaultPrevented).toBe(false);
  });

  it('ArrowUp from the FIRST line of a multi-line draft DOES recall', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'line one\nline two' } });
    textarea.setSelectionRange(3, 3); // first line
    await key(textarea, 'ArrowUp');
    expect(textarea.value).toBe('third question');
  });

  it('an empty (or absent) history never intercepts arrows', async () => {
    const textarea = setup([]);
    fireEvent.change(textarea, { target: { value: 'draft' } });
    const up = await key(textarea, 'ArrowUp');
    expect(textarea.value).toBe('draft');
    expect(up.defaultPrevented).toBe(false);
  });

  it('editing ends browse mode: a later ArrowDown is native, not a restore', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'stash' } });
    await key(textarea, 'ArrowUp'); // browsing at 'third question'
    expect(textarea.value).toBe('third question');
    // The user edits the recalled text.
    fireEvent.change(textarea, { target: { value: 'edited recall' } });
    const down = await key(textarea, 'ArrowDown');
    expect(textarea.value).toBe('edited recall');
    expect(down.defaultPrevented).toBe(false);
  });

  it('while generating, the composer is disabled — the keyboard cannot reach it', async () => {
    render(<ChatInput onSend={vi.fn()} isLoading={true} onCancel={vi.fn()} history={HISTORY} />);
    const textarea = screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
    // A disabled textarea cannot take focus, so no recall keydown can
    // originate from it while a generation is in flight.
    expect(textarea).toBeDisabled();
  });
});
