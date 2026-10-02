/**
 * TrainingPlayer — embeds an installed Storyline training pack and exposes
 * programmatic navigation + slide-change events to the app (issue #81, D5).
 *
 * Desktop: the course loads from app://training/<packId>/story.html (served
 * by the Electron main process). Browser (browser-training-parity,
 * ADR-0012): it loads from <player origin>/training/<packId>/story.html — a
 * DEDICATED origin distinct from the app's — served by that origin's service
 * worker from bytes the app page relays out of its private storage. The src
 * is version-less in the browser (the relay serves the pack's ACTIVE version)
 * and is computed from the pack id and the RESOLVED player origin: until the
 * start-up resolution settled and the app-shell frame-src policy for that
 * origin is installed (ADR-0012 threat model item 6) the frame stays
 * about:blank.
 *
 * The player document and this renderer are distinct WHATWG origins in both
 * apps, so ALL player communication goes through ./training-player-bridge
 * (exact-origin postMessage + one-shot MessagePort to the pack-local bridge
 * script the pack ships at story_content/trainingapp-bridge.js).
 *
 * Contract notes:
 *  - Polls the player state at a 1000 ms cadence and calls onSlideChange
 *    ONLY when the player-reported slideId changes (never per tick).
 *  - jumpToSlide resolves true iff the player's own state subsequently
 *    reported the target slide (the A8 recipe's success definition).
 *  - Before the course starts the player reports no state; polls stay
 *    silent and queued jumps wait inside the pack bridge until ready.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  createTrainingPlayerBridge,
  type TrainingPlayerBridge,
  type TrainingPlayerSlideState,
} from './training-player-bridge';
import { isElectron } from '../lib/desktop-session';
import { browserTrainingHost } from '../lib/packs/browser-training';
import { browserTrainingUrl, getPlayerOriginStatus, getResolvedPlayerOrigin, resolvePlayerOrigin } from '../lib/packs/player-origin';

/**
 * Sandbox of the course frame (review round 1, F2; desktop parity with the
 * main-process window-open/navigation denial). allow-same-origin keeps the
 * course on its OWN origin — the player origin in the browser, app://training
 * on desktop — which is never the app origin, so it grants no access to app
 * storage or DOM; the player-origin service worker and the course's own
 * storage need it. No popups, no top navigation, no storage-access prompts.
 */
export const TRAINING_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

/** The course id of a pack key ('<id>' or the desktop dir key '<id>/<version>'). */
export function courseIdOf(packKey: string): string {
  return packKey.split('/')[0] ?? packKey;
}

/** Where the course document loads from in THIS app, or null when it cannot be played here. */
export function trainingPlayerSrc(packKey: string): { src: string; origin: string | null } | null {
  if (isElectron()) return { src: `app://training/${packKey}/story.html`, origin: null };
  // Only the resolved origin, and only once its frame policy is installed:
  // a frame never loads from the synchronous alias prediction.
  const playerOrigin = getResolvedPlayerOrigin();
  if (playerOrigin === null) return null;
  return { src: browserTrainingUrl(playerOrigin, courseIdOf(packKey)), origin: playerOrigin };
}

export interface TrainingPlayerProps {
  packId: string;
  initialSlideId?: string;
  onSlideChange?: (event: TrainingPlayerSlideState) => void;
}

export interface TrainingPlayerHandle {
  jumpToSlide(slideId: string): Promise<boolean>;
}

const POLL_INTERVAL_MS = 1000;

export const TrainingPlayer = forwardRef<TrainingPlayerHandle, TrainingPlayerProps>(
  function TrainingPlayer({ packId, initialSlideId, onSlideChange }, ref) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const bridgeRef = useRef<TrainingPlayerBridge | null>(null);
    const [current, setCurrent] = useState<TrainingPlayerSlideState | null>(null);
    const [changeLog, setChangeLog] = useState<TrainingPlayerSlideState[]>([]);
    const lastEmittedSlideRef = useRef<string | null>(null);
    const initialJumpDoneRef = useRef(false);
    const onSlideChangeRef = useRef(onSlideChange);
    onSlideChangeRef.current = onSlideChange;

    // Re-render once the start-up player-origin resolution settles (it may
    // find this host does not serve the player).
    const [, setOriginSettled] = useState(0);
    useEffect(() => {
      if (isElectron()) return;
      let live = true;
      void resolvePlayerOrigin().then(() => {
        if (live) setOriginSettled((n) => n + 1);
      });
      return () => {
        live = false;
      };
    }, []);
    const location = trainingPlayerSrc(packId);
    // The browser host exists only once the player origin resolved with its
    // frame policy installed; the effects below re-run when it appears.
    const resolvedOrigin = isElectron() ? null : getResolvedPlayerOrigin();
    const originStatus = isElectron() ? 'ok' : getPlayerOriginStatus();
    const framed = originStatus === 'framed';
    const courseId = courseIdOf(packId);
    const [playerError, setPlayerError] = useState<string | null>(null);
    const reloadedRef = useRef(false);
    const readyRef = useRef<Promise<{ ready: boolean; detail?: string }> | null>(null);

    const ensureBridge = (): TrainingPlayerBridge | null => {
      if (bridgeRef.current === null && frameRef.current !== null) {
        bridgeRef.current = createTrainingPlayerBridge(
          frameRef.current,
          location?.origin ? { expectedOrigin: location.origin } : {},
        );
      }
      return bridgeRef.current;
    };

    // Browser app: scope the app-side relay to THIS course synchronously
    // (before the frame's first request can reach the app), recreate the
    // boot frame and hand the player-origin worker a fresh relay port.
    useLayoutEffect(() => {
      const host = browserTrainingHost();
      if (host === null) return undefined;
      reloadedRef.current = false;
      setPlayerError(null);
      readyRef.current = host.openCourse(courseId).then((info) => {
        if (!info.ready) setPlayerError(info.detail ?? 'the training player service did not start');
        return info;
      });
      return () => host.closeCourse(courseId);
    }, [courseId, resolvedOrigin]);

    // First-ever activation: the worker did not exist when the frame first
    // loaded, so that load never reached the relay. Once the relay is ready,
    // reload ONCE by reassigning src on the SAME element (a remount would
    // detach the frame handle automation and the bridge hold).
    const handleFrameLoad = (): void => {
      const host = browserTrainingHost();
      if (host === null || reloadedRef.current || readyRef.current === null) return;
      if (host.relay.servedCount() > 0) return;
      void readyRef.current.then((info) => {
        const frame = frameRef.current;
        if (!info.ready || frame === null || reloadedRef.current || location === null) return;
        if (host.relay.servedCount() > 0) return;
        reloadedRef.current = true;
        frame.setAttribute('src', location.src);
      });
    };

    useEffect(() => {
      ensureBridge();
      // Read once at mount, then keep the 1000 ms cadence: a fresh frame may
      // already be mid-course (resume), so the first state can precede the
      // first interval tick.
      const poll = (): void => {
        const bridge = ensureBridge();
        if (bridge === null) return;
        void bridge.readState().then((state) => {
          if (state === null) return;
          setCurrent(state);
          if (state.slideId !== lastEmittedSlideRef.current) {
            lastEmittedSlideRef.current = state.slideId;
            setChangeLog((log) => [...log, state]);
            onSlideChangeRef.current?.(state);
          }
        });
      };
      poll();
      const interval = window.setInterval(poll, POLL_INTERVAL_MS);
      return () => {
        window.clearInterval(interval);
        bridgeRef.current?.destroy?.();
        bridgeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [packId, location?.origin]);

    // Drive the initial slide once the player reports readable state (before
    // course start the player has no state; the pack bridge defers jumps
    // until readiness, so a pre-start initialSlideId still lands).
    useEffect(() => {
      if (current === null || initialSlideId === undefined || initialJumpDoneRef.current) {
        return;
      }
      initialJumpDoneRef.current = true;
      const bridge = ensureBridge();
      if (bridge !== null) void bridge.jumpToSlide(initialSlideId);
    }, [current, initialSlideId]);

    useImperativeHandle(
      ref,
      () => ({
        jumpToSlide: (slideId: string): Promise<boolean> => {
          const bridge = ensureBridge();
          if (bridge === null) return Promise.resolve(false);
          return bridge.jumpToSlide(slideId);
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [packId],
    );

    // E2E drive seam: lets automation drive THIS component's own API without
    // touching Storyline DOM (desktop/e2e/training-player.spec.ts).
    useEffect(() => {
      const w = window as unknown as {
        __trainingappTrainingPlayer?: { jumpToSlide(slideId: string): Promise<boolean> };
      };
      w.__trainingappTrainingPlayer = {
        jumpToSlide: (slideId: string): Promise<boolean> => {
          const bridge = ensureBridge();
          if (bridge === null) return Promise.resolve(false);
          return bridge.jumpToSlide(slideId);
        },
      };
      return () => {
        delete w.__trainingappTrainingPlayer;
      };
    }, [packId]);

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-sm)',
          height: '100%',
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-md)',
            padding: 'var(--spacing-sm) var(--spacing-md)',
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
            color: 'var(--color-text-muted)',
          }}
        >
          <span>
            Current slide:{' '}
            <span data-testid="training-player-slide">
              {current === null ? '' : `${current.slideId}|${current.slideTitle}`}
            </span>
          </span>
        </div>
        {location === null && framed && (
          <p role="alert" data-testid="training-player-framed" style={{ margin: 0, padding: 'var(--spacing-sm) var(--spacing-md)' }}>
            Course playback is disabled because this app is embedded in another page. Open the app directly in its own
            browser tab to play courses.
          </p>
        )}
        {location === null && originStatus === 'host-unsupported' && (
          <p role="alert" data-testid="training-player-host-unsupported" style={{ margin: 0, padding: 'var(--spacing-sm) var(--spacing-md)' }}>
            Course playback is not available on this host: it does not serve the course player. Serve the app with
            the bundled start scripts (start.bat / start.command) or play courses in the desktop app.
          </p>
        )}
        {location === null && originStatus === 'no-origin' && (
          <p role="alert" data-testid="training-player-unavailable" style={{ margin: 0, padding: 'var(--spacing-sm) var(--spacing-md)' }}>
            Course playback needs a player origin: open the app at http://localhost or http://127.0.0.1 (its loopback
            alias serves the player), or configure player-origin.json / VITE_TRAININGAPP_PLAYER_ORIGIN for this host.
          </p>
        )}
        {playerError !== null && location !== null && (
          <p role="alert" data-testid="training-player-error" style={{ margin: 0, padding: 'var(--spacing-sm) var(--spacing-md)' }}>
            Course player could not start: {playerError}. Course playback is supported in current Chrome and Edge (Safari is not
            supported).{' '}
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </p>
        )}
        <iframe
          ref={frameRef}
          data-testid="training-player-frame"
          sandbox={TRAINING_FRAME_SANDBOX}
          src={location?.src ?? 'about:blank'}
          onLoad={handleFrameLoad}
          title={`Training player (${packId})`}
          style={{
            flex: 1,
            width: '100%',
            minHeight: 0,
            border: '1px solid var(--color-secondary)',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--color-surface)',
          }}
        />
        <div
          data-testid="training-player-slidechange"
          style={{
            maxHeight: '96px',
            overflowY: 'auto',
            padding: 'var(--spacing-xs) var(--spacing-md)',
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
            color: 'var(--color-text-muted)',
          }}
        >
          {changeLog.map((entry, index) => (
            <div key={`${entry.slideId}-${index}`} data-trainingapp-entry="">
              {entry.slideId}|{entry.slideTitle}
            </div>
          ))}
        </div>
      </div>
    );
  },
);
