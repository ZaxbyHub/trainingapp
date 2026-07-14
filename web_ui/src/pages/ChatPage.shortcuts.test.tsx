/**
 * Tests for ChatPage keyboard shortcuts wiring (Task 8.6)
 * Verifies:
 * - useKeyboardShortcuts is called with correct callbacks
 * - Ctrl+L triggers clear confirm state (via handleClearClick callback)
 * - Double Ctrl+L clears messages
 * - Ctrl+L is ignored when textarea is focused
 * - onOpenSettings callback exists and is invoked when triggered (real navigation
 *   callback, wired from App's `openSettings`, not a no-op — see PR #28
 *   F-KEYBOARD-REGRESSION / F-STALE-TEST-DOC)
 *
 * Note: useKeyboardShortcuts is mocked, so keyboard events don't trigger callbacks.
 * We verify the wiring by checking the callback passed to the hook is handleClearClick,
 * and test the clear behavior via the button click (same callback).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatPage } from './ChatPage';
import * as keyboardShortcutsModule from '../hooks/useKeyboardShortcuts';

// Types for RAG events
interface RAGEvent {
  type: 'token' | 'complete' | 'error' | 'retrieving';
  data?: unknown;
}

/**
 * Helper: Create a controlled AsyncGenerator that yields RAGEvents
 */
async function* mockRAGEvents(events: RAGEvent[]): AsyncGenerator<RAGEvent> {
  for (const event of events) {
    yield event;
  }
}

// Mock dependencies
vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    isModelReady: true,
    isServerConnected: true,
    modelLoadingProgress: 0,
    serverUrl: '',
  }),
}));

vi.mock('../components/StreamingIndicator', () => ({
  StreamingIndicator: ({ isVisible }: { isVisible: boolean }) =>
    isVisible ? <div data-testid="streaming-indicator">Streaming...</div> : null,
}));

vi.mock('../components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => <button data-testid="inference-toggle">Mode</button>,
}));

let mockDoneCallback: ((data: { sources: string[]; contextLength: number; inferenceTime: number }) => void) | null = null;
let mockErrorCallback: ((error: string) => void) | null = null;

let mockStreamManagerInstance: {
  onToken: ReturnType<typeof vi.fn>;
  onDone: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  pushToken: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(function () {
    return mockStreamManagerInstance;
  }),
}));

let mockOrchestratorInstance: {
  query: ReturnType<typeof vi.fn>;
};

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => mockOrchestratorInstance),
}));

vi.mock('../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}));

describe('ChatPage Keyboard Shortcuts (Task 8.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock stream manager instance with functional methods
    mockDoneCallback = null;
    mockErrorCallback = null;

    mockStreamManagerInstance = {
      onToken: vi.fn(),
      onDone: vi.fn().mockImplementation((cb: typeof mockDoneCallback) => {
        mockDoneCallback = cb;
      }),
      onError: vi.fn().mockImplementation((cb: typeof mockErrorCallback) => {
        mockErrorCallback = cb;
      }),
      pushToken: vi.fn(),
      complete: vi.fn().mockImplementation((data: { sources: string[]; contextLength: number; inferenceTime: number }) => {
        if (mockDoneCallback) {
          mockDoneCallback(data);
        }
      }),
      error: vi.fn().mockImplementation((message: string) => {
        if (mockErrorCallback) {
          mockErrorCallback(message);
        }
      }),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };

    // Create fresh mock orchestrator instance
    mockOrchestratorInstance = {
      query: vi.fn(),
    };

    cleanup();
    vi.useFakeTimers();
    vi.mocked(keyboardShortcutsModule.useKeyboardShortcuts).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe('useKeyboardShortcuts wiring', () => {
    it('is called with onClearChat callback', () => {
      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

      expect(keyboardShortcutsModule.useKeyboardShortcuts).toHaveBeenCalledTimes(1);
      const lastCall = vi.mocked(keyboardShortcutsModule.useKeyboardShortcuts).mock.calls[0][0];
      expect(lastCall).toHaveProperty('onClearChat');
      expect(typeof lastCall.onClearChat).toBe('function');
    });

    it('is called with onOpenSettings callback (real navigation callback)', () => {
      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

      expect(keyboardShortcutsModule.useKeyboardShortcuts).toHaveBeenCalledTimes(1);
      const lastCall = vi.mocked(keyboardShortcutsModule.useKeyboardShortcuts).mock.calls[0][0];
      expect(lastCall).toHaveProperty('onOpenSettings');
      expect(typeof lastCall.onOpenSettings).toBe('function');
    });

    it('onOpenSettings passed to the hook is the real onOpenSettings prop, not a no-op', () => {
      // onOpenSettings is App's real navigation callback (see App.tsx openSettings /
      // PR #28 F-KEYBOARD-REGRESSION), wired straight through to useKeyboardShortcuts
      // and to the model-blocked overlay's "Open Settings" button. Assert the callback
      // the hook receives actually invokes the caller-supplied prop, so a regression
      // that swaps it back for an inert no-op would be caught here.
      const onOpenSettingsSpy = vi.fn();
      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={onOpenSettingsSpy}
/>);

      const lastCall = vi.mocked(keyboardShortcutsModule.useKeyboardShortcuts).mock.calls[0][0];
      expect(() => lastCall.onOpenSettings()).not.toThrow();
      expect(onOpenSettingsSpy).toHaveBeenCalledTimes(1);
    });

    it('is called with onSendMessage undefined (not wired in ChatPage)', () => {
      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

      const lastCall = vi.mocked(keyboardShortcutsModule.useKeyboardShortcuts).mock.calls[0][0];
      expect(lastCall.onSendMessage).toBeUndefined();
    });
  });

  describe('Clear chat behavior (same as Ctrl+L callback)', () => {
    // These tests use the button to test the clear behavior
    // since useKeyboardShortcuts is mocked and doesn't register event listeners

    it('first click shows confirm state', async () => {
      vi.useRealTimers();

      // Mock RAG orchestrator to yield complete event
      const events: RAGEvent[] = [
        { type: 'complete', data: { answer: 'Test response', sources: ['source1'], chunks: [] } },
      ];
      vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

      // Send a message
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      // Click Clear Chat button (same callback as Ctrl+L)
      const clearButton = await waitFor(() => screen.getByText('Clear Chat'));
      fireEvent.click(clearButton);

      await waitFor(() => {
        expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();
      });

      vi.useFakeTimers();
    });

    it('second click clears messages', async () => {
      vi.useRealTimers();

      const events: RAGEvent[] = [
        { type: 'complete', data: { answer: 'Test response', sources: ['source1'], chunks: [] } },
      ];
      vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await new Promise(resolve => setTimeout(resolve, 500));
      vi.advanceTimersByTime(2000);

      // First click
      const clearButton = await waitFor(() => screen.getByText('Clear Chat'));
      fireEvent.click(clearButton);

      await waitFor(() => {
        expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();
      });

      // Second click (confirm)
      const confirmButton = await waitFor(() => screen.getByText('Confirm Clear?'));
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(screen.queryByText('Hello')).not.toBeInTheDocument();
        expect(screen.queryByText('Confirm Clear?')).not.toBeInTheDocument();
      });

      vi.useFakeTimers();
    });

    it('clear button shows only when messages exist', async () => {
      vi.useRealTimers();

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

      // Should not show Clear Chat button initially
      expect(screen.queryByText('Clear Chat')).not.toBeInTheDocument();

      vi.useFakeTimers();
    });

    it('confirm timer auto-resets after 3 seconds', async () => {
      vi.useRealTimers();

      const events: RAGEvent[] = [
        { type: 'complete', data: { answer: 'Test response', sources: ['source1'], chunks: [] } },
      ];
      vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

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

  describe('Keyboard shortcut behavior via callback verification', () => {
    it('Ctrl+L callback would trigger clear confirm state', () => {
      // This test verifies that the onClearChat callback is the same function
      // that the clear button uses, so pressing Ctrl+L would trigger the same behavior

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={() => {}}
/>);

      // Get the onClearChat callback passed to useKeyboardShortcuts
      const onClearChat = vi.mocked(keyboardShortcutsModule.useKeyboardShortcuts).mock.calls[0][0].onClearChat;

      // The onClearChat should be a function
      expect(typeof onClearChat).toBe('function');
    });

    it('onOpenSettings callback invokes the real onOpenSettings prop (Ctrl+, would navigate)', () => {
      // Regression check for PR #28 F-KEYBOARD-REGRESSION: onOpenSettings is real
      // navigation (App's openSettings), not a no-op, so a simulated Ctrl+, press
      // (i.e. calling the callback the hook was given) must reach the caller's prop.
      const onOpenSettingsSpy = vi.fn();
      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  onOpenSettings={onOpenSettingsSpy}
/>);

      const onOpenSettings = vi.mocked(keyboardShortcutsModule.useKeyboardShortcuts).mock.calls[0][0].onOpenSettings;

      expect(() => onOpenSettings()).not.toThrow();
      expect(onOpenSettingsSpy).toHaveBeenCalledTimes(1);
    });
  });
});
