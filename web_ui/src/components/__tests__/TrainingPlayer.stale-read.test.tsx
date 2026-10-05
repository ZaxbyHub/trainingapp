/**
 * PRR-215 guard: a slide read that resolves AFTER the course changed belongs to the old
 * course and must be dropped (the live flag of the poll effect), not shown or emitted.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

type State = { slideId: string; slideTitle: string } | null;
const reads = vi.hoisted(() => ({ pending: [] as Array<(state: State) => void> }));
vi.mock('../training-player-bridge', () => ({
  createTrainingPlayerBridge: () => ({
    jumpToSlide: () => Promise.resolve(false),
    readState: () => new Promise<State>((resolve) => reads.pending.push(resolve)),
    destroy: () => undefined,
  }),
}));

import { TrainingPlayer } from '../TrainingPlayer';

beforeEach(() => {
  (window as unknown as { desktopApi?: unknown }).desktopApi = {};
  reads.pending = [];
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).desktopApi;
});

describe('TrainingPlayer stale slide read after a course switch (PRR-215)', () => {
  it('drops a read that resolves after the course changed, and still accepts the new course read', async () => {
    const onSlideChange = vi.fn();
    const view = render(<TrainingPlayer packId="course-a" onSlideChange={onSlideChange} />);
    expect(reads.pending).toHaveLength(1); // course A's mount read, still in flight
    view.rerender(<TrainingPlayer packId="course-b" onSlideChange={onSlideChange} />);
    expect(reads.pending).toHaveLength(2); // course B's own mount read

    await act(async () => reads.pending[0]({ slideId: 'a-last', slideTitle: 'Course A last slide' }));
    expect(onSlideChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('training-player-slide').textContent).toBe('');

    await act(async () => reads.pending[1]({ slideId: 'b-first', slideTitle: 'Course B first slide' }));
    expect(onSlideChange).toHaveBeenCalledTimes(1);
    expect(onSlideChange).toHaveBeenLastCalledWith({ slideId: 'b-first', slideTitle: 'Course B first slide' });
  });
});
