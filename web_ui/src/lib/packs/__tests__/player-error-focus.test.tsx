/**
 * PR 144 review F19: the player START failure alert (training-player-error)
 * appears after mount, once the course host reports it did not start. It must
 * be programmatically focusable and take keyboard focus so AT users land on it.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const host = vi.hoisted(() => ({
  openCourse: vi.fn(async () => ({ ready: false, detail: 'the training player service did not start' })),
  closeCourse: vi.fn(),
  relay: { servedCount: () => 0 },
}));

vi.mock('../browser-training', () => ({ browserTrainingHost: () => host }));
vi.mock('../../../components/training-player-bridge', () => ({
  frameOrigin: () => null,
  createTrainingPlayerBridge: () => ({ jumpToSlide: async () => false, readState: async () => null, destroy: () => undefined }),
}));

import { TrainingPlayer } from '../../../components/TrainingPlayer';
import { resetPlayerOriginForTests } from '../player-origin';

afterEach(() => {
  cleanup();
  resetPlayerOriginForTests();
  vi.clearAllMocks();
});

describe('player start failure alert focus (F19)', () => {
  it('PE1 training-player-error is focusable and receives focus when it appears', async () => {
    resetPlayerOriginForTests('http://127.0.0.1:4183');
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.queryByTestId('training-player-error')).toBeNull();
    const alert = await screen.findByTestId('training-player-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveAttribute('tabindex', '-1');
    expect(alert).toHaveTextContent(/did not start/);
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
