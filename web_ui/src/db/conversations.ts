import { db } from './index';
import type { ChatMessage } from '../types/chat';

/**
 * Conversation entity stored in IndexedDB via Dexie.
 */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;  // Unix timestamp (ms)
  updatedAt: number;  // Unix timestamp (ms)
  mode: 'server' | 'wllama';
  modelUsed: string;  // model identifier
}

/**
 * Create a new conversation.
 *
 * @param conversation - Full conversation object to persist
 */
export async function createConversation(conversation: Conversation): Promise<void> {
  try {
    await db.conversations.add(conversation);
  } catch (error) {
    console.error('[conversations] Failed to create conversation:', error);
    throw error;
  }
}

/**
 * Retrieve a single conversation by ID.
 *
 * @param id - Conversation identifier
 * @returns The conversation if found, otherwise undefined
 */
export async function getConversation(id: string): Promise<Conversation | undefined> {
  try {
    return await db.conversations.get(id);
  } catch (error) {
    console.error('[conversations] Failed to get conversation:', error);
    throw error;
  }
}

/**
 * Partially update an existing conversation.
 *
 * @param id - Conversation identifier
 * @param changes - Fields to merge into the existing record
 */
export async function updateConversation(
  id: string,
  changes: Partial<Conversation>
): Promise<void> {
  try {
    await db.conversations.update(id, changes);
  } catch (error) {
    console.error('[conversations] Failed to update conversation:', error);
    throw error;
  }
}

/**
 * Delete a conversation permanently.
 *
 * @param id - Conversation identifier
 */
export async function deleteConversation(id: string): Promise<void> {
  try {
    await db.conversations.delete(id);
  } catch (error) {
    console.error('[conversations] Failed to delete conversation:', error);
    throw error;
  }
}

/**
 * List conversations in descending order by updatedAt with pagination.
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
    return await db.conversations
      .orderBy('updatedAt')
      .reverse()
      .offset(offset)
      .limit(pageSize)
      .toArray();
  } catch (error) {
    console.error('[conversations] Failed to list conversations:', error);
    throw error;
  }
}

/**
 * Total count of stored conversations.
 *
 * @returns Total number of conversations
 */
export async function countConversations(): Promise<number> {
  try {
    return await db.conversations.count();
  } catch (error) {
    console.error('[conversations] Failed to count conversations:', error);
    throw error;
  }
}

/** Most matches a search returns (newest first); the caller is told when more exist. */
export const CONVERSATION_SEARCH_LIMIT = 50;

/** Normalise a search query: trimmed, case-folded. Empty means "no search". */
export function normalizeConversationQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/**
 * Whether a conversation matches a normalised query: a case-insensitive
 * substring of its title or of any message's text.
 */
export function conversationMatches(conversation: Conversation, needle: string): boolean {
  if (needle === '') return false;
  if ((conversation.title ?? '').toLocaleLowerCase().includes(needle)) return true;
  return (conversation.messages ?? []).some(
    (m) => typeof m.content === 'string' && m.content.toLocaleLowerCase().includes(needle)
  );
}

/**
 * Search ALL stored conversations, not just a loaded page (Lumen phase 3,
 * sidebar search). Walks the updatedAt index newest-first in IndexedDB and
 * stops after `limit + 1` matches, so the newest `limit` matches are returned
 * and `truncated` says whether more exist. Conversations live only in this
 * renderer's IndexedDB in both the browser and the Electron app (the desktop
 * backend stores documents, not chat history), so this one query serves both.
 *
 * @param query - Raw user query (trimmed and case-folded here)
 * @param limit - Maximum matches to return (default CONVERSATION_SEARCH_LIMIT)
 */
export async function searchConversations(
  query: string,
  limit: number = CONVERSATION_SEARCH_LIMIT
): Promise<{ matches: Conversation[]; truncated: boolean }> {
  const needle = normalizeConversationQuery(query);
  if (needle === '') return { matches: [], truncated: false };
  try {
    const found = await db.conversations
      .orderBy('updatedAt')
      .reverse()
      .filter((c) => conversationMatches(c, needle))
      .limit(limit + 1)
      .toArray();
    return { matches: found.slice(0, limit), truncated: found.length > limit };
  } catch (error) {
    console.error('[conversations] Failed to search conversations:', error);
    throw error;
  }
}
