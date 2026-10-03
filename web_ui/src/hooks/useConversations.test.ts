/**
 * Tests for useConversations hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { CONVERSATION_SEARCH_DEBOUNCE_MS, useConversations } from './useConversations';
import type { ChatMessage } from '../types/chat';

// Mock the conversations database module
vi.mock('../db/conversations', () => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
  countConversations: vi.fn(),
  searchConversations: vi.fn(),
}));

import * as conversationsDb from '../db/conversations';

const mockListConversations = conversationsDb.listConversations as ReturnType<typeof vi.fn>;
const mockGetConversation = conversationsDb.getConversation as ReturnType<typeof vi.fn>;
const mockCreateConversation = conversationsDb.createConversation as ReturnType<typeof vi.fn>;
const mockUpdateConversation = conversationsDb.updateConversation as ReturnType<typeof vi.fn>;
const mockDeleteConversation = conversationsDb.deleteConversation as ReturnType<typeof vi.fn>;
const mockCountConversations = conversationsDb.countConversations as ReturnType<typeof vi.fn>;
const mockSearchConversations = conversationsDb.searchConversations as ReturnType<typeof vi.fn>;

// Helper to create mock conversation
const createMockConversation = (overrides: Partial<{
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}> = {}) => ({
  id: 'conv-1',
  title: 'Test Conversation',
  messages: [] as ChatMessage[],
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now(),
  mode: 'server' as const,
  modelUsed: 'test-model',
  ...overrides,
});

describe('useConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockListConversations.mockResolvedValue([]);
    mockGetConversation.mockResolvedValue(undefined);
    mockCreateConversation.mockResolvedValue(undefined);
    mockUpdateConversation.mockResolvedValue(undefined);
    mockDeleteConversation.mockResolvedValue(undefined);
    mockCountConversations.mockResolvedValue(0);
    mockSearchConversations.mockResolvedValue({ matches: [], truncated: false });
  });

  afterEach(() => {
    // Clean up any pending timers or state
  });

  describe('Initial Load', () => {
    it('calls listConversations on mount', async () => {
      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(mockListConversations).toHaveBeenCalled();
      });
    });

    it('populates conversations list from listConversations', async () => {
      const mockConvs = [
        createMockConversation({ id: 'conv-1', title: 'First', updatedAt: Date.now() - 1000 }),
        createMockConversation({ id: 'conv-2', title: 'Second', updatedAt: Date.now() - 2000 }),
      ];

      // Hook calls listConversations twice on mount:
      // 1. refreshConversations -> listConversations(0, 50)
      // 2. listConversations(0, 1) for restoring last conversation
      mockListConversations
        .mockResolvedValueOnce(mockConvs)  // first call for refreshConversations
        .mockResolvedValueOnce(mockConvs); // second call for getting last conversation
      mockCountConversations.mockResolvedValueOnce(2);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(2);
      });

      expect(result.current.conversations[0].title).toBe('First');
      expect(result.current.conversations[1].title).toBe('Second');
    });

    it('sets hasMore based on count when more conversations exist', async () => {
      const mockConvs = [createMockConversation({ id: 'conv-1' })];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)
        .mockResolvedValueOnce(mockConvs);
      mockCountConversations.mockResolvedValueOnce(50); // More than page size of 50

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.hasMore).toBe(true);
      });
    });

    it('sets hasMore to false when all conversations loaded', async () => {
      const mockConvs = [createMockConversation({ id: 'conv-1' })];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)
        .mockResolvedValueOnce(mockConvs);
      mockCountConversations.mockResolvedValueOnce(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.hasMore).toBe(false);
      });
    });

    it('restores last conversation on initial load', async () => {
      const mockConvs = [
        createMockConversation({
          id: 'conv-1',
          messages: [{ id: 'msg-1', role: 'user' as const, content: 'Hello', timestamp: Date.now() }]
        }),
      ];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)  // refreshConversations
        .mockResolvedValueOnce(mockConvs); // get last conversation
      mockCountConversations.mockResolvedValueOnce(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.currentConversationId).toBe('conv-1');
      });
    });
  });

  describe('Pagination', () => {
    it('loadMore fetches next page', async () => {
      const initialConvs = [createMockConversation({ id: 'conv-1' })];
      const moreConvs = [createMockConversation({ id: 'conv-2' })];

      mockListConversations
        .mockResolvedValueOnce(initialConvs) // initial refreshConversations
        .mockResolvedValueOnce(initialConvs)  // get last conversation
        .mockResolvedValueOnce(moreConvs);    // loadMore
      mockCountConversations.mockResolvedValue(2);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      await act(async () => {
        await result.current.loadMore();
      });

      expect(mockListConversations).toHaveBeenCalledWith(1, 50); // offset 1, pageSize 50
    });

    it('loadMore appends to existing list', async () => {
      const initialConvs = [createMockConversation({ id: 'conv-1', title: 'First' })];
      const moreConvs = [createMockConversation({ id: 'conv-2', title: 'Second' })];

      mockListConversations
        .mockResolvedValueOnce(initialConvs)
        .mockResolvedValueOnce(initialConvs)
        .mockResolvedValueOnce(moreConvs);
      mockCountConversations.mockResolvedValue(2);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.conversations.length).toBe(2);
      expect(result.current.conversations[0].title).toBe('First');
      expect(result.current.conversations[1].title).toBe('Second');
    });

    it('sets isLoadingMore during loadMore fetch', async () => {
      const initialConvs = [createMockConversation({ id: 'conv-1' })];
      let resolveLoadMore: () => void;
      const loadMorePromise = new Promise<void>((resolve) => { resolveLoadMore = resolve; });

      mockListConversations
        .mockResolvedValueOnce(initialConvs)
        .mockResolvedValueOnce(initialConvs)
        .mockImplementation(() => loadMorePromise);
      mockCountConversations.mockResolvedValue(2);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      act(() => {
        result.current.loadMore();
      });

      expect(result.current.isLoadingMore).toBe(true);

      await act(async () => {
        resolveLoadMore!();
      });

      expect(result.current.isLoadingMore).toBe(false);
    });

    it('sets hasMore to false when no more items returned', async () => {
      const initialConvs = [createMockConversation({ id: 'conv-1' })];
      mockListConversations
        .mockResolvedValueOnce(initialConvs)
        .mockResolvedValueOnce(initialConvs)
        .mockResolvedValueOnce([]);
      mockCountConversations.mockResolvedValue(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.hasMore).toBe(false);
    });
  });

  describe('CRUD Operations', () => {
    it('selectConversation loads messages for given id', async () => {
      const mockConv = createMockConversation({
        id: 'conv-1',
        messages: [{ id: 'msg-1', role: 'user' as const, content: 'Hello', timestamp: Date.now() }]
      });
      mockGetConversation.mockResolvedValueOnce(mockConv);

      const { result } = renderHook(() => useConversations());

      await act(async () => {
        await result.current.selectConversation('conv-1');
      });

      expect(result.current.currentConversationId).toBe('conv-1');
      expect(result.current.currentMessages).toHaveLength(1);
    });

    it('newChat clears current state', async () => {
      const mockConvs = [createMockConversation({ id: 'conv-1' })];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)
        .mockResolvedValueOnce(mockConvs);
      mockGetConversation.mockResolvedValueOnce(mockConvs[0]);
      mockCountConversations.mockResolvedValueOnce(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.currentConversationId).toBeTruthy();
      });

      await act(async () => {
        result.current.newChat();
      });

      expect(result.current.currentConversationId).toBeUndefined();
      expect(result.current.currentMessages).toEqual([]);
    });

    it('renameConversation updates title via updateConversation', async () => {
      const mockConvs = [createMockConversation({ id: 'conv-1', title: 'Old Title' })];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)
        .mockResolvedValueOnce(mockConvs);
      mockCountConversations.mockResolvedValueOnce(1);

      // Mock refreshConversations after rename
      mockListConversations.mockResolvedValueOnce([
        createMockConversation({ id: 'conv-1', title: 'New Title' })
      ]);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      await act(async () => {
        await result.current.renameConversation('conv-1', 'New Title');
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', expect.objectContaining({
        title: 'New Title',
      }));
    });

    it('removeConversation removes conversation from list', async () => {
      const mockConvs = [
        createMockConversation({ id: 'conv-1', title: 'To Delete' }),
        createMockConversation({ id: 'conv-2', title: 'To Keep' }),
      ];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)
        .mockResolvedValueOnce(mockConvs);
      mockCountConversations.mockResolvedValueOnce(2);

      // After delete, refresh returns only conv-2
      mockListConversations.mockResolvedValueOnce([
        createMockConversation({ id: 'conv-2', title: 'To Keep' })
      ]);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(2);
      });

      await act(async () => {
        await result.current.removeConversation('conv-1');
      });

      expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
      expect(result.current.conversations.length).toBe(1);
      expect(result.current.conversations[0].id).toBe('conv-2');
    });

    it('removeConversation clears current state if deleted conversation was selected', async () => {
      const mockConv = createMockConversation({ id: 'conv-1' });
      mockListConversations
        .mockResolvedValueOnce([mockConv])
        .mockResolvedValueOnce([mockConv]);
      mockGetConversation.mockResolvedValue(mockConv);
      mockCountConversations.mockResolvedValue(1);

      // After delete, refresh returns empty
      mockListConversations.mockResolvedValue([]);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.currentConversationId).toBe('conv-1');
      });

      await act(async () => {
        await result.current.removeConversation('conv-1');
      });

      expect(result.current.currentConversationId).toBeUndefined();
      expect(result.current.currentMessages).toEqual([]);
    });
  });

  describe('Error Handling', () => {
    it('listConversations failure sets persistenceError', async () => {
      mockListConversations.mockRejectedValueOnce(new Error('Database error'));

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.persistenceError).toBeTruthy();
      });

      expect(result.current.persistenceError).toBe('Failed to load conversations');
    });

    it('deleteConversation failure sets persistenceError', async () => {
      const mockConvs = [createMockConversation({ id: 'conv-1' })];
      mockListConversations.mockResolvedValue(mockConvs);
      mockCountConversations.mockResolvedValue(1);
      mockDeleteConversation.mockRejectedValueOnce(new Error('Delete failed'));

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      await act(async () => {
        await result.current.removeConversation('conv-1');
      });

      expect(result.current.persistenceError).toBe('Failed to delete conversation');
    });

    it('clearPersistenceError clears the error', async () => {
      mockListConversations.mockRejectedValueOnce(new Error('Database error'));

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.persistenceError).toBeTruthy();
      });

      await act(() => {
        result.current.clearPersistenceError();
      });

      expect(result.current.persistenceError).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('handles empty conversation list', async () => {
      mockListConversations.mockResolvedValue([]);
      mockCountConversations.mockResolvedValue(0);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(mockListConversations).toHaveBeenCalled();
      });

      expect(result.current.conversations).toEqual([]);
      expect(result.current.hasMore).toBe(false);
    });

    it('handles single conversation', async () => {
      const mockConvs = [createMockConversation({ id: 'conv-1' })];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)
        .mockResolvedValueOnce(mockConvs);
      mockCountConversations.mockResolvedValue(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      expect(result.current.conversations[0].id).toBe('conv-1');
    });

    it('converts updatedAt to ISO string format', async () => {
      const timestamp = Date.now();
      const mockConvs = [createMockConversation({ id: 'conv-1', updatedAt: timestamp })];
      mockListConversations
        .mockResolvedValueOnce(mockConvs)
        .mockResolvedValueOnce(mockConvs);
      mockCountConversations.mockResolvedValue(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.conversations.length).toBe(1);
      });

      // The updatedAt should be an ISO string
      expect(result.current.conversations[0].updatedAt).toBe(new Date(timestamp).toISOString());
    });
  });

  describe('saveMessages', () => {
    it('returns early when messages array is empty', async () => {
      const { result } = renderHook(() => useConversations());

      await act(async () => {
        await result.current.saveMessages('conv-1', [], 'server', 'test-model');
      });

      expect(mockCreateConversation).not.toHaveBeenCalled();
      expect(mockUpdateConversation).not.toHaveBeenCalled();
    });

    it('creates a new conversation when none is selected', async () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello world', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
      ];

      // Mock refreshConversations (called after save)
      mockListConversations.mockResolvedValue([]);

      const { result } = renderHook(() => useConversations());

      await act(async () => {
        await result.current.saveMessages(undefined, messages, 'server', 'gpt-4');
      });

      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Hello world',
          messages,
          mode: 'server',
          modelUsed: 'gpt-4',
        })
      );
      expect(result.current.currentConversationId).toBeTruthy();
    });

    it('updates existing conversation when one is selected', async () => {
      const existingConv = createMockConversation({
        id: 'existing-conv',
        title: 'Existing',
        messages: [{ id: 'msg-1', role: 'user', content: 'Old message', timestamp: Date.now() }],
      });

      mockListConversations
        .mockResolvedValueOnce([existingConv])
        .mockResolvedValueOnce([existingConv]);
      mockGetConversation.mockResolvedValueOnce(existingConv);
      mockCountConversations.mockResolvedValueOnce(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.currentConversationId).toBe('existing-conv');
      });

      const newMessages: ChatMessage[] = [
        { id: 'msg-2', role: 'user', content: 'New message', timestamp: Date.now() },
      ];

      // Mock refresh after update
      mockListConversations.mockResolvedValue([existingConv]);

      await act(async () => {
        await result.current.saveMessages('existing-conv', newMessages, 'wllama', 'llama2');
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith(
        'existing-conv',
        expect.objectContaining({
          messages: newMessages,
        })
      );
      expect(mockCreateConversation).not.toHaveBeenCalled();
    });

    it('truncates long first user message for title', async () => {
      // 55-char string: 50 chars of 'A' followed by 'BCDE' and 'XXXXX' for clear truncation point
      // "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" = 50 A's
      // "BCDEXXXXX" = 9 chars, total = 59 chars
      const longMessage = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBB';
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: longMessage, timestamp: Date.now() },
      ];

      mockListConversations.mockResolvedValue([]);

      const { result } = renderHook(() => useConversations());

      await act(async () => {
        await result.current.saveMessages(undefined, messages, 'server', 'test-model');
      });

      // Title should be first 50 chars + '...'
      // First 50 chars are all 'A', so title = 50*A + '...'
      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA...',
        })
      );
    });

    it('uses fallback title when no user message', async () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'assistant', content: 'Hello, I am an assistant', timestamp: Date.now() },
      ];

      mockListConversations.mockResolvedValue([]);

      const { result } = renderHook(() => useConversations());

      await act(async () => {
        await result.current.saveMessages(undefined, messages, 'server', 'test-model');
      });

      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New conversation',
        })
      );
    });

    it('sets persistenceError when save fails', async () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
      ];

      // Create a mock that throws synchronously when called
      mockCreateConversation.mockImplementation(() => {
        throw new Error('Database error');
      });

      const { result } = renderHook(() => useConversations());

      // Call saveMessages - it should throw and be caught
      act(() => {
        result.current.saveMessages(undefined, messages, 'server', 'test-model');
      });

      // The error should be caught and persistenceError should be set
      expect(mockCreateConversation).toHaveBeenCalled();
      expect(result.current.persistenceError).toBe('Failed to save conversation');
    });

    it('strips isStreaming before persisting (S3 regression)', async () => {
      // The transient render-only isStreaming flag must NEVER be written to
      // IndexedDB — it would leave a permanent blinking cursor after reload.
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Hi!', timestamp: Date.now(), isStreaming: true },
      ];

      mockListConversations.mockResolvedValue([]);

      const { result } = renderHook(() => useConversations());

      await act(async () => {
        await result.current.saveMessages(undefined, messages, 'server', 'gpt-4');
      });

      expect(mockCreateConversation).toHaveBeenCalledTimes(1);
      const persisted = mockCreateConversation.mock.calls[0][0];
      // No persisted message may carry isStreaming.
      expect(persisted.messages.every((m: ChatMessage) => m.isStreaming === undefined)).toBe(true);
      // And the streaming assistant content is still preserved.
      expect(persisted.messages).toHaveLength(2);
      expect(persisted.messages[1].content).toBe('Hi!');
    });

    it('strips isStreaming when updating an existing conversation (S3 regression)', async () => {
      const existingConv = createMockConversation({
        id: 'existing-conv',
        title: 'Existing',
        messages: [{ id: 'msg-1', role: 'user', content: 'Old', timestamp: Date.now() }],
      });

      mockListConversations
        .mockResolvedValueOnce([existingConv])
        .mockResolvedValueOnce([existingConv]);
      mockGetConversation.mockResolvedValueOnce(existingConv);
      mockCountConversations.mockResolvedValueOnce(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.currentConversationId).toBe('existing-conv');
      });

      const newMessages: ChatMessage[] = [
        { id: 'msg-2', role: 'assistant', content: 'Streaming reply', timestamp: Date.now(), isStreaming: true },
      ];

      mockListConversations.mockResolvedValue([existingConv]);

      await act(async () => {
        await result.current.saveMessages('existing-conv', newMessages, 'server', 'gpt-4');
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith(
        'existing-conv',
        expect.objectContaining({
          messages: expect.any(Array),
        })
      );
      const persisted = mockUpdateConversation.mock.calls[0][1].messages;
      expect(persisted.every((m: ChatMessage) => m.isStreaming === undefined)).toBe(true);
    });

    it('passes the new conversation id to onCreate when creating', async () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
      ];

      mockListConversations.mockResolvedValue([]);

      const { result } = renderHook(() => useConversations());

      const onCreate = vi.fn();
      await act(async () => {
        await result.current.saveMessages(undefined, messages, 'server', 'gpt-4', onCreate);
      });

      expect(mockCreateConversation).toHaveBeenCalledTimes(1);
      const newId = mockCreateConversation.mock.calls[0][0].id;
      expect(onCreate).toHaveBeenCalledTimes(1);
      expect(onCreate).toHaveBeenCalledWith(newId);
    });

    it('does not call onCreate when updating an existing conversation', async () => {
      const existingConv = createMockConversation({
        id: 'existing-conv',
        title: 'Existing',
        messages: [{ id: 'msg-1', role: 'user', content: 'Old', timestamp: Date.now() }],
      });

      mockListConversations
        .mockResolvedValueOnce([existingConv])
        .mockResolvedValueOnce([existingConv]);
      mockGetConversation.mockResolvedValueOnce(existingConv);
      mockCountConversations.mockResolvedValueOnce(1);

      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(result.current.currentConversationId).toBe('existing-conv');
      });

      const newMessages: ChatMessage[] = [
        { id: 'msg-2', role: 'user', content: 'Follow up', timestamp: Date.now() },
      ];
      mockListConversations.mockResolvedValue([existingConv]);

      const onCreate = vi.fn();
      await act(async () => {
        await result.current.saveMessages('existing-conv', newMessages, 'server', 'gpt-4', onCreate);
      });

      expect(onCreate).not.toHaveBeenCalled();
      expect(mockUpdateConversation).toHaveBeenCalled();
    });
  });

  describe('setCurrentConversationId', () => {
    it('exposes setCurrentConversationId as a function', async () => {
      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(mockListConversations).toHaveBeenCalled();
      });

      expect(typeof result.current.setCurrentConversationId).toBe('function');
    });

    it('sets the current conversation id (string | undefined)', async () => {
      const { result } = renderHook(() => useConversations());

      await waitFor(() => {
        expect(mockListConversations).toHaveBeenCalled();
      });

      await act(async () => {
        result.current.setCurrentConversationId('conv-42');
      });
      expect(result.current.currentConversationId).toBe('conv-42');

      await act(async () => {
        result.current.setCurrentConversationId(undefined);
      });
      expect(result.current.currentConversationId).toBeUndefined();
    });
  });

  describe('Search (Lumen phase 3: all conversations, debounced)', () => {
    const page = Array.from({ length: 50 }, (_, i) =>
      createMockConversation({ id: `conv-${i}`, title: `Recent ${i}`, updatedAt: 10_000 - i })
    );
    const old = createMockConversation({ id: 'conv-110', title: 'Quarterly budget review', updatedAt: 1 });

    async function mountWithPage() {
      mockListConversations.mockImplementation(async (offset: number, size: number) =>
        page.slice(offset, offset + size)
      );
      mockCountConversations.mockResolvedValue(120);
      const hook = renderHook(() => useConversations());
      await waitFor(() => expect(hook.result.current.conversations).toHaveLength(50));
      return hook;
    }

    it('queries the whole store, so a match beyond the loaded page is found', async () => {
      mockSearchConversations.mockResolvedValue({ matches: [old], truncated: false });
      const { result } = await mountWithPage();
      expect(result.current.conversations.some((c) => c.id === 'conv-110')).toBe(false);
      expect(result.current.searchResults).toBeNull();

      act(() => result.current.setSearchQuery('budget'));
      await waitFor(() => expect(result.current.searchResults).not.toBeNull());
      expect(mockSearchConversations).toHaveBeenCalledWith('budget', expect.objectContaining({ isCancelled: expect.any(Function) }));
      expect(result.current.searchResults?.map((c) => c.id)).toEqual(['conv-110']);
      // The paginated list is untouched: no client-side filtering of the loaded page.
      expect(result.current.conversations).toHaveLength(50);
    });

    it('is debounced: rapid typing issues one query, for the final text', async () => {
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('b'));
      act(() => result.current.setSearchQuery('bu'));
      act(() => result.current.setSearchQuery('bud'));
      expect(mockSearchConversations).not.toHaveBeenCalled();
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, CONVERSATION_SEARCH_DEBOUNCE_MS + 50));
      expect(mockSearchConversations).toHaveBeenCalledTimes(1);
      expect(mockSearchConversations).toHaveBeenCalledWith('bud', expect.objectContaining({ isCancelled: expect.any(Function) }));
    });

    it('no match yields an empty result list (the "No conversations match" state)', async () => {
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('zzz'));
      await waitFor(() => expect(result.current.searchResults).toEqual([]));
      expect(result.current.isSearching).toBe(false);
    });

    it('clearing the query drops the results immediately and stops searching', async () => {
      mockSearchConversations.mockResolvedValue({ matches: [old], truncated: true });
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('budget'));
      await waitFor(() => expect(result.current.searchResults).toHaveLength(1));
      expect(result.current.searchTruncated).toBe(true);
      act(() => result.current.setSearchQuery(''));
      expect(result.current.searchResults).toBeNull();
      expect(result.current.searchTruncated).toBe(false);
      await new Promise((r) => setTimeout(r, CONVERSATION_SEARCH_DEBOUNCE_MS + 50));
      expect(mockSearchConversations).toHaveBeenCalledTimes(1);
    });

    it('a slower, older query never overwrites a newer one', async () => {
      let resolveOld: (v: unknown) => void = () => {};
      mockSearchConversations
        .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
        .mockResolvedValueOnce({ matches: [page[3]], truncated: false });
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('first'));
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(1));
      act(() => result.current.setSearchQuery('second'));
      await waitFor(() => expect(result.current.searchResults?.map((c) => c.id)).toEqual(['conv-3']));
      await act(async () => resolveOld({ matches: [old], truncated: false }));
      expect(result.current.searchResults?.map((c) => c.id)).toEqual(['conv-3']);
    });

    it('a superseded search is told to stop: its isCancelled() flips once a newer query starts', async () => {
      const tokens: Array<() => boolean> = [];
      mockSearchConversations.mockImplementation(
        (_q: string, opts?: { isCancelled?: () => boolean }) => {
          if (opts?.isCancelled) tokens.push(opts.isCancelled);
          return new Promise(() => {}); // never settles: the walk is "still running"
        }
      );
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('first'));
      await waitFor(() => expect(tokens).toHaveLength(1));
      expect(tokens[0]()).toBe(false);
      act(() => result.current.setSearchQuery('second'));
      await waitFor(() => expect(tokens).toHaveLength(2));
      expect(tokens[0]()).toBe(true); // the stale walk stops
      expect(tokens[1]()).toBe(false);
      act(() => result.current.setSearchQuery(''));
      expect(tokens[1]()).toBe(true); // clearing cancels the in-flight walk too
    });

    it('isSearching is true from the first keystroke (results are stale) until the query settles', async () => {
      let settle: (v: unknown) => void = () => {};
      mockSearchConversations.mockImplementation(() => new Promise((r) => { settle = r; }));
      const { result } = await mountWithPage();
      expect(result.current.isSearching).toBe(false);
      act(() => result.current.setSearchQuery('bud'));
      expect(result.current.isSearching).toBe(true); // before the debounce fires
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(1));
      expect(result.current.isSearching).toBe(true);
      await act(async () => settle({ matches: [], truncated: false }));
      expect(result.current.isSearching).toBe(false);
    });

    it('desktop (Electron) path: same renderer store query, no backend call', async () => {
      // Chat history lives in the renderer's IndexedDB in the desktop app too;
      // the desktop backend has no conversation API. Search must not reach for one.
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      (window as unknown as { desktopApi?: unknown }).desktopApi = {};
      try {
        mockSearchConversations.mockResolvedValue({ matches: [old], truncated: false });
        const { result } = await mountWithPage();
        act(() => result.current.setSearchQuery('budget'));
        await waitFor(() => expect(result.current.searchResults?.map((c) => c.id)).toEqual(['conv-110']));
        expect(mockSearchConversations).toHaveBeenCalledWith('budget', expect.objectContaining({ isCancelled: expect.any(Function) }));
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        delete (window as unknown as { desktopApi?: unknown }).desktopApi;
        fetchSpy.mockRestore();
      }
    });

    it('a rename re-runs an active search and the NEW title appears in the results (PRR-017)', async () => {
      // A tiny live "store" the search mock reads, so the rename really changes what it finds.
      const live = new Map([[old.id, { ...old }]]);
      mockSearchConversations.mockImplementation(async (q: string) => ({
        matches: [...live.values()].filter((c) => c.title.toLowerCase().includes(q.toLowerCase())),
        truncated: false,
      }));
      mockUpdateConversation.mockImplementation(async (id: string, changes: { title?: string }) => {
        const row = live.get(id);
        if (row && changes.title) live.set(id, { ...row, title: changes.title });
      });
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('budget'));
      await waitFor(() => expect(result.current.searchResults?.map((c) => c.title)).toEqual(['Quarterly budget review']));
      await act(async () => {
        await result.current.renameConversation('conv-110', 'Budget v2 (final)');
      });
      await waitFor(() => expect(result.current.searchResults?.map((c) => c.title)).toEqual(['Budget v2 (final)']));
      expect(result.current.isSearching).toBe(false);
    });

    it('a mutation during an in-flight walk does not restart it; the walk is re-run once when it finishes (PRR-011)', async () => {
      const pending: Array<(v: unknown) => void> = [];
      mockSearchConversations.mockImplementation(() => new Promise((r) => { pending.push(r); }));
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('budget'));
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(1));
      await act(async () => {
        await result.current.renameConversation('conv-1', 'Renamed');
      });
      // The identical in-flight walk was neither cancelled nor restarted.
      expect(mockSearchConversations).toHaveBeenCalledTimes(1);
      const token = mockSearchConversations.mock.calls[0][1] as { isCancelled: () => boolean };
      expect(token.isCancelled()).toBe(false);
      await act(async () => pending[0]({ matches: [old], truncated: false }));
      // ...and re-run exactly once afterwards, so results reflect the rename.
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(2));
      expect(result.current.isSearching).toBe(true);
      await act(async () => pending[1]({ matches: [], truncated: false }));
      expect(result.current.searchResults).toEqual([]);
      expect(result.current.isSearching).toBe(false);
    });

    it('a mutation while the debounce is pending runs the search now and clears the timer (no second run) (PRR-011)', async () => {
      mockSearchConversations.mockResolvedValue({ matches: [old], truncated: false });
      const { result } = await mountWithPage();
      act(() => result.current.setSearchQuery('budget'));
      expect(mockSearchConversations).not.toHaveBeenCalled(); // still debouncing
      await act(async () => {
        await result.current.renameConversation('conv-1', 'Renamed');
      });
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, CONVERSATION_SEARCH_DEBOUNCE_MS + 80));
      expect(mockSearchConversations).toHaveBeenCalledTimes(1);
      expect(result.current.searchResults?.map((c) => c.id)).toEqual(['conv-110']);
    });
  });

  describe('Busy cue does not flicker off between queries (review appendix, rejected-candidate 7 side note)', () => {
    it('a walk finishing while a newer query is still debouncing leaves isSearching on', async () => {
      const pending: Array<(v: unknown) => void> = [];
      mockSearchConversations.mockImplementation(() => new Promise((r) => { pending.push(r); }));
      mockListConversations.mockResolvedValue([]);
      const { result } = renderHook(() => useConversations());
      await waitFor(() => expect(mockListConversations).toHaveBeenCalled());
      act(() => result.current.setSearchQuery('bud'));
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(1));
      act(() => result.current.setSearchQuery('budget')); // debounce pending, walk 1 still reading
      await act(async () => pending[0]({ matches: [], truncated: false }));
      expect(result.current.isSearching).toBe(true);
      await waitFor(() => expect(mockSearchConversations).toHaveBeenCalledTimes(2));
      await act(async () => pending[1]({ matches: [], truncated: false }));
      expect(result.current.isSearching).toBe(false);
    });
  });

  describe('hasMore after a de-duplicated "Load more" (round 4 LOW-3)', () => {
    it('counts only the rows actually added', async () => {
      const first = Array.from({ length: 50 }, (_, i) => createMockConversation({ id: `conv-${i}`, updatedAt: 10_000 - i }));
      // Page 2 overlaps the loaded page by 10 ids: only 40 rows are new, so 90 of 100 are loaded.
      const second = Array.from({ length: 50 }, (_, i) => createMockConversation({ id: `conv-${40 + i}`, updatedAt: 9_000 - i }));
      mockCountConversations.mockResolvedValue(100);
      mockListConversations.mockImplementation(async (offset: number) => (offset === 0 ? first : second));
      const { result } = renderHook(() => useConversations());
      await waitFor(() => expect(result.current.conversations).toHaveLength(50));
      await act(async () => {
        await result.current.loadMore();
      });
      expect(result.current.conversations).toHaveLength(90);
      expect(result.current.hasMore).toBe(true); // 90 < 100 (the raw count, 100, would say false)
    });
  });

  describe('Load more vs refresh race (PRR-005)', () => {
    it('a refresh during a pending "Load more" discards the stale page (no duplicates, no stale tail)', async () => {
      const first = Array.from({ length: 50 }, (_, i) =>
        createMockConversation({ id: `conv-${i}`, title: `Recent ${i}`, updatedAt: 10_000 - i })
      );
      const second = Array.from({ length: 50 }, (_, i) =>
        createMockConversation({ id: `conv-${50 + i}`, title: `Older ${i}`, updatedAt: 5_000 - i })
      );
      let resolveMore: (v: unknown) => void = () => {};
      let refreshedFirst = first;
      mockCountConversations.mockResolvedValue(120);
      mockListConversations.mockImplementation((offset: number) => {
        if (offset === 0) return Promise.resolve(refreshedFirst);
        return new Promise((r) => { resolveMore = r; });
      });
      const { result } = renderHook(() => useConversations());
      await waitFor(() => expect(result.current.conversations).toHaveLength(50));

      let loading: Promise<void> = Promise.resolve();
      act(() => { loading = result.current.loadMore(); });
      // While page 2 loads, a rename moves conv-60 (a page-2 row) to the top.
      refreshedFirst = [createMockConversation({ id: 'conv-60', title: 'Renamed', updatedAt: 20_000 }), ...first.slice(0, 49)];
      await act(async () => {
        await result.current.renameConversation('conv-60', 'Renamed');
      });
      await act(async () => {
        resolveMore(second);
        await loading;
      });
      const ids = result.current.conversations.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicate conv-60
      expect(ids).toEqual(refreshedFirst.map((c) => c.id)); // stale tail dropped
    });
  });
});
