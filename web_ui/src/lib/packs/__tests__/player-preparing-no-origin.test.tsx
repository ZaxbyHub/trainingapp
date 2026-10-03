// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://training.example.com/"}
/**
 * A non-loopback host with no build-time origin relies on the runtime
 * player-origin.json. While that fetch is pending the static prediction is
 * null ('no-origin'), but the player must show the polite preparing status,
 * not the no-origin alert (which also takes focus). A deployment that truly
 * has no origin still gets the alert once resolution settles to null.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../browser-training', () => ({ browserTrainingHost: () => null }));
vi.mock('../../../components/training-player-bridge', () => ({
  frameOrigin: () => null,
  createTrainingPlayerBridge: () => ({ jumpToSlide: async () => false, readState: async () => null, destroy: () => undefined }),
}));

import { TrainingPlayer } from '../../../components/TrainingPlayer';
import { resetPlayerOriginForTests } from '../player-origin';

afterEach(() => {
  cleanup();
  resetPlayerOriginForTests();
  vi.unstubAllGlobals();
});

function pendingFetch() {
  let release: (r: Response) => void = () => undefined;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
  return (r: Response) => release(r);
}

describe('no-origin alert vs pending resolution', () => {
  it('NO1 pending: status only, no alert, focus unmoved; a valid origin never raises an alert', async () => {
    expect(window.location.origin).toBe('https://training.example.com');
    resetPlayerOriginForTests();
    const release = pendingFetch();
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.getByTestId('training-player-preparing')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(document.body);
    release(new Response(JSON.stringify({ playerOrigin: 'https://player.example.com' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(screen.queryByTestId('training-player-preparing')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).not.toBeNull();
    expect(screen.getByTestId('training-player-frame').getAttribute('src')).toMatch(/^https:\/\/player\.example\.com\//);
  });

  it('NO2 settles to null: the no-origin alert appears and takes focus', async () => {
    resetPlayerOriginForTests();
    const release = pendingFetch();
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.queryByTestId('training-player-unavailable')).toBeNull();
    release(new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const alert = await screen.findByTestId('training-player-unavailable');
    expect(screen.queryByTestId('training-player-preparing')).toBeNull();
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
