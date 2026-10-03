/**
 * Review round 1 F1/F2 (browser-training-parity AC11, ADR-0012): course
 * playback never starts in a framed app, and the course frame is sandboxed.
 *
 *   FR1 isFramedContext: framed when top or parent is another window, or when
 *       touching them throws; not framed at top level.
 *   FR2 a framed app has no player origin (even a cached one) and never
 *       fetches player-origin.json.
 *   FR3 a framed app has no course host and startBrowserTraining embeds no
 *       boot frame.
 *   FR4 TrainingPlayerHost itself refuses to embed the boot frame when framed.
 *   FR5 TrainingPlayer shows the framed notice (not the player-origin notice).
 *   FR6 the course frame carries exactly the sandbox flags of ADR-0012.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../components/training-player-bridge', () => ({
  frameOrigin: () => null,
  createTrainingPlayerBridge: () => ({ jumpToSlide: async () => false, readState: async () => null, destroy: () => undefined }),
}));

import { TRAINING_FRAME_SANDBOX, TrainingPlayer } from '../../../components/TrainingPlayer';
import { browserTrainingHost, startBrowserTraining } from '../browser-training';
import { getPlayerOrigin, getPlayerOriginStatus, isFramedContext, loopbackAliasOrigin, resetPlayerOriginForTests, resolvePlayerOrigin } from '../player-origin';
import { FRAMED_DETAIL, TrainingPlayerHost, resetTrainingPlayerHostForTests } from '../training-player-host';

const realTop = Object.getOwnPropertyDescriptor(window, 'top');

function frameTheApp(): void {
  const outer = {} as Window;
  Object.defineProperty(window, 'top', { configurable: true, get: () => outer });
}

afterEach(() => {
  cleanup();
  if (realTop !== undefined) Object.defineProperty(window, 'top', realTop);
  resetPlayerOriginForTests();
  resetTrainingPlayerHostForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('framed app refusal (F1)', () => {
  it('FR1 isFramedContext distinguishes top level, framed and inaccessible ancestors', () => {
    const self: Record<string, unknown> = {};
    self.self = self;
    self.top = self;
    self.parent = self;
    expect(isFramedContext(self as unknown as Window)).toBe(false);
    expect(isFramedContext({ ...self, self, top: {} as Window, parent: self } as unknown as Window)).toBe(true);
    expect(isFramedContext({ ...self, self, top: self, parent: {} as Window } as unknown as Window)).toBe(true);
    const throwing = { self } as unknown as Window;
    Object.defineProperty(throwing, 'top', { get: () => { throw new DOMException('blocked', 'SecurityError'); } });
    expect(isFramedContext(throwing)).toBe(true);
    expect(isFramedContext()).toBe(false);
  });

  it('FR2 a framed app has no player origin and never fetches the runtime config', async () => {
    resetPlayerOriginForTests('http://127.0.0.1:4183');
    expect(getPlayerOrigin()).toBe('http://127.0.0.1:4183');
    frameTheApp();
    expect(getPlayerOrigin()).toBeNull();
    const fetchSpy = vi.fn();
    resetPlayerOriginForTests();
    await expect(resolvePlayerOrigin(fetchSpy as unknown as typeof fetch)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('FR3 a framed app has no course host and embeds no boot frame at start', async () => {
    frameTheApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(browserTrainingHost()).toBeNull();
    await startBrowserTraining();
    expect(document.querySelector('iframe[data-testid="training-player-boot"]')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('course playback is disabled'));
  });

  it('FR4 TrainingPlayerHost refuses to embed the boot frame when framed', async () => {
    const host = new TrainingPlayerHost({
      playerOrigin: 'http://127.0.0.1:4183',
      appOrigin: 'http://localhost:4183',
      readActiveFile: async () => null,
    });
    frameTheApp();
    await expect(host.start()).resolves.toEqual({ ready: false, hadActiveWorker: false, detail: FRAMED_DETAIL });
    await expect(host.openCourse('pack-a')).resolves.toMatchObject({ ready: false, detail: FRAMED_DETAIL });
    expect(document.querySelector('iframe[data-testid="training-player-boot"]')).toBeNull();
    host.dispose();
  });

  it('FR5 TrainingPlayer shows the framed notice when the app is framed', () => {
    frameTheApp();
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.getByTestId('training-player-framed')).toHaveTextContent(/embedded in another page/);
    expect(screen.queryByTestId('training-player-unavailable')).toBeNull();
    expect(screen.getByTestId('training-player-frame').getAttribute('src')).toBe('about:blank');
  });
});

describe('player failure alerts take keyboard focus (PR 144 review F19)', () => {
  it('FR5b the framed notice is focusable (tabIndex -1) and receives focus when it appears', async () => {
    frameTheApp();
    render(<TrainingPlayer packId="pack-a" />);
    const alert = screen.getByTestId('training-player-framed');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('FR5c the host-unsupported notice is focusable and takes focus too', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'player-origin.json') return new Response('<html>spa</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    });
    await resolvePlayerOrigin(fetchImpl as unknown as typeof fetch);
    render(<TrainingPlayer packId="pack-a" />);
    const alert = screen.getByTestId('training-player-host-unsupported');
    expect(alert).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(alert).toHaveFocus());
  });
});

describe('course frame sandbox (F2)', () => {
  it('FR6 the course frame is sandboxed without popups or top navigation', () => {
    resetPlayerOriginForTests('http://127.0.0.1:4183');
    render(<TrainingPlayer packId="pack-a" />);
    const sandbox = screen.getByTestId('training-player-frame').getAttribute('sandbox');
    expect(sandbox).toBe(TRAINING_FRAME_SANDBOX);
    expect(sandbox).toBe('allow-scripts allow-same-origin allow-forms');
    expect(sandbox).not.toMatch(/allow-popups|allow-top-navigation|allow-storage-access/);
  });
});

describe('host that does not serve the player (final-critic FC1)', () => {
  function fetchWith(boot: Response | Error) {
    return vi.fn(async (url: string) => {
      if (url === 'player-origin.json') return new Response('<html>spa</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === '/training-boot.html') {
        if (boot instanceof Error) throw boot;
        return boot;
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  it('HU1 a host answering the boot page with 404 (api_server) disables playback with a clear notice', async () => {
    const fetchImpl = fetchWith(new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }));
    await expect(resolvePlayerOrigin(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith('/training-boot.html', expect.objectContaining({ method: 'HEAD' }));
    expect(getPlayerOriginStatus()).toBe('host-unsupported');
    expect(getPlayerOrigin()).toBeNull();
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.getByTestId('training-player-host-unsupported')).toHaveTextContent(/not available on this host/);
    expect(screen.queryByTestId('training-player-unavailable')).toBeNull();
    expect(screen.getByTestId('training-player-frame').getAttribute('src')).toBe('about:blank');
  });

  it('HU2 a host that serves the boot page keeps the loopback-alias player origin', async () => {
    const fetchImpl = fetchWith(new Response(null, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const alias = loopbackAliasOrigin(window.location.origin);
    await expect(resolvePlayerOrigin(fetchImpl as unknown as typeof fetch)).resolves.toBe(alias);
    expect(getPlayerOriginStatus()).toBe('ok');
  });

  it('HU3 a network error on the probe proves nothing and keeps the alias', async () => {
    const fetchImpl = fetchWith(new Error('offline'));
    await expect(resolvePlayerOrigin(fetchImpl as unknown as typeof fetch)).resolves.toBe(loopbackAliasOrigin(window.location.origin));
  });
});
