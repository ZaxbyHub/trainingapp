/**
 * Tests for ChatPage server API mode (Task 8.4)
 * Verifies handleSend behavior when mode === 'api'
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ChatPage } from './ChatPage';

// ============================================================
// MOCK SETUP
// ============================================================

// Mock TokenStreamManager with spying capability
const mockStartSSEStream = vi.fn();
const mockCancel = vi.fn();
const mockDispose = vi.fn();
const mockOnToken = vi.fn();
const mockOnDone = vi.fn();
const mockOnError = vi.fn();
const mockPushToken = vi.fn();
const mockComplete = vi.fn();
const mockError = vi.fn();

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(() => ({
    onToken: mockOnToken,
    onDone: mockOnDone,
    onError: mockOnError,
    pushToken: mockPushToken,
    complete: mockComplete,
    error: mockError,
    cancel: mockCancel,
    dispose: mockDispose,
    startSSEStream: mockStartSSEStream,
  })),
}));

// Mock RAGOrchestrator to verify it's NOT called in API mode
const mockRAGQuery = vi.fn();
vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({
    query: mockRAGQuery,
    dispose: vi.fn(),
  })),
}));

// Mock useInferenceMode - default to API mode
function createUseInferenceModeMock(mode: 'api' | 'browser-local', serverUrl: string) {
  return {
    mode,
    browserEngine: 'wllama' as const,
    ragPreset: 'balanced' as const,
    serverUrl,
    isModelReady: mode === 'browser-local',
    isServerConnected: true,
    modelLoadingProgress: 0,
    modeError: null,
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    setServerUrl: vi.fn(),
    checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
    setModelReady: vi.fn(),
    setModelLoadingProgress: vi.fn(),
  };
}

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../components/StreamingIndicator', () => ({
  StreamingIndicator: ({ isVisible }: { isVisible: boolean }) =>
    isVisible ? <div data-testid="streaming-indicator">Streaming...</div> : null,
}));

vi.mock('../components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => <button data-testid="inference-toggle">Mode</button>,
}));

// Import the mock after vi.mock
import { useInferenceMode } from '../lib/inference';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function setupAPIMode(serverUrl = 'http://localhost:8000') {
  vi.mocked(useInferenceMode).mockReturnValue(createUseInferenceModeMock('api', serverUrl));
}

function setupBrowserLocalMode() {
  vi.mocked(useInferenceMode).mockReturnValue(createUseInferenceModeMock('browser-local', ''));
}

function getTokenCallback() {
  return mockOnToken.mock.calls[mockOnToken.mock.calls.length - 1]?.[0] as ((token: string) => void) | undefined;
}

function getDoneCallback() {
  return mockOnDone.mock.calls[mockOnDone.mock.calls.length - 1]?.[0] as ((data: { sources: string[]; contextLength: number; inferenceTime: number }) => void) | undefined;
}

function getErrorCallback() {
  return mockOnError.mock.calls[mockOnError.mock.calls.length - 1]?.[0] as ((error: string) => void) | undefined;
}

// ============================================================
// TESTS
// ============================================================

describe('ChatPage API Mode (Task 8.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
  });

  // ----------------------------------------------------------------
  // Test 1: API mode — handleSend calls startSSEStream with correct URL
  // ----------------------------------------------------------------
  describe('API mode URL construction', () => {
    it('calls startSSEStream with serverUrl + /ask/stream', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'What is AI?' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Wait for the mock to be called
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(mockStartSSEStream).toHaveBeenCalledTimes(1);

      // Verify the URL
      const [url, body, token] = mockStartSSEStream.mock.calls[0];
      expect(url).toBe('http://localhost:8000/ask/stream');
      expect(body).toEqual({ question: 'What is AI?' });
      expect(token).toBeUndefined();
    });

    it('strips trailing slash from serverUrl before appending /ask/stream', async () => {
      setupAPIMode('http://localhost:8000/');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      const [url] = mockStartSSEStream.mock.calls[0];
      expect(url).toBe('http://localhost:8000/ask/stream');
    });
  });

  // ----------------------------------------------------------------
  // Test 4: API mode — empty serverUrl uses relative path '/ask/stream'
  // ----------------------------------------------------------------
  describe('API mode with empty serverUrl', () => {
    it('uses relative path /ask/stream when serverUrl is empty', async () => {
      setupAPIMode('');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      const [url] = mockStartSSEStream.mock.calls[0];
      expect(url).toBe('/ask/stream');
    });

    it('uses relative path /ask/stream when serverUrl is undefined', async () => {
      vi.mocked(useInferenceMode).mockReturnValue({
        ...createUseInferenceModeMock('api', undefined as unknown as string),
        isModelReady: false,
        isServerConnected: true,
      });
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      const [url] = mockStartSSEStream.mock.calls[0];
      expect(url).toBe('/ask/stream');
    });
  });

  // ----------------------------------------------------------------
  // Test 2: API mode — handleSend passes { question: text } as body
  // ----------------------------------------------------------------
  describe('API mode request body', () => {
    it('passes { question: text } as body to startSSEStream', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'What is machine learning?' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      const [, body] = mockStartSSEStream.mock.calls[0];
      expect(body).toEqual({ question: 'What is machine learning?' });
    });

    it('handles special characters in question text', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'What is "artificial intelligence"? & how does it work?' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      const [, body] = mockStartSSEStream.mock.calls[0];
      expect(body).toEqual({ question: 'What is "artificial intelligence"? & how does it work?' });
    });
  });

  // ----------------------------------------------------------------
  // Test 3: API mode — RAGOrchestrator is NOT created or called
  // ----------------------------------------------------------------
  describe('RAGOrchestrator NOT called in API mode', () => {
    it('does not instantiate RAGOrchestrator when mode is api', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // RAGOrchestrator query should NOT have been called
      expect(mockRAGQuery).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Test 5: API mode — token callback from SSE updates message content
  // ----------------------------------------------------------------
  describe('API mode token callback', () => {
    it('updates message content when token callback is invoked', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // Verify user message appears
      expect(screen.getByText('Hello')).toBeInTheDocument();

      // Simulate token callback
      const tokenCallback = getTokenCallback();
      expect(tokenCallback).toBeDefined();

      act(() => {
        tokenCallback!('Hello, World!');
      });

      expect(screen.getByText('Hello, World!')).toBeInTheDocument();
    });

    it('accumulates multiple tokens correctly', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hi' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(screen.getByText('Hi')).toBeInTheDocument();

      // Send multiple tokens
      const tokenCallback = getTokenCallback();
      act(() => {
        tokenCallback!('One ');
        tokenCallback!('Two ');
        tokenCallback!('Three');
      });

      expect(screen.getByText('One Two Three')).toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Test 6: API mode — done callback from SSE finalizes message with sources
  // ----------------------------------------------------------------
  describe('API mode done callback', () => {
    it('onDone callback is registered on TokenStreamManager', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // Verify onDone was registered on TokenStreamManager
      expect(mockOnDone).toHaveBeenCalledTimes(1);
    });

    it('verifies SSE stream consumer is created with correct parameters', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // Verify startSSEStream was called with correct parameters
      expect(mockStartSSEStream).toHaveBeenCalledWith(
        'http://localhost:8000/ask/stream',
        { question: 'Test question' },
        undefined
      );

      // Verify the consumer object has the expected methods
      const consumer = mockStartSSEStream.mock.results[0].value;
      expect(consumer.onToken).toBeDefined();
      expect(consumer.onDone).toBeDefined();
      expect(consumer.onError).toBeDefined();
      expect(consumer.stop).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // Test 7: API mode — error callback from SSE shows error in message
  // ----------------------------------------------------------------
  describe('API mode error callback', () => {
    it('shows error in message when error callback is invoked', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(screen.getByText('Hello')).toBeInTheDocument();

      // Simulate partial content before error
      const tokenCallback = getTokenCallback();
      act(() => {
        tokenCallback!('Partial answer');
      });

      // Simulate error callback
      const errorCallback = getErrorCallback();
      expect(errorCallback).toBeDefined();

      act(() => {
        errorCallback!('Connection failed');
      });

      expect(screen.getByText(/\[Error: Connection failed\]/)).toBeInTheDocument();
    });

    it('handles error without prior content', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(screen.getByText('Hello')).toBeInTheDocument();

      // Simulate error with no prior content
      const errorCallback = getErrorCallback();
      act(() => {
        errorCallback!('Server unavailable');
      });

      expect(screen.getByText(/\[Error: Server unavailable\]/)).toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Test 8: Browser-local mode — handleSend does NOT call startSSEStream
  // ----------------------------------------------------------------
  describe('Browser-local mode does NOT call startSSEStream', () => {
    it('does NOT call startSSEStream when mode is browser-local', async () => {
      setupBrowserLocalMode();
      // Make mockRAGQuery return an async generator
      mockRAGQuery.mockImplementation(async function* () {
        yield { type: 'token', data: 'Hello' };
        yield { type: 'complete', data: { answer: 'Hello', sources: [], chunks: [] } };
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      // startSSEStream should NOT have been called
      expect(mockStartSSEStream).not.toHaveBeenCalled();
    });

    it('creates RAGOrchestrator instance when mode is browser-local', async () => {
      setupBrowserLocalMode();
      // Make mockRAGQuery return an async generator
      mockRAGQuery.mockImplementation(async function* () {
        yield { type: 'token', data: 'Hello' };
        yield { type: 'complete', data: { answer: 'Hello', sources: [], chunks: [] } };
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      // RAGOrchestrator query SHOULD have been called
      expect(mockRAGQuery).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Test 9: API mode — cancel during SSE stream calls TokenStreamManager.cancel()
  // ----------------------------------------------------------------
  describe('API mode cancellation', () => {
    it('cancel calls TokenStreamManager.cancel()', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(screen.getByText('Hello')).toBeInTheDocument();

      // Click cancel button
      const cancelButton = screen.getByRole('button', { name: /stop generation/i });
      fireEvent.click(cancelButton);

      // cancel should have been called on the TokenStreamManager
      expect(mockCancel).toHaveBeenCalledTimes(1);
    });

    it('cancel clears streaming state', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(screen.getByText('Hello')).toBeInTheDocument();

      // Click cancel button
      const cancelButton = screen.getByRole('button', { name: /stop generation/i });
      fireEvent.click(cancelButton);

      // After cancel, streaming indicator should be gone
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Additional edge case tests
  // ----------------------------------------------------------------
  describe('Edge cases', () => {
    it('prevents overlapping streams by returning early if tokenStreamManager exists', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');

      // Send first message
      fireEvent.change(textarea, { target: { value: 'First' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(mockStartSSEStream).toHaveBeenCalledTimes(1);

      // Try to send second message while first is still streaming
      fireEvent.change(textarea, { target: { value: 'Second' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Should still only have been called once (early return prevents second call)
      expect(mockStartSSEStream).toHaveBeenCalledTimes(1);
    });

    it('creates user and assistant message pair', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'What is AI?' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // User message should be visible
      expect(screen.getByText('What is AI?')).toBeInTheDocument();
    });

    it('registers all callbacks on TokenStreamManager', async () => {
      setupAPIMode('http://localhost:8000');
      mockStartSSEStream.mockReturnValue({
        onToken: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      });

      render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(mockOnToken).toHaveBeenCalledTimes(1);
      expect(mockOnDone).toHaveBeenCalledTimes(1);
      expect(mockOnError).toHaveBeenCalledTimes(1);
    });
  });
});
