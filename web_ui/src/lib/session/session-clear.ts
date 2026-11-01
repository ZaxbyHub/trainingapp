/**
 * session-clear — the inactivity-clear bus (issue #34 item 6p, plan R2/R5-6).
 *
 * A tiny injectable registry coordinating "clear the workstation's
 * conversation state" across the app:
 *  - surface handlers ({isBusy, onClear}): ChatPage registers one whose
 *    isBusy is "a generation stream is active" and whose onClear cancels the
 *    stream and resets its local message state;
 *  - requestSessionClear(): while ANY handler is busy the clear is DEFERRED
 *    (never kills an active turn — AC6); otherwise every handler's onClear
 *    runs, the persisted conversation clear executes (conv-protocol:
 *    pending-record + epoch transaction, cross-tab reset via storage event),
 *    and the cleared notice is dispatched;
 *  - runClearHandlers(): the in-tab reset used by the cross-tab storage-event
 *    path (another tab cleared — this tab cancels its stream and resets its
 *    in-memory state);
 *  - onSessionCleared(cb): subscribers (App) surface the visible notice.
 *
 * The default persisted-clear dependency is injectable so tests (and the
 * inactivity suite, check C6) can observe the clear path being invoked.
 */
import { clearAllConversationsInDb } from '../../db/conv-protocol';

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

/** The persisted-clear seam (conv-protocol by default; injectable in tests). */
let clearConversations: ConversationsClearer = () => clearAllConversationsInDb();

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
 * partial clear while a turn streams). A completed clear runs the handlers'
 * resets, the persisted conversation clear, and the notice.
 */
export async function requestSessionClear(): Promise<SessionClearResult> {
  if (anyHandlerBusy()) return { deferred: true };
  await runClearHandlers();
  const result = await clearConversations();
  if ('deferred' in result) return result;
  for (const cb of [...clearedCallbacks]) {
    try {
      cb();
    } catch {
      /* a broken notice subscriber never blocks the others */
    }
  }
  return result;
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
  clearConversations = () => clearAllConversationsInDb();
}
