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

/**
 * Strip transient UI state from messages before persistence so nothing
 * render-only (the streaming cursor flag) is ever written to IndexedDB.
 * Persisting `isStreaming:true` causes a permanent blinking cursor after
 * reload (S3). The flag is always re-derived in-memory at send time. */
function stripTransientFlags(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.isStreaming === undefined) return m;
    // Destructure out isStreaming; keep every other field.
    const { isStreaming: _isStreaming, ...rest } = m;
    void _isStreaming;
    return rest as ChatMessage;
  });
}

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

  // Ref mirror of currentConversationId so async callbacks (e.g. an in-flight
  // generation's onDone/onError) can read the LIVE id for the no-re-point
  // guard (S1) without a stale closure. Kept in sync by the effect below.
  const currentConversationIdRef = useRef<string | undefined>(currentConversationId);
  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);
  const setCurrentConversationIdBoth = useCallback((id: string | undefined) => {
    currentConversationIdRef.current = id;
    setCurrentConversationId(id);
  }, []);

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
            setCurrentConversationIdBoth(last.id);
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
        setCurrentConversationIdBoth(conv.id);
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
    setCurrentConversationIdBoth(undefined);
    setCurrentMessages([]);
  }, []);

  /**
   * Save messages to Dexie, targeting a SPECIFIC conversation id.
   *
   * S1 fix: the `conversationId` param is the OWNING id captured at send time
   * (not the live `currentConversationId`). This breaks the stale-closure race
   * where an in-flight stream's onDone would save the switched-to
   * conversation's messages into the switched-FROM conversation. Callers
   * capture the owning id once (in ChatPage.handleSend) and pass it through
   * runGeneration to onDone/onError. When `conversationId` is undefined (no
   * prior conversation), a new conversation is created and its id returned via
   * the ref + state setters so subsequent saves target it.
   *
   * S3 fix: transient `isStreaming` is stripped before writing so a saved
   * mid-stream snapshot never persists a blinking-cursor flag.
   *
   * @param conversationId - Owning conversation ID (captured at send time);
   *   undefined creates a new conversation.
   * @param messages - ChatMessage array to save
   * @param mode - Inference mode ('server' or 'wllama')
   * @param modelUsed - Model identifier string
   * @param onCreate - Optional callback receiving the created conversation id
   *   when a new conversation is created (lets the caller re-point its owning
   *   id + the active conversation atomically).
   */
  const saveMessages = useCallback(async (
    conversationId: string | undefined,
    messages: ChatMessage[],
    mode: 'server' | 'wllama',
    modelUsed: string,
    onCreate?: (newId: string) => void
  ) => {
    const persisted = stripTransientFlags(messages);
    if (persisted.length === 0) return;

    const now = Date.now();
    // Preserve an existing conversation's title; only derive for new ones.
    const existing = conversationId ? await getConversation(conversationId) : undefined;
    const firstUserMsg = persisted.find(m => m.role === 'user');
    const title = existing?.title ?? (firstUserMsg
      ? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
      : 'New conversation');

    try {
      if (!conversationId || !existing) {
        // Create new conversation
        const newConv: Conversation = {
          id: (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          title,
          messages: persisted,
          createdAt: now,
          updatedAt: now,
          mode,
          modelUsed,
        };
        await createConversation(newConv);
        // Only re-point the ACTIVE conversation when the caller is still on
        // the conversation that produced this save (S1 no-re-point guard).
        // The onCreate callback lets the caller decide whether to adopt the
        // new id as the owning id for the in-flight stream.
        onCreate?.(newConv.id);
        if (currentConversationIdRef.current === conversationId) {
          setCurrentConversationIdBoth(newConv.id);
        }
      } else {
        // Update existing — strip transient flags and write.
        await updateConversation(conversationId, {
          messages: persisted,
          updatedAt: now,
        });
      }
      await refreshConversations();
      setPersistenceError(null);
    } catch (error) {
      console.error('[useConversations] Failed to save conversation:', error);
      setPersistenceError('Failed to save conversation');
    }
  }, [refreshConversations]);

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
        setCurrentConversationIdBoth(undefined);
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
    // Exposed so ChatPage can adopt a send-time-created conversation id as
    // both the owning id (for the in-flight stream) and the active id.
    setCurrentConversationId: setCurrentConversationIdBoth,
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
