/**
 * Renderer-side bridge to the pack-local player bridge (issue #81, D5).
 *
 * The embedded Storyline player is served from app://training/<packId>/...,
 * a distinct WHATWG origin from the renderer's app://index.html, so the
 * component cannot reach the player runtime through the frame directly.
 * Communication goes through the postMessage protocol implemented by
 * story_content/trainingapp-bridge.js inside the pack (protocol frozen in
 * desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md §5):
 *
 *   renderer -> frame:  { __trainingapp: true, kind: 'jump',  reqId, slideId }
 *   frame -> renderer:  { __trainingapp: true, kind: 'jump-result',  reqId, ok }
 *   renderer -> frame:  { __trainingapp: true, kind: 'state', reqId }
 *   frame -> renderer:  { __trainingapp: true, kind: 'state-result', reqId, state }
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
  /** Detach the bridge's window listener. Optional so test doubles may omit it. */
  destroy?(): void;
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

export function createTrainingPlayerBridge(frame: HTMLIFrameElement): TrainingPlayerBridge {
  let nextReqId = 1;
  const pending = new Map<number, (message: TrainingappMessage) => void>();

  function handleMessage(event: MessageEvent): void {
    const data = event.data as TrainingappMessage | null;
    if (data === null || typeof data !== 'object' || data.__trainingapp !== MESSAGE_MARKER) {
      return;
    }
    const resolve = typeof data.reqId === 'number' ? pending.get(data.reqId) : undefined;
    if (resolve === undefined) return;
    if (typeof data.reqId === 'number') pending.delete(data.reqId);
    resolve(data);
  }

  // The listener is per-bridge; a bridge is created once per mounted player.
  window.addEventListener('message', handleMessage);

  function request(kind: 'jump' | 'state', slideId?: string): Promise<TrainingappMessage | null> {
    const target = frame.contentWindow;
    if (target === null) return Promise.resolve(null);
    const reqId = nextReqId++;
    const payload: TrainingappMessage = { __trainingapp: MESSAGE_MARKER, kind, reqId };
    if (slideId !== undefined) payload.slideId = slideId;
    return new Promise((resolve) => {
      pending.set(reqId, resolve);
      // If the frame never answers (bridge script absent, frame torn down),
      // the promise would dangle — poll callers bound their own cadence, and
      // a jump caller gets its answer from this same map, so settle jumps on
      // a generous timeout to keep the handle's Promise<boolean> honest.
      window.setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          resolve(null);
        }
      }, 75_000);
      target.postMessage(payload, '*');
    });
  }

  return {
    jumpToSlide(slideId: string): Promise<boolean> {
      return request('jump', slideId).then(
        (reply) => reply !== null && reply.ok === true,
      );
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
      window.removeEventListener('message', handleMessage);
    },
  };
}
