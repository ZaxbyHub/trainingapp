/**
 * Tests for ToastProvider (issue #25 F9 fixes):
 *  - conditional role (alert for error, status for success/info)
 *  - accessible name is the message (not "Dismiss notification")
 *  - pause-on-hover/focus extends the auto-dismiss timer
 *  - AA-compliant background colors
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ToastProvider, useToast } from './ToastProvider';

function ToastTrigger({ message, type }: { message: string; type: 'success' | 'error' | 'info' }) {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast(message, type)} data-testid="trigger">
      Show
    </button>
  );
}

function renderWithProvider() {
  return render(
    <ToastProvider>
      <ToastTrigger message="Saved successfully" type="success" />
    </ToastProvider>
  );
}

describe('ToastProvider (issue #25 F9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders the toast message as the accessible content', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId('trigger'));

    // The message text should be visible and queryable.
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
  });

  it('uses role="status" for success/info toasts (not alert)', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId('trigger'));

    // success → status, not alert.
    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status.textContent).toContain('Saved successfully');
  });

  it('uses role="alert" for error toasts', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Something broke" type="error" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId('trigger'));

    expect(screen.getByRole('alert').textContent).toContain('Something broke');
  });

  it('provides a separate dismiss button with aria-label', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId('trigger'));

    // The dismiss button should exist as a separate control.
    expect(screen.getByRole('button', { name: /dismiss notification/i })).toBeInTheDocument();
  });

  it('pauses auto-dismiss on mouseenter and resumes on mouseleave', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId('trigger'));

    const toast = screen.getByText('Saved successfully').closest('[role="status"]')!;

    // Advance most of the duration — toast still visible.
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();

    // Hover pauses the timer.
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Still visible because paused.
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();

    // Leave resumes — toast should dismiss shortly after.
    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(5001);
    });
    // After resume + remaining time, the exit animation timer fires.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  it('applies the success-strong background color for success toasts', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId('trigger'));

    const toast = screen.getByRole('status');
    expect(toast.style.backgroundColor).toBe('var(--color-success-strong)');
  });

  it('applies the info-strong background color for info toasts', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="FYI" type="info" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId('trigger'));

    const toast = screen.getByRole('status');
    expect(toast.style.backgroundColor).toBe('var(--color-info-strong)');
  });

  it('dismisses when the dismiss button is clicked', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId('trigger'));

    const dismissBtn = screen.getByRole('button', { name: /dismiss notification/i });
    fireEvent.click(dismissBtn);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });
});
