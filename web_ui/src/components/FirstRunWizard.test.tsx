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
import { FirstRunGate, FirstRunWizard } from './FirstRunWizard';
import { clearFirstRunSession, getFirstRunSession } from './first-run-session';
import { emitFirstRunReopen } from '../lib/first-run';
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
  clearFirstRunSession();
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

/** A promise the test settles by hand (controls when an IPC call "returns"). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const packsPending = (): FirstRunStatus =>
  stubStatus({
    packs: {
      toolsAvailable: true,
      required: [{ id: 'bundled-min', version: '1.0.0', resolvedDir: null }],
      installed: [],
    },
  });
const packsActive = (): FirstRunStatus =>
  stubStatus({
    packs: {
      toolsAvailable: true,
      required: [{ id: 'bundled-min', version: '1.0.0', resolvedDir: null }],
      installed: [{ id: 'bundled-min', version: '1.0.0', active: true }],
    },
  });

describe('FirstRunWizard step announcements (PRR-151-004, PRR-151-068)', () => {
  const LABELS = [
    'Hardware check',
    'Inference profile',
    'File integrity',
    'Knowledge packs',
    'Licensing notices',
  ];

  it('announces "Step N of 5: <label>" in one persistent live region on every transition', () => {
    const { getByTestId } = mount();
    const region = getByTestId('wizard-announcer');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent(`Step 1 of 5: ${LABELS[0]}`);
    for (let i = 1; i < 5; i += 1) {
      next(getByTestId, 1);
      expect(getByTestId('wizard-announcer')).toBe(region); // same node: never remounted
      expect(region).toHaveTextContent(`Step ${i + 1} of 5: ${LABELS[i]}`);
    }
    for (let i = 3; i >= 0; i -= 1) {
      fireEvent.click(within(getByTestId('first-run-wizard')).getByRole('button', { name: 'Back' }));
      expect(region).toHaveTextContent(`Step ${i + 1} of 5: ${LABELS[i]}`);
    }
  });

  it('announces the terminal step', async () => {
    completeFirstRunMock.mockResolvedValue({ ok: true });
    const { getByTestId } = mount(packsActive());
    next(getByTestId, 4);
    fireEvent.click(getByTestId('license-ack'));
    await act(async () => {
      fireEvent.click(getByTestId('wizard-complete'));
    });
    expect(getByTestId('wizard-announcer')).toHaveTextContent('Setup complete');
  });

  it('the step list shows human labels, never the raw slugs', () => {
    const { getByTestId } = mount();
    const steps = getByTestId('wizard-steps');
    expect(steps).toHaveTextContent('Hardware check');
    expect(steps).toHaveTextContent('Knowledge packs');
    expect(steps.textContent).not.toMatch(/detect-hardware|select-profile|activate-packs|licensing-notices/);
  });
});

describe('FirstRunWizard licensing text region (PRR-151-073)', () => {
  it('the scrollable, focusable notices text is a named region', () => {
    const status = {
      ...stubStatus(),
      licenses: { available: true, path: 'docs/licenses.md', content: 'MIT and friends' },
    } as FirstRunStatus;
    const { getByTestId, getByRole } = mount(status);
    next(getByTestId, 4);
    const region = getByRole('region', { name: 'Licensing notices text' });
    expect(region).toHaveTextContent('MIT and friends');
    expect(region).toHaveAttribute('tabindex', '0');
  });
});

describe('FirstRunWizard in-session progress (PRR-151-013)', () => {
  it('Skip then reopen in the same session restores step, profile and licence tick; nothing hits storage', () => {
    const first = mount();
    next(first.getByTestId, 1);
    fireEvent.click(first.getByTestId('profile-fast'));
    next(first.getByTestId, 3);
    fireEvent.click(first.getByTestId('license-ack'));
    fireEvent.click(first.getByTestId('first-run-skip'));
    first.unmount();

    const second = mount();
    expect(second.getByTestId('wizard-announcer')).toHaveTextContent('Step 5 of 5: Licensing notices');
    expect(second.getByTestId('license-ack')).toBeChecked();
    fireEvent.click(within(second.getByTestId('first-run-wizard')).getByRole('button', { name: 'Back' }));
    fireEvent.click(within(second.getByTestId('first-run-wizard')).getByRole('button', { name: 'Back' }));
    fireEvent.click(within(second.getByTestId('first-run-wizard')).getByRole('button', { name: 'Back' }));
    expect(second.getByTestId('profile-fast')).toBeChecked();
    expect(completeFirstRunMock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('an untouched profile follows the new status recommendation on reopen', () => {
    const withRec = (r: 'quality' | 'fast'): FirstRunStatus => {
      const s = stubStatus();
      s.profile.recommended = r;
      return s;
    };
    const first = mount(withRec('quality'));
    next(first.getByTestId, 1);
    fireEvent.click(first.getByTestId('first-run-skip'));
    first.unmount();
    const second = mount(withRec('fast'));
    expect(second.getByTestId('wizard-announcer')).toHaveTextContent('Step 2 of 5');
    expect(second.getByTestId('profile-fast')).toBeChecked();
  });

  it('an explicit profile pick survives a reopen even when the recommendation differs', () => {
    const first = mount();
    next(first.getByTestId, 1);
    fireEvent.click(first.getByTestId('profile-fast'));
    fireEvent.click(first.getByTestId('first-run-skip'));
    first.unmount();
    const s = stubStatus();
    s.profile.recommended = 'quality';
    const second = mount(s);
    expect(second.getByTestId('profile-fast')).toBeChecked();
  });

  it('Finish then reopen starts fresh', async () => {
    completeFirstRunMock.mockResolvedValue({ ok: true });
    const first = mount(packsActive());
    next(first.getByTestId, 1);
    fireEvent.click(first.getByTestId('profile-fast'));
    next(first.getByTestId, 3);
    fireEvent.click(first.getByTestId('license-ack'));
    await act(async () => {
      fireEvent.click(first.getByTestId('wizard-complete'));
    });
    fireEvent.click(first.getByTestId('wizard-finish'));
    first.unmount();

    const second = mount(packsActive());
    expect(second.getByTestId('wizard-announcer')).toHaveTextContent('Step 1 of 5: Hardware check');
    next(second.getByTestId, 1);
    expect(second.getByTestId('profile-quality')).toBeChecked();
    next(second.getByTestId, 3);
    expect(second.getByTestId('license-ack')).not.toBeChecked();
  });
});

describe('FirstRunWizard in-flight guards (PRR-151-014)', () => {
  const toComplete = (view: { getByTestId: (id: string) => HTMLElement }): void => {
    next(view.getByTestId, 4);
    fireEvent.click(view.getByTestId('license-ack'));
  };

  it('a double-click on Complete issues one IPC call, disables the controls, then lands on the terminal step', async () => {
    const gate = deferred<{ ok: boolean }>();
    completeFirstRunMock.mockReturnValue(gate.promise);
    const onCompleted = vi.fn();
    const view = render(
      <FirstRunWizard status={packsActive()} onClose={vi.fn()} onCompleted={onCompleted} refreshStatus={vi.fn()} />,
    );
    toComplete(view);
    const button = view.getByTestId('wizard-complete');
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(completeFirstRunMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => {
      gate.resolve({ ok: true });
    });
    expect(view.getByTestId('step-complete')).toBeInTheDocument();
    expect(view.queryByTestId('complete-error')).toBeNull();
    expect(completeFirstRunMock).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('moves focus to Finish even when focus was parked on the dialog panel as the terminal step appears', async () => {
    const gate = deferred<{ ok: boolean }>();
    completeFirstRunMock.mockReturnValue(gate.promise);
    const view = mount(packsActive());
    toComplete(view);
    await act(async () => {
      fireEvent.click(view.getByTestId('wizard-complete'));
    });
    const panel = view.getByTestId('first-run-wizard');
    panel.focus();
    expect(document.activeElement).toBe(panel);
    await act(async () => {
      gate.resolve({ ok: true });
    });
    expect(document.activeElement).toBe(view.getByTestId('wizard-finish'));
  });

  it('a refused completion re-enables Complete so the operator can retry', async () => {
    completeFirstRunMock.mockResolvedValueOnce({ ok: false, detail: 'nope' });
    const view = mount(packsActive());
    toComplete(view);
    await act(async () => {
      fireEvent.click(view.getByTestId('wizard-complete'));
    });
    expect(view.getByTestId('complete-error')).toHaveTextContent('nope');
    expect(view.getByTestId('wizard-complete')).not.toBeDisabled();
  });

  it('a double-click on the activate button issues one IPC call and is disabled while in flight', async () => {
    const gate = deferred<{ ok: boolean; results: Array<{ id: string; ok: boolean; detail: string }> }>();
    activateRequiredPacksMock.mockReturnValue(gate.promise);
    const refreshStatus = vi.fn();
    const view = render(
      <FirstRunWizard status={packsPending()} onClose={vi.fn()} onCompleted={vi.fn()} refreshStatus={refreshStatus} />,
    );
    next(view.getByTestId, 3);
    const button = view.getByTestId('activate-packs-button');
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(activateRequiredPacksMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => {
      gate.resolve({ ok: true, results: [{ id: 'bundled-min', ok: true, detail: 'installed' }] });
    });
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('activate-packs-button')).not.toBeDisabled();
  });

  it('a completion that resolves after unmount still clears in-session progress and notifies the owner, without touching the dead tree', async () => {
    const gate = deferred<{ ok: boolean }>();
    completeFirstRunMock.mockReturnValue(gate.promise);
    const onCompleted = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = render(
      <FirstRunWizard status={packsActive()} onClose={vi.fn()} onCompleted={onCompleted} refreshStatus={vi.fn()} />,
    );
    toComplete(first);
    await act(async () => {
      fireEvent.click(first.getByTestId('wizard-complete'));
    });
    first.unmount(); // Skip while the IPC call is in flight
    await act(async () => {
      gate.resolve({ ok: true });
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    const second = mount(packsActive());
    expect(second.getByTestId('wizard-announcer')).toHaveTextContent('Step 1 of 5');
  });

  it('a refusal that arrives after unmount is ignored', async () => {
    const gate = deferred<{ ok: boolean; detail?: string }>();
    completeFirstRunMock.mockReturnValue(gate.promise);
    const onCompleted = vi.fn();
    const first = render(
      <FirstRunWizard status={packsActive()} onClose={vi.fn()} onCompleted={onCompleted} refreshStatus={vi.fn()} />,
    );
    toComplete(first);
    await act(async () => {
      fireEvent.click(first.getByTestId('wizard-complete'));
    });
    first.unmount();
    await act(async () => {
      gate.resolve({ ok: false, detail: 'late' });
    });
    expect(onCompleted).not.toHaveBeenCalled();
    // progress is kept (completion did not happen): reopen resumes on the licensing step
    expect(mount(packsActive()).getByTestId('wizard-announcer')).toHaveTextContent('Step 5 of 5');
  });
});

describe('FirstRunGate completion refresh (PRR-151-047)', () => {
  afterEach(() => {
    delete (window as unknown as { desktopApi?: unknown }).desktopApi;
  });

  it('keeps the wizard mounted on its terminal step after the refresh reports needed=false; Finish closes it', async () => {
    completeFirstRunMock.mockResolvedValue({ ok: true });
    const needed = packsActive();
    const done = { ...packsActive(), needed: false };
    const getFirstRunStatus = vi.fn().mockResolvedValueOnce(needed).mockResolvedValue(done);
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      getFirstRunStatus,
      onFirstRunRequired: () => () => undefined,
    };
    const view = render(<FirstRunGate />);
    await act(async () => {
      await Promise.resolve();
    });
    next(view.getByTestId, 4);
    fireEvent.click(view.getByTestId('license-ack'));
    view.getByTestId('wizard-complete').focus();
    await act(async () => {
      fireEvent.click(view.getByTestId('wizard-complete'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getFirstRunStatus).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('step-complete')).toBeInTheDocument();
    expect(document.activeElement).toBe(view.getByTestId('wizard-finish'));
    fireEvent.click(view.getByTestId('wizard-finish'));
    expect(view.queryByTestId('first-run-wizard')).toBeNull();
  });

  // PR #151 final review LOW-4: Complete's IPC resolving after Escape must not latch
  // `finished` onto a later, non-completed wizard session.
  describe('a completion that resolves after Escape (LOW-4)', () => {
    function stubBridge(statuses: FirstRunStatus[]) {
      let push: ((next: FirstRunStatus) => void) | null = null;
      const getFirstRunStatus = vi.fn();
      for (const s of statuses) getFirstRunStatus.mockResolvedValueOnce(s);
      (window as unknown as { desktopApi: unknown }).desktopApi = {
        getFirstRunStatus,
        onFirstRunRequired: (cb: (next: FirstRunStatus) => void) => {
          push = cb;
          return () => undefined;
        },
      };
      return { getFirstRunStatus, push: (next: FirstRunStatus) => push?.(next) };
    }
    const flush = async (): Promise<void> => {
      await act(async () => {
        await Promise.resolve();
      });
    };
    const wizard = (base: HTMLElement): HTMLElement | null => base.querySelector('[data-testid="first-run-wizard"]');

    it('Complete in flight, Escape, resolve, reopen: the completion is honoured and the reopened wizard is not stuck "finished"', async () => {
      const gate = deferred<{ ok: boolean }>();
      completeFirstRunMock.mockReturnValue(gate.promise);
      const needed = packsActive();
      const done = { ...packsActive(), needed: false };
      const rerun = { ...packsActive(), rerun: true };
      const bridge = stubBridge([needed, done, rerun]);
      const view = render(<FirstRunGate />);
      await flush();
      next(view.getByTestId, 4);
      fireEvent.click(view.getByTestId('license-ack'));
      await act(async () => {
        fireEvent.click(view.getByTestId('wizard-complete'));
      });
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      expect(wizard(view.baseElement)).toBeNull();

      await act(async () => {
        gate.resolve({ ok: true });
      });
      await flush();
      // The backend completion is still honoured: in-session progress cleared and
      // the gate refreshed its status (the second fetch).
      expect(getFirstRunSession()).toBeNull();
      expect(bridge.getFirstRunStatus).toHaveBeenCalledTimes(2);
      expect(wizard(view.baseElement)).toBeNull();

      // Settings "Re-run setup": a fresh wizard on step 1.
      await act(async () => {
        emitFirstRunReopen();
      });
      await flush();
      expect(view.getByTestId('wizard-announcer')).toHaveTextContent('Step 1 of 5: Hardware check');

      // The status flips to needed=false without THIS wizard completing: it must
      // unmount like any other not-needed status (a latched `finished` kept it up).
      act(() => bridge.push(done));
      expect(wizard(view.baseElement)).toBeNull();
    });

    it('a completion that resolves after Escape AND a reopen does not mark the reopened session finished', async () => {
      const gate = deferred<{ ok: boolean }>();
      completeFirstRunMock.mockReturnValue(gate.promise);
      const needed = packsActive();
      const done = { ...packsActive(), needed: false };
      const bridge = stubBridge([needed, needed, done]);
      const view = render(<FirstRunGate />);
      await flush();
      next(view.getByTestId, 4);
      fireEvent.click(view.getByTestId('license-ack'));
      await act(async () => {
        fireEvent.click(view.getByTestId('wizard-complete'));
      });
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      await act(async () => {
        emitFirstRunReopen(); // reopened before the old completion lands
      });
      await flush();
      expect(wizard(view.baseElement)).not.toBeNull();
      expect(view.queryByTestId('step-complete')).toBeNull();

      await act(async () => {
        gate.resolve({ ok: true });
      });
      await flush();
      expect(bridge.getFirstRunStatus).toHaveBeenCalledTimes(3); // the late completion still refreshed
      expect(getFirstRunSession()).toBeNull();
      // Setup is complete (needed=false) and this session never completed: it closes.
      expect(wizard(view.baseElement)).toBeNull();
    });

    it('a needed=true push while the wizard is already open keeps its session: its own completion still reaches the terminal step', async () => {
      const gate = deferred<{ ok: boolean }>();
      completeFirstRunMock.mockReturnValue(gate.promise);
      const needed = packsActive();
      const done = { ...packsActive(), needed: false };
      const bridge = stubBridge([needed, done]);
      const view = render(<FirstRunGate />);
      await flush();
      next(view.getByTestId, 4);
      fireEvent.click(view.getByTestId('license-ack'));
      await act(async () => {
        fireEvent.click(view.getByTestId('wizard-complete'));
      });
      act(() => bridge.push(needed)); // e.g. a repeated boot push while open
      await act(async () => {
        gate.resolve({ ok: true });
      });
      await flush();
      expect(view.getByTestId('step-complete')).toBeInTheDocument();
    });

    it('Finish, then a Settings re-run: the reopened wizard is not "finished" either (closing clears it)', async () => {
      completeFirstRunMock.mockResolvedValue({ ok: true });
      const needed = packsActive();
      const done = { ...packsActive(), needed: false };
      const rerun = { ...packsActive(), rerun: true };
      const bridge = stubBridge([needed, done, rerun]);
      const view = render(<FirstRunGate />);
      await flush();
      next(view.getByTestId, 4);
      fireEvent.click(view.getByTestId('license-ack'));
      await act(async () => {
        fireEvent.click(view.getByTestId('wizard-complete'));
      });
      await flush();
      fireEvent.click(view.getByTestId('wizard-finish'));
      expect(wizard(view.baseElement)).toBeNull();
      await act(async () => {
        emitFirstRunReopen();
      });
      await flush();
      expect(view.getByTestId('wizard-announcer')).toHaveTextContent('Step 1 of 5');
      act(() => bridge.push(done));
      expect(wizard(view.baseElement)).toBeNull();
    });
  });
});
