/**
 * inactivity (issue #34 item 6p, AC6, check C6): the workstation-wide
 * inactivity auto-clear, with FAKE TIMERS. One behavior per test:
 *   1. threshold from settings; default 15 minutes; 0 = disabled (no timer
 *      ever fires);
 *   2. user activity resets the timer (no clear while interacting);
 *   3. firing clears BOTH the in-memory conversation state (the registered
 *      handler's reset) and the persisted conversation history of the ACTIVE
 *      profile (the clear path runs against the active profile's namespace);
 *   4. the streaming guard: busy handlers defer the clear at threshold and
 *      the re-arm poll lands once the turn ends;
 *   5. the notice callback fires when the auto-clear completes.
 *
 * The Web Locks wrappers and the pending-clear replay are mocked (their own
 * arbitration is pinned in the conversation-clear integration suite); the
 * session-clear bus is real, with the persisted-clear dependency injected so
 * the active-profile invocation is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_KEY } from '../storage/persisted-keys';
import { getProfilePrefix } from '../storage/profile';

const lockState = vi.hoisted(() => ({
  webLocks: true,
  exclusiveAcquired: true,
  sharedHeld: 0,
}));

vi.mock('../../db/conv-protocol', () => ({
  hasWebLocks: () => lockState.webLocks,
  holdSessionActiveShared: async () => {
    lockState.sharedHeld += 1;
    return { release: () => { lockState.sharedHeld -= 1; } };
  },
  tryAcquireSessionActiveExclusive: async () =>
    lockState.exclusiveAcquired
      ? { acquired: true, release: () => {} }
      : { acquired: false, release: () => {} },
  replayPendingConversationClear: async () => ({ replayed: false, deferred: false }),
}));

import {
  INACTIVITY_REARM_POLL_MS,
  startInactivityWatch,
  type InactivityWatchOptions,
} from './inactivity';
import {
  anyHandlerBusy,
  onSessionCleared,
  registerClearHandler,
  resetSessionClearBusForTests,
  requestSessionClear,
  setConversationsClearerForTests,
} from './session-clear';

const MIN = 60_000;
const DEFAULT_THRESHOLD_MIN = 15;

function activity(): void {
  window.dispatchEvent(new Event('keydown'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetSessionClearBusForTests();
  lockState.webLocks = true;
  lockState.exclusiveAcquired = true;
  lockState.sharedHeld = 0;
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, 'inactiv');
});

afterEach(() => {
  for (const stop of activeWatches.splice(0)) stop();
  vi.useRealTimers();
  resetSessionClearBusForTests();
});

interface WatchHarness {
  threshold: { value: number | null };
  busy: { value: boolean };
  clearedNotice: ReturnType<typeof vi.fn>;
  onClear: ReturnType<typeof vi.fn>;
  persistedClear: ReturnType<typeof vi.fn>;
  activeProfileAtClear: string[];
  stop(): void;
}

const activeWatches: Array<() => void> = [];

function makeWatch(): WatchHarness {
  const harness: WatchHarness = {
    threshold: { value: null },
    busy: { value: false },
    clearedNotice: vi.fn(),
    onClear: vi.fn(),
    persistedClear: vi.fn(async () => {
      harness.activeProfileAtClear.push(getProfilePrefix());
      return { cleared: true };
    }),
    activeProfileAtClear: [],
    stop: () => {},
  };
  setConversationsClearerForTests(() => harness.persistedClear());
  registerClearHandler({
    isBusy: () => harness.busy.value,
    // The in-memory conversation state reset: the stand-in "message list".
    onClear: harness.onClear,
  });
  const options: InactivityWatchOptions = {
    getThresholdMin: () => (harness.threshold.value === null ? DEFAULT_THRESHOLD_MIN : harness.threshold.value),
    isBusy: () => anyHandlerBusy(),
    onCleared: harness.clearedNotice,
    warn: () => {},
  };
  const watch = startInactivityWatch(options);
  harness.stop = () => watch.stop();
  activeWatches.push(harness.stop);
  return harness;
}

describe('inactivity auto-clear (AC6)', () => {
  it('fires at the configured threshold and clears in-memory AND persisted state of the ACTIVE profile', async () => {
    const h = makeWatch();
    h.threshold.value = 15;
    activity();
    await vi.advanceTimersByTimeAsync(15 * MIN - 1);
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.persistedClear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.onClear).toHaveBeenCalledTimes(1);
    expect(h.persistedClear).toHaveBeenCalledTimes(1);
    // The clear path ran against the ACTIVE profile's namespace.
    expect(h.activeProfileAtClear).toEqual(['inactiv']);
    // Empty-chat surface: the handler's reset ran; the notice surfaced.
    expect(h.clearedNotice).toHaveBeenCalledTimes(1);
  });

  it('default threshold is 15 minutes when the setting is absent', async () => {
    const h = makeWatch();
    h.threshold.value = 0; // overridden below with null → default
    h.threshold.value = null;
    activity();
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(h.persistedClear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(h.persistedClear).toHaveBeenCalledTimes(1);
  });

  it('0 disables the watch: no timer, no lock, no clear — ever', async () => {
    const h = makeWatch();
    h.threshold.value = 0;
    activity();
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.persistedClear).not.toHaveBeenCalled();
    expect(h.clearedNotice).not.toHaveBeenCalled();
    expect(lockState.sharedHeld).toBe(0);
  });

  it('user activity resets the timer, so the clear does not fire while interacting', async () => {
    const h = makeWatch();
    h.threshold.value = 15;
    activity();
    // Interact every 10 minutes for 40 minutes: each event re-arms 15 min.
    for (let elapsed = 0; elapsed < 40; elapsed += 10) {
      await vi.advanceTimersByTimeAsync(10 * MIN);
      activity();
    }
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(h.persistedClear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(h.persistedClear).toHaveBeenCalledTimes(1);
  });

  it('streaming guard: a busy handler defers the clear at threshold; the re-arm poll lands once the turn ends', async () => {
    const h = makeWatch();
    h.threshold.value = 15;
    activity();
    h.busy.value = true; // a turn is streaming
    await vi.advanceTimersByTimeAsync(15 * MIN);
    // No clear, no notice — the active turn was not killed.
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.persistedClear).not.toHaveBeenCalled();
    expect(h.clearedNotice).not.toHaveBeenCalled();
    // The stream ends; the 30 s re-arm poll completes the clear.
    h.busy.value = false;
    await vi.advanceTimersByTimeAsync(INACTIVITY_REARM_POLL_MS);
    expect(h.onClear).toHaveBeenCalledTimes(1);
    expect(h.persistedClear).toHaveBeenCalledTimes(1);
    expect(h.clearedNotice).toHaveBeenCalledTimes(1);
  });

  it('a turn that starts just before the idle boundary blocks the clear at fire time', async () => {
    const h = makeWatch();
    h.threshold.value = 15;
    activity();
    await vi.advanceTimersByTimeAsync(14 * MIN);
    // The turn starts one minute BEFORE the threshold fires: the fire-time
    // isBusy check must see it and defer.
    h.busy.value = true;
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.persistedClear).not.toHaveBeenCalled();
    // Stream ends; the poll lands the clear.
    h.busy.value = false;
    await vi.advanceTimersByTimeAsync(INACTIVITY_REARM_POLL_MS);
    expect(h.persistedClear).toHaveBeenCalledTimes(1);
  });

  it('surfaces the notice through onSessionCleared subscribers (App banner)', async () => {
    const h = makeWatch();
    h.threshold.value = 15;
    const notice = vi.fn();
    const unsubscribe = onSessionCleared(notice);
    activity();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(notice).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('requestSessionClear defers (no clear at all) while any handler is busy', async () => {
    makeWatch();
    const unregister = registerClearHandler({
      isBusy: () => true,
      onClear: () => {},
    });
    const result = await requestSessionClear();
    expect(result).toEqual({ deferred: true });
    unregister();
  });

  it('is disabled without Web Locks (disclosed degradation)', async () => {
    lockState.webLocks = false;
    const warn = vi.fn();
    startInactivityWatch({
      getThresholdMin: () => 15,
      isBusy: () => false,
      onCleared: () => {},
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * MIN);
  });

  it('an idle tab re-arms the poll while ANOTHER tab holds the session-active lock', async () => {
    const h = makeWatch();
    h.threshold.value = 15;
    activity();
    lockState.exclusiveAcquired = false; // a colleague's tab is active
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(h.persistedClear).not.toHaveBeenCalled();
    lockState.exclusiveAcquired = true; // workstation quiet now
    await vi.advanceTimersByTimeAsync(INACTIVITY_REARM_POLL_MS);
    expect(h.persistedClear).toHaveBeenCalledTimes(1);
  });
});
