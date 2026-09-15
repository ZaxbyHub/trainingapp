/**
 * D5 acceptance check C5 (issue #81, AC5): the TrainingPlayer component is
 * packId-parameterized and exposes the jumpToSlide imperative handle.
 *
 * FROZEN SPEC — authored by the independent check author at base d2380bb,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Component contract frozen by this spec (web_ui/src/components/TrainingPlayer.tsx):
 *
 *   export const TrainingPlayer = forwardRef<TrainingPlayerHandle, TrainingPlayerProps>
 *   interface TrainingPlayerProps {
 *     packId: string;
 *     initialSlideId?: string;
 *     onSlideChange?: (event: { slideId: string; slideTitle: string }) => void;
 *   }
 *   interface TrainingPlayerHandle { jumpToSlide(slideId: string): Promise<boolean>; }
 *
 *   - renders <iframe data-testid="training-player-frame" src={`app://training/${packId}/story.html`} ...>
 *   - renders the current player state as text in
 *     [data-testid="training-player-slide"] formatted `${slideId}|${slideTitle}`
 *     (empty/unpopulated until the first state read)
 *   - renders [data-testid="training-player-slidechange"], a log that gains
 *     exactly ONE child [data-trainingapp-entry] (text `${slideId}|${slideTitle}`)
 *     per emitted slidechange — the AC3 observation surface
 *   - polls the player state at a cadence of at most 1000 ms and emits
 *     onSlideChange ONLY when the slideId changes (no event for unchanged polls)
 *   - while mounted, exposes the e2e drive seam
 *     window.__trainingappTrainingPlayer = { jumpToSlide } (cleared on unmount) —
 *     this is how the Electron e2e (desktop/e2e/training-player.spec.ts) drives
 *     the component's own API without touching Storyline DOM
 *
 * BRIDGE INJECTION SEAM (defined by the component, frozen here): the component
 * must source ALL player-frame communication from the sibling module
 * web_ui/src/components/training-player-bridge.ts:
 *
 *   export interface TrainingPlayerBridge {
 *     jumpToSlide(slideId: string): Promise<boolean>;
 *     readState(): Promise<{ slideId: string; slideTitle: string } | null>;
 *   }
 *   export function createTrainingPlayerBridge(frame: HTMLIFrameElement): TrainingPlayerBridge;
 *
 * This test mocks that module at its boundary. The mechanism INSIDE it (the
 * postMessage protocol of desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md
 * §5) is exercised live by the e2e checks, not here.
 */
import React, { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

// Controllable fake bridge (hoisted so vi.mock's factory can close over it).
const bridge = vi.hoisted(() => {
  const ctrl = {
    frames: [] as Array<HTMLElement | undefined>,
    jumpCalls: [] as string[],
    jumpResults: new Map<string, boolean>(),
    stateQueue: [] as Array<{ slideId: string; slideTitle: string } | null>,
    readIndex: 0,
    reset() {
      ctrl.frames = [];
      ctrl.jumpCalls = [];
      ctrl.jumpResults = new Map();
      ctrl.stateQueue = [];
      ctrl.readIndex = 0;
    },
  };
  return ctrl;
});

vi.mock('../training-player-bridge', () => ({
  createTrainingPlayerBridge: (frame: HTMLElement) => {
    bridge.frames.push(frame);
    return {
      jumpToSlide: (slideId: string) => {
        bridge.jumpCalls.push(slideId);
        const ok = bridge.jumpResults.get(slideId) ?? false;
        return Promise.resolve(ok);
      },
      readState: () => {
        const value =
          bridge.readIndex < bridge.stateQueue.length
            ? bridge.stateQueue[bridge.readIndex++]
            : bridge.stateQueue[bridge.stateQueue.length - 1] ?? null;
        return Promise.resolve(value ?? null);
      },
    };
  },
}));

import { TrainingPlayer } from '../TrainingPlayer';

const OPMED = 'opmed-cdp-mlc';
const SECOND = 'second.course_pub';

function frameElement(): HTMLIFrameElement {
  return screen.getByTestId('training-player-frame') as HTMLIFrameElement;
}

beforeEach(() => {
  bridge.reset();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__trainingappTrainingPlayer;
  vi.useRealTimers();
});

describe('D5 C5: TrainingPlayer component (issue #81 AC5)', () => {
  it('renders an iframe whose src starts with app://training/<packId>/story.html', () => {
    bridge.stateQueue = [null];
    render(<TrainingPlayer packId={OPMED} />);
    const frame = frameElement();
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.src.startsWith(`app://training/${OPMED}/story.html`)).toBe(true);
  });

  it('renders differently for two distinct packIds (multi-course readiness)', () => {
    bridge.stateQueue = [null];
    const first = render(<TrainingPlayer packId={OPMED} />);
    expect(frameElement().src.startsWith(`app://training/${OPMED}/story.html`)).toBe(true);
    first.unmount();

    bridge.reset();
    bridge.stateQueue = [null];
    render(<TrainingPlayer packId={SECOND} />);
    expect(frameElement().src.startsWith(`app://training/${SECOND}/story.html`)).toBe(true);
    expect(frameElement().src.startsWith(`app://training/${OPMED}/story.html`)).toBe(false);
  });

  it('creates its bridge against the rendered player frame', () => {
    bridge.stateQueue = [null];
    render(<TrainingPlayer packId={OPMED} />);
    expect(bridge.frames.length).toBeGreaterThanOrEqual(1);
    expect(bridge.frames[0]).toBe(frameElement());
  });

  it('ref/handle jumpToSlide resolves a boolean promise (true when the bridge jumps, false when it cannot)', async () => {
    bridge.stateQueue = [null];
    bridge.jumpResults.set('6mEtFwFWVpq', true);
    const ref = createRef<{ jumpToSlide: (id: string) => Promise<boolean> }>();
    render(<TrainingPlayer ref={ref} packId={OPMED} />);
    expect(typeof ref.current?.jumpToSlide).toBe('function');
    const ok = await ref.current!.jumpToSlide('6mEtFwFWVpq');
    expect(ok).toBe(true);
    expect(bridge.jumpCalls).toContain('6mEtFwFWVpq');
    const bad = await ref.current!.jumpToSlide('does-not-exist');
    expect(bad).toBe(false);
  });

  it('exposes the e2e drive seam window.__trainingappTrainingPlayer while mounted', async () => {
    bridge.stateQueue = [null];
    bridge.jumpResults.set('5rN4PvXJM5d', true);
    const { unmount } = render(<TrainingPlayer packId={OPMED} />);
    const w = window as unknown as { __trainingappTrainingPlayer?: { jumpToSlide(id: string): Promise<boolean> } };
    expect(typeof w.__trainingappTrainingPlayer?.jumpToSlide).toBe('function');
    await expect(w.__trainingappTrainingPlayer!.jumpToSlide('5rN4PvXJM5d')).resolves.toBe(true);
    unmount();
    expect(w.__trainingappTrainingPlayer).toBeUndefined();
  });

  it('polls state (<=1000ms cadence) and emits onSlideChange only on slideId change', async () => {
    vi.useFakeTimers();
    const onSlideChange = vi.fn();
    // Only null states available at first: whether the component polls at mount
    // or only on its interval, no event may fire yet.
    bridge.stateQueue = [null, null];
    render(<TrainingPlayer packId={OPMED} onSlideChange={onSlideChange} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(onSlideChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('training-player-slidechange').querySelectorAll('[data-trainingapp-entry]')).toHaveLength(0);

    // State becomes Welcome: exactly one event, slide text rendered, one entry.
    bridge.stateQueue.push({ slideId: '5rN4PvXJM5d', slideTitle: 'Welcome' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(onSlideChange).toHaveBeenCalledTimes(1);
    expect(onSlideChange).toHaveBeenLastCalledWith({ slideId: '5rN4PvXJM5d', slideTitle: 'Welcome' });
    expect(screen.getByTestId('training-player-slide').textContent).toBe('5rN4PvXJM5d|Welcome');
    expect(screen.getByTestId('training-player-slidechange').querySelectorAll('[data-trainingapp-entry]')).toHaveLength(1);

    // Unchanged polls (Welcome again, several cycles): NO new event, NO new entry.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onSlideChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('training-player-slidechange').querySelectorAll('[data-trainingapp-entry]')).toHaveLength(1);

    // Change to Roles Menu: exactly one new event + one new log entry with the new id|title.
    bridge.stateQueue.push({ slideId: '6RdggQhakWc', slideTitle: 'Roles Menu' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(onSlideChange).toHaveBeenCalledTimes(2);
    expect(onSlideChange).toHaveBeenLastCalledWith({ slideId: '6RdggQhakWc', slideTitle: 'Roles Menu' });
    const entries = screen.getByTestId('training-player-slidechange').querySelectorAll('[data-trainingapp-entry]');
    expect(entries).toHaveLength(2);
    expect(entries[entries.length - 1].textContent).toBe('6RdggQhakWc|Roles Menu');
  });

  it('drives initialSlideId through the bridge once state is readable', async () => {
    vi.useFakeTimers();
    bridge.stateQueue = [null, { slideId: '5rN4PvXJM5d', slideTitle: 'Welcome' }];
    bridge.jumpResults.set('6mZvfaT2voE', true);
    render(<TrainingPlayer packId={OPMED} initialSlideId="6mZvfaT2voE" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(bridge.jumpCalls).toContain('6mZvfaT2voE');
  });
});
