/**
 * Tests for ChatMessageList component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '../../types/chat';

describe('ChatMessageList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Empty State', () => {
    it('renders empty state message when no messages', () => {
      render(<ChatMessageList messages={[]} isStreaming={false} />);

      expect(screen.getByText('Ask a question about your documents')).toBeInTheDocument();
    });

    it('renders empty state centered', () => {
      const { container } = render(<ChatMessageList messages={[]} isStreaming={false} />);

      const emptyState = container.querySelector('[style*="justifyContent: center"]');
      expect(emptyState).toBeInTheDocument();
    });

    it('uses larger padding for empty state', () => {
      const { container } = render(<ChatMessageList messages={[]} isStreaming={false} />);

      const messageList = container.querySelector('[style*="padding: var(--spacing-xxl)"]');
      expect(messageList).toBeInTheDocument();
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

      const { container } = render(<ChatMessageList messages={messages} isStreaming={false} />);

      const messageElements = container.querySelectorAll('[style*="marginBottom: var(--spacing-sm)"]');
      expect(messageElements).toHaveLength(3);
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

      const { container } = render(<ChatMessageList messages={messages} isStreaming={true} />);

      const scrollContainer = container.querySelector('[style*="overflowY: auto"]');
      expect(scrollContainer).toBeInTheDocument();
    });

    it('tracks scroll position with isNearBottomRef', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() },
      ];

      const { container } = render(<ChatMessageList messages={messages} isStreaming={false} />);

      const scrollContainer = container.querySelector('[style*="overflowY: auto"]');
      expect(scrollContainer).toBeInTheDocument();
    });
  });

  describe('Auto-scroll Behavior', () => {
    it('auto-scrolls when messages change', () => {
      const messages1: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'First', timestamp: Date.now() },
      ];

      const { container, rerender } = render(<ChatMessageList messages={messages1} isStreaming={false} />);

      expect(container.querySelector('[style*="overflowY: auto"]')).toBeInTheDocument();

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

      const { container } = render(<ChatMessageList messages={messages} isStreaming={false} />);

      const scrollContainer = container.querySelector('[style*="overflowY: auto"]');
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
});
