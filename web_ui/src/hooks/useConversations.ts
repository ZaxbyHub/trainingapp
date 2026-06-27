import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  countConversations,
  type Conversation,
} from '../db/conversations';
import type { ChatMessage } from '../types/chat';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/**
 * Hook for managing conversation state with Dexie IndexedDB persistence.
 *
 * Provides:
 * - Conversation list management (load, paginate, rename, delete)
 * - Current conversation selection and message state
 * - Persistence error surfacing via `persistenceError` state
 *
 * All Dexie operations surface user-friendly error messages via `persistenceError`.
 * Call `clearPersistenceError()` to dismiss an error banner.
 *
 * @returns {Object} Conversation state and operations
 * @returns {ConversationSummary[]} conversations - Paginated conversation list
 * @returns {string|undefined} currentConversationId - Active conversation ID
 * @returns {ChatMessage[]} currentMessages - Messages for active conversation
 * @returns {function} setCurrentMessages - Direct message state setter
 * @returns {function} selectConversation - Load conversation by ID
 * @returns {function} newChat - Clear current conversation
 * @returns {function} saveMessages - Create/update conversation in Dexie
 * @returns {function} removeConversation - Delete conversation
 * @returns {function} renameConversation - Update conversation title
 * @returns {function} refreshConversations - Reload conversation list
 * @returns {boolean} hasMore - Whether more conversations exist
 * @returns {function} loadMore - Load next page
 * @returns {boolean} isLoadingMore - Pagination loading state
 * @returns {string|null} persistenceError - Current error message or null
 * @returns {function} clearPersistenceError - Clear persistence error state
 */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>(undefined);
  const [currentMessages, setCurrentMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const pageSize = 50;
  const isInitialized = useRef(false);

  const clearPersistenceError = useCallback(() => setPersistenceError(null), []);

  // Load conversation list from Dexie on mount
  const refreshConversations = useCallback(async () => {
    try {
      const list = await listConversations(0, pageSize);
      setConversations(list.map(c => ({
        id: c.id,
        title: c.title,
        updatedAt: new Date(c.updatedAt).toISOString(),
      })));
      const total = await countConversations();
      setHasMore(list.length < total);
      setPersistenceError(null);
    } catch (error) {
      console.error('[useConversations] Failed to load conversations:', error);
      setPersistenceError('Failed to load conversations');
    }
  }, [pageSize]);

  // Load more conversations for pagination
  const loadMore = useCallback(async () => {
    if (isLoadingMore) return;
    try {
      setIsLoadingMore(true);
      const more = await listConversations(conversations.length, pageSize);
      if (more.length > 0) {
        setConversations(prev => [...prev, ...more.map(c => ({
          id: c.id,
          title: c.title,
          updatedAt: new Date(c.updatedAt).toISOString(),
        }))]);
        const total = await countConversations();
        setHasMore(conversations.length + more.length < total);
      } else {
        setHasMore(false);
      }
      setPersistenceError(null);
    } catch (error) {
      console.error('[useConversations] Failed to load more conversations:', error);
      setPersistenceError('Failed to load more conversations');
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversations.length, pageSize, isLoadingMore]);

  /**
   * Rename a conversation's title.
   *
   * @param id - Conversation ID to rename
   * @param newTitle - New title string
   */
  const renameConversation = useCallback(async (id: string, newTitle: string) => {
    try {
      await updateConversation(id, { title: newTitle, updatedAt: Date.now() });
      await refreshConversations();
      setPersistenceError(null);
    } catch (error) {
      console.error('[useConversations] Failed to rename conversation:', error);
      setPersistenceError('Failed to rename conversation');
    }
  }, [refreshConversations]);

  useEffect(() => {
    if (!isInitialized.current) {
      isInitialized.current = true;
      (async () => {
        try {
          await refreshConversations();
          // Restore last conversation on load
          const list = await listConversations(0, 1);
          if (list.length > 0) {
            const last = list[0];
            setCurrentConversationId(last.id);
            setCurrentMessages(last.messages);
          }
        } catch (error) {
          console.error('[useConversations] Failed to initialize conversations:', error);
          setPersistenceError('Failed to load conversations');
        }
      })();
    }
  }, [refreshConversations]);

  /**
   * Select a conversation by ID and load its messages.
   * @param id - Conversation ID to load
   */
  const selectConversation = useCallback(async (id: string) => {
    try {
      const conv = await getConversation(id);
      if (conv) {
        setCurrentConversationId(conv.id);
        setCurrentMessages(conv.messages);
      }
      setPersistenceError(null);
    } catch (error) {
      console.error('[useConversations] Failed to load conversation:', error);
      setPersistenceError('Failed to load conversation');
    }
  }, []);

  /**
   * Clear current conversation state to start a new chat.
   */
  const newChat = useCallback(() => {
    setCurrentConversationId(undefined);
    setCurrentMessages([]);
  }, []);

  /**
   * Save messages to Dexie. Creates new conversation if currentConversationId is null,
   * otherwise updates the existing conversation. Auto-generates title from first user message.
   *
   * @param messages - ChatMessage array to save
   * @param mode - Inference mode ('server' or 'wllama')
   * @param modelUsed - Model identifier string
   */
  const saveMessages = useCallback(async (
    messages: ChatMessage[],
    mode: 'server' | 'wllama',
    modelUsed: string
  ) => {
    if (messages.length === 0) return;

    const now = Date.now();
    const firstUserMsg = messages.find(m => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
      : 'New conversation';

    try {
      if (!currentConversationId) {
        // Create new conversation
        const newConv: Conversation = {
          id: (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          title,
          messages,
          createdAt: now,
          updatedAt: now,
          mode,
          modelUsed,
        };
        await createConversation(newConv);
        setCurrentConversationId(newConv.id);
      } else {
        // Update existing
        await updateConversation(currentConversationId, {
          messages,
          updatedAt: now,
        });
      }
      await refreshConversations();
      setPersistenceError(null);
    } catch (error) {
      console.error('[useConversations] Failed to save conversation:', error);
      setPersistenceError('Failed to save conversation');
    }
  }, [currentConversationId, refreshConversations]);

  /**
   * Delete a conversation by ID. If the deleted conversation is the current one,
   * clears currentConversationId and currentMessages.
   *
   * @param id - Conversation ID to delete
   */
  const removeConversation = useCallback(async (id: string) => {
    try {
      await deleteConversation(id);
      if (currentConversationId === id) {
        setCurrentConversationId(undefined);
        setCurrentMessages([]);
      }
      await refreshConversations();
      setPersistenceError(null);
    } catch (error) {
      console.error('[useConversations] Failed to delete conversation:', error);
      setPersistenceError('Failed to delete conversation');
    }
  }, [currentConversationId, refreshConversations]);

  return {
    conversations,
    currentConversationId,
    currentMessages,
    setCurrentMessages,
    selectConversation,
    newChat,
    saveMessages,
    removeConversation,
    refreshConversations,
    renameConversation,
    hasMore,
    loadMore,
    isLoadingMore,
    persistenceError,
    clearPersistenceError,
  };
}