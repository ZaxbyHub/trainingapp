/**
 * App-shell frame policy (browser-training-parity ADR-0012 threat model item
 * 6, navigation egress). CSP on a course document does not govern
 * navigation; the EMBEDDING page's frame-src does. The browser app installs
 * `frame-src <player origin>` as a runtime meta CSP once the player origin
 * resolves, and no player frame loads a player-origin URL before that.
 *
 *   NF1 the policy is installed exactly once, in <head>, for one origin.
 *   NF2 nothing is installed and no player frame loads before resolution;
 *       both frames appear only after it.
 *   NF3 never under Electron (its renderer CSP has frame-src 'self' app:).
 *   NF4 never in a framed app.
 *   NF5 a configured player origin (player-origin.json): the app-wide host is
 *       built for it, never for the synchronous loopback-alias prediction.
 *   NF6 TrainingPlayerHost appends the boot frame only after its
 *       framePolicyReady gate says yes, and only once per open.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../components/training-player-bridge', () => ({
  frameOrigin: () => null,
  createTrainingPlayerBridge: () => ({ jumpToSlide: async () => false, readState: async () => null, destroy: () => undefined }),
}));

import { TrainingPlayer, trainingPlayerSrc } from '../../../components/TrainingPlayer';
import { browserTrainingHost } from '../browser-training';
import {
  FRAME_POLICY_MARKER,
  getPlayerOriginStatus,
  getResolvedPlayerOrigin,
  installPlayerFramePolicy,
  loopbackAliasOrigin,
  resetPlayerOriginForTests,
  resolvePlayerOrigin,
} from '../player-origin';
import { FRAME_POLICY_DETAIL, TrainingPlayerHost, resetTrainingPlayerHostForTests } from '../training-player-host';

const realTop = Object.getOwnPropertyDescriptor(window, 'top');

function policies(): HTMLMetaElement[] {
  return Array.from(document.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]'));
}

function bootFrames(): HTMLIFrameElement[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-testid="training-player-boot"]'));
}

/** A fetch whose player-origin.json answer the test releases; the boot probe proves nothing (offline). */
function deferredFetch(): { fetchImpl: (url: string) => Promise<Response>; release: (response: Response) => void } {
  let release: (response: Response) => void = () => undefined;
  const config = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchImpl = vi.fn((url: string) => (url === 'player-origin.json' ? config : Promise.reject(new Error('offline'))));
  return { fetchImpl, release: (response) => release(response) };
}

const spaFallback = (): Response => new Response('<html>spa</html>', { status: 200, headers: { 'content-type': 'text/html' } });

afterEach(() => {
  cleanup();
  if (realTop !== undefined) Object.defineProperty(window, 'top', realTop);
  delete (window as unknown as { desktopApi?: unknown }).desktopApi;
  resetTrainingPlayerHostForTests();
  resetPlayerOriginForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('app-shell frame policy (navigation egress, ADR-0012 item 6)', () => {
  it('NF1 installs frame-src <player origin> exactly once, in <head>', () => {
    resetPlayerOriginForTests();
    expect(policies()).toHaveLength(0);
    expect(installPlayerFramePolicy('http://127.0.0.1:4183')).toBe(true);
    expect(installPlayerFramePolicy('http://127.0.0.1:4183')).toBe(true);
    // A meta CSP can only tighten: a different origin is never added.
    expect(installPlayerFramePolicy('https://player.example')).toBe(false);
    expect(policies()).toHaveLength(1);
    const meta = policies()[0]!;
    expect(meta.parentElement).toBe(document.head);
    expect(meta.getAttribute('content')).toBe('frame-src http://127.0.0.1:4183');
    expect(meta.getAttribute(FRAME_POLICY_MARKER)).toBe('http://127.0.0.1:4183');
  });

  it('NF2 no policy and no player frame before resolution; both frames only after it', async () => {
    resetPlayerOriginForTests();
    const { fetchImpl, release } = deferredFetch();
    const resolving = resolvePlayerOrigin(fetchImpl as unknown as typeof fetch);
    // Pending: nothing installed, nothing loads from the player origin.
    expect(policies()).toHaveLength(0);
    expect(getResolvedPlayerOrigin()).toBeNull();
    expect(trainingPlayerSrc('pack-a')).toBeNull();
    expect(browserTrainingHost()).toBeNull();
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.getByTestId('training-player-frame').getAttribute('src')).toBe('about:blank');
    expect(bootFrames()).toHaveLength(0);

    release(spaFallback());
    const alias = loopbackAliasOrigin(window.location.origin)!;
    await expect(resolving).resolves.toBe(alias);
    expect(policies().map((m) => m.getAttribute('content'))).toEqual([`frame-src ${alias}`]);
    await waitFor(() => expect(screen.getByTestId('training-player-frame').getAttribute('src')).toBe(`${alias}/training/pack-a/story.html`));
    await waitFor(() => expect(bootFrames()).toHaveLength(1));
    expect(bootFrames()[0]!.getAttribute('src')).toBe(`${alias}/training-boot.html`);
  });

  it('NF3 never under Electron: no meta, the course loads from app://training', async () => {
    resetPlayerOriginForTests();
    (window as unknown as { desktopApi?: unknown }).desktopApi = {};
    expect(installPlayerFramePolicy('http://127.0.0.1:4183')).toBe(false);
    await resolvePlayerOrigin((async () => spaFallback()) as unknown as typeof fetch);
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.getByTestId('training-player-frame').getAttribute('src')).toBe('app://training/pack-a/story.html');
    expect(policies()).toHaveLength(0);
    expect(bootFrames()).toHaveLength(0);
  });

  it('NF4 never in a framed app', () => {
    resetPlayerOriginForTests();
    const outer = {} as Window;
    Object.defineProperty(window, 'top', { configurable: true, get: () => outer });
    expect(installPlayerFramePolicy('http://127.0.0.1:4183')).toBe(false);
    expect(policies()).toHaveLength(0);
  });

  it('NF5 a configured player origin: the host is built for it, never for the alias prediction', async () => {
    resetPlayerOriginForTests();
    const configured = 'http://127.0.0.1:9911';
    expect(configured).not.toBe(loopbackAliasOrigin(window.location.origin));
    const { fetchImpl, release } = deferredFetch();
    const resolving = resolvePlayerOrigin(fetchImpl as unknown as typeof fetch);
    // Before resolution the old code built the app-wide singleton here, with
    // the alias, leaving boot frame and relay on another origin than the
    // course frame.
    expect(browserTrainingHost()).toBeNull();
    release(new Response(JSON.stringify({ playerOrigin: configured }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(resolving).resolves.toBe(configured);
    const host = browserTrainingHost();
    expect(host?.playerOrigin).toBe(configured);
    expect(browserTrainingHost()).toBe(host);
    expect(trainingPlayerSrc('pack-a')?.origin).toBe(configured);
    expect(policies().map((m) => m.getAttribute('content'))).toEqual([`frame-src ${configured}`]);
  });
});

describe('frame policy that cannot be installed (review round 4, F2)', () => {
  it('NF7 reports policy-failed with a visible notice instead of a silently blank course frame', async () => {
    resetPlayerOriginForTests();
    Object.defineProperty(document, 'head', { configurable: true, get: () => null });
    try {
      const alias = loopbackAliasOrigin(window.location.origin)!;
      await expect(resolvePlayerOrigin((async () => spaFallback()) as unknown as typeof fetch)).resolves.toBe(alias);
    } finally {
      // Back to the Document.prototype getter for the rest of the suite.
      delete (document as unknown as { head?: unknown }).head;
    }
    expect(document.head).not.toBeNull();
    expect(policies()).toHaveLength(0);
    expect(getResolvedPlayerOrigin()).toBeNull();
    expect(getPlayerOriginStatus()).toBe('policy-failed');
    render(<TrainingPlayer packId="pack-a" />);
    expect(screen.getByTestId('training-player-unsecured')).toHaveTextContent(/could not be secured/);
    expect(screen.getByTestId('training-player-frame').getAttribute('src')).toBe('about:blank');
    expect(bootFrames()).toHaveLength(0);
  });
});

describe('TrainingPlayerHost frame-policy gate', () => {
  const opts = (framePolicyReady: () => Promise<boolean>) => ({
    playerOrigin: 'http://127.0.0.1:4183',
    appOrigin: 'http://localhost:4183',
    readActiveFile: async () => null,
    container: () => document.body,
    readyTimeoutMs: 50,
    framePolicyReady,
  });

  it('NF6 appends the boot frame only after the gate says yes, once per open', async () => {
    let open: (ok: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => {
      open = resolve;
    });
    const host = new TrainingPlayerHost(opts(() => gate));
    void host.start();
    void host.openCourse('pack-a');
    await Promise.resolve();
    expect(bootFrames()).toHaveLength(0);
    open(true);
    await waitFor(() => expect(bootFrames()).toHaveLength(1));
    expect(bootFrames()[0]!.getAttribute('src')).toBe('http://127.0.0.1:4183/training-boot.html');
    host.dispose();
  });

  it('NF6 a gate that says no embeds nothing and reports why', async () => {
    const host = new TrainingPlayerHost(opts(async () => false));
    await expect(host.start()).resolves.toEqual({ ready: false, hadActiveWorker: false, detail: FRAME_POLICY_DETAIL });
    expect(bootFrames()).toHaveLength(0);
    host.dispose();
  });
});
