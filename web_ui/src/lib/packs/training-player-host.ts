// training-player-host.ts — the app page's side of the browser course
// player (trace browser-training-parity AC3/AC4/AC11, ADR-0012).
//
// The app embeds a hidden boot frame on the PLAYER origin
// (/training-boot.html), which registers the player-origin service worker.
// The relay handshake is ALWAYS app-initiated: the app creates a
// MessageChannel, keeps one end for its TrainingRelay, and transfers the
// other to the boot frame with targetOrigin = the player origin; the boot
// frame hands it to the worker, which acknowledges `relay-ready` on that same
// port. On every course open the boot frame is RECREATED and a fresh port is
// handed over (threat model item 1); the previous frame and port are
// discarded. A window message from the player origin is honored for exactly
// one thing — asking the app to repeat that handshake — and only when its
// source is the CURRENT boot frame window; relay traffic itself never flows
// through window messages.
import { isFramedContext } from './player-origin';
import { TrainingRelay } from './training-relay';

export interface TrainingPlayerHostOptions {
  playerOrigin: string;
  appOrigin: string;
  readActiveFile(packId: string, segments: readonly string[]): Promise<Blob | null>;
  /** Where the hidden boot frame is attached (default document.body). */
  container?: () => HTMLElement | null;
  readyTimeoutMs?: number;
  /**
   * Awaited before every boot frame is appended: resolves true once the
   * app-shell frame-src policy for `playerOrigin` is installed (browser app,
   * ADR-0012 threat model item 6). false embeds nothing.
   */
  framePolicyReady?: () => Promise<boolean>;
}

export interface RelayReadyInfo {
  ready: boolean;
  /** False on the first-ever activation: the course frame's first load was not intercepted. */
  hadActiveWorker: boolean;
  detail?: string;
}

const BOOT_PATH = '/training-boot.html';
/**
 * The boot frame's sandbox (final-critic FC6). Course JS on the player origin
 * can script the boot frame as a same-origin sibling, so the boot frame must
 * not grant what the course frame's sandbox withholds: no popups, no top
 * navigation, no forms, no modals. `allow-same-origin` keeps the player
 * origin (the worker registration needs it); `allow-scripts` runs the boot
 * script.
 */
export const BOOT_FRAME_SANDBOX = 'allow-scripts allow-same-origin';
/** Minimum spacing between window-requested re-handshakes. */
export const RELAY_REQUEST_MIN_INTERVAL_MS = 1000;
/** Why a framed app does not start the course player. */
export const FRAMED_DETAIL = 'course playback is disabled because this app is embedded in another page';
/** Why the boot frame was not embedded without the app-shell frame policy. */
export const FRAME_POLICY_DETAIL = 'the course player frame policy is not in place';

export class TrainingPlayerHost {
  readonly relay: TrainingRelay;
  private bootFrame: HTMLIFrameElement | null = null;
  private generation = 0;
  private readyPromise: Promise<RelayReadyInfo> | null = null;
  /** A window-requested re-handshake is in flight (coalesces bursts). */
  private relayRequestInFlight = false;
  private lastRelayRequestAt = Number.NEGATIVE_INFINITY;
  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (this.bootFrame === null || event.source !== this.bootFrame.contentWindow) return;
    if (event.origin !== this.opts.playerOrigin) return;
    const data = event.data as { type?: unknown } | null;
    if (data === null || typeof data !== 'object' || data.type !== 'trainingapp-relay-request') return;
    // The worker lost its port (stopped while idle): repeat the handshake
    // with the CURRENT boot frame. Course JS shares the boot frame's origin
    // and can send this at will, so requests are coalesced (one in flight)
    // and spaced (RELAY_REQUEST_MIN_INTERVAL_MS) — a flood cannot make the
    // app tab churn channels and timers.
    const now = Date.now();
    if (this.relayRequestInFlight || now - this.lastRelayRequestAt < RELAY_REQUEST_MIN_INTERVAL_MS) return;
    this.relayRequestInFlight = true;
    this.lastRelayRequestAt = now;
    void this.handshake(this.generation).finally(() => {
      this.relayRequestInFlight = false;
    });
  };

  /** The player origin this host embeds the boot frame on. */
  get playerOrigin(): string {
    return this.opts.playerOrigin;
  }

  constructor(private readonly opts: TrainingPlayerHostOptions) {
    this.relay = new TrainingRelay({ readActiveFile: opts.readActiveFile, appOrigin: opts.appOrigin });
    window.addEventListener('message', this.onWindowMessage);
  }

  /** App start: register the worker early so a later course open is usually served on first load. */
  start(): Promise<RelayReadyInfo> {
    if (this.readyPromise === null) this.readyPromise = this.recreateBootFrame();
    return this.readyPromise;
  }

  /**
   * Open a course: scope the relay to `packId` (synchronously, before the
   * course frame's first request can arrive), recreate the boot frame and
   * hand the worker a fresh relay port.
   */
  openCourse(packId: string): Promise<RelayReadyInfo> {
    this.relay.setOpenPack(packId);
    this.readyPromise = this.recreateBootFrame();
    return this.readyPromise;
  }

  /** The course closed: the relay serves nothing until the next open. */
  closeCourse(packId: string): void {
    if (this.relay.getOpenPack() === packId) this.relay.setOpenPack(null);
  }

  /** The last pack was removed: ask the boot frame to unregister the worker. */
  unregisterWorker(): void {
    this.relay.setOpenPack(null);
    try {
      this.bootFrame?.contentWindow?.postMessage({ type: 'trainingapp-unregister' }, this.opts.playerOrigin);
    } catch {
      /* frame gone */
    }
  }

  dispose(): void {
    window.removeEventListener('message', this.onWindowMessage);
    this.relay.detach();
    this.bootFrame?.remove();
    this.bootFrame = null;
  }

  private recreateBootFrame(): Promise<RelayReadyInfo> {
    // Defense in depth for review round 1 F1: a framed app never embeds the
    // boot frame or hands out a relay port (browserTrainingHost also refuses).
    if (isFramedContext()) {
      return Promise.resolve({ ready: false, hadActiveWorker: false, detail: FRAMED_DETAIL });
    }
    this.generation += 1;
    const generation = this.generation;
    this.bootFrame?.remove();
    this.bootFrame = null;
    const gate = this.opts.framePolicyReady;
    if (gate === undefined) return this.embedBootFrame(generation);
    return gate().then((ok): Promise<RelayReadyInfo> => {
      if (!ok) return Promise.resolve({ ready: false, hadActiveWorker: false, detail: FRAME_POLICY_DETAIL });
      // A newer open superseded this one while the gate was pending: answer
      // with the newest attempt, never with a second boot frame.
      if (generation !== this.generation) return this.readyPromise ?? Promise.resolve({ ready: false, hadActiveWorker: false });
      return this.embedBootFrame(generation);
    });
  }

  private embedBootFrame(generation: number): Promise<RelayReadyInfo> {
    const container = (this.opts.container ?? (() => document.body))();
    if (container === null) return Promise.resolve({ ready: false, hadActiveWorker: false, detail: 'no document' });
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', BOOT_FRAME_SANDBOX);
    frame.src = `${this.opts.playerOrigin}${BOOT_PATH}`;
    frame.title = 'Training player service';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.dataset.testid = 'training-player-boot';
    frame.style.display = 'none';
    const loaded = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    container.appendChild(frame);
    this.bootFrame = frame;
    return loaded.then(() => this.handshake(generation));
  }

  private handshake(generation: number): Promise<RelayReadyInfo> {
    const frame = this.bootFrame;
    if (frame === null || generation !== this.generation || frame.contentWindow === null || typeof MessageChannel === 'undefined') {
      return Promise.resolve({ ready: false, hadActiveWorker: false, detail: 'boot frame unavailable' });
    }
    const channel = new MessageChannel();
    const timeoutMs = this.opts.readyTimeoutMs ?? 15_000;
    const ready = new Promise<RelayReadyInfo>((resolve) => {
      const timer = window.setTimeout(
        () => resolve({ ready: false, hadActiveWorker: false, detail: 'the training player service did not start in time' }),
        timeoutMs,
      );
      this.relay.onControl = (message) => {
        if (message.type === 'relay-ready') {
          window.clearTimeout(timer);
          resolve({ ready: true, hadActiveWorker: message.hadActiveWorker === true });
        }
      };
    });
    this.relay.attachPort(channel.port1);
    frame.contentWindow.postMessage({ type: 'trainingapp-relay-handshake' }, this.opts.playerOrigin, [channel.port2]);
    return ready;
  }
}

let host: TrainingPlayerHost | null = null;

/** The app-wide host (created on first use in the browser app). */
export function getTrainingPlayerHost(factory: () => TrainingPlayerHost): TrainingPlayerHost {
  if (host === null) host = factory();
  return host;
}

/** Tests only. */
export function resetTrainingPlayerHostForTests(): void {
  host?.dispose();
  host = null;
}
