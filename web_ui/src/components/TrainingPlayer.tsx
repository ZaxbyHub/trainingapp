/**
 * TrainingPlayer — embeds an installed Storyline training pack under
 * app://training/<packId>/story.html and exposes programmatic navigation +
 * slide-change events to the app (issue #81, D5).
 *
 * The player document and this renderer are distinct WHATWG origins (both
 * under the app: scheme), so ALL player communication goes through
 * ./training-player-bridge (postMessage to the pack-local bridge script the
 * pack ships at story_content/trainingapp-bridge.js).
 *
 * Contract notes:
 *  - Polls the player state at a 1000 ms cadence and calls onSlideChange
 *    ONLY when the player-reported slideId changes (never per tick).
 *  - jumpToSlide resolves true iff the player's own state subsequently
 *    reported the target slide (the A8 recipe's success definition).
 *  - Before the course starts the player reports no state; polls stay
 *    silent and queued jumps wait inside the pack bridge until ready.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  createTrainingPlayerBridge,
  type TrainingPlayerBridge,
  type TrainingPlayerSlideState,
} from './training-player-bridge';

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

    const ensureBridge = (): TrainingPlayerBridge | null => {
      if (bridgeRef.current === null && frameRef.current !== null) {
        bridgeRef.current = createTrainingPlayerBridge(frameRef.current);
      }
      return bridgeRef.current;
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
    }, [packId]);

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
        <iframe
          ref={frameRef}
          data-testid="training-player-frame"
          src={`app://training/${packId}/story.html`}
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
