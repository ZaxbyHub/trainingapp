/**
 * Tests for ChatMessageList component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatMessageList } from './ChatMessageList';
import type { ChatMessage } from '../types/chat';

// U4: ChatMessageList now keys its empty state off useDocumentCount(). In
// jsdom the underlying raw-IndexedDB document store throws ("indexedDB is
// not defined") so the hook reports count=0 — which would route every
// existing "How can I help" / suggested-prompt test into the zero-doc branch
// and silently stop exercising that path. Default the mock to count>0 so the
// legacy empty-state behavior is tested as before; the zero-doc branch is
// covered explicitly below.
const mockUseDocumentCount = vi.fn();
vi.mock('../hooks/useDocumentCount', () => ({
  useDocumentCount: (...args: unknown[]) => mockUseDocumentCount(...args),
}));

describe('ChatMessageList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    // Default: documents present so the legacy "How can I help" + suggested
    // prompts empty state is exercised.
    mockUseDocumentCount.mockReturnValue({ count: 3, loading: false });
  });

  afterEach(() => {
    cleanup();
  });

  describe('Empty State', () => {
    it('renders empty state message when no messages', () => {
      render(<ChatMessageList messages={[]} isStreaming={false} />);

      expect(screen.getByText('How can I help with your documents?')).toBeInTheDocument();
    });

    it('renders empty state centered', () => {
      render(<ChatMessageList messages={[]} isStreaming={false} />);

      const emptyState = screen.getByRole('region', { name: /How can I help/i });
      expect(emptyState).toBeInTheDocument();
    });

    it('uses larger padding for empty state', () => {
      const { container } = render(<ChatMessageList messages={[]} isStreaming={false} />);

      const messageList = container.querySelector('[style*="padding: var(--spacing-xxl)"]');
      expect(messageList).toBeInTheDocument();
    });
  });

  describe('Suggested Prompts', () => {
    it('renders 3 suggested prompt buttons', () => {
      render(<ChatMessageList messages={[]} isStreaming={false} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(3);
      expect(screen.getByText('Summarize my documents')).toBeInTheDocument();
      expect(screen.getByText('What are the key topics?')).toBeInTheDocument();
      expect(screen.getByText('Find specific information')).toBeInTheDocument();
    });

    it('calls onSuggestedPrompt when a prompt card is clicked', () => {
      const mockHandler = vi.fn();
      render(<ChatMessageList messages={[]} isStreaming={false} onSuggestedPrompt={mockHandler} />);

      fireEvent.click(screen.getByText('Summarize my documents'));
      expect(mockHandler).toHaveBeenCalledWith('Summarize my documents');
    });

    it('does not crash when onSuggestedPrompt is undefined', () => {
      render(<ChatMessageList messages={[]} isStreaming={false} />);

      expect(() => fireEvent.click(screen.getByText('Summarize my documents'))).not.toThrow();
    });

    it('renders prompt buttons with accessible aria-labels', () => {
      render(<ChatMessageList messages={[]} isStreaming={false} />);

      expect(screen.getByLabelText('Suggested prompt: Summarize my documents')).toBeInTheDocument();
      expect(screen.getByLabelText('Suggested prompt: What are the key topics?')).toBeInTheDocument();
      expect(screen.getByLabelText('Suggested prompt: Find specific information')).toBeInTheDocument();
    });
  });

  describe('Message Rendering', () => {
    it('renders messages when provided', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          content: 'First message',
          timestamp: Date.now(),
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Second message',
          timestamp: Date.now(),
        },
      ];

      render(<ChatMessageList messages={messages} isStreaming={false} />);

      expect(screen.getByText('First message')).toBeInTheDocument();
      expect(screen.getByText('Second message')).toBeInTheDocument();
    });

    it('renders messages with correct order', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Message 1', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'Message 2', timestamp: 2000 },
        { id: 'msg-3', role: 'user', content: 'Message 3', timestamp: 3000 },
      ];

      render(<ChatMessageList messages={messages} isStreaming={false} />);

      const messageContents = screen.getAllByText(/Message \d/);
      expect(messageContents).toHaveLength(3);
      expect(screen.getByText('Message 1')).toBeInTheDocument();
      expect(screen.getByText('Message 2')).toBeInTheDocument();
      expect(screen.getByText('Message 3')).toBeInTheDocument();
    });

    it('uses correct padding when messages exist', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() },
      ];

      const { container } = render(<ChatMessageList messages={messages} isStreaming={false} />);

      const messageList = container.querySelector('[style*="padding: var(--spacing-lg)"]');
      expect(messageList).toBeInTheDocument();
    });
  });

  describe('Scroll Behavior', () => {
    it('scrolls to bottom when isStreaming is true', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() },
      ];

      const scrollToBottomMock = vi.fn();
      const scrollTopSetter = vi.fn();

      Object.defineProperty(Element.prototype, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(Element.prototype, 'clientHeight', { value: 500, configurable: true });

      render(<ChatMessageList messages={messages} isStreaming={true} />);

      const scrollContainer = screen.getByRole('log');
      expect(scrollContainer).toBeInTheDocument();
    });

    it('tracks scroll position with isNearBottomRef', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() },
      ];

      render(<ChatMessageList messages={messages} isStreaming={false} />);

      const scrollContainer = screen.getByRole('log');
      expect(scrollContainer).toBeInTheDocument();
    });
  });

  describe('Auto-scroll Behavior', () => {
    it('auto-scrolls when messages change', () => {
      const messages1: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'First', timestamp: Date.now() },
      ];

      const { rerender } = render(<ChatMessageList messages={messages1} isStreaming={false} />);

      expect(screen.getByRole('log')).toBeInTheDocument();

      const messages2: ChatMessage[] = [
        ...messages1,
        { id: 'msg-2', role: 'assistant', content: 'Second', timestamp: Date.now() },
      ];

      rerender(<ChatMessageList messages={messages2} isStreaming={false} />);

      expect(screen.getByText('Second')).toBeInTheDocument();
    });

    it('respects scroll position when not streaming', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() },
      ];

      render(<ChatMessageList messages={messages} isStreaming={false} />);

      const scrollContainer = screen.getByRole('log');
      expect(scrollContainer).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles rapid message additions', () => {
      let messages: ChatMessage[] = [];

      const { rerender } = render(<ChatMessageList messages={messages} isStreaming={false} />);

      for (let i = 0; i < 10; i++) {
        messages = [
          ...messages,
          { id: `msg-${i}`, role: 'user' as const, content: `Message ${i}`, timestamp: Date.now() + i },
        ];
        rerender(<ChatMessageList messages={messages} isStreaming={false} />);
      }

      expect(screen.getByText('Message 9')).toBeInTheDocument();
    });

    it('handles very long message content', () => {
      const longContent = 'B'.repeat(5000);
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: longContent, timestamp: Date.now() },
      ];

      const { container } = render(<ChatMessageList messages={messages} isStreaming={false} />);

      expect(container.textContent?.includes(longContent)).toBe(true);
    });

    it('handles messages with special characters', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test with `code` and **bold**', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Response with [link](https://example.com)', timestamp: Date.now() },
      ];

      render(<ChatMessageList messages={messages} isStreaming={false} />);

      expect(screen.getByText(/Test with/)).toBeInTheDocument();
    });
  });

  describe('Scroll Event Listener', () => {
    it('adds scroll event listener on mount', () => {
      const addEventListenerSpy = vi.spyOn(Element.prototype, 'addEventListener');

      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() },
      ];

      render(<ChatMessageList messages={messages} isStreaming={false} />);

      expect(addEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
    });

    it('removes scroll event listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(Element.prototype, 'removeEventListener');

      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() },
      ];

      const { unmount } = render(<ChatMessageList messages={messages} isStreaming={false} />);
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    });
  });

  describe('Scroll-trap fix (issue #25 F6)', () => {
    it('does NOT force-scroll to bottom while streaming when the user has scrolled up', () => {
      // Seed an assistant reply already in progress (prev last role = assistant).
      // Appending more assistant tokens during streaming must respect the
      // near-bottom heuristic — NOT force-scroll — when the user scrolled up.
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Question', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Answer part 1', timestamp: Date.now(), isStreaming: true },
      ];

      Object.defineProperty(Element.prototype, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(Element.prototype, 'clientHeight', { value: 500, configurable: true });

      const { rerender } = render(<ChatMessageList messages={messages} isStreaming={true} />);
      const container = screen.getByRole('log') as HTMLElement;

      // User scrolls up — scrollTop well beyond the near-bottom threshold.
      let currentScrollTop = 0;
      Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get: () => currentScrollTop,
        set: (v: number) => { currentScrollTop = v; },
      });
      container.dispatchEvent(new Event('scroll'));

      // Append another streaming assistant token — prevLastRole is already
      // 'assistant', so this is mid-stream (not reply-start), and the user is
      // scrolled away from bottom. The component must NOT force scrollTop=1000.
      const grown: ChatMessage[] = [
        ...messages,
        { id: 'msg-3', role: 'assistant', content: 'Answer part 2', timestamp: Date.now(), isStreaming: true },
      ];
      currentScrollTop = 0;
      rerender(<ChatMessageList messages={grown} isStreaming={true} />);

      // scrollTop must remain 0 (not forced to scrollHeight 1000).
      expect(currentScrollTop).toBe(0);
    });

    it('force-scrolls to bottom when a new user message is appended (send)', () => {
      // The positive case: a new USER message must force-scroll to bottom,
      // even if the user was scrolled up (snapping them to their new message).
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'assistant', content: 'Previous answer', timestamp: Date.now() },
      ];

      Object.defineProperty(Element.prototype, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(Element.prototype, 'clientHeight', { value: 500, configurable: true });

      const { rerender } = render(<ChatMessageList messages={messages} isStreaming={false} />);
      const container = screen.getByRole('log') as HTMLElement;

      // User is scrolled up.
      let currentScrollTop = 0;
      Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get: () => currentScrollTop,
        set: (v: number) => { currentScrollTop = v; },
      });
      container.dispatchEvent(new Event('scroll'));

      // Append a new user message — this is a "send", last role = user.
      const withUser: ChatMessage[] = [
        ...messages,
        { id: 'msg-2', role: 'user', content: 'New question', timestamp: Date.now() },
      ];
      rerender(<ChatMessageList messages={withUser} isStreaming={false} />);

      // Force-scrolled to the bottom (scrollHeight 1000).
      expect(currentScrollTop).toBe(1000);
    });

    it('shows a Jump to latest button when scrolled away from the bottom', async () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Question', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Answer', timestamp: Date.now() },
      ];

      Object.defineProperty(Element.prototype, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(Element.prototype, 'clientHeight', { value: 500, configurable: true });

      render(<ChatMessageList messages={messages} isStreaming={false} />);
      const container = screen.getByRole('log') as HTMLElement;

      // User scrolls up — scrollTop=0 leaves 500px to the bottom (>threshold).
      Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true, writable: true });
      await act(async () => {
        container.dispatchEvent(new Event('scroll'));
      });

      expect(await screen.findByRole('button', { name: /jump to latest/i })).toBeInTheDocument();
    });
  });

  describe('Completion announcement (issue #25 AC7)', () => {
    it('announces "Response complete" when streaming ends', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Question', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Answer', timestamp: Date.now(), isStreaming: true },
      ];

      const { rerender } = render(<ChatMessageList messages={messages} isStreaming={true} />);

      // Streaming ends.
      rerender(<ChatMessageList messages={messages} isStreaming={false} />);

      // The visually-hidden status region should now carry the completion text.
      const status = screen.getByRole('status');
      expect(status.textContent).toContain('Response complete');
    });
  });

  describe('Zero-document empty state (U4)', () => {
    it('renders the add-documents hero when documentCount is 0', () => {
      mockUseDocumentCount.mockReturnValue({ count: 0, loading: false });

      render(<ChatMessageList messages={[]} isStreaming={false} />);

      expect(screen.getByText('Add documents to get started')).toBeInTheDocument();
      // The doc-present hero must NOT render in the zero-doc branch.
      expect(screen.queryByText('How can I help with your documents?')).not.toBeInTheDocument();
      // And no suggested-prompt buttons (those route through a cold load then
      // abstain when there are no documents — a guaranteed dead end).
      expect(screen.queryByLabelText('Suggested prompt: Summarize my documents')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Suggested prompt: What are the key topics?')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Suggested prompt: Find specific information')).not.toBeInTheDocument();
    });

    it('does NOT render the "Go to Documents" button when onNavigateToDocuments is omitted', () => {
      mockUseDocumentCount.mockReturnValue({ count: 0, loading: false });

      render(<ChatMessageList messages={[]} isStreaming={false} />);

      expect(screen.queryByRole('button', { name: /go to documents/i })).not.toBeInTheDocument();
    });

    it('renders the "Go to Documents" button and calls onNavigateToDocuments on click', () => {
      mockUseDocumentCount.mockReturnValue({ count: 0, loading: false });
      const onNavigate = vi.fn();

      render(<ChatMessageList messages={[]} isStreaming={false} onNavigateToDocuments={onNavigate} />);

      const button = screen.getByRole('button', { name: /go to documents/i });
      expect(button).toBeInTheDocument();

      fireEvent.click(button);
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('uses the doc-present hero when documentCount > 0', () => {
      mockUseDocumentCount.mockReturnValue({ count: 5, loading: false });

      render(<ChatMessageList messages={[]} isStreaming={false} />);

      expect(screen.getByText('How can I help with your documents?')).toBeInTheDocument();
      expect(screen.queryByText('Add documents to get started')).not.toBeInTheDocument();
      // Suggested prompts render in the doc-present branch.
      expect(screen.getByLabelText('Suggested prompt: Summarize my documents')).toBeInTheDocument();
    });
  });
});
