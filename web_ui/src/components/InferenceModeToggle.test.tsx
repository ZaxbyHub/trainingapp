/**
 * Tests for InferenceModeToggle — the chat-header STATUS indicator.
 *
 * #265 (AC6, decision comment 6825525627): this control is a NON-FLIPPING
 * status indicator — a status dot plus a status word, rendered ONLY inside
 * the Electron desktop app (null in the browser). There is no button and it
 * never calls setMode; run-location changes are made in Settings. These tests
 * pin that current contract:
 *   - nothing renders outside Electron;
 *   - word + dot tone per inference state: browser-local Ready / Not ready /
 *     Loading… (progress strictly between 1 and 99), api Connected, api
 *     modeError → error dot with NO visible word;
 *   - the tooltip sentence is exposed on dot and status span (title + the
 *     visually-hidden sentence, U7b);
 *   - and there is never a button to flip modes.
 *
 * The context hook (useInferenceMode) and the Electron probe (isElectron)
 * are stubbed at module level so each state is driven directly, without the
 * real provider's boot side effects (connectivity fetch, localStorage
 * migrations).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { InferenceModeToggle } from './InferenceModeToggle';

const electron = vi.hoisted(() => ({ on: false }));

vi.mock('../lib/desktop-session', () => ({
  isElectron: () => electron.on,
}));

const inferenceState = vi.hoisted(() => ({
  value: {
    mode: 'browser-local' as 'browser-local' | 'api',
    isModelReady: false,
    modelLoadingProgress: 0,
    isServerConnected: false,
    modeError: null as string | null,
  },
  // Spy pinning the non-flipping contract: the component must never invoke
  // setMode itself — run-location changes happen in Settings (#265 AC6).
  setMode: vi.fn(),
}));

vi.mock('../lib/inference', () => ({
  useInferenceMode: () => ({ ...inferenceState.value, setMode: inferenceState.setMode }),
}));

function setInferenceState(overrides: Partial<typeof inferenceState.value>): void {
  inferenceState.value = { ...inferenceState.value, ...overrides };
}

beforeEach(() => {
  electron.on = true;
  inferenceState.value = {
    mode: 'browser-local',
    isModelReady: false,
    modelLoadingProgress: 0,
    isServerConnected: false,
    modeError: null,
  };
  inferenceState.setMode.mockClear();
});

afterEach(() => {
  cleanup();
});

/** The status span's own testid element (word + visually-hidden sentence). */
function statusSpan(): HTMLElement {
  return screen.getByTestId('inference-mode-status');
}

/** The decorative status dot. */
function statusDot(): HTMLElement {
  return document.querySelector('.chat-mode__dot') as HTMLElement;
}

/**
 * What a sighted user sees in the status span: its text minus the
 * visually-hidden tooltip sentence (the component hides the full sentence in
 * a .ui-visually-hidden child, U7b).
 */
function visibleStatusWord(): string {
  const clone = statusSpan().cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.ui-visually-hidden').forEach((hidden) => hidden.remove());
  return (clone.textContent ?? '').trim();
}

describe('InferenceModeToggle (non-flipping status indicator)', () => {
  describe('rendering', () => {
    it('renders nothing outside the Electron desktop app', () => {
      electron.on = false;
      const { container } = render(<InferenceModeToggle />);
      expect(container.querySelector('.chat-mode')).toBeNull();
      expect(screen.queryByTestId('inference-mode-status')).toBeNull();
    });

    it('renders the dot + status word inside Electron and never a button', () => {
      const { container } = render(<InferenceModeToggle />);
      expect(container.querySelector('.chat-mode__dot')).toBeInTheDocument();
      expect(statusSpan()).toBeInTheDocument();
      // #265 AC6: the mode-flip button was removed — this control only
      // REPORTS state; run-location changes happen in Settings.
      expect(screen.queryByRole('button')).toBeNull();
      // Non-flipping, verifiable: rendering in any state never invokes the
      // context's setMode.
      expect(inferenceState.setMode).not.toHaveBeenCalled();
    });
  });

  describe('status word + dot tone per inference state', () => {
    it('browser-local with a ready model shows "Ready" and an ok dot', () => {
      setInferenceState({ mode: 'browser-local', isModelReady: true });
      render(<InferenceModeToggle />);
      expect(visibleStatusWord()).toBe('Ready');
      expect(statusDot().getAttribute('data-status')).toBe('ok');
      expect(statusDot()).toHaveAttribute('title', 'In this window (model ready)');
    });

    it('browser-local with an unloaded model shows "Not ready" and a pending dot', () => {
      // No load is running (progress 0): the honest word is "Not ready", not
      // "Loading…" (review F3).
      setInferenceState({ mode: 'browser-local', isModelReady: false, modelLoadingProgress: 0 });
      render(<InferenceModeToggle />);
      expect(visibleStatusWord()).toBe('Not ready');
      expect(statusDot().getAttribute('data-status')).toBe('pending');
      expect(statusDot()).toHaveAttribute('title', 'In this window (model not loaded)');
    });

    it('browser-local while a load reports progress (1-99) shows "Loading…" and a pending dot', () => {
      setInferenceState({ mode: 'browser-local', isModelReady: false, modelLoadingProgress: 50 });
      render(<InferenceModeToggle />);
      expect(visibleStatusWord()).toBe('Loading…');
      expect(statusDot().getAttribute('data-status')).toBe('pending');
      expect(statusDot()).toHaveAttribute('title', 'In this window (model loading, 50%)');
    });

    it('api mode with a connected server shows "Connected" and an ok dot', () => {
      setInferenceState({ mode: 'api', isServerConnected: true });
      render(<InferenceModeToggle />);
      expect(visibleStatusWord()).toBe('Connected');
      expect(statusDot().getAttribute('data-status')).toBe('ok');
      expect(statusDot()).toHaveAttribute('title', 'Desktop backend (connected)');
    });

    it('api mode with a modeError shows an error dot and NO visible word', () => {
      setInferenceState({
        mode: 'api',
        isServerConnected: false,
        modeError: 'Server unreachable',
      });
      render(<InferenceModeToggle />);
      expect(statusDot().getAttribute('data-status')).toBe('error');
      // Review F8: ChatPage already shows the "Server not connected" pill in
      // this state, so the indicator repeats nothing visibly — but the hidden
      // sentence still reads the failure.
      expect(visibleStatusWord()).toBe('');
      const hidden = statusSpan().querySelector('.ui-visually-hidden');
      expect(hidden?.textContent).toContain('Desktop backend (Server unreachable)');
    });
  });

  describe('tooltip accessibility (U7b)', () => {
    it('dot and status span both carry the full tooltip sentence via title', () => {
      setInferenceState({ mode: 'browser-local', isModelReady: true });
      render(<InferenceModeToggle />);
      // Both the decorative dot and the status span expose the sentence.
      const tooltips = screen.getAllByTitle('In this window (model ready)');
      expect(tooltips).toHaveLength(2);
      // The sentence is also legible to assistive tech as hidden text.
      const hidden = statusSpan().querySelector('.ui-visually-hidden');
      expect(hidden?.textContent).toContain('In this window (model ready)');
    });
  });
});
