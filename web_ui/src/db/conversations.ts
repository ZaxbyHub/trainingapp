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
 * @param page - Zero-based page index (default 0)
 * @param pageSize - Number of items per page (default 50)
 * @returns Array of conversations for the requested page
 */
export async function listConversations(
  page: number = 0,
  pageSize: number = 50
): Promise<Conversation[]> {
  try {
    return await db.conversations
      .orderBy('updatedAt')
      .reverse()
      .offset(page * pageSize)
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
