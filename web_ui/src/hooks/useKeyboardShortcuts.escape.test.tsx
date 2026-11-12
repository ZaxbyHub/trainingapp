/**
 * #267 (AC4, frozen check C20): Escape while a generation is in flight calls
 * the stop handler EXACTLY ONCE per press — before the hook's editable/Ctrl
 * bail-outs, so it works even with focus in the composer — returns early on
 * already-prevented events (overlay priority), and does nothing while no
 * generation runs.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function Probe({
  isGenerating,
  onStopGeneration,
}: {
  isGenerating: boolean;
  onStopGeneration: () => void;
}) {
  useKeyboardShortcuts({
    onOpenSettings: vi.fn(),
    onStopGeneration,
    isGenerating,
  });
  return <textarea aria-label="probe composer" data-chat-composer="true" />;
}

function escapeOn(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('useKeyboardShortcuts Escape stop (#267 AC4)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('Escape while generating calls stop exactly once per press and is prevented', () => {
    const onStopGeneration = vi.fn();
    const { rerender } = render(<Probe isGenerating={true} onStopGeneration={onStopGeneration} />);
    const event = escapeOn(window);
    expect(onStopGeneration).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    // Exactly once per press: a second press is a second single call.
    escapeOn(window);
    expect(onStopGeneration).toHaveBeenCalledTimes(2);
    rerender(<Probe isGenerating={true} onStopGeneration={onStopGeneration} />);
  });

  it('Escape while NOT generating does nothing (and is not prevented)', () => {
    const onStopGeneration = vi.fn();
    render(<Probe isGenerating={false} onStopGeneration={onStopGeneration} />);
    const event = escapeOn(window);
    expect(onStopGeneration).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('an already-prevented Escape returns without stopping (overlay priority belt)', () => {
    const onStopGeneration = vi.fn();
    render(<Probe isGenerating={true} onStopGeneration={onStopGeneration} />);
    // A panel handler consumed the Escape (e.g. a non-dismissible modal or an
    // expanded citation) before this window-bubble listener saw it.
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onStopGeneration).not.toHaveBeenCalled();
  });

  it('Escape fires from an EDITABLE target too (the branch precedes the bail-outs)', () => {
    const onStopGeneration = vi.fn();
    const { container } = render(<Probe isGenerating={true} onStopGeneration={onStopGeneration} />);
    const textarea = container.querySelector('textarea')!;
    const event = escapeOn(textarea);
    expect(onStopGeneration).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('without an onStopGeneration callback, Escape is inert (and un-prevented)', () => {
    function Noop() {
      useKeyboardShortcuts({ onOpenSettings: vi.fn(), isGenerating: true });
      return null;
    }
    render(<Noop />);
    const event = escapeOn(window);
    expect(event.defaultPrevented).toBe(false);
  });
});
