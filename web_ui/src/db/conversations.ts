import { db, CONV_WRITE_LOCK, migrationReady, requireKeyForWrite } from './index';
import { readConversationEpoch, readClearRecord, readEpochOf, withConversationWriteLock, withEpochGate, withAdvancingDeleteGate } from './conv-protocol';
import { CONVERSATION_QUERY_MAX_LENGTH } from './conversation-query';
import {
  ConversationConflictError,
  decryptRowOrPlain,
  encryptRow,
  prefixOfDbName,
} from '../lib/storage/db-crypto';
import { withExclusiveLock } from '../lib/storage/exclusive-lock';

export { CONVERSATION_QUERY_MAX_LENGTH };
import type { ChatMessage } from '../types/chat';

/**
 * Conversation entity stored in IndexedDB via Dexie. AT REST (issue #367):
 * every row is persisted as an encrypted envelope (db-crypto) — the object
 * shape below is the DECRYPTED form the public API returns.
 */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;  // Unix timestamp (ms)
  updatedAt: number;  // Unix timestamp (ms)
  mode: 'server' | 'wllama';
  modelUsed: string;  // model identifier
  /** M3v10 clear-repair signals. Absence is meaningful and must be preserved. */
  afterClear?: number;
  sawPendingGoal?: number;
}

/**
 * Epoch-gating options for conversation mutations (issue #34 item 6p,
 * R4-3/R5-3). `stateEpoch` is the db epoch the caller's in-memory state was
 * loaded (or created) under: the write transaction re-reads the epoch and
 * ABORTS (no-op) when it moved — a save enqueued before a cross-tab clear
 * can never resurrect cleared history. When omitted, a fresh epoch is
 * captured before the write (the pre-protocol behavior for non-hook
 * callers, which always land).
 */
export interface ConversationMutationOptions {
  stateEpoch?: number;
}

/** The active profile db's prefix (key derivation is per-database, #367). */
function activePrefix(): string {
  return prefixOfDbName(db.name);
}

/**
 * Create a new conversation (persisted encrypted, issue #367).
 *
 * @param conversation - Full conversation object to persist
 * @param options - Epoch gating (see ConversationMutationOptions)
 * @returns true when written; false when the epoch gate aborted a stale write
 */
export async function createConversation(
  conversation: Conversation,
  options?: ConversationMutationOptions,
): Promise<boolean> {
  try {
    await migrationReady(db.name);
    await requireKeyForWrite(db);
    // Crypto OUTSIDE the transaction (PC-06): the envelope is fully built
    // before the epoch-gated add opens.
    // Gate INSIDE the lock, and the ENVELOPE BUILT inside it too (review
    // round 3: a secret change while waiting on the lock must not let a
    // gate under the new secret persist an envelope encrypted under the
    // old one). Deletes stay keyless (matrix: destructive paths never
    // probe), so create inlines the gated mutation instead of the shared
    // keyless helper.
    const stateEpoch = options?.stateEpoch ?? (await readConversationEpoch());
    return withConversationWriteLock(async () => {
      await requireKeyForWrite(db);
      const record = readClearRecord();
      const tagged: Conversation = {
        ...conversation,
        ...(record.completed?.[activePrefix()] === undefined
          ? {}
          : { afterClear: record.completed[activePrefix()] }),
        ...((record.pendingV2 ?? record.pending)?.profile === activePrefix()
          ? { sawPendingGoal: (record.pendingV2 ?? record.pending)!.epochGoal }
          : {}),
      };
      const envelope = await encryptRow(tagged, undefined, activePrefix());
      return withEpochGate(stateEpoch, () => db.conversations.add(envelope));
    });
  } catch (error) {
    console.error('[conversations] Failed to create conversation:', error);
    throw error;
  }
}

/**
 * Retrieve a single conversation by ID (transparently decrypted, #367).
 * Fail-closed: a missing profile secret or a failed authentication THROWS
 * (ConversationDecryptError) — there is no plaintext fallback.
 *
 * @param id - Conversation identifier
 * @returns The conversation if found, otherwise undefined
 */
export async function getConversation(id: string): Promise<Conversation | undefined> {
  try {
    await migrationReady(db.name);
    const row = await db.conversations.get(id);
    if (row === undefined) return undefined;
    return await decryptRowOrPlain<Conversation>(row, activePrefix());
  } catch (error) {
    console.error('[conversations] Failed to get conversation:', error);
    throw error;
  }
}

/** Bound on the optimistic three-phase retries (RC4-01); exhaustion surfaces
 *  a typed conflict instead of silently dropping either change. */
const UPDATE_MAX_ATTEMPTS = 5;

/**
 * Storage-identity byte compare for the phase-3 optimistic guard: two stored
 * rows are "the same" iff their serialized bytes match (envelopes compare by
 * iv+ct+index fields — no decryption; plaintext legacy rows compare whole).
 * Deterministic key order: both shapes are produced by this module's own
 * writers with stable key insertion order.
 */
function sameStoredRow(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Partially update an existing conversation (issue #367 three-phase path).
 *
 * The envelope turns every update into read-merge-write, so the WHOLE
 * sequence runs inside withExclusiveLock(CONV_WRITE_LOCK) — Web-Locks
 * preferred with a real in-tab chain (RC4-01: the legacy direct-call
 * degrade would let a same-tab rename and message-append lose one update).
 * Phases: (1) tx{epoch check + read current row}, (2) decrypt/merge/encrypt
 * OUTSIDE any transaction, (3) tx{epoch recheck + envelope byte-compare +
 * write}; a guard mismatch restarts from phase 1 with a FRESH read/decrypt
 * (bounded; exhaustion throws ConversationConflictError). The epoch recheck
 * retains withEpochGate's exact-equality stale-write semantics.
 *
 * @param id - Conversation identifier
 * @param changes - Fields to merge into the existing record
 * @param options - Epoch gating (see ConversationMutationOptions)
 * @returns true when written; false when the epoch gate aborted a stale write
 */
export async function updateConversation(
  id: string,
  changes: Partial<Conversation>,
  options?: ConversationMutationOptions
): Promise<boolean> {
  try {
    await migrationReady(db.name);
    const prefix = activePrefix();
    const stateEpoch = options?.stateEpoch ?? (await readConversationEpoch());
    return await withExclusiveLock(CONV_WRITE_LOCK, async () => {
      // Gate INSIDE the lock (review round 2 finding 3): a fresh matrix
      // probe immediately governs this write's retry loop.
      await requireKeyForWrite(db);
      for (let attempt = 0; attempt < UPDATE_MAX_ATTEMPTS; attempt += 1) {
        // Phase 1: epoch-gated read of the current stored row.
        let snapshot: unknown;
        let phase1Applied = false;
        await db.transaction('rw', [db.conversations, db.meta], async () => {
          const current = await readEpochOf(db);
          if (current !== stateEpoch) return;
          snapshot = await db.conversations.get(id);
          phase1Applied = true;
        });
        if (!phase1Applied) return false; // stale epoch: gate aborts the write
        if (snapshot === undefined) {
          // Base semantics: Dexie's partial update of a missing id no-ops
          // and the mutation still counts as applied (no row to merge into).
          return true;
        }

        // Phase 2: decrypt/merge/encrypt OUTSIDE every transaction (PC-06 —
        // a WebCrypto await inside the write tx would auto-commit it). The
        // envelope is fully built here; phase 3 only byte-compares and puts.
        const currentConv = await decryptRowOrPlain<Conversation>(snapshot, prefix);
        const merged: Conversation = {
          ...currentConv,
          ...changes,
          // The primary key cannot change; the envelope binds it via AAD.
          id,
        };
        // M3v10 create-vs-overwrite: an existing row's scoped signals (and
        // their absence) survive every rename/save. Only a genuinely new row
        // receives the current clear signals.
        const stored = snapshot as Record<string, unknown>;
        if (typeof stored['afterClear'] === 'number') merged.afterClear = stored['afterClear'];
        else delete merged.afterClear;
        if (typeof stored['sawPendingGoal'] === 'number') merged.sawPendingGoal = stored['sawPendingGoal'];
        else delete merged.sawPendingGoal;
        const envelope = await encryptRow(merged, undefined, prefix);

        // Phase 3: tx{epoch recheck + optimistic byte-compare + write}. No
        // async crypto inside this scope — every statement is IDB work.
        let conflict = false;
        let written = false;
        await db.transaction('rw', [db.conversations, db.meta], async () => {
          const current = await readEpochOf(db);
          if (current !== stateEpoch) return; // stale: gate aborts (false)
          const nowStored = await db.conversations.get(id);
          if (!sameStoredRow(nowStored, snapshot)) {
            // RC4-01: another writer committed between phase 1 and here.
            conflict = true;
            return;
          }
          await db.conversations.put(envelope);
          written = true;
        });
        if (conflict) continue; // fresh phase-1 read on the next attempt
        if (!written) return false; // stale epoch aborted in phase 3
        return true;
      }
      throw new ConversationConflictError(id);
    });
  } catch (error) {
    console.error('[conversations] Failed to update conversation:', error);
    throw error;
  }
}

/**
 * Delete a conversation permanently. Deletes need no key (plan matrix:
 * destructive paths serialize but never decrypt/mint).
 *
 * @param id - Conversation identifier
 * @param options - Epoch gating (see ConversationMutationOptions)
 * @returns true when deleted; false when the epoch gate aborted a stale delete
 */
export async function deleteConversation(
  id: string,
  options?: ConversationMutationOptions
): Promise<boolean> {
  try {
    await migrationReady(db.name);
    const stateEpoch = options?.stateEpoch ?? (await readConversationEpoch());
    return withConversationWriteLock(() => withAdvancingDeleteGate(stateEpoch, id));
  } catch (error) {
    console.error('[conversations] Failed to delete conversation:', error);
    throw error;
  }
}

/**
 * List conversations in descending order by updatedAt with pagination
 * (transparently decrypted, #367).
 *
 * The first argument is an ITEM offset, which is what the only caller
 * (useConversations: initial page at 0, "Load more" at the number already
 * loaded) passes. It used to be a page index multiplied by pageSize, so the
 * second "Load more" page asked for offset 50 * 50 = 2500 and came back empty.
 *
 * @param offset - Number of newest conversations to skip (default 0)
 * @param pageSize - Number of items to return (default 50)
 * @returns Array of conversations for the requested window
 */
export async function listConversations(
  offset: number = 0,
  pageSize: number = 50
): Promise<Conversation[]> {
  try {
    await migrationReady(db.name);
    const rows = await db.conversations
      .orderBy('updatedAt')
      .reverse()
      .offset(offset)
      .limit(pageSize)
      .toArray();
    const prefix = activePrefix();
    return await Promise.all(rows.map((row) => decryptRowOrPlain<Conversation>(row, prefix)));
  } catch (error) {
    console.error('[conversations] Failed to list conversations:', error);
    throw error;
  }
}

/**
 * Total count of stored conversations. Counting needs NO key (plan matrix:
 * the count rides the plaintext index fields), which is exactly what the
 * frozen C2 wrong-key leg asserts (the ciphertext row stays countable).
 *
 * @returns Total number of conversations
 */
export async function countConversations(): Promise<number> {
  try {
    await migrationReady(db.name);
    return await db.conversations.count();
  } catch (error) {
    console.error('[conversations] Failed to count conversations:', error);
    throw error;
  }
}

/** Most matches a search returns (newest first); the caller is told when more exist. */
export const CONVERSATION_SEARCH_LIMIT = 50;

const NON_ASCII = /[^\u0000-\u007f]/;

const COMBINING_DOT_ABOVE = '\u0307';

/**
 * Case-fold text for matching. Lower-casing the Turkish capital dotted I
 * ("I" + dot, U+0130) yields "i" + U+0307 (combining dot above), which would
 * never match a plain "i" (PR #147 review PRR-016), so that mark is dropped
 * after lower-casing. U+0307 survives NFC after any base letter that has no
 * precomposed dotted form (not just "i"/"j"). The mark is stripped from the
 * needle and the haystack alike, so this only broadens matching (text that
 * differs solely by a dot above now matches) and can never cause a miss.
 */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.indexOf(COMBINING_DOT_ABOVE) === -1 ? lower : lower.split(COMBINING_DOT_ABOVE).join('');
}

/**
 * Normalise a search query: trimmed, capped at CONVERSATION_QUERY_MAX_LENGTH
 * code points, Unicode NFC, case-folded (foldCase). Empty means "no search".
 * NFC makes a precomposed "e-acute" (U+00E9) and a decomposed one
 * ("e" + U+0301) the same needle.
 */
export function normalizeConversationQuery(query: string): string {
  const capped = Array.from(query.trim()).slice(0, CONVERSATION_QUERY_MAX_LENGTH).join('');
  return foldCase(capped.normalize('NFC'));
}

/**
 * Whether a conversation matches an already-normalised needle: a substring of
 * its title or of any message's text. Cheap path first: the title, then the
 * messages, returning on the first hit (a long conversation stops at its first
 * matching message). The haystack is NFC-normalised only
 * when the needle contains non-ASCII characters; for an ASCII needle that step
 * cannot create a match (it only composes letters with combining marks) and it
 * is the most expensive part of a full-store walk.
 */
export function conversationMatches(conversation: Conversation, needle: string): boolean {
  if (needle === '') return false;
  const fold = NON_ASCII.test(needle)
    ? (text: string) => foldCase(text.normalize('NFC'))
    : foldCase;
  if (typeof conversation.title === 'string' && fold(conversation.title).includes(needle)) return true;
  const messages = conversation.messages;
  if (!Array.isArray(messages)) return false;
  for (let i = 0; i < messages.length; i += 1) {
    const text = messages[i]?.content;
    if (typeof text === 'string' && fold(text).includes(needle)) return true;
  }
  return false;
}

export interface ConversationSearchOptions {
  /** Maximum matches to return (default CONVERSATION_SEARCH_LIMIT). */
  limit?: number;
  /**
   * Checked once PER ROW before that row is read+decrypted (the per-row
   * cursor of the #367 re-plan; the old Dexie `until` callback ran at the
   * same boundary): once true the scan stops, so a search superseded by a
   * newer keystroke reads nothing further. A cancelled search resolves with
   * whatever it had found; callers discard it.
   */
  isCancelled?: () => boolean;
}

/**
 * Search ALL stored conversations, not just a loaded page (Lumen phase 3,
 * sidebar search). #367 re-plan (RC4/PC2-08): PER-ROW cursor iteration over
 * the updatedAt-descending key order — every visited row is read
 * individually and decrypted (typed decrypt failures PROPAGATE, never skip)
 * — stopping at `limit + 1` MATCHES or store exhaustion, preserving the old
 * filter-then-limit visit contract on encrypted rows. Conversations live
 * only in this renderer's IndexedDB in both the browser and the Electron
 * app (the desktop backend stores documents, not chat history), so this one
 * query serves both.
 */
export async function searchConversations(
  query: string,
  options: ConversationSearchOptions = {}
): Promise<{ matches: Conversation[]; truncated: boolean }> {
  const { limit = CONVERSATION_SEARCH_LIMIT, isCancelled } = options;
  const needle = normalizeConversationQuery(query);
  if (needle === '') return { matches: [], truncated: false };
  try {
    await migrationReady(db.name);
    const prefix = activePrefix();
    // Cancellation is honored at BOTH phases (RC3-05): the key-only scan
    // stops at the first cancellation observation (collection.until — the
    // base cursor's own early-stop seam), and the body-read loop checks
    // before each get. PC-06 forces bodies out of the cursor transaction
    // (no awaitable crypto inside it), so matches can only be evaluated
    // outside it: a query that matches broadly still enumerates the store's
    // keys up front — the disclosed residual vs the base design, recorded
    // in the trace 08.
    if (isCancelled?.() === true) return { matches: [], truncated: false };
    let scanCancelled = false;
    const keys = await db.conversations
      .orderBy('updatedAt')
      .reverse()
      .until(() => {
        if (isCancelled?.() === true) {
          scanCancelled = true;
          return true;
        }
        return false;
      })
      .primaryKeys();
    if (scanCancelled) return { matches: [], truncated: false };
    const matches: Conversation[] = [];
    let truncated = false;
    for (const key of keys) {
      if (isCancelled?.() === true) break;
      const row = await db.conversations.get(key);
      if (row === undefined) continue; // deleted mid-scan
      const conversation = await decryptRowOrPlain<Conversation>(row, prefix);
      if (conversationMatches(conversation, needle)) {
        matches.push(conversation);
        if (matches.length > limit) {
          truncated = true;
          break;
        }
      }
    }
    return { matches: matches.slice(0, limit), truncated };
  } catch (error) {
    console.error('[conversations] Failed to search conversations:', error);
    throw error;
  }
}
