/**
 * inactivity — the workstation-wide inactivity auto-clear watch (issue #34
 * item 6p, AC6; plan R5-4/R6-3/R6-4).
 *
 * Semantics:
 *  - The threshold comes from `getThresholdMin()` (Settings, workstation
 *    level): default 15 minutes, 0 disables (no timer, no lock), clamped to
 *    0..120.
 *  - While the user is active (pointerdown/keydown/wheel/touchstart,
 *    passive) the tab HOLDS the origin-wide session-active Web Lock in
 *    SHARED mode (R6-3); a busy (streaming) tab holds it too. On the timer's
 *    idle fire the tab releases its shared lock and requests the session
 *    clear; the persisted clear's OWN exclusive-ifAvailable arbitration on
 *    the same lock (conv-protocol clearAllConversationsInDb) is the SINGLE
 *    authority — it succeeds only when NO tab on the workstation is active
 *    or busy, so a foreground colleague always blocks a background tab's
 *    clear. The watch itself never holds the exclusive lock across the clear
 *    call (review F1: Web Locks are not reentrant; nesting the two
 *    acquisitions made every fire defer to the poll).
 *  - Idle fire with a busy handler DEFERS (AC6 streaming guard) and re-arms
 *    a 30 s poll that retries once the turn ends. A deferred persisted clear
 *    (another tab active) also re-arms the poll, which re-runs the whole
 *    idle path — deferred clear included. A pending conversation clear from
 *    a crashed tab replays on the same poll (R6-4) — a boot replay can never
 *    kill an active stream.
 *  - A successful clear surfaces the notice through `onCleared()`.
 *  - Requires Web Locks (secure context). Without them the watch is disabled
 *    entirely (degraded class, disclosed) — the alternative (a tab-local
 *    idle timer clearing a shared workstation) is exactly the hazard this
 *    design exists to prevent.
 */
import {
  hasWebLocks,
  holdSessionActiveShared,
  replayPendingConversationClear,
  type HeldLock,
} from '../../db/conv-protocol';
import { requestSessionClear, runLocalClearCompletion } from './session-clear';

/**
 * Re-check / retry cadence after a deferred fire (busy turn, or a persisted
 * clear whose exclusive arbitration found another active tab — review F1: the
 * poll re-runs the whole idle path, including the deferred persisted clear).
 */
export const INACTIVITY_REARM_POLL_MS = 30_000;

export const INACTIVITY_DEFAULT_MIN = 15;
export const INACTIVITY_MAX_MIN = 120;

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

export interface InactivityWatch {
  stop(): void;
}

export interface InactivityWatchOptions {
  /** The configured threshold in minutes (0 = disabled). */
  getThresholdMin(): number;
  /** True while a turn streams (the bus aggregates registered handlers). */
  isBusy(): boolean;
  /** The visible notice callback once a clear completed. */
  onCleared(): void;
  /** Log seam (defaults to console.warn). */
  warn?(message: string): void;
}

function clampThreshold(raw: number): number {
  if (!Number.isFinite(raw)) return INACTIVITY_DEFAULT_MIN;
  return Math.min(Math.max(Math.round(raw), 0), INACTIVITY_MAX_MIN);
}

/**
 * Start the inactivity watch. Returns a stop() that disarms the timer,
 * releases the shared lock and removes the listeners.
 */
export function startInactivityWatch(options: InactivityWatchOptions): InactivityWatch {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  if (!hasWebLocks()) {
    // R5-4: disabled without Web Locks — disclosed degradation, not a silent
    // no-op.
    warn('[inactivity] Web Locks unavailable — inactivity auto-clear is disabled on this origin');
    return { stop() {} };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sharedHeld: HeldLock | null = null;
  let acquireInFlight = false;
  let releasePending = false;

  const releaseShared = (): void => {
    if (acquireInFlight) {
      // The acquire resolves later; release the lock the moment it lands.
      releasePending = true;
      return;
    }
    sharedHeld?.release();
    sharedHeld = null;
  };

  const acquireSharedIfAbsent = (): void => {
    if (sharedHeld !== null || acquireInFlight) return;
    acquireInFlight = true;
    releasePending = false;
    void holdSessionActiveShared()
      .then((held) => {
        acquireInFlight = false;
        if (stopped || releasePending) {
          releasePending = false;
          held?.release();
          return;
        }
        sharedHeld = held;
      })
      .catch(() => {
        acquireInFlight = false;
      });
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Arm the full threshold timer; 0 disables (no timer, no lock). */
  const armThreshold = (): void => {
    clearTimer();
    const threshold = clampThreshold(options.getThresholdMin());
    if (threshold <= 0) {
      releaseShared();
      return;
    }
    timer = setTimeout(onIdle, threshold * 60_000);
  };

  /**
   * Arm the 30 s retry poll (busy turn, or a persisted clear whose exclusive
   * arbitration found another active tab — review F1: the poll re-runs the
   * whole idle path, including the deferred persisted clear).
   */
  const armPoll = (): void => {
    clearTimer();
    timer = setTimeout(onIdle, INACTIVITY_REARM_POLL_MS);
  };

  const onIdle = (): void => {
    if (stopped) return;
    if (options.isBusy()) {
      // AC6 streaming guard: defer and retry — a busy tab also holds the
      // shared lock so no other tab can clear under the stream.
      acquireSharedIfAbsent();
      armPoll();
      return;
    }
    releaseShared();
    // R6-4: resolve a still-pending clear from a crashed tab first (the
    // replay performs its own exclusive arbitration).
    void replayPendingConversationClear().then((replay) => {
      if (stopped) return;
      if (replay.replayed) {
        // The pending clear completed. #279 B2: the replay branch runs the
        // FULL post-clear path — the same handler resets + cleared
        // subscribers requestSessionClear uses (a replayed clear wiped this
        // tab's persisted conversations too, so its in-memory state and the
        // conversation list must reset here, not only in the bus path) —
        // WITHOUT calling requestSessionClear again (the replay's own epoch
        // transaction WAS the persisted clear; a second one would bump the
        // epoch once more). Order: handlers/subscribers first, then the
        // banner, then re-arm.
        void runLocalClearCompletion().then(() => {
          if (stopped) return;
          options.onCleared();
          armThreshold();
        });
        return;
      }
      // NO exclusive lock is held here on purpose (review F1): Web Locks
      // have no reentrancy — acquiring the exclusive here and then calling
      // the clear, which acquires the SAME exclusive internally, would make
      // every fire defer to the 30 s poll. The persisted clear's OWN
      // exclusive-ifAvailable arbitration (conv-protocol
      // clearAllConversationsInDb) is the single authority: when another tab
      // holds the session-active lock (shared or exclusive) the clear
      // returns {deferred} and the re-arm poll below retries it until the
      // workstation is quiet.
      void (async () => {
        const result = await requestSessionClear();
        if ('cleared' in result && result.cleared) {
          options.onCleared();
          armThreshold();
        } else {
          armPoll();
        }
      })();
    });
  };

  const onActivity = (): void => {
    if (stopped) return;
    acquireSharedIfAbsent();
    armThreshold();
  };

  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { passive: true });
  }
  // Arm once at start (and hold the shared lock — the app just opened).
  onActivity();

  return {
    stop() {
      stopped = true;
      clearTimer();
      releaseShared();
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity);
      }
    },
  };
}
