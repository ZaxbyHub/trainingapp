/**
 * #267 (AC2, frozen check C18): ArrowDown walks back toward the newest
 * entry; pressing it PAST the newest restores the pre-browse draft.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ChatInput } from './ChatInput';

const HISTORY = ['first question', 'second question', 'third question'];

function setup() {
  render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} history={HISTORY} />);
  return screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
}

/**
 * Raw dispatch keeps defaultPrevented readable; the async act flush lands
 * React's controlled-value update before assertions.
 */
async function key(target: HTMLTextAreaElement, k: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  await act(async () => {});
  return event;
}

describe('ChatInput history walk (#267 AC2)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('ArrowDown walks NEWER after stepping older', async () => {
    const textarea = setup();
    await key(textarea, 'ArrowUp'); // third
    await key(textarea, 'ArrowUp'); // second
    expect(textarea.value).toBe('second question');
    await key(textarea, 'ArrowDown');
    expect(textarea.value).toBe('third question');
  });

  it('ArrowDown PAST the newest restores the pre-browse draft', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'my unfinished draft' } });
    await key(textarea, 'ArrowUp'); // third (draft stashed)
    await key(textarea, 'ArrowDown'); // past the newest -> stash restored
    expect(textarea.value).toBe('my unfinished draft');
  });

  it('the restore is preventDefault-ed; ArrowDown without browse mode is native', async () => {
    const textarea = setup();
    // Not browsing: ArrowDown does nothing to the value and is not prevented.
    fireEvent.change(textarea, { target: { value: 'abc' } });
    const native = await key(textarea, 'ArrowDown');
    expect(native.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('abc');
    // After a browse cycle, the exit press IS prevented (it acted).
    await key(textarea, 'ArrowUp');
    const exit = await key(textarea, 'ArrowDown');
    expect(exit.defaultPrevented).toBe(true);
    // Exiting past the newest restores the stashed pre-browse draft ('abc').
    expect(textarea.value).toBe('abc');
  });

  it('a second browse cycle stashes the CURRENT draft again', async () => {
    const textarea = setup();
    fireEvent.change(textarea, { target: { value: 'draft one' } });
    await key(textarea, 'ArrowUp');
    await key(textarea, 'ArrowDown'); // restore 'draft one'
    expect(textarea.value).toBe('draft one');
    await key(textarea, 'ArrowUp');
    await key(textarea, 'ArrowDown');
    expect(textarea.value).toBe('draft one');
  });
});
