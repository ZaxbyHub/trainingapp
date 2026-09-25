/**
 * StreamingIndicator.cold-load.test.tsx — #133 feedback: the cold-load
 * notice must appear when a send has no token yet, INCLUDING under
 * prefers-reduced-motion (RDP Windows often reports reduce; the tick must
 * not be gated on it — that froze the notice "like it never happened").
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { StreamingIndicator } from './StreamingIndicator';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('StreamingIndicator cold-load notice (#133)', () => {
  it('switches to the cold-load notice after the grace period and ticks elapsed time', () => {
    vi.useFakeTimers();
    const since = Date.now();
    render(<StreamingIndicator isVisible awaitingFirstTokenSince={since} />);
    // Inside the grace period: the generic Generating cursor.
    expect(screen.getByTestId('streaming-indicator')).toBeTruthy();
    expect(screen.queryByTestId('streaming-indicator-cold-load')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    const notice = screen.queryByTestId('streaming-indicator-cold-load');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Preparing the local AI model');
    expect(notice?.textContent).toContain('exploring other tabs');
  });

  it('renders the notice under prefers-reduced-motion (no animation, state machine intact)', () => {
    vi.useFakeTimers();
    const matchMediaMock = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('matchMedia', matchMediaMock);
    const since = Date.now();
    render(<StreamingIndicator isVisible awaitingFirstTokenSince={since} />);
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    const notice = screen.queryByTestId('streaming-indicator-cold-load');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Preparing the local AI model');
  });

  it('stays on the normal indicator while a determinate model load progress is supplied', () => {
    vi.useFakeTimers();
    const since = Date.now();
    render(<StreamingIndicator isVisible modelLoadProgress={40} awaitingFirstTokenSince={since} />);
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(screen.queryByTestId('streaming-indicator-cold-load')).toBeNull();
    expect(screen.getByTestId('streaming-indicator').textContent).toContain('40%');
  });
});
