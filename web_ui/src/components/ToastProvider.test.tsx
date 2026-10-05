/**
 * Toast system tests (ToastProvider is the app-facing wrapper over ui/Toast).
 * Lumen phase 7 rewrote the old inline-style assertions to role / class / state
 * assertions: always-mounted live regions (WAI-ARIA), tone to region routing,
 * dismiss + auto-dismiss + pause timing, focus return, reduced motion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ToastProvider, useToast } from './ToastProvider';
import { TOAST_DURATION_MS, TOAST_EXIT_MS } from '../ui/Toast';

type Tone = 'success' | 'error' | 'info';

function Trigger({ message, type }: { message: string; type: Tone }) {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast(message, type)} data-testid="trigger">
      Show
    </button>
  );
}

function setup(message = 'Saved successfully', type: Tone = 'success') {
  return render(
    <ToastProvider>
      <Trigger message={message} type={type} />
    </ToastProvider>
  );
}

const show = () => fireEvent.click(screen.getByTestId('trigger'));
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const polite = () => document.querySelector<HTMLElement>('[role="status"]')!;
const assertive = () => document.querySelector<HTMLElement>('[role="alert"]')!;
const toastEl = (text: string) => screen.getByText(text).closest<HTMLElement>('.ui-toast')!;
const dismissBtn = () => screen.getByRole('button', { name: /dismiss notification/i });

function timers() {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });
}

describe('ToastProvider live regions (WAI-ARIA)', () => {
  timers();

  it('mounts the polite and assertive regions before any toast exists', () => {
    setup();
    expect(polite()).toBeInTheDocument();
    expect(polite()).toHaveAttribute('aria-live', 'polite');
    expect(assertive()).toBeInTheDocument();
    expect(assertive()).toHaveAttribute('aria-live', 'assertive');
    // Only newly added toasts are announced, not the whole region again.
    expect(polite()).toHaveAttribute('aria-atomic', 'false');
    expect(assertive()).toHaveAttribute('aria-atomic', 'false');
    expect(polite()).toBeEmptyDOMElement();
    expect(assertive()).toBeEmptyDOMElement();
  });

  it('keeps the same region elements when toasts arrive and leave (never remounted)', () => {
    setup();
    const before = [polite(), assertive()];
    show();
    advance(TOAST_DURATION_MS + TOAST_EXIT_MS);
    expect([polite(), assertive()]).toEqual(before);
    expect(document.body.contains(before[0])).toBe(true);
    expect(document.body.contains(before[1])).toBe(true);
  });

  it.each<[Tone]>([['success'], ['info']])('routes %s toasts to the polite region only', (tone) => {
    setup('Hello', tone);
    show();
    expect(polite()).toContainElement(screen.getByText('Hello'));
    expect(assertive()).not.toContainElement(screen.getByText('Hello'));
  });

  it('routes error toasts to the assertive region only', () => {
    setup('Something broke', 'error');
    show();
    expect(assertive()).toContainElement(screen.getByText('Something broke'));
    expect(polite()).not.toContainElement(screen.getByText('Something broke'));
  });

  it('gives toasts no live role of their own (nested live roles double-announce)', () => {
    setup('Hello', 'info');
    show();
    expect(document.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(2);
  });

  it('maps tones to Banner tones via classes (error is the danger tone)', () => {
    setup('Boom', 'error');
    show();
    expect(toastEl('Boom')).toHaveClass('ui-toast--error');
    expect(toastEl('Boom').querySelector('.ui-banner--danger')).not.toBeNull();
  });

  it('renders no inline styles (all presentation comes from classes and tokens)', () => {
    setup();
    show();
    expect(document.querySelectorAll('.ui-toast-viewport [style]')).toHaveLength(0);
  });

  it('provides a stable showToast so consumers do not re-render per toast', () => {
    const seen: Array<(m: string, t: Tone) => void> = [];
    function Probe() {
      seen.push(useToast().showToast);
      return null;
    }
    const tree = (
      <ToastProvider>
        <Probe />
        <Trigger message="x" type="info" />
      </ToastProvider>
    );
    const { rerender } = render(tree);
    show();
    rerender(tree);
    expect(new Set(seen).size).toBe(1);
  });

  it('useToast throws outside a provider', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger message="x" type="info" />)).toThrow(/within a ToastProvider/);
    err.mockRestore();
  });
});

describe('ToastProvider dismissal timing', () => {
  timers();

  it('exposes a labelled dismiss button', () => {
    setup();
    show();
    expect(dismissBtn()).toBeInTheDocument();
  });

  it('dismisses via the button: leaving class first, removed after the exit animation', () => {
    setup();
    show();
    fireEvent.click(dismissBtn());
    expect(toastEl('Saved successfully')).toHaveClass('ui-toast--leaving');
    advance(TOAST_EXIT_MS - 1);
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  it('auto-dismisses after 5000 ms', () => {
    setup();
    show();
    advance(TOAST_DURATION_MS - 1);
    expect(toastEl('Saved successfully')).not.toHaveClass('ui-toast--leaving');
    advance(1);
    expect(toastEl('Saved successfully')).toHaveClass('ui-toast--leaving');
    advance(TOAST_EXIT_MS);
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  it('pauses auto-dismiss on hover and resumes with the remaining time on leave', () => {
    setup();
    show();
    const toast = toastEl('Saved successfully');
    advance(4000);
    fireEvent.mouseEnter(toast);
    advance(60000);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    fireEvent.mouseLeave(toast);
    advance(999);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    advance(1);
    expect(toast).toHaveClass('ui-toast--leaving');
    advance(TOAST_EXIT_MS);
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  it('pauses while a control inside the toast has focus and resumes on blur', () => {
    setup();
    show();
    const btn = dismissBtn();
    act(() => btn.focus());
    advance(60000);
    expect(toastEl('Saved successfully')).not.toHaveClass('ui-toast--leaving');
    act(() => btn.blur());
    advance(TOAST_DURATION_MS);
    expect(toastEl('Saved successfully')).toHaveClass('ui-toast--leaving');
  });

  it('stays paused until BOTH hover and focus have ended', () => {
    setup();
    show();
    const toast = toastEl('Saved successfully');
    const btn = dismissBtn();
    act(() => btn.focus());
    fireEvent.mouseEnter(toast);
    fireEvent.mouseLeave(toast);
    advance(60000);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    act(() => btn.blur());
    advance(TOAST_DURATION_MS);
    expect(toast).toHaveClass('ui-toast--leaving');
  });

  it('stays paused when focus leaves while the pointer is still over the toast', () => {
    setup();
    show();
    const toast = toastEl('Saved successfully');
    const btn = dismissBtn();
    fireEvent.mouseEnter(toast);
    act(() => btn.focus());
    act(() => btn.blur());
    advance(60000);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    fireEvent.mouseLeave(toast);
    advance(TOAST_DURATION_MS);
    expect(toast).toHaveClass('ui-toast--leaving');
  });

  it('under prefers-reduced-motion, dismiss removes the toast immediately (no exit animation)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    setup();
    show();
    fireEvent.click(dismissBtn());
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  it('dismissing one toast leaves the others', () => {
    setup();
    show();
    show();
    const buttons = screen.getAllByRole('button', { name: /dismiss notification/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    advance(TOAST_EXIT_MS);
    expect(screen.getAllByText('Saved successfully')).toHaveLength(1);
  });
});

describe('ToastProvider focus handling', () => {
  timers();

  it('returns focus to the element that had it before the toast took focus', () => {
    setup();
    const opener = screen.getByTestId('trigger');
    act(() => opener.focus());
    show();
    const btn = dismissBtn();
    act(() => btn.focus());
    fireEvent.click(btn);
    advance(TOAST_EXIT_MS);
    expect(document.activeElement).toBe(opener);
  });

  it('does not steal focus when the dismissed toast did not hold it', () => {
    setup();
    const opener = screen.getByTestId('trigger');
    show();
    act(() => opener.focus());
    advance(TOAST_DURATION_MS + TOAST_EXIT_MS);
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('is not a focus trap: Tab is not intercepted and only the dismiss button is tabbable', () => {
    setup();
    show();
    expect(fireEvent.keyDown(dismissBtn(), { key: 'Tab' })).toBe(true);
    expect(document.querySelectorAll('.ui-toast-viewport [tabindex]')).toHaveLength(0);
    expect(document.querySelectorAll('.ui-toast-viewport button')).toHaveLength(1);
  });
});
