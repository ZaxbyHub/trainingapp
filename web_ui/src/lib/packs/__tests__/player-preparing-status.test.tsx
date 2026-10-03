/**
 * PR 144 review F19 (second half): while the player origin resolves (up to the
 * config-fetch bound) the player announces a polite status instead of
 * rendering nothing a screen reader can hear. It goes away when resolution
 * settles, never appears under Electron, and never accompanies an alert.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const env = vi.hoisted(() => ({ electron: false }));
vi.mock('../../desktop-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../desktop-session')>()),
  isElectron: () => env.electron,
}));
vi.mock('../../../components/training-player-bridge', () => ({
  frameOrigin: () => null,
  createTrainingPlayerBridge: () => ({ jumpToSlide: async () => false, readState: async () => null, destroy: () => undefined }),
}));

import { TrainingPlayer } from '../../../components/TrainingPlayer';
import { isPlayerOriginPending, resetPlayerOriginForTests } from '../player-origin';

afterEach(() => {
  cleanup();
  env.electron = false;
  resetPlayerOriginForTests();
  vi.unstubAllGlobals();
});

describe('player preparing status (F19)', () => {
  it('PS1 is a polite status while resolution is pending and gone once it settles', async () => {
    resetPlayerOriginForTests(); // unresolved
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    render(<TrainingPlayer packId="pack-a" />);
    const status = screen.getByTestId('training-player-preparing');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(/Preparing the course player/);
    expect(screen.queryByRole('alert')).toBeNull();
    // Settle: every probe answers 404 -> the host does not serve the player.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } })));
    release(new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }));
    await waitFor(() => expect(screen.queryByTestId('training-player-preparing')).toBeNull());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('PS2 is absent once the origin is settled', () => {
    resetPlayerOriginForTests('http://127.0.0.1:4183');
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.queryByTestId('training-player-preparing')).toBeNull();
  });

  it('PS4 isPlayerOriginPending is false under Electron with resolution unsettled, true in the browser', () => {
    resetPlayerOriginForTests();
    env.electron = true;
    expect(isPlayerOriginPending()).toBe(false);
    env.electron = false;
    expect(isPlayerOriginPending()).toBe(true);
    resetPlayerOriginForTests('http://127.0.0.1:4183');
    expect(isPlayerOriginPending()).toBe(false);
  });

  it('PS3 never appears under Electron (no flash)', () => {
    env.electron = true;
    resetPlayerOriginForTests();
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.queryByTestId('training-player-preparing')).toBeNull();
  });
});
