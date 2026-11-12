/**
 * draft-store.ts — the chat composer's in-memory, per-conversation draft
 * store (#267, AC26).
 *
 * A synchronous module-level Map: keyed by the conversation id (or the chat
 * page's new-conversation sentinel). Deliberately NEVER persisted — drafts are
 * UI state, not user data: no localStorage, no sessionStorage, no IndexedDB.
 * The synchronous Map also makes rapid conversation switches A→B→C safe (each
 * read/write observes the previous one in order, no async gap).
 *
 * Empty deletes: setting '' removes the key, so the store never accumulates
 * empty-string entries.
 */

const drafts = new Map<string, string>();

/** The stored draft for `key`, or undefined when none exists. */
export function getDraft(key: string): string | undefined {
  return drafts.get(key);
}

/**
 * Store the draft for `key`. An EMPTY string deletes the entry (empty
 * deletes; no empty-string values are ever stored).
 */
export function setDraft(key: string, text: string): void {
  if (text.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, text);
}

/** Remove the draft for `key` (absent is fine). */
export function clearDraft(key: string): void {
  drafts.delete(key);
}

/**
 * #267 (AC27, plan C5): the ONE atomic sentinel-migration owner. When the
 * first turn of a NEW conversation adopts its real id (ChatPage), the draft
 * the user typed under the new-conversation sentinel must travel to that id
 * BEFORE the composer hydrates from the store — otherwise the adopted
 * conversation would show an empty composer while the draft stays stranded
 * under the sentinel key.
 *
 * Moves `fromKey`'s draft onto `toKey` only when `toKey` has no stored draft
 * (never clobbers an existing draft of the adopted conversation). The moved
 * draft is removed from `fromKey`. Returns whether a draft was moved.
 */
/**
 * #267 (plan C5): the single new-conversation draft sentinel, shared by
 * ChatPage (draft key for the not-yet-created conversation) and ChatInput
 * (the sentinel-to-adopted-id migration trigger below).
 */
export const NEW_DRAFT_SENTINEL = '\u0000new';

export function moveDraftIfTargetEmpty(fromKey: string, toKey: string): boolean {
  if (fromKey === toKey) return false;
  const moving = drafts.get(fromKey);
  if (moving === undefined || moving.length === 0) return false;
  const existing = drafts.get(toKey);
  if (existing !== undefined && existing.length > 0) return false;
  drafts.set(toKey, moving);
  drafts.delete(fromKey);
  return true;
}
