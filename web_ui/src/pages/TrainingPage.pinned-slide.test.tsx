/**
 * D7 acceptance check C1 — wire half (issue #83, AC1): the player's
 * `slidechange` event reaches the page level, where the pinned-slide state
 * for the chat panel is captured.
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec (web_ui/src/pages/TrainingPage.tsx):
 *
 *   export interface TrainingPageProps {
 *     initialPackId?: string;
 *     pendingSlideId?: string;
 *     // D7 (issue #83): forwarded verbatim to TrainingPlayer.onSlideChange.
 *     onSlideChange?: (event: { slideId: string; slideTitle: string }) => void;
 *   }
 *
 * When TrainingPage renders <TrainingPlayer .../>, it must pass
 * `onSlideChange={onSlideChange}` so each emitted slidechange (exactly one
 * per slideId change — TrainingPlayer already guarantees that) reaches the
 * page's caller (App), which owns the pinned-slide state.
 *
 * Test mechanism: the TrainingPlayer bridge module
 * (web_ui/src/components/training-player-bridge.ts) is mocked with a
 * controllable stateQueue + fake timers, exactly like
 * src/components/__tests__/TrainingPlayer.test.tsx. No network, no player.
 */
import React from 'react';
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

vi.mock('../components/training-player-bridge', () => ({
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

import { TrainingPage } from './TrainingPage';

const PACK = 'opmed-cdp-mlc';

beforeEach(() => {
  bridge.reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('D7 C1 (wire): TrainingPage forwards slidechange into pinned-slide state (issue #83 AC1)', () => {
  it('renders the player for initialPackId (base behavior preserved)', () => {
    bridge.stateQueue = [null];
    render(<TrainingPage initialPackId={PACK} />);
    const frame = screen.getByTestId('training-player-frame') as HTMLIFrameElement;
    expect(frame.src.startsWith(`app://training/${PACK}/story.html`)).toBe(true);
  });

  it('[AC1-RED] TrainingPage must forward the player slidechange to its onSlideChange prop', async () => {
    vi.useFakeTimers();
    const onSlideChange = vi.fn();
    // No state at first (course not started), then the Welcome slide appears.
    bridge.stateQueue = [null, { slideId: '5rN4PvXJM5d', slideTitle: 'Welcome' }];
    render(<TrainingPage initialPackId={PACK} onSlideChange={onSlideChange} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(
      onSlideChange,
      '[AC1-RED] expected onSlideChange to fire with the slidechange payload — TrainingPage does not pass onSlideChange through to TrainingPlayer yet'
    ).toHaveBeenCalledTimes(1);
    expect(onSlideChange).toHaveBeenLastCalledWith({
      slideId: '5rN4PvXJM5d',
      slideTitle: 'Welcome',
    });
  });

  it('[AC1-RED] a later slidechange replaces the captured slide (pin follows the player)', async () => {
    vi.useFakeTimers();
    const onSlideChange = vi.fn();
    bridge.stateQueue = [
      null,
      { slideId: '5rN4PvXJM5d', slideTitle: 'Welcome' },
      { slideId: '5rN4PvXJM5d', slideTitle: 'Welcome' },
      { slideId: '6RdggQhakWc', slideTitle: 'Roles Menu' },
    ];
    render(<TrainingPage initialPackId={PACK} onSlideChange={onSlideChange} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });

    expect(
      onSlideChange,
      '[AC1-RED] expected exactly two slidechange events (Welcome, then Roles Menu) — the pin must be replaced by every new slidechange'
    ).toHaveBeenCalledTimes(2);
    expect(onSlideChange).toHaveBeenLastCalledWith({
      slideId: '6RdggQhakWc',
      slideTitle: 'Roles Menu',
    });
  });
});
