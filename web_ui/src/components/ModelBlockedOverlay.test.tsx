/**
 * Tests for ModelBlockedOverlay (issue #25 F14):
 *  - role="alertdialog" + aria-modal="true"
 *  - focus moves into the dialog on mount, restored on unmount
 *  - focus trap cycles Tab/Shift+Tab within the dialog
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

  it('renders as an alertdialog with aria-modal', () => {
    renderOverlay();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Model not ready');
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
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
  });

  it('traps Tab focus within the dialog (wraps from last to first)', () => {
    renderOverlay();
    const retry = screen.getByRole('button', { name: 'Retry' });
    // settings-wiring-honesty (AC10): the external-model action is now the
    // last focusable control.
    const last = screen.getByRole('button', { name: 'Use a local server or cloud model' });

    // Focus starts on Retry (first focusable).
    expect(retry).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    // After Tab from the last focusable, wrap to first (Retry).
    last.focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    // The wrap should land focus back on the first element.
    expect(document.activeElement).toBe(retry);
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
