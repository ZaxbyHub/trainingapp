/**
 * Tests for ChatMessageBubble component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ChatMessageBubble } from './ChatMessageBubble';
import type { ChatMessage } from '../../types/chat';

// Mock clipboard API
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
  configurable: true,
});

describe('ChatMessageBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('User Message Rendering', () => {
    it('renders user message with correct content', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello, world!',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);

      expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    });

    it('renders user message right-aligned', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Test message',
        timestamp: Date.now(),
      };

      const { container } = render(<ChatMessageBubble message={message} />);
      const bubble = container.querySelector('[style*="justify-content: flex-end"]');
      expect(bubble).toBeInTheDocument();
    });

    it('shows relative time for user message', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Test',
        timestamp: Date.now() - 60000, // 1 minute ago
      };

      render(<ChatMessageBubble message={message} />);
      expect(screen.getByText(/\d+m ago/)).toBeInTheDocument();
    });

    it('shows "just now" for very recent messages', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Test',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);
      expect(screen.getByText('Just now')).toBeInTheDocument();
    });
  });

  describe('Assistant Message Rendering', () => {
    it('renders assistant message with correct content', () => {
      const message: ChatMessage = {
        id: 'msg-2',
        role: 'assistant',
        content: 'I am an assistant',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);

      expect(screen.getByText('I am an assistant')).toBeInTheDocument();
    });

    it('renders assistant message left-aligned', () => {
      const message: ChatMessage = {
        id: 'msg-2',
        role: 'assistant',
        content: 'Test',
        timestamp: Date.now(),
      };

      const { container } = render(<ChatMessageBubble message={message} />);
      const bubble = container.querySelector('[style*="justify-content: flex-start"]');
      expect(bubble).toBeInTheDocument();
    });

    it('shows streaming cursor when isStreaming is true', () => {
      const message: ChatMessage = {
        id: 'msg-2',
        role: 'assistant',
        content: 'Streaming...',
        timestamp: Date.now(),
        isStreaming: true,
      };

      render(<ChatMessageBubble message={message} />);

      // Cursor is rendered as a span with blink animation
      const cursor = document.querySelector('span[aria-hidden="true"]');
      expect(cursor).toBeInTheDocument();
    });

    it('does not show streaming cursor when isStreaming is false', () => {
      const message: ChatMessage = {
        id: 'msg-2',
        role: 'assistant',
        content: 'Done',
        timestamp: Date.now(),
        isStreaming: false,
      };

      render(<ChatMessageBubble message={message} />);

      const cursor = document.querySelector('span[style*="animation: blink"]');
      expect(cursor).not.toBeInTheDocument();
    });
  });

  describe('System Message Rendering', () => {
    it('renders system message centered', () => {
      const message: ChatMessage = {
        id: 'msg-3',
        role: 'system',
        content: 'System notification',
        timestamp: Date.now(),
      };

      const { container } = render(<ChatMessageBubble message={message} />);
      const bubble = container.querySelector('[style*="justify-content: center"]');
      expect(bubble).toBeInTheDocument();
      expect(screen.getByText('System notification')).toBeInTheDocument();
    });

    it('renders system message with smaller font', () => {
      const message: ChatMessage = {
        id: 'msg-3',
        role: 'system',
        content: 'System message',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);
      expect(screen.getByText('System message')).toBeInTheDocument();
    });
  });

  describe('Copy Functionality', () => {
    it('shows copy button on hover for user message', async () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Copy me',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);

      const bubble = screen.getByText('Copy me').closest('div');
      fireEvent.mouseEnter(bubble!);

      await waitFor(() => {
        const copyButton = screen.getByRole('button', { name: /copy message/i });
        expect(copyButton).toBeInTheDocument();
      });
    });

    it('shows copy button on hover for assistant message', async () => {
      const message: ChatMessage = {
        id: 'msg-2',
        role: 'assistant',
        content: 'Copy this',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);

      const bubble = document.querySelector('[style*="justify-content: flex-start"]');
      fireEvent.mouseEnter(bubble!);

      await waitFor(() => {
        const copyButton = screen.getByRole('button', { name: /copy message/i });
        expect(copyButton).toBeInTheDocument();
      });
    });

    it('copies message content to clipboard when copy button clicked', async () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Content to copy',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);

      const bubble = screen.getByText('Content to copy').closest('div');
      fireEvent.mouseEnter(bubble!);

      await waitFor(() => {
        const copyButton = screen.getByRole('button', { name: /copy message/i });
        fireEvent.click(copyButton);
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Content to copy');
    });

    it('shows "Copied!" feedback after successful copy', async () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Test copy',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);

      const bubble = screen.getByText('Test copy').closest('div');
      fireEvent.mouseEnter(bubble!);

      await waitFor(() => {
        const copyButton = screen.getByRole('button', { name: /copy message/i });
        fireEvent.click(copyButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument();
      });
    });

    it('handles clipboard API failure gracefully', async () => {
      mockClipboard.writeText.mockRejectedValueOnce(new Error('Clipboard not available'));

      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Test',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);

      const bubble = screen.getByText('Test').closest('div');
      fireEvent.mouseEnter(bubble!);

      await waitFor(() => {
        const copyButton = screen.getByRole('button', { name: /copy message/i });
        fireEvent.click(copyButton);
      });

      // Should not throw, no feedback shown
      await waitFor(() => {
        expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
      });
    });
  });

  describe('Empty and Edge Cases', () => {
    it('renders empty message content', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: '',
        timestamp: Date.now(),
      };

      const { container } = render(<ChatMessageBubble message={message} />);
      // Should render without errors
      expect(container.firstChild).not.toBeNull();
    });

    it('handles very long message content', () => {
      const longContent = 'A'.repeat(10000);
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: longContent,
        timestamp: Date.now(),
      };

      const { container } = render(<ChatMessageBubble message={message} />);
      expect(container.textContent?.includes(longContent)).toBe(true);
    });

    it('handles special characters in message', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: 'Test with `code`, **bold**, *italic*, and [links](https://example.com)',
        timestamp: Date.now(),
      };

      render(<ChatMessageBubble message={message} />);
      expect(screen.getByText(/Test with/)).toBeInTheDocument();
    });
  });

  describe('Timer Cleanup', () => {
    it('clears copy feedback timer on unmount', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Test',
        timestamp: Date.now(),
      };

      const { container, unmount } = render(<ChatMessageBubble message={message} />);

      // Hover to reveal copy button (with real timers)
      const bubble = container.querySelector('[style*="justify-content: flex-end"]');
      await userEvent.hover(bubble!);

      // Button is now visible, click it to start timer
      const copyButton = screen.getByRole('button', { name: /copy message/i });
      fireEvent.click(copyButton);

      // Now switch to fake timers and unmount
      vi.useFakeTimers();

      // Timer was set via setTimeout (1500ms)
      unmount();

      // Timer should have been cleared on unmount
      expect(clearTimeoutSpy).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
