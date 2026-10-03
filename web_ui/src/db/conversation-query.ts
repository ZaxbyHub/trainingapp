/**
 * Conversation search query limits, kept free of the Dexie database import so
 * UI code (the sidebar search field) can use them without opening IndexedDB.
 */

/**
 * Longest search query honoured, in Unicode code points (PR #147 review PRR-003).
 * Longer input is truncated: it bounds the per-row substring work of a full
 * store walk, and no realistic conversation search needs more.
 */
export const CONVERSATION_QUERY_MAX_LENGTH = 200;
