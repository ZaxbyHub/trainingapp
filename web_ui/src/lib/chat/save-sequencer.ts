/**
 * Module-scope per-conversation save sequencer (issue #269).
 *
 * Every ChatPage message save for one conversation — the send-time save,
 * Regenerate's saves, partial-answer checkpoints, and every terminal save
 * (onDone / onError / Stop / conversation switch / engine switch / unmount) —
 * is issued through `sequenceConversationSave`, so a save is handed to the
 * persistence layer only after every EARLIER save to the SAME conversation
 * key settled. Completion order therefore equals issue order, across streams
 * AND across ChatPage unmount/remount: the tail map lives at MODULE scope, so
 * a held unmount-terminal save still orders ahead of a remounted page's
 * send-time save for the same conversation (a component-owned map would die
 * with the component and let the stale unmount write land last).
 *
 * A first-turn create (owning conversation id still undefined) uses the
 * caller's reserved key until the awaited create resolves; the stream then
 * adopts the real id, so every later save for that stream chains behind the
 * create's key — never ahead of it.
 *
 * A rejected save does not break the chain: the next task runs whether the
 * previous one fulfilled or rejected (`.then(fn, fn)`), matching the
 * fire-and-forget terminal saves whose errors already surface through
 * `persistenceError` inside the save layer. Settled tails are pruned when
 * they are still the key's tail, so the map never grows without bound.
 */

/** A single save task. Issued only when every earlier task on the same key settled. */
type SaveTask = () => void | Promise<void>;

/** Per-key tail promise. Module scope on purpose (survives component unmount). */
const tails = new Map<string, Promise<void>>();

/**
 * Sequence `fn` behind every save already queued for `key`.
 *
 * @param key the owning conversation id (or the caller's reserved first-turn
 *   key — ordering is per key, whatever it names).
 * @param fn the save task; invoked with the previous task's outcome ignored
 *   (runs on fulfilment AND rejection of the tail).
 * @returns the promise that settles when `fn`'s own save settled.
 */
export function sequenceConversationSave(key: string, fn: SaveTask): Promise<void> {
  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  tails.set(key, next);
  // Prune once settled — but only when no newer task queued behind us in the
  // meantime (that newer tail must stay so the next save still chains on it).
  const prune = (): void => {
    if (tails.get(key) === next) {
      tails.delete(key);
    }
  };
  // Handlers on both outcomes keep `next` from ever becoming an unhandled
  // rejection when callers fire-and-forget the returned promise.
  next.then(prune, prune);
  return next;
}

/** Test-only: drop every pending tail so one test's held save cannot order
 *  the next test's saves (the checkpoint suite resets this in afterEach). */
export function __resetSaveSequencerForTests(): void {
  tails.clear();
}
