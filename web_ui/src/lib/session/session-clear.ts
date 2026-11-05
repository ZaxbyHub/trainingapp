/**
 * session-clear — the inactivity-clear bus (issue #34 item 6p, plan R2/R5-6;
 * issue #279 plan B1/PC-4/PC2-2).
 *
 * A tiny injectable registry coordinating "clear the workstation's
 * conversation state" across the app:
 *  - surface handlers ({isBusy, onClear}): ChatPage registers one whose
 *    isBusy is "a generation stream is active" and whose onClear cancels the
 *    stream and resets its local message state;
 *  - requestSessionClear(): while ANY handler is busy the clear is DEFERRED
 *    (never kills an active turn — AC6); otherwise the handler resets ride
 *    the persisted clear's OWN exclusive arbitration as a beforeClear hook
 *    (#279 B1) — they run only inside the locked section, AFTER acquisition
 *    and BEFORE the pending-record write + persisted clear, so a DEFERRED
 *    clear (a busy/active colleague tab) resets nothing anywhere; on a
 *    completed clear the notice is dispatched;
 *  - runClearHandlers(): the in-tab reset used by the cross-tab storage-event
 *    path (another tab cleared — this tab cancels its stream and resets its
 *    in-memory state);
 *  - runLocalClearCompletion(): handlers + cleared-callbacks without another
 *    persisted clear — the post-clear path the inactivity replay branch
 *    reuses (#279 B2);
 *  - onSessionCleared(cb): subscribers (App) surface the visible notice.
 *
 * The default persisted-clear dependency is injectable so tests (and the
 * inactivity suite, check C6) can observe the clear path being invoked. The
 * injected seam keeps a zero-argument signature (it ignores the options the
 * default adapter forwards); requestSessionClear's flag-recording wrapper
 * covers an injected seam that cannot run the hook, running the handlers
 * itself after a non-deferred clear — exactly once either way.
 */
import {
  clearAllConversationsInDb,
  type ClearAllConversationsOptions,
} from '../../db/conv-protocol';

export interface SessionClearHandler {
  /** True while this handler's work must not be interrupted (active stream). */
  isBusy(): boolean;
  /** Cancel the in-flight work and reset this handler's local state. */
  onClear(): void | Promise<void>;
}

export type SessionClearResult = { cleared: boolean } | { deferred: true };

/** The persisted conversation clear (conv-protocol full protocol). */
export type ConversationsClearer = () => Promise<{ cleared: boolean } | { deferred: true }>;

const handlers = new Set<SessionClearHandler>();
const clearedCallbacks = new Set<() => void>();

/**
 * The persisted-clear seam. The DEFAULT adapter is signature-aware (it
 * forwards the #279 beforeClear options to conv-protocol); test-injected
 * clearers keep the zero-argument ConversationsClearer shape and simply
 * ignore the extra arguments.
 */
let clearConversations: (
  profile?: string,
  options?: ClearAllConversationsOptions,
) => Promise<{ cleared: boolean } | { deferred: true }> = (profile, options) =>
  clearAllConversationsInDb(profile, options);

/** Replace the persisted-clear dependency (tests). */
export function setConversationsClearerForTests(clearer: ConversationsClearer): void {
  clearConversations = clearer;
}

/**
 * Register a clear handler. Returns the unregister function; the handler
 * itself is also auto-removed when its owner unmounts and calls it.
 */
export function registerClearHandler(handler: SessionClearHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** True while any registered handler is busy (an active turn streams). */
export function anyHandlerBusy(): boolean {
  for (const handler of handlers) {
    try {
      if (handler.isBusy()) return true;
    } catch {
      /* a broken handler never blocks the clear */
    }
  }
  return false;
}

/** Run every handler's onClear (the in-tab reset; used by both paths). */
export async function runClearHandlers(): Promise<void> {
  for (const handler of [...handlers]) {
    try {
      await handler.onClear();
    } catch (error) {
      console.warn('[session-clear] a clear handler failed:', error);
    }
  }
}

/**
 * Request the session clear. Busy handlers DEFER the whole operation (no
 * partial clear while a turn streams). The handler resets ride the persisted
 * clear as its beforeClear hook (#279 B1): they run only when the clear's
 * exclusive session-active arbitration SUCCEEDS — after acquisition, before
 * the pending-record write and the persisted clear — so a deferred clear
 * (another active/busy tab holds the lock) resets NOTHING in any tab. A
 * zero-argument injected seam that swallowed the hook is covered by the
 * flag-recording wrapper: on a non-deferred result with the flag still
 * false the handlers run after the fact (exactly once, no fallback on
 * deferral). A completed clear then dispatches the notice.
 */
export async function requestSessionClear(): Promise<SessionClearResult> {
  if (anyHandlerBusy()) return { deferred: true };
  let handlersRan = false;
  const result = await clearConversations(undefined, {
    beforeClear: async () => {
      // Set the flag BEFORE invoking the handlers, so a synchronous
      // handler failure still counts as "the hook ran".
      handlersRan = true;
      await runClearHandlers();
    },
  });
  if ('deferred' in result) return result;
  if (!handlersRan) {
    // The injected seam swallowed the hook (PC2-2): run the in-tab reset
    // after the fact — the persisted clear already completed.
    await runClearHandlers();
  }
  for (const cb of [...clearedCallbacks]) {
    try {
      cb();
    } catch {
      /* a broken notice subscriber never blocks the others */
    }
  }
  return result;
}

/**
 * The local post-clear completion (#279 B2): handler resets + cleared
 * subscribers WITHOUT another persisted clear. The inactivity replay branch
 * runs this after a pending record resolved — the persisted clear already
 * happened (the replay's epoch transaction), so this path must not call
 * requestSessionClear again (no second clear, no second pending record).
 */
export async function runLocalClearCompletion(): Promise<void> {
  await runClearHandlers();
  for (const cb of [...clearedCallbacks]) {
    try {
      cb();
    } catch {
      /* a broken notice subscriber never blocks the others */
    }
  }
}

/** Subscribe to the cleared notice (App surfaces the banner). */
export function onSessionCleared(cb: () => void): () => void {
  clearedCallbacks.add(cb);
  return () => {
    clearedCallbacks.delete(cb);
  };
}

/** Test helper: drop every registration (isolates suites). */
export function resetSessionClearBusForTests(): void {
  handlers.clear();
  clearedCallbacks.clear();
  clearConversations = (profile, options) => clearAllConversationsInDb(profile, options);
}
