/**
 * Tests for ModelBlockedOverlay (issue #25 F14):
 *  - role="alertdialog", named by its title; aria-modal is NOT claimed (Lumen
 *    phase 7: the gate covers the chat page only, the shell nav stays usable)
 *  - focus moves into the dialog on mount, restored on unmount
 *  - focus trap cycles Tab/Shift+Tab within the dialog
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ModelBlockedOverlay } from './ModelBlockedOverlay';
import type { ReadinessResult } from '../lib/llm/model-readiness';

const readyResult: ReadinessResult = {
  ready: false,
  checks: {
    webgpu: true,
    memory: { availableBytes: 8e9, requiredBytes: 4e9, sufficient: true, tier: 'HIGH' as const },
    modelCached: false,
  },
  failures: ['Model not downloaded'],
  recommendations: ['Download the model in Settings'],
};

function renderOverlay(overrides: Partial<React.ComponentProps<typeof ModelBlockedOverlay>> = {}) {
  return render(
    <ModelBlockedOverlay
      readinessResult={readyResult}
      browserEngine="webllm"
      modelLoadingProgress={0}
      onRetry={vi.fn()}
      onOpenSettings={vi.fn()}
      {...overrides}
    />
  );
}

describe('ModelBlockedOverlay (issue #25 F14)', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders as a non-modal alertdialog named "Model not ready" and described by the headline', () => {
    renderOverlay();
    const dialog = screen.getByRole('alertdialog', { name: 'Model not ready' });
    // aria-modal="true" would tell assistive tech the shell navigation is inert; it is not.
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(dialog).toHaveAccessibleDescription(/browser model is not available/i);
  });

  it('is a blocking state: Escape and a scrim press do nothing, and Escape is swallowed', () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <ModelBlockedOverlay
          readinessResult={readyResult}
          browserEngine="webllm"
          modelLoadingProgress={0}
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </div>
    );
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(fireEvent.keyDown(retry, { key: 'Escape' })).toBe(false);
    fireEvent.mouseDown(screen.getByTestId('ui-dialog-backdrop'));
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Model not ready' })).toBeInTheDocument();
  });

  it('renders in place (contained scrim), not in a body portal', () => {
    const { container } = renderOverlay();
    expect(container).toContainElement(screen.getByTestId('ui-dialog-backdrop'));
    expect(screen.getByTestId('ui-dialog-backdrop')).toHaveClass('ui-dialog__backdrop--contained');
  });

  it('failures use a danger Banner and recommendations an info Banner (no inline styles)', () => {
    const { container } = renderOverlay();
    const failure = screen.getByText('Model not downloaded').closest('.ui-banner');
    const recommendation = screen.getByText('Download the model in Settings').closest('.ui-banner');
    expect(failure).toHaveClass('ui-banner--danger');
    expect(recommendation).toHaveClass('ui-banner--info');
    // The alertdialog is the live announcement; the banners inside must not re-announce.
    expect(failure).not.toHaveAttribute('role');
    expect(recommendation).not.toHaveAttribute('role');
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('offers "Use a local server or cloud model" as the primary (first-class) action', () => {
    renderOverlay();
    expect(screen.getByRole('button', { name: 'Use a local server or cloud model' })).toHaveClass('ui-button--primary');
  });

  it('moves focus to the Retry button on mount', () => {
    renderOverlay();
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toHaveFocus();
  });

  it('renders the engine-aware headline for wllama missing-weights', () => {
    renderOverlay({ browserEngine: 'wllama' });
    expect(screen.getByText(/missing the packaged model/i)).toBeInTheDocument();
  });

  it('renders the webllam headline when model unavailable', () => {
    renderOverlay({ browserEngine: 'webllm' });
    expect(screen.getByText(/browser model is not available/i)).toBeInTheDocument();
  });

  it('calls onRetry when Retry is clicked', () => {
    const onRetry = vi.fn();
    renderOverlay({ onRetry });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenSettings when Open Settings is clicked', () => {
    const onOpenSettings = vi.fn();
    renderOverlay({ onOpenSettings });
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('shows failures and recommendations lists', () => {
    renderOverlay();
    expect(screen.getByText('Model not downloaded')).toBeInTheDocument();
    expect(screen.getByText('Download the model in Settings')).toBeInTheDocument();
  });

  it('shows the progress bar when loading with no hard failure', () => {
    const noFailure: ReadinessResult = {
      ready: false,
      checks: {
        webgpu: true,
        memory: { availableBytes: 8e9, requiredBytes: 4e9, sufficient: true, tier: 'HIGH' as const },
        modelCached: false,
      },
      failures: [],
      recommendations: [],
    };
    renderOverlay({ readinessResult: noFailure, modelLoadingProgress: 42 });
    const bar = screen.getByRole('progressbar', { name: 'Model loading progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('does not trap Tab (non-modal): edge presses are left to the browser so the shell nav stays reachable', () => {
    renderOverlay();
    const retry = screen.getByRole('button', { name: 'Retry' });
    const last = screen.getByRole('button', { name: 'Use a local server or cloud model' });
    expect(retry).toHaveFocus();
    // Not default-prevented, and Dialog moves no focus itself.
    expect(fireEvent.keyDown(retry, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(retry).toHaveFocus();
    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(true);
    expect(last).toHaveFocus();
  });

  it('does not hijack Tab/Shift+Tab that start outside the dialog (phase-3 review F1)', () => {
    const { container } = render(<button type="button">Outside</button>);
    renderOverlay();
    const outside = within(container).getByRole('button', { name: 'Outside' });
    outside.focus();
    const shiftTab = fireEvent.keyDown(outside, { key: 'Tab', shiftKey: true });
    expect(shiftTab).toBe(true); // not default-prevented
    expect(outside).toHaveFocus();
  });

  it('settings-wiring-honesty (AC10): the external-model action opens Settings at the model-connection section', () => {
    const onOpenSettings = vi.fn();
    renderOverlay({ onOpenSettings });
    fireEvent.click(screen.getByRole('button', { name: 'Use a local server or cloud model' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith('model-connection');
  });

  it('settings-wiring-honesty (AC10): Open Settings still navigates with no section', () => {
    const onOpenSettings = vi.fn();
    renderOverlay({ onOpenSettings });
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings.mock.calls[0]).toEqual([]);
  });
});
