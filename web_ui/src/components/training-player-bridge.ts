/**
 * Renderer-side bridge to the pack-local player bridge (issue #81, D5).
 *
 * The embedded Storyline player is a DIFFERENT origin from the app in both
 * apps — app://training/<packId>/... vs app://index.html on desktop, the
 * dedicated player origin vs the app origin in the browser (ADR-0012) — so
 * the component cannot reach the player runtime directly. Communication goes
 * through the postMessage protocol implemented by
 * story_content/trainingapp-bridge.js inside the pack (protocol in
 * desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md §5):
 *
 *   renderer -> frame:  { __trainingapp: true, kind: 'jump',  reqId, slideId }
 *   frame -> renderer:  { __trainingapp: true, kind: 'jump-result',  reqId, ok }
 *   renderer -> frame:  { __trainingapp: true, kind: 'state', reqId }
 *   frame -> renderer:  { __trainingapp: true, kind: 'state-result', reqId, state }
 *
 * Origin discipline (browser-training-parity AC5): every request is posted
 * to the frame's EXACT origin (never the '*' wildcard) together with a
 * one-shot MessagePort, and the reply is accepted ONLY on that port — so a
 * window message from any other frame or origin can never resolve a request.
 * When the frame's origin cannot be determined (no src, opaque origin) the
 * bridge posts nothing and answers null.
 *
 * The pack-side bridge implements the proven A8 recipe (#58): jumps defer
 * until the player reports a current slide, then
 * DS.presentation.getFlatSlides() + DS.windowManager.requestSlideForReview,
 * verifying the jump through the player's own state.
 */
export interface TrainingPlayerSlideState {
  slideId: string;
  slideTitle: string;
}

export interface TrainingPlayerBridge {
  jumpToSlide(slideId: string): Promise<boolean>;
  readState(): Promise<TrainingPlayerSlideState | null>;
  /** Settle pending requests and detach. Optional so test doubles may omit it. */
  destroy?(): void;
}

export interface TrainingPlayerBridgeOptions {
  /** The player frame's origin; derived from the frame's src when omitted. */
  expectedOrigin?: string;
}

interface TrainingappMessage {
  __trainingapp?: boolean;
  kind?: string;
  reqId?: number;
  ok?: boolean;
  slideId?: string;
  state?: TrainingPlayerSlideState | null;
}

const MESSAGE_MARKER = true;
/** Jumps may wait for the player to become ready (narration, slide load). */
const JUMP_TIMEOUT_MS = 75_000;
/**
 * State polls settle fast: a poll posted before the course document loaded
 * is dropped by the browser (the frame still holds the app-origin initial
 * document), and the 1 s poll cadence retries anyway.
 */
const STATE_TIMEOUT_MS = 5_000;

/** The exact origin of `frame`'s document URL, or null when it is unknown/opaque. */
export function frameOrigin(frame: HTMLIFrameElement): string | null {
  const src = frame.getAttribute('src');
  if (src === null || src === '') return null;
  try {
    const origin = new URL(src, window.location.href).origin;
    return origin === 'null' || origin === '' ? null : origin;
  } catch {
    return null;
  }
}

export function createTrainingPlayerBridge(
  frame: HTMLIFrameElement,
  options: TrainingPlayerBridgeOptions = {},
): TrainingPlayerBridge {
  let nextReqId = 1;
  const pending = new Set<(message: TrainingappMessage | null) => void>();

  function request(kind: 'jump' | 'state', slideId?: string): Promise<TrainingappMessage | null> {
    const target = frame.contentWindow;
    const targetOrigin = options.expectedOrigin ?? frameOrigin(frame);
    if (target === null || targetOrigin === null || typeof MessageChannel === 'undefined') {
      return Promise.resolve(null);
    }
    const reqId = nextReqId++;
    const payload: TrainingappMessage = { __trainingapp: MESSAGE_MARKER, kind, reqId };
    if (slideId !== undefined) payload.slideId = slideId;
    const channel = new MessageChannel();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (message: TrainingappMessage | null): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        pending.delete(finish);
        channel.port1.onmessage = null;
        channel.port1.close();
        resolve(message);
      };
      // A frame that never answers (bridge absent, frame torn down) settles
      // on a generous timeout so the handle's Promise<boolean> stays honest.
      const timer = window.setTimeout(() => finish(null), kind === 'jump' ? JUMP_TIMEOUT_MS : STATE_TIMEOUT_MS);
      pending.add(finish);
      channel.port1.onmessage = (event: MessageEvent) => {
        const data = event.data as TrainingappMessage | null;
        if (data === null || typeof data !== 'object' || data.__trainingapp !== MESSAGE_MARKER || data.reqId !== reqId) {
          return;
        }
        finish(data);
      };
      try {
        target.postMessage(payload, targetOrigin, [channel.port2]);
      } catch {
        finish(null);
      }
    });
  }

  return {
    jumpToSlide(slideId: string): Promise<boolean> {
      return request('jump', slideId).then((reply) => reply !== null && reply.ok === true);
    },
    readState(): Promise<TrainingPlayerSlideState | null> {
      return request('state').then((reply) => {
        if (reply === null || reply.state === null || reply.state === undefined) return null;
        const state = reply.state;
        if (typeof state.slideId !== 'string') return null;
        return { slideId: state.slideId, slideTitle: state.slideTitle };
      });
    },
    destroy(): void {
      for (const finish of [...pending]) finish(null);
    },
  };
}
