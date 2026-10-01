/**
 * App-side course player host (trace browser-training-parity AC3/AC11,
 * ADR-0012 threat model item 1): the app acts on exactly ONE kind of window
 * message from the player origin — a data-free "relay needed" signal from the
 * CURRENT boot frame window — and answers it by repeating the app-initiated
 * handshake. Course JS shares the boot frame's origin and can send that signal
 * at will, so the host must ignore other sources/origins and coalesce bursts.
 *
 *   HS1 the handshake is posted to the boot frame at the exact player origin
 *       with one transferred port (never '*').
 *   HS2 a relay request from a window other than the current boot frame is ignored.
 *   HS3 a relay request from the right window but another origin is ignored.
 *   HS4 a burst of relay requests produces exactly one re-handshake.
 *   HS5 after the in-flight handshake settled and the spacing elapsed, a new
 *       request is honored again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAY_REQUEST_MIN_INTERVAL_MS, TrainingPlayerHost } from '../training-player-host';

const PLAYER = 'http://127.0.0.1:4183';
const APP = 'http://localhost:4183';

interface Harness {
  host: TrainingPlayerHost;
  frame: HTMLIFrameElement;
  handshakes: () => Array<[unknown, string, unknown[] | undefined]>;
}

async function startHost(readyTimeoutMs: number): Promise<Harness> {
  const host = new TrainingPlayerHost({
    playerOrigin: PLAYER,
    appOrigin: APP,
    readActiveFile: async () => null,
    container: () => document.body,
    readyTimeoutMs,
  });
  const started = host.start();
  const frame = document.querySelector('iframe[data-testid="training-player-boot"]') as HTMLIFrameElement;
  expect(frame).not.toBeNull();
  const spy = vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
  frame.dispatchEvent(new Event('load'));
  await Promise.resolve();
  await Promise.resolve();
  void started;
  const handshakes = () =>
    (spy.mock.calls as unknown as Array<[unknown, string, unknown[] | undefined]>).filter(
      (c) => (c[0] as { type?: unknown }).type === 'trainingapp-relay-handshake',
    );
  return { host, frame, handshakes };
}

function relayRequest(source: Window | null, origin: string): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'trainingapp-relay-request' }, origin, source }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('TrainingPlayerHost window-message discipline', () => {
  it('HS1 posts the handshake to the exact player origin with one transferred port', async () => {
    const { host, handshakes } = await startHost(60_000);
    expect(handshakes()).toHaveLength(1);
    const [, origin, transfer] = handshakes()[0]!;
    expect(origin).toBe(PLAYER);
    expect(transfer).toHaveLength(1);
    host.dispose();
  });

  it('HS2 ignores a relay request from a window other than the current boot frame', async () => {
    const { host, handshakes } = await startHost(60_000);
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    relayRequest(other.contentWindow, PLAYER);
    relayRequest(window, PLAYER);
    await Promise.resolve();
    expect(handshakes()).toHaveLength(1);
    host.dispose();
  });

  it('HS3 ignores a relay request from the boot frame window with another origin', async () => {
    const { host, frame, handshakes } = await startHost(60_000);
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    for (const origin of [APP, 'http://evil.example', 'null']) relayRequest(frame.contentWindow, origin);
    await Promise.resolve();
    expect(handshakes()).toHaveLength(1);
    host.dispose();
  });

  it('HS4 a burst of relay requests produces exactly one re-handshake', async () => {
    const { host, frame, handshakes } = await startHost(60_000);
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    for (let i = 0; i < 25; i += 1) relayRequest(frame.contentWindow, PLAYER);
    await Promise.resolve();
    expect(handshakes()).toHaveLength(2);
    host.dispose();
  });

  it('HS5 a request after the in-flight handshake settled and the spacing elapsed is honored', async () => {
    const { host, frame, handshakes } = await startHost(5);
    let now = 10_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    relayRequest(frame.contentWindow, PLAYER);
    expect(handshakes()).toHaveLength(2);
    // Let the 5 ms ready timeout settle the in-flight re-handshake.
    await new Promise((r) => setTimeout(r, 30));
    relayRequest(frame.contentWindow, PLAYER);
    expect(handshakes()).toHaveLength(2); // spacing not yet elapsed
    now += RELAY_REQUEST_MIN_INTERVAL_MS + 1;
    relayRequest(frame.contentWindow, PLAYER);
    expect(handshakes()).toHaveLength(3);
    host.dispose();
  });
});
