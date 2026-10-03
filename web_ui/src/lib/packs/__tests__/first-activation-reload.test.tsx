/**
 * First-activation reload under the frame-policy gate (ADR-0012 threat model
 * item 6). The course frame now mounts as about:blank and switches to the
 * player-origin URL only after the player origin resolved with its frame
 * policy installed. The first-activation reload (TrainingPlayer
 * handleFrameLoad: when the worker did not intercept the frame's first load,
 * reassign src ONCE after the relay is ready) must still fire exactly once
 * for the course load, and never for the pre-resolution about:blank load.
 *
 *   FA1 about:blank load before resolution: no reload.
 *   FA2 first course load with nothing served: exactly one src reassignment
 *       once the relay is ready; later loads never reload again.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const fake = vi.hoisted(() => ({
  enabled: false,
  served: 0,
  openCalls: [] as string[],
  readyResolve: null as null | ((info: { ready: boolean; hadActiveWorker: boolean }) => void),
}));

vi.mock('../../../components/training-player-bridge', () => ({
  frameOrigin: () => null,
  createTrainingPlayerBridge: () => ({ jumpToSlide: async () => false, readState: async () => null, destroy: () => undefined }),
}));

vi.mock('../browser-training', () => {
  const host = {
    relay: { servedCount: () => fake.served },
    openCourse: (courseId: string) => {
      fake.openCalls.push(courseId);
      return new Promise((resolve) => {
        fake.readyResolve = resolve;
      });
    },
    closeCourse: () => undefined,
  };
  return { browserTrainingHost: () => (fake.enabled ? host : null) };
});

import { TrainingPlayer } from '../../../components/TrainingPlayer';
import { loopbackAliasOrigin, resetPlayerOriginForTests, resolvePlayerOrigin } from '../player-origin';

afterEach(() => {
  cleanup();
  resetPlayerOriginForTests();
  vi.restoreAllMocks();
  fake.enabled = false;
  fake.served = 0;
  fake.openCalls = [];
  fake.readyResolve = null;
});

describe('first-activation reload with the frame-policy gate', () => {
  it('FA1/FA2 the about:blank load never reloads; the first course load reloads exactly once', async () => {
    resetPlayerOriginForTests();
    let release: (response: Response) => void = () => undefined;
    const config = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn((url: string) => (url === 'player-origin.json' ? config : Promise.reject(new Error('offline'))));
    const resolving = resolvePlayerOrigin(fetchImpl as unknown as typeof fetch);

    render(<TrainingPlayer packId="pack-a" />);
    const frame = screen.getByTestId('training-player-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('about:blank');
    const setAttribute = vi.spyOn(frame, 'setAttribute');

    // FA1: the pre-resolution about:blank load reaches handleFrameLoad.
    fireEvent.load(frame);
    await Promise.resolve();
    expect(setAttribute).not.toHaveBeenCalledWith('src', expect.anything());
    expect(fake.openCalls).toEqual([]);

    // Resolution: the policy installs, the host appears, the src switches.
    fake.enabled = true;
    release(new Response('<html>spa</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const alias = loopbackAliasOrigin(window.location.origin)!;
    await expect(resolving).resolves.toBe(alias);
    const courseUrl = `${alias}/training/pack-a/story.html`;
    await waitFor(() => expect(frame.getAttribute('src')).toBe(courseUrl));
    await waitFor(() => expect(fake.openCalls).toEqual(['pack-a']));
    setAttribute.mockClear();

    // FA2: the first course load was not intercepted (nothing served).
    fireEvent.load(frame);
    expect(setAttribute).not.toHaveBeenCalledWith('src', expect.anything());
    fake.readyResolve?.({ ready: true, hadActiveWorker: false });
    await waitFor(() => expect(setAttribute).toHaveBeenCalledWith('src', courseUrl));
    expect(setAttribute.mock.calls.filter(([name]) => name === 'src')).toHaveLength(1);

    // A later load never reloads again.
    fireEvent.load(frame);
    await Promise.resolve();
    await Promise.resolve();
    expect(setAttribute.mock.calls.filter(([name]) => name === 'src')).toHaveLength(1);
  });
});
