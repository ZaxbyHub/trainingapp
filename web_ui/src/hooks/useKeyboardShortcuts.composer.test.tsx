/**
 * #267 (AC6, frozen check C25-companion — C22): composer-aware bail-outs —
 * Ctrl/Cmd+Shift+L and Ctrl/Cmd+, work FROM THE COMPOSER
 * (`[data-chat-composer]`), are ignored in other inputs, Ctrl/Cmd+K works
 * from any target, and Ctrl/Cmd+Enter stays composer-owned (ChatInput sends
 * it itself; the global hook must not double-send).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function Probe({
  onSendMessage,
  onClearChat,
  onOpenSettings,
}: {
  onSendMessage: () => void;
  onClearChat: () => void;
  onOpenSettings: () => void;
}) {
  useKeyboardShortcuts({ onSendMessage, onClearChat, onOpenSettings });
  return (
    <div>
      <div data-chat-composer="true">
        <textarea aria-label="composer" data-chat-composer="true" />
      </div>
      <input type="text" aria-label="other input" />
      <div aria-label="plain area">plain</div>
    </div>
  );
}

function setup() {
  const onSendMessage = vi.fn();
  const onClearChat = vi.fn();
  const onOpenSettings = vi.fn();
  const { container } = render(
    <Probe onSendMessage={onSendMessage} onClearChat={onClearChat} onOpenSettings={onOpenSettings} />,
  );
  const composer = container.querySelector('textarea[data-chat-composer]')!;
  const otherInput = container.querySelector('input')!;
  const plain = container.querySelector('[aria-label="plain area"]')!;
  const keyOn = (target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return { composer, otherInput, plain, keyOn, onSendMessage, onClearChat, onOpenSettings };
}

describe('useKeyboardShortcuts composer carve-outs (#267 AC6)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('Ctrl+Shift+L clears the chat FROM THE COMPOSER', () => {
    const { composer, keyOn, onClearChat } = setup();
    const event = keyOn(composer, 'L', { ctrlKey: true, shiftKey: true });
    expect(onClearChat).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+Shift+L is ignored in OTHER inputs', () => {
    const { otherInput, keyOn, onClearChat } = setup();
    const event = keyOn(otherInput, 'L', { ctrlKey: true, shiftKey: true });
    expect(onClearChat).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('plain Ctrl+L (the browser address bar) is never hijacked', () => {
    const { plain, keyOn, onClearChat } = setup();
    const event = keyOn(plain, 'l', { ctrlKey: true });
    expect(onClearChat).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl+, opens Settings from the composer', () => {
    const { composer, keyOn, onOpenSettings } = setup();
    const event = keyOn(composer, ',', { ctrlKey: true });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+, is ignored in other inputs', () => {
    const { otherInput, keyOn, onOpenSettings } = setup();
    const event = keyOn(otherInput, ',', { ctrlKey: true });
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl+Enter stays COMPOSER-OWNED: the global hook does not send it', () => {
    const { composer, keyOn, onSendMessage } = setup();
    const event = keyOn(composer, 'Enter', { ctrlKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl+Enter from a non-editable target still sends (the pre-existing binding)', () => {
    const { plain, keyOn, onSendMessage } = setup();
    keyOn(plain, 'Enter', { ctrlKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });
});
