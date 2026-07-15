/**
 * Issue #25 acceptance criterion 2:
 * "A thrown error inside any page component shows the ErrorBoundary fallback
 *  UI, not a blank page (write a test that force-throws from a page and
 *  asserts the fallback renders)."
 *
 * App.tsx wraps every page branch in <ErrorBoundary> (and main.tsx wraps the
 * whole tree). This test renders the real ErrorBoundary around a component
 * that throws during render and asserts the fallback "Something went wrong"
 * UI appears with a "Try Again" button, instead of a blank page.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ErrorBoundary } from './components/ErrorBoundary';

// Suppress the expected console.error noise from React when a render throws
// inside an ErrorBoundary during the test.
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalConsoleError;
  cleanup();
});

function Bomb({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) {
    throw new Error('kaboom from test page');
  }
  return <div data-testid="healthy-page">Page rendered fine</div>;
}

describe('App — ErrorBoundary mount (issue #25 AC2)', () => {
  it('renders the fallback UI (not a blank page) when a page throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );

    // The fallback heading, not a blank page.
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    // The error message surfaces.
    expect(screen.getByText('kaboom from test page')).toBeInTheDocument();
    // A retry affordance exists.
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // The healthy content did NOT render.
    expect(screen.queryByTestId('healthy-page')).not.toBeInTheDocument();
  });

  it('renders children normally when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('healthy-page')).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('recovers when the user presses Try Again', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    // First rerender with the throw disabled so the retry won't re-throw, then
    // press Try Again — the boundary resets hasError and re-renders children.
    rerender(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByTestId('healthy-page')).toBeInTheDocument();
  });
});
