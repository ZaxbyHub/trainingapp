/**
 * FirstRunWizard component tests (PRR-003 regression, issue #85 review round;
 * named-gate reasons added for issue #133/AC4; Lumen phase 7 migration onto ui/Dialog
 * and ui/Banner).
 *
 * Esc dismisses exactly like "Skip for now" (never completes), and the modal
 * traps Tab focus inside the panel while it is open. A disabled Complete
 * button must always NAME its unmet gate(s) - never a silent disable. The dialog is
 * portaled to document.body, so DOM queries go through baseElement.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act, within } from '@testing-library/react';
import { FirstRunWizard } from './FirstRunWizard';
import type { FirstRunStatus } from '../lib/first-run';

const completeFirstRunMock = vi.fn();
const activateRequiredPacksMock = vi.fn();
vi.mock('../lib/first-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/first-run')>()),
  completeFirstRun: (...args: unknown[]) => completeFirstRunMock(...args),
  activateRequiredPacks: (...args: unknown[]) => activateRequiredPacksMock(...args),
}));

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

beforeEach(() => {
  completeFirstRunMock.mockReset();
  activateRequiredPacksMock.mockReset();
});
afterEach(cleanup);

const mount = (status: FirstRunStatus = stubStatus(), onClose = vi.fn()) =>
  render(<FirstRunWizard status={status} onClose={onClose} onCompleted={vi.fn()} refreshStatus={vi.fn()} />);

/** Step the wizard forward `n` times via the Next button. */
const next = (getByTestId: (id: string) => HTMLElement, n: number): void => {
  for (let i = 0; i < n; i += 1) fireEvent.click(getByTestId('wizard-next'));
};

describe('FirstRunWizard keyboard behavior (PRR-003)', () => {
  it('Escape dismisses via onClose (same as Skip for now - never completes)', () => {
    const onClose = vi.fn();
    const { getByTestId } = mount(stubStatus(), onClose);
    expect(getByTestId('first-run-wizard')).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(completeFirstRunMock).not.toHaveBeenCalled();
  });

  it('opens with focus on Next (not on Skip for now, so Enter at launch does not dismiss setup)', () => {
    const { getByTestId } = mount();
    expect(document.activeElement).toBe(getByTestId('wizard-next'));
  });

  it('Skip for now calls onClose without completing', () => {
    const onClose = vi.fn();
    const { getByTestId } = mount(stubStatus(), onClose);
    fireEvent.click(getByTestId('first-run-skip'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(completeFirstRunMock).not.toHaveBeenCalled();
  });

  it('Tab is trapped inside the modal panel (wraps from the last control to the first)', () => {
    const { getByTestId } = mount();
    const nextBtn = getByTestId('wizard-next');
    nextBtn.focus();
    const proceeded = fireEvent.keyDown(nextBtn, { key: 'Tab' });
    expect(proceeded).toBe(false); // default prevented: the dialog moved focus itself
    const panel = getByTestId('first-run-wizard');
    const active = document.activeElement as HTMLElement;
    expect(panel.contains(active)).toBe(true);
    expect(active).toBe(getByTestId('first-run-skip'));
  });

  it('returns focus to the element that opened it when it unmounts', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = mount();
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('FirstRunWizard dialog semantics (Lumen phase 7)', () => {
  it('is a modal dialog named by its title, tagged first-run-wizard for the desktop e2e', () => {
    const { getByRole, getByTestId } = mount();
    const dialog = getByRole('dialog', { name: 'Welcome to TrainingApp' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(getByTestId('first-run-wizard')).toBe(dialog);
  });

  it('titles a re-run, and the root test id contains the title and the drift lede', () => {
    const status = { ...stubStatus(), rerun: true, reason: 'drift' } as FirstRunStatus;
    const { getByTestId } = mount(status);
    expect(getByTestId('first-run-wizard')).toHaveTextContent('Re-run setup');
    expect(getByTestId('first-run-wizard')).toHaveTextContent('changed since setup');
  });

  it('marks the current step with aria-current and keeps the wizard-steps test id', () => {
    const { getByTestId } = mount();
    const steps = getByTestId('wizard-steps');
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).toHaveClass('first-run__step--current');
    expect(items[5]).not.toHaveAttribute('aria-current');
    next(getByTestId, 1);
    expect(items[0]).toHaveClass('first-run__step--done');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
  });

  it('uses no inline styles on any step', () => {
    const { getByTestId, baseElement } = mount();
    for (let i = 0; i < 5; i += 1) {
      expect(baseElement.querySelector('.ui-dialog')).not.toBeNull();
      expect(baseElement.querySelectorAll('.ui-dialog [style]')).toHaveLength(0);
      if (i < 4) next(getByTestId, 1);
    }
  });

  it('the profile choice keeps its test ids and is a native radio group', () => {
    const { getByTestId, getByRole } = mount();
    next(getByTestId, 1);
    expect(getByRole('group', { name: 'Inference profile' })).toContainElement(getByTestId('profile-fast'));
    expect(getByTestId('profile-quality')).toBeChecked();
    fireEvent.click(getByTestId('profile-fast'));
    expect(getByTestId('profile-fast')).toBeChecked();
    expect(getByTestId('profile-quality')).not.toBeChecked();
  });

  it('Back is natively disabled on the first step and focus stays inside the dialog when it becomes so', () => {
    const { getByTestId, getByRole } = mount();
    const back = getByRole('button', { name: 'Back' });
    expect(back).toBeDisabled();
    next(getByTestId, 1);
    const backNow = getByRole('button', { name: 'Back' });
    expect(backNow).not.toBeDisabled();
    backNow.focus();
    fireEvent.click(backNow);
    expect(getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(getByTestId('first-run-wizard').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});
describe('FirstRunWizard named completion gates (issue #133 AC4)', () => {
  /** Walk to the licensing step where the Complete control renders. */
  const reachCompleteStep = (getByTestId: (id: string) => HTMLElement): void => {
    for (let i = 0; i < 4; i += 1) fireEvent.click(getByTestId('wizard-next'));
  };

  const reasonText = (baseElement: HTMLElement): string => {
    const nodes = baseElement.querySelectorAll('[data-testid="complete-blocked-reasons"], [role="alert"]');
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
    const { getByTestId, baseElement } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(true);
    const text = reasonText(baseElement);
    expect(text).toContain('bundled-min');
    expect(text).toContain('training-stub');
    expect(text).toContain('pack lifecycle unavailable');
    expect(text).toContain('store-unavailable');
  });

  it('names the license gate when only the acknowledgment is missing', () => {
    const status = stubStatus();
    status.licenses = { available: false, path: null, content: null };
    const { getByTestId, baseElement } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(true);
    const text = reasonText(baseElement);
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
    const { getByTestId, baseElement } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    fireEvent.click(getByTestId('license-ack'));
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(false);
    expect(baseElement.querySelector('[data-testid="complete-blocked-reasons"]')).toBeNull();
  });

  // #133 round 8 review blocker: the backend's satisfaction verdict
  // (installed+active at the manifest version OR NEWER) must drive the
  // Complete gate — strict equality soft-locked the wizard when the operator
  // had installed a newer pack zip than the manifest pins (the update flow
  // the Training tab itself advertises), while the activate-packs step
  // reported "already installed and active".
  it('enables Complete when the backend says a NEWER installed pack satisfies the manifest', () => {
    const status = stubStatus({
      packs: {
        toolsAvailable: true,
        required: [{ id: 'bundled-min', version: '1.0.0', resolvedDir: null, satisfied: true }],
        installed: [{ id: 'bundled-min', version: '1.0.2', active: true }],
      },
    });
    const { getByTestId, baseElement } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    fireEvent.click(getByTestId('license-ack'));
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(false);
    expect(baseElement.querySelector('[data-testid="complete-blocked-reasons"]')).toBeNull();
  });

  it('still blocks when the backend marks the entry NOT satisfied (legacy fallback intact)', () => {
    const status = stubStatus({
      packs: {
        toolsAvailable: true,
        required: [{ id: 'bundled-min', version: '1.0.1', resolvedDir: null, satisfied: false }],
        installed: [{ id: 'bundled-min', version: '1.0.0', active: true }],
      },
    });
    const { getByTestId, baseElement } = render(
      <FirstRunWizard status={status} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={vi.fn()} />,
    );
    reachCompleteStep(getByTestId);
    fireEvent.click(getByTestId('license-ack'));
    expect(getByTestId('wizard-complete').hasAttribute('disabled')).toBe(true);
    expect(reasonText(baseElement)).toContain('bundled-min');
  });
});

describe('FirstRunWizard errors use ui/Banner with alert semantics (Lumen phase 7)', () => {
  const withManifest = (manifest: Partial<FirstRunStatus['manifest']>): FirstRunStatus => ({
    ...stubStatus(),
    manifest: { staged: false, packaged: false, failures: [], verifiedCount: 0, ...manifest },
  });

  it('a packaged install with no manifest is a danger alert', () => {
    const { getByTestId } = mount(withManifest({ packaged: true }));
    next(getByTestId, 2);
    const alert = within(getByTestId('step-verify-manifest')).getByRole('alert');
    expect(alert).toHaveClass('ui-banner--danger');
    expect(alert).toHaveTextContent('missing its integrity manifest');
  });

  it('manifest failures render a danger alert plus the failures table with column headers', () => {
    const status = withManifest({
      staged: true,
      failures: [{ path: 'models/a.gguf', reason: 'hash-mismatch', expected: 'aaa', actual: 'bbb' }],
    });
    const { getByTestId } = mount(status);
    next(getByTestId, 2);
    const step = getByTestId('step-verify-manifest');
    expect(within(step).getByRole('alert')).toHaveTextContent('failed for 1 file(s)');
    const table = getByTestId('manifest-failures');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['File', 'Reason', 'Expected', 'Actual']);
    expect(headers.every((h) => h.getAttribute('scope') === 'col')).toBe(true);
    expect(table).toHaveTextContent('models/a.gguf');
    expect(table).toHaveTextContent('hash-mismatch');
  });

  it('the profile warning is a warning alert inside the profile-warning test id', () => {
    const status = stubStatus();
    status.profile.warning = { detail: 'needs 9000 bytes, 100 free', requiredBytes: 9000, freeBytes: 100 };
    const { getByTestId } = mount(status);
    next(getByTestId, 1);
    const alert = within(getByTestId('profile-warning')).getByRole('alert');
    expect(alert).toHaveClass('ui-banner--warning');
    expect(alert).toHaveTextContent('bytes');
    expect(getByTestId('step-select-profile')).toHaveTextContent('override');
  });

  it('unavailable pack lifecycle is a danger alert on the packs step', () => {
    const status = stubStatus({ packs: { toolsAvailable: false, unavailableReason: 'store-unavailable' } });
    const { getByTestId } = mount(status);
    next(getByTestId, 3);
    const alert = within(getByTestId('step-activate-packs')).getByRole('alert');
    expect(alert).toHaveClass('ui-banner--danger');
    expect(alert).toHaveTextContent('store-unavailable');
  });

  it('a refused completion shows a danger alert inside complete-error', async () => {
    completeFirstRunMock.mockResolvedValue({ ok: false, detail: 'completion refused: license' });
    const { getByTestId } = mount();
    next(getByTestId, 4);
    fireEvent.click(getByTestId('license-ack'));
    await act(async () => {
      fireEvent.click(getByTestId('wizard-complete'));
    });
    const alert = within(getByTestId('complete-error')).getByRole('alert');
    expect(alert).toHaveClass('ui-banner--danger');
    expect(alert).toHaveTextContent('completion refused: license');
  });

  it('the blocked-reasons banner is a warning alert carrying the id Complete is described by', () => {
    const { getByTestId } = mount();
    next(getByTestId, 4);
    const holder = getByTestId('complete-blocked-reasons');
    expect(holder.id).toBe('wizard-complete-blocked-reasons');
    expect(within(holder).getByRole('alert')).toHaveClass('ui-banner--warning');
    expect(getByTestId('wizard-complete')).toHaveAttribute('aria-describedby', holder.id);
  });
});

describe('FirstRunWizard completion flow and focus recovery', () => {
  const readyStatus = (): FirstRunStatus =>
    stubStatus({
      packs: {
        toolsAvailable: true,
        required: [{ id: 'bundled-min', version: '1.0.0', resolvedDir: null }],
        installed: [{ id: 'bundled-min', version: '1.0.0', active: true }],
      },
    });

  it('shows failed activation results with a text cue, not colour alone', async () => {
    activateRequiredPacksMock.mockResolvedValue({
      ok: false,
      results: [
        { id: 'good', ok: true, detail: 'installed good@1.0.0' },
        { id: 'bad', ok: false, detail: 'signature rejected' },
      ],
    });
    const status = stubStatus({
      packs: {
        toolsAvailable: true,
        required: [{ id: 'bad', version: '1.0.0', resolvedDir: null }],
        installed: [],
      },
    });
    const { getByTestId } = mount(status);
    next(getByTestId, 3);
    await act(async () => {
      fireEvent.click(getByTestId('activate-packs-button'));
    });
    const step = getByTestId('step-activate-packs');
    const failed = within(step).getByText(/signature rejected/).closest('li') as HTMLElement;
    expect(failed).toHaveClass('first-run__result--failed');
    expect(failed).toHaveTextContent('Failed: bad: signature rejected');
    expect(step).toHaveTextContent('good: installed good@1.0.0');
  });

  it('completing moves focus to Finish, and Escape and Finish still close the wizard', async () => {
    completeFirstRunMock.mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    const { getByTestId } = mount(readyStatus(), onClose);
    next(getByTestId, 4);
    fireEvent.click(getByTestId('license-ack'));
    getByTestId('wizard-complete').focus();
    await act(async () => {
      fireEvent.click(getByTestId('wizard-complete'));
    });
    expect(getByTestId('step-complete')).toHaveTextContent('quality');
    expect(document.activeElement).toBe(getByTestId('wizard-finish'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId('wizard-finish'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps focus inside the dialog when the activate button unmounts after packs become active', () => {
    const pending = stubStatus({
      packs: {
        toolsAvailable: true,
        required: [{ id: 'bundled-min', version: '1.0.0', resolvedDir: null }],
        installed: [],
      },
    });
    const props = { onClose: vi.fn(), onCompleted: vi.fn(), refreshStatus: vi.fn() };
    const { getByTestId, queryByTestId, rerender } = render(<FirstRunWizard status={pending} {...props} />);
    next(getByTestId, 3);
    getByTestId('activate-packs-button').focus();
    rerender(<FirstRunWizard status={readyStatus()} {...props} />);
    expect(queryByTestId('activate-packs-button')).toBeNull();
    expect(getByTestId('first-run-wizard').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('a backdrop press does nothing (a stray click must not skip setup); Escape and Skip still dismiss', () => {
    const onClose = vi.fn();
    const { baseElement, getByTestId } = mount(stubStatus(), onClose);
    fireEvent.mouseDown(baseElement.querySelector('.ui-dialog__backdrop') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(getByTestId('first-run-wizard')).toBeInTheDocument();
    fireEvent.keyDown(getByTestId('wizard-next'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId('first-run-skip'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(completeFirstRunMock).not.toHaveBeenCalled();
  });
});
