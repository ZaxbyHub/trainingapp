/**
 * Tests for ChatInput component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from '../ChatInput';

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('renders textarea with placeholder', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      expect(screen.getByPlaceholderText('Ask a question...')).toBeInTheDocument();
    });

    it('renders Send button initially', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
    });

    it('renders disabled textarea when disabled prop is true', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} disabled={true} />);

      expect(screen.getByPlaceholderText('Ask a question...')).toBeDisabled();
    });

    it('renders disabled textarea when isLoading is true', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={true} onCancel={vi.fn()} />);

      expect(screen.getByPlaceholderText('Ask a question...')).toBeDisabled();
    });
  });

  describe('Send Functionality', () => {
    it('calls onSend with trimmed value when Send button clicked', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: '  Hello world  ' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      expect(mockSend).toHaveBeenCalledWith('Hello world');
    });

    it('clears textarea after send', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test message' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      expect((textarea as HTMLTextAreaElement).value).toBe('');
    });

    it('does not call onSend when textarea is empty', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not call onSend when textarea contains only whitespace', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: '   ' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Keyboard Interactions', () => {
    it('calls onSend when Enter key pressed without Shift', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(mockSend).toHaveBeenCalledWith('Test');
    });

    it('does not call onSend when Shift+Enter pressed', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test\nNew line' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not call onSend when loading', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={true} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Cancel Functionality', () => {
    it('renders Cancel button when loading', () => {
      const mockCancel = vi.fn();
      render(<ChatInput onSend={vi.fn()} isLoading={true} onCancel={mockCancel} />);

      expect(screen.getByRole('button', { name: /stop generation/i })).toBeInTheDocument();
    });

    it('calls onCancel when Cancel button clicked', () => {
      const mockCancel = vi.fn();
      render(<ChatInput onSend={vi.fn()} isLoading={true} onCancel={mockCancel} />);

      const cancelButton = screen.getByRole('button', { name: /stop generation/i });
      fireEvent.click(cancelButton);

      expect(mockCancel).toHaveBeenCalled();
    });

    it('does not render Cancel button when not loading', () => {
      const mockCancel = vi.fn();
      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={mockCancel} />);

      expect(screen.queryByRole('button', { name: /stop generation/i })).not.toBeInTheDocument();
    });
  });

  describe('Clear Button', () => {
    it('shows clear button when textarea has value and not loading', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });

      expect(screen.getByRole('button', { name: /clear input/i })).toBeInTheDocument();
    });

    it('hides clear button when textarea is empty', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      expect(screen.queryByRole('button', { name: /clear input/i })).not.toBeInTheDocument();
    });

    it('hides clear button when loading', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={true} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });

      expect(screen.queryByRole('button', { name: /clear input/i })).not.toBeInTheDocument();
    });

    it('clears textarea when clear button clicked', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test message' } });

      const clearButton = screen.getByRole('button', { name: /clear input/i });
      fireEvent.click(clearButton);

      expect((textarea as HTMLTextAreaElement).value).toBe('');
    });

    it('focuses textarea after clear', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });

      const clearButton = screen.getByRole('button', { name: /clear input/i });
      fireEvent.click(clearButton);

      expect(document.activeElement).toBe(textarea);
    });
  });

  describe('Auto-resize Behavior', () => {
    it('adjusts height based on content', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2\nLine 3' } });

      // The height should change based on content
      const style = (textarea as HTMLTextAreaElement).style;
      expect(style.height).toBeTruthy();
    });
  });

  describe('Disabled State', () => {
    it('disables send button when textarea empty', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).toBeDisabled();
    });

    it('disables send button when disabled prop is true', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} disabled={true} />);

      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).toBeDisabled();
    });

    it('send button is not disabled when textarea has content', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).not.toBeDisabled();
    });
  });

  describe('Edge Cases', () => {
    it('handles very long input', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const longText = 'A'.repeat(10000);
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: longText } });

      expect((textarea as HTMLTextAreaElement).value).toBe(longText);
    });

    it('handles special characters', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test with `code` and **bold** and "quotes"' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      expect(mockSend).toHaveBeenCalledWith('Test with `code` and **bold** and "quotes"');
    });

    it('handles newlines in input', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2' } });

      // Shift+Enter should not send
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
      expect(mockSend).not.toHaveBeenCalled();

      // Enter should send
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      expect(mockSend).toHaveBeenCalledWith('Line 1\nLine 2');
    });
  });
});
