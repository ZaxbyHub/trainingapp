/**
 * FirstRunWizard component tests (PRR-003 regression, issue #85 review round;
 * named-gate reasons added for issue #133/AC4).
 *
 * Esc dismisses exactly like "Skip for now" (never completes), and the modal
 * traps Tab focus inside the panel while it is open. A disabled Complete
 * button must always NAME its unmet gate(s) — never a silent disable.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { FirstRunWizard } from './FirstRunWizard';
import type { FirstRunStatus } from '../lib/first-run';

function stubStatus(overrides: { packs?: Partial<FirstRunStatus['packs']> } = {}): FirstRunStatus {
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
    packs: { toolsAvailable: true, required: [], installed: [], ...overrides.packs },
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

describe('FirstRunWizard named completion gates (issue #133 AC4)', () => {
  /** Walk to the licensing step where the Complete control renders. */
  const reachCompleteStep = (getByTestId: (id: string) => HTMLElement): void => {
    for (let i = 0; i < 4; i += 1) fireEvent.click(getByTestId('wizard-next'));
  };

  const reasonText = (container: HTMLElement): string => {
    const nodes = container.querySelectorAll('[data-testid="complete-blocked-reasons"], [role="alert"]');
    return Array.from(nodes)
      .map((node) => node.textContent ?? '')
      .join(' ');
  };

  it('names the unmet pack ids and the lifecycle reason when the pack gate blocks completion', () => {
    const status = stubStatus({
      packs: {
        toolsAvailable: false,
        unavailableReason: 'store-unavailable',
        required: [
          { id: 'bundled-min', version: '1.0.0', resolvedDir: null },
          { id: 'training-stub', version: '1.0.0', resolvedDir: null },
        ],
        installed: [],
      },
    });
    const { getByTestId, container } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(true);
    const text = reasonText(container);
    expect(text).toContain('bundled-min');
    expect(text).toContain('training-stub');
    expect(text).toContain('pack lifecycle unavailable');
    expect(text).toContain('store-unavailable');
  });

  it('names the license gate when only the acknowledgment is missing', () => {
    const status = stubStatus();
    status.licenses = { available: false, path: null, content: null };
    const { getByTestId, container } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(true);
    const text = reasonText(container);
    expect(text).toMatch(/licen[cs]e/i);
    expect(text).toContain('cannot be skipped');
  });

  it('renders no blocked-reason element and enables Complete when all gates pass', () => {
    const status = stubStatus({
      packs: {
        toolsAvailable: true,
        required: [{ id: 'bundled-min', version: '1.0.0', resolvedDir: null }],
        installed: [{ id: 'bundled-min', version: '1.0.0', active: true }],
      },
    });
    const { getByTestId, container } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    fireEvent.click(getByTestId('license-ack'));
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(false);
    expect(container.querySelector('[data-testid="complete-blocked-reasons"]')).toBeNull();
  });
});
