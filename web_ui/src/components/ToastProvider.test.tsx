/**
 * Toast system tests (ToastProvider is the app-facing wrapper over ui/Toast).
 * Lumen phase 7 rewrote the old inline-style assertions to role / class / state
 * assertions: always-mounted live regions (WAI-ARIA), tone to region routing,
 * dismiss + auto-dismiss + pause timing, focus return, reduced motion.
 */
import { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ToastProvider, useToast } from './ToastProvider';
import { MAX_TOASTS, TOAST_DURATION_MS, TOAST_EXIT_MS } from '../ui/Toast';

type Tone = 'success' | 'error' | 'info';

function Trigger({ message, type }: { message: string; type: Tone }) {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast(message, type)} data-testid="trigger">
      Show
    </button>
  );
}

/** Each click shows a DIFFERENT message (identical message+type pairs are deduped). */
function Burst() {
  const { showToast } = useToast();
  const n = useRef(0);
  return (
    <button onClick={() => showToast(`Message ${n.current++}`, 'info')} data-testid="burst">
      Burst
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
    // Spies (e.g. Element.prototype.matches) are restored here, not at the end of the test that
    // made them, so a mid-test throw cannot leak one into later tests. (PRR-152-07)
    vi.restoreAllMocks();
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

  it('exposes both regions in the accessibility tree while empty (not display:none)', () => {
    setup();
    // getByRole skips inaccessible (hidden) elements, so this fails if a stylesheet hides an empty region.
    expect(screen.getByRole('status')).toBe(polite());
    expect(screen.getByRole('alert')).toBe(assertive());
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
    // Fresh elements (the same `tree` reference would bail out and re-render nothing),
    // so the provider and the probe genuinely re-render.
    rerender(
      <ToastProvider>
        <Probe />
        <Trigger message="x" type="info" />
      </ToastProvider>
    );
    expect(seen.length).toBeGreaterThan(1);
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
    advance(3000);
    act(() => btn.focus());
    advance(60000);
    expect(toastEl('Saved successfully')).not.toHaveClass('ui-toast--leaving');
    act(() => btn.blur());
    // Resumes with the 2000 ms that were left; a restart would run the full 5000 again.
    advance(1999);
    expect(toastEl('Saved successfully')).not.toHaveClass('ui-toast--leaving');
    advance(1);
    expect(toastEl('Saved successfully')).toHaveClass('ui-toast--leaving');
  });

  it('stays paused until BOTH hover and focus have ended', () => {
    setup();
    show();
    const toast = toastEl('Saved successfully');
    const btn = dismissBtn();
    advance(3000);
    act(() => btn.focus());
    fireEvent.mouseEnter(toast);
    fireEvent.mouseLeave(toast);
    advance(60000);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    act(() => btn.blur());
    advance(1999);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    advance(1);
    expect(toast).toHaveClass('ui-toast--leaving');
  });

  it('stays paused when focus leaves while the pointer is still over the toast', () => {
    setup();
    show();
    const toast = toastEl('Saved successfully');
    const btn = dismissBtn();
    advance(3000);
    fireEvent.mouseEnter(toast);
    act(() => btn.focus());
    act(() => btn.blur());
    advance(60000);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    fireEvent.mouseLeave(toast);
    advance(1999);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    advance(1);
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
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId('burst'));
    fireEvent.click(screen.getByTestId('burst'));
    const buttons = screen.getAllByRole('button', { name: /dismiss notification/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    advance(TOAST_EXIT_MS);
    expect(screen.queryByText('Message 0')).not.toBeInTheDocument();
    expect(screen.getByText('Message 1')).toBeInTheDocument();
  });

  it('only the dismiss button dismisses: clicking, Enter or Space on the toast body does not', () => {
    setup();
    show();
    const toast = toastEl('Saved successfully');
    const text = screen.getByText('Saved successfully');
    fireEvent.click(text);
    fireEvent.click(toast);
    for (const key of ['Enter', ' ']) {
      fireEvent.keyDown(text, { key });
      fireEvent.keyDown(toast, { key });
      fireEvent.keyUp(toast, { key });
    }
    advance(TOAST_EXIT_MS + 100);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
  });

  it('pauses when the pointer already rests on the toast at mount (no mouseenter fires)', () => {
    const realMatches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':hover' ? this.classList.contains('ui-toast') : realMatches.call(this, sel);
    });
    setup();
    show();
    const toast = toastEl('Saved successfully');
    advance(60000);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    fireEvent.mouseLeave(toast);
    advance(TOAST_DURATION_MS - 1);
    expect(toast).not.toHaveClass('ui-toast--leaving');
    advance(1);
    expect(toast).toHaveClass('ui-toast--leaving');
  });

  it('does not inherit the Element.prototype.matches spy of the previous test (PRR-152-07)', () => {
    expect(vi.isMockFunction(Element.prototype.matches)).toBe(false);
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

  it('does not restore a stale element once focus left the toasts and came back from nowhere', () => {
    setup();
    const opener = screen.getByTestId('trigger');
    act(() => opener.focus());
    show();
    const btn = dismissBtn();
    act(() => btn.focus()); // entered from the opener
    act(() => btn.blur()); // focus leaves to nowhere (e.g. the window lost focus)
    act(() => btn.focus()); // and returns with no related target
    fireEvent.click(btn);
    advance(TOAST_EXIT_MS);
    expect(document.activeElement).not.toBe(opener);
  });

  it('keeps the original return target while focus moves between toasts', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>
    );
    const opener = screen.getByTestId('burst');
    act(() => opener.focus());
    fireEvent.click(opener);
    fireEvent.click(opener);
    const [first, second] = screen.getAllByRole('button', { name: /dismiss notification/i });
    act(() => first.focus());
    act(() => second.focus());
    fireEvent.click(second);
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

describe('ToastProvider bounds and placement', () => {
  timers();

  it('hands focus to a surviving toast when the cap drops the toast that holds it', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>
    );
    for (let i = 0; i < MAX_TOASTS; i += 1) fireEvent.click(screen.getByTestId('burst'));
    act(() => screen.getAllByRole('button', { name: /dismiss notification/i })[0].focus()); // oldest: Message 0
    fireEvent.click(screen.getByTestId('burst')); // drops Message 0
    expect(screen.queryByText('Message 0')).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByText('Message 1').closest('.ui-toast')!.querySelector('button'));
  });

  it('a repeat that arrives while the first is fading out shows as a new toast', () => {
    setup();
    show();
    fireEvent.click(dismissBtn());
    expect(toastEl('Saved successfully')).toHaveClass('ui-toast--leaving');
    show(); // same message and type, mid-fade
    advance(TOAST_EXIT_MS); // the first is removed
    expect(screen.getAllByText('Saved successfully')).toHaveLength(1);
    expect(toastEl('Saved successfully')).not.toHaveClass('ui-toast--leaving');
  });

  it('a repeated toast restarts the auto-dismiss timer of the one already showing', () => {
    setup();
    show();
    advance(4000);
    show(); // identical: no second toast, but a fresh 5000 ms
    expect(screen.getAllByText('Saved successfully')).toHaveLength(1);
    advance(4999);
    expect(toastEl('Saved successfully')).not.toHaveClass('ui-toast--leaving');
    advance(1);
    expect(toastEl('Saved successfully')).toHaveClass('ui-toast--leaving');
  });

  it('caps visible toasts at MAX_TOASTS, dropping the oldest', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>
    );
    for (let i = 0; i < MAX_TOASTS + 2; i += 1) fireEvent.click(screen.getByTestId('burst'));
    expect(screen.getAllByRole('button', { name: /dismiss notification/i })).toHaveLength(MAX_TOASTS);
    expect(screen.queryByText('Message 0')).not.toBeInTheDocument();
    expect(screen.queryByText('Message 1')).not.toBeInTheDocument();
    expect(screen.getByText(`Message ${MAX_TOASTS + 1}`)).toBeInTheDocument();
  });

  it('does not stack an identical message and type that is already showing', () => {
    setup();
    show();
    show();
    expect(screen.getAllByText('Saved successfully')).toHaveLength(1);
  });

  it('still shows the same message with a different tone', () => {
    const { rerender } = setup('Same', 'info');
    show();
    rerender(
      <ToastProvider>
        <Trigger message="Same" type="error" />
      </ToastProvider>
    );
    show();
    expect(screen.getAllByText('Same')).toHaveLength(2);
  });

  it('portals the viewport to document.body, outside the provider subtree', () => {
    const { container } = setup();
    const viewport = document.querySelector('.ui-toast-viewport')!;
    expect(viewport.parentElement).toBe(document.body);
    expect(container.contains(viewport)).toBe(false);
  });
});
