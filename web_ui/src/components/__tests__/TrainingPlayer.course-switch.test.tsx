/**
 * PRR-215 (PR 150 review): the player stays mounted when the course changes (the
 * Training page renders it without a key), so the per-course slide dedupe, the
 * readout and the slide-change log must reset on the switch.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const bridge = vi.hoisted(() => ({ state: null as { slideId: string; slideTitle: string } | null }));
vi.mock('../training-player-bridge', () => ({
  createTrainingPlayerBridge: () => ({
    jumpToSlide: () => Promise.resolve(false),
    readState: () => Promise.resolve(bridge.state),
    destroy: () => undefined,
  }),
}));

import { TrainingPlayer } from '../TrainingPlayer';

beforeEach(() => {
  (window as unknown as { desktopApi?: unknown }).desktopApi = {};
  bridge.state = null;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).desktopApi;
  vi.useRealTimers();
});

const entries = (): string[] =>
  Array.from(screen.getByTestId('training-player-slidechange').querySelectorAll('[data-trainingapp-entry]')).map(
    (el) => el.textContent ?? '',
  );

describe('TrainingPlayer course switch (PRR-215)', () => {
  it('re-emits a slide id the previous course ended on, and clears the log and readout', async () => {
    vi.useFakeTimers();
    const onSlideChange = vi.fn();
    bridge.state = { slideId: 'intro', slideTitle: 'Course A intro' };
    const view = render(<TrainingPlayer packId="course-a" onSlideChange={onSlideChange} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onSlideChange).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual(['intro|Course A intro']);

    // Switch course while mounted; the new course has no readable state yet.
    bridge.state = null;
    view.rerender(<TrainingPlayer packId="course-b" onSlideChange={onSlideChange} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(entries()).toEqual([]);
    expect(screen.getByTestId('training-player-slide').textContent).toBe('');

    // The new course's first slide shares the id the old course ended on.
    bridge.state = { slideId: 'intro', slideTitle: 'Course B intro' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onSlideChange).toHaveBeenCalledTimes(2);
    expect(onSlideChange).toHaveBeenLastCalledWith({ slideId: 'intro', slideTitle: 'Course B intro' });
    expect(entries()).toEqual(['intro|Course B intro']);
  });
});
