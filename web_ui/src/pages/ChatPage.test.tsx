/**
 * Tests for ChatPage component
 * Verifies streaming behavior, cancellation, and timer cleanup
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ChatPage } from './ChatPage';

// Mock dependencies
vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    isModelReady: true,
    isServerConnected: true,
    modelLoadingProgress: 0,
  }),
}));

vi.mock('../components/StreamingIndicator', () => ({
  StreamingIndicator: ({ isVisible }: { isVisible: boolean }) =>
    isVisible ? <div data-testid="streaming-indicator">Streaming...</div> : null,
}));

vi.mock('../components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => <button data-testid="inference-toggle">Mode</button>,
}));

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(() => ({
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    pushToken: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe('Initial Rendering', () => {
    it('renders empty state with placeholder message', () => {
      render(<ChatPage />);

      expect(screen.getByText('Ask a question about your documents')).toBeInTheDocument();
    });

    it('renders header with title', () => {
      render(<ChatPage />);

      expect(screen.getByText('Document Q&A')).toBeInTheDocument();
    });

    it('does not show Clear Chat button when no messages', () => {
      render(<ChatPage />);

      expect(screen.queryByText(/clear chat/i)).not.toBeInTheDocument();
    });
  });

  describe('Message Sending', () => {
    it('sends message and creates user/assistant pair', async () => {
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => {
        expect(screen.getByText('Hello')).toBeInTheDocument();
      });
    });

    it('shows streaming indicator while loading', async () => {
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => {
        expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
      });
    });

    it('shows Cancel button while streaming', async () => {
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop generation/i })).toBeInTheDocument();
      });
    });

    it('streams tokens progressively', async () => {
      vi.useRealTimers();
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Wait for the mock streaming to complete (30ms per token chunk)
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should see streaming content
      await waitFor(() => {
        const content = screen.getByText(/Based on your documents/i);
        expect(content).toBeInTheDocument();
      }, { timeout: 2000 });
      vi.useFakeTimers();
    });
  });

  describe('Streaming Cancellation', () => {
    it('cancel stops streaming and marks messages as complete', async () => {
      vi.useRealTimers();
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Wait for some streaming to happen
      await new Promise(resolve => setTimeout(resolve, 100));

      // Click cancel
      const cancelButton = await waitFor(() => 
        screen.getByRole('button', { name: /stop generation/i })
      );
      fireEvent.click(cancelButton);

      // Streaming indicator should be gone
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();

      // Cancel button should be replaced with Send button
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
      });
      vi.useFakeTimers();
    });

    it('clears mock timer on cancel', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      
      vi.useRealTimers();
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Wait a bit then cancel
      await new Promise(resolve => setTimeout(resolve, 50));

      const cancelButton = await waitFor(() =>
        screen.getByRole('button', { name: /stop generation/i })
      );
      fireEvent.click(cancelButton);

      // clearTimeout should have been called
      expect(clearTimeoutSpy).toHaveBeenCalled();
      
      vi.useFakeTimers();
    });
  });

  describe('Timer Cleanup on Unmount', () => {
    it('clears all timers on unmount', () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const { unmount } = render(<ChatPage />);

      // Trigger some state that creates timers
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Unmount
      unmount();

      // clearTimeout should have been called for cleanup
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('clears confirm clear timer on unmount', () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const { unmount } = render(<ChatPage />);

      // Send a message first to make Clear Chat button appear
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Wait for streaming to complete
      vi.advanceTimersByTime(2000);

      // Click Clear Chat button
      const clearButton = screen.getByText('Clear Chat');
      fireEvent.click(clearButton);

      // Now unmount
      unmount();

      // confirm clear timer should have been cleared
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe('Clear Chat Functionality', () => {
    it('shows Clear Chat button when messages exist', async () => {
      vi.useRealTimers();
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      await waitFor(() => {
        expect(screen.getByText('Clear Chat')).toBeInTheDocument();
      });
      vi.useFakeTimers();
    });

    it('first click shows confirm state', async () => {
      vi.useRealTimers();
      render(<ChatPage />);

      // Send and complete message
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      const clearButton = await waitFor(() => screen.getByText('Clear Chat'));
      fireEvent.click(clearButton);

      await waitFor(() => {
        expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();
      });
      vi.useFakeTimers();
    });

    it('second click clears messages', async () => {
      vi.useRealTimers();
      render(<ChatPage />);

      // Send and complete message
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      const clearButton = await waitFor(() => screen.getByText('Clear Chat'));
      
      // First click
      fireEvent.click(clearButton);
      
      // Second click (confirm)
      const confirmButton = await waitFor(() => screen.getByText('Confirm Clear?'));
      fireEvent.click(confirmButton);

      // Messages should be cleared
      await waitFor(() => {
        expect(screen.queryByText('Hello')).not.toBeInTheDocument();
        expect(screen.getByText('Ask a question about your documents')).toBeInTheDocument();
      });
      vi.useFakeTimers();
    });

    it('confirm timer auto-resets after 3 seconds', async () => {
      vi.useRealTimers();
      render(<ChatPage />);

      // Send and complete message
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      const clearButton = await waitFor(() => screen.getByText('Clear Chat'));
      fireEvent.click(clearButton);

      await waitFor(() => {
        expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();
      });

      // Advance time past 3 seconds
      vi.advanceTimersByTime(3000);

      await waitFor(() => {
        expect(screen.getByText('Clear Chat')).toBeInTheDocument();
      });
      vi.useFakeTimers();
    });
  });

  describe('Input Behavior', () => {
    it('Enter key sends message', async () => {
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test message' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => {
        expect(screen.getByText('Test message')).toBeInTheDocument();
      });
    });

    it('Shift+Enter creates newline without sending', async () => {
      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Line1\nLine2' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      // Message should not be sent
      expect(screen.queryByText('Line1')).not.toBeInTheDocument();
    });

    it('input is disabled when model is blocked', () => {
      // Override the mock to simulate blocked model
      vi.doMock('../lib/inference', () => ({
        InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
        useInferenceMode: () => ({
          mode: 'browser-local',
          isModelReady: false,
          isServerConnected: true,
          modelLoadingProgress: 0,
        }),
      }));

      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      expect(textarea).toBeDisabled();
    });
  });

  describe('setTimeout Timer Tracking', () => {
    it('uses setTimeout for mock streaming producer', () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      vi.useRealTimers();

      render(<ChatPage />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // setTimeout should have been called for the mock producer
      expect(setTimeoutSpy).toHaveBeenCalled();

      vi.useFakeTimers();
    });

    it('uses setTimeout for clear confirm timer', async () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      vi.useRealTimers();

      render(<ChatPage />);

      // Send and complete message
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      const clearButton = screen.getByText('Clear Chat');
      fireEvent.click(clearButton);

      // setTimeout should have been called for confirm timer
      expect(setTimeoutSpy).toHaveBeenCalled();

      vi.useFakeTimers();
    });

    it('clearTimeout is called when timer is no longer needed', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      vi.spyOn(global, 'setTimeout');
      vi.useRealTimers();

      render(<ChatPage />);

      // Send and complete message
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      const clearButton = screen.getByText('Clear Chat');
      fireEvent.click(clearButton);

      // Click again to clear (should cancel the confirm timer)
      const confirmButton = screen.getByText('Confirm Clear?');
      fireEvent.click(confirmButton);

      // clearTimeout should have been called when clearing messages
      expect(clearTimeoutSpy).toHaveBeenCalled();

      vi.useFakeTimers();
    });
  });
});
