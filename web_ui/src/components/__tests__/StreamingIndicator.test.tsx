/**
 * Tests for StreamingIndicator component
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StreamingIndicator } from '../StreamingIndicator';

describe('StreamingIndicator', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Mock matchMedia globally for jsdom environment
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with data-testid="streaming-indicator"', () => {
    render(<StreamingIndicator isVisible={true} />);
    expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
  });

  it('displays "Generating" text', () => {
    render(<StreamingIndicator isVisible={true} />);
    expect(screen.getByText('Generating')).toBeTruthy();
  });

  it('shows blinking cursor element when not in reduced motion', () => {
    render(<StreamingIndicator isVisible={true} />);
    const container = screen.getByTestId('streaming-indicator');
    expect(container.textContent?.includes('▋')).toBe(true);
  });

  it('shows static "Generating..." when reduced motion is preferred', () => {
    // Re-mock with matches: true
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    render(<StreamingIndicator isVisible={true} />);
    expect(screen.getByText('Generating...')).toBeTruthy();
    const container = screen.getByTestId('streaming-indicator');
    expect(container.textContent?.includes('▋')).toBe(false);
  });

  it('returns null when isVisible is false', () => {
    const { container } = render(<StreamingIndicator isVisible={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('has role="status" and aria-live="polite" for screen reader accessibility', () => {
    render(<StreamingIndicator isVisible={true} />);
    const container = screen.getByTestId('streaming-indicator');
    expect(container.getAttribute('role')).toBe('status');
    expect(container.getAttribute('aria-live')).toBe('polite');
  });

  it('PRE-3: the ticking load percentage is aria-hidden and the live region text/name do not change per tick', () => {
    const { rerender } = render(<StreamingIndicator isVisible={true} modelLoadProgress={10} modelLoadLabel="Loading model" />);
    const region = screen.getByTestId('streaming-indicator');
    const pct = screen.getByTestId('streaming-indicator-pct');
    expect(pct).toHaveAttribute('aria-hidden', 'true');
    expect(pct).toHaveTextContent('10%');
    // Visual text is unchanged: label and percentage still read together.
    expect(region).toHaveTextContent('Loading model 10%');
    const nameAt10 = region.getAttribute('aria-label');
    expect(nameAt10).not.toMatch(/\d/);

    rerender(<StreamingIndicator isVisible={true} modelLoadProgress={55} modelLoadLabel="Loading model" />);
    expect(screen.getByTestId('streaming-indicator-pct')).toHaveTextContent('55%');
    expect(region.getAttribute('aria-label')).toBe(nameAt10);
    // Nothing a screen reader would read (non-aria-hidden text) contains the digits.
    const clone = region.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    expect(clone.textContent).not.toMatch(/\d/);
  });

  it('registers change listener on matchMedia', () => {
    render(<StreamingIndicator isVisible={true} />);

    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    const matchMediaCall = (window.matchMedia as ReturnType<typeof vi.fn>).mock.results[0];
    expect(matchMediaCall.value.addEventListener).toHaveBeenCalled();
  });

  it('removes change listener on cleanup', () => {
    const { unmount } = render(<StreamingIndicator isVisible={true} />);

    const matchMediaCall = (window.matchMedia as ReturnType<typeof vi.fn>).mock.results[0];
    unmount();
    expect(matchMediaCall.value.removeEventListener).toHaveBeenCalled();
  });
});
