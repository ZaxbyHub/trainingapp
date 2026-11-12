/**
 * #267 (AC5, frozen check C21): Ctrl/Cmd+K focuses the composer from ANY
 * target (including other inputs); plain '/' focuses it when the target is
 * NOT editable and is never intercepted from an input.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function Probe({ onFocusComposer }: { onFocusComposer: () => void }) {
  useKeyboardShortcuts({
    onOpenSettings: vi.fn(),
    onFocusComposer,
  });
  return (
    <div>
      <input type="text" aria-label="other input" />
      <button type="button">plain target</button>
    </div>
  );
}

function keyOn(target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('useKeyboardShortcuts composer focus (#267 AC5)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('Ctrl+K from a NON-editable target focuses the composer', () => {
    const onFocusComposer = vi.fn();
    const { container } = render(<Probe onFocusComposer={onFocusComposer} />);
    const button = container.querySelector('button')!;
    const event = keyOn(button, 'k', { ctrlKey: true });
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+K from ANY target — including another INPUT — focuses the composer', () => {
    const onFocusComposer = vi.fn();
    const { container } = render(<Probe onFocusComposer={onFocusComposer} />);
    const input = container.querySelector('input')!;
    keyOn(input, 'k', { ctrlKey: true });
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
    // Cmd (meta) variant too.
    keyOn(input, 'k', { metaKey: true });
    expect(onFocusComposer).toHaveBeenCalledTimes(2);
  });

  it("plain '/' focuses the composer from a non-editable target", () => {
    const onFocusComposer = vi.fn();
    const { container } = render(<Probe onFocusComposer={onFocusComposer} />);
    const button = container.querySelector('button')!;
    const event = keyOn(button, '/');
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("plain '/' in an input is NOT intercepted (the user is typing)", () => {
    const onFocusComposer = vi.fn();
    const { container } = render(<Probe onFocusComposer={onFocusComposer} />);
    const input = container.querySelector('input')!;
    const event = keyOn(input, '/');
    expect(onFocusComposer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("Ctrl+'/' is not the slash binding (modifier wins)", () => {
    const onFocusComposer = vi.fn();
    const { container } = render(<Probe onFocusComposer={onFocusComposer} />);
    const button = container.querySelector('button')!;
    const event = keyOn(button, '/', { ctrlKey: true });
    expect(onFocusComposer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('without an onFocusComposer callback nothing is prevented', () => {
    function Noop() {
      useKeyboardShortcuts({ onOpenSettings: vi.fn() });
      return null;
    }
    render(<Noop />);
    const event = keyOn(window, 'k', { ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
  });
});
