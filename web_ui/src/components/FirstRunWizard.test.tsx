/**
 * FirstRunWizard component tests (PRR-003 regression, issue #85 review round).
 *
 * Esc dismisses exactly like "Skip for now" (never completes), and the modal
 * traps Tab focus inside the panel while it is open.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { FirstRunWizard } from './FirstRunWizard';
import type { FirstRunStatus } from '../lib/first-run';

function stubStatus(): FirstRunStatus {
  return {
    needed: true,
    reason: 'not-completed',
    rerun: false,
    engine: 'llama.cpp',
    hardware: { freeBytes: 16 * 1024 ** 3 },
    profile: {
      recommended: 'quality',
      warning: null,
      stored: 'fast',
      contextSize: 8192,
      models: { quality: null, fast: null },
    },
    manifest: { staged: false, packaged: false, failures: [], verifiedCount: 0 },
    packs: { toolsAvailable: true, required: [], installed: [] },
    licenses: { available: false, path: null, content: null },
    state: { completed: false, selectedProfile: 'fast', completedAt: '', acknowledgedLicenses: false },
  };
}

afterEach(cleanup);

describe('FirstRunWizard keyboard behavior (PRR-003)', () => {
  it('Escape dismisses via onClose (same as Skip for now — never completes)', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <FirstRunWizard status={stubStatus()} onClose={onClose} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    expect(getByTestId('first-run-wizard')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab is trapped inside the modal panel', () => {
    const { getByTestId, getByText } = render(
      <FirstRunWizard status={stubStatus()} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    const next = getByTestId('wizard-next');
    next.focus();
    // Tab from the last focusable on this step wraps back into the panel.
    fireEvent.keyDown(document, { key: 'Tab' });
    const panel = getByTestId('first-run-wizard');
    const active = document.activeElement as HTMLElement;
    expect(panel.contains(active)).toBe(true);
    expect(active).not.toBe(document.body);
    expect(getByText('Next')).toBeTruthy();
  });
});
