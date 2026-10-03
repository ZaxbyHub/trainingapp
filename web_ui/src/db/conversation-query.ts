/**
 * Conversation search query limits, kept free of the Dexie database import so
 * UI code (the sidebar search field) can use them without opening IndexedDB.
 */

/**
 * Longest search query honoured (PR #147 review PRR-003). It bounds the per-row
 * substring work of a full store walk; no realistic conversation search needs more.
 *
 * Two enforcement points, deliberately with different units:
 * - normalizeConversationQuery truncates to this many Unicode CODE POINTS (an
 *   astral character such as an emoji counts once and is never split);
 * - the sidebar field's HTML `maxLength` counts UTF-16 CODE UNITS, so an astral
 *   character uses two of them there. The field is therefore the stricter of the
 *   two, and anything it accepts is within the normaliser's cap.
 */
export const CONVERSATION_QUERY_MAX_LENGTH = 200;
