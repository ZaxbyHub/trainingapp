/**
 * Tests for ChatInput component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatInput } from './ChatInput';

// Issue #156: the image-attach control is gone with the text-only LFM2 model
// swap — the composer is text-only (see the Image Attachment removal describe
// at the bottom for the regression pin).

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

      expect(screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)')).toBeInTheDocument();
    });

    it('renders Send button initially', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
    });

    it('renders disabled textarea when disabled prop is true', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} disabled={true} />);

      expect(screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)')).toBeDisabled();
    });

    it('renders disabled textarea when isLoading is true', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={true} onCancel={vi.fn()} />);

      expect(screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)')).toBeDisabled();
    });
  });

  describe('Send Functionality', () => {
    it('calls onSend with trimmed value when Send button clicked', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: '  Hello world  ' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      expect(mockSend).toHaveBeenCalledWith('Hello world');
    });

    it('clears textarea after send', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
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

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
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

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(mockSend).toHaveBeenCalledWith('Test');
    });

    it('does not call onSend when Shift+Enter pressed', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Test\nNew line' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not call onSend when loading', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={true} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not call onSend when Enter is pressed during IME composition (issue #25 F11)', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'こんにちは' } });
      // Enter confirms an IME candidate — isComposing must prevent send.
      // Construct a real KeyboardEvent with isComposing=true so React's
      // synthetic event exposes e.nativeEvent.isComposing correctly.
      const composingEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(composingEnter, 'isComposing', { value: true });
      textarea.dispatchEvent(composingEnter);

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

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
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

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Test' } });

      expect(screen.queryByRole('button', { name: /clear input/i })).not.toBeInTheDocument();
    });

    it('clears textarea when clear button clicked', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Test message' } });

      const clearButton = screen.getByRole('button', { name: /clear input/i });
      fireEvent.click(clearButton);

      expect((textarea as HTMLTextAreaElement).value).toBe('');
    });

    it('focuses textarea after clear', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Test' } });

      const clearButton = screen.getByRole('button', { name: /clear input/i });
      fireEvent.click(clearButton);

      expect(document.activeElement).toBe(textarea);
    });
  });

  describe('Auto-resize Behavior', () => {
    // Lumen phase 5: the old assertion only checked that an inline height existed.
    // This pins the behaviour instead: the measured height is clamped to
    // [40, 150] px and the textarea reports an overflow STATE once content
    // exceeds the cap (pages/chat.css turns that state into a scrollbar).
    it('grows with content, clamps at the cap, and reports overflow state', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
      let contentHeight = 96;
      Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => contentHeight });

      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2\nLine 3' } });
      expect(textarea.style.height).toBe('96px');
      expect(textarea).toHaveAttribute('data-overflow', 'none');

      contentHeight = 400;
      fireEvent.change(textarea, { target: { value: 'many\nlines\nof\ntext' } });
      expect(textarea.style.height).toBe('150px');
      expect(textarea).toHaveAttribute('data-overflow', 'scroll');

      contentHeight = 10;
      fireEvent.change(textarea, { target: { value: 'x' } });
      expect(textarea.style.height).toBe('40px');
      expect(textarea).toHaveAttribute('data-overflow', 'none');
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

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
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
      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: longText } });

      expect((textarea as HTMLTextAreaElement).value).toBe(longText);
    });

    it('handles special characters', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Test with `code` and **bold** and "quotes"' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      expect(mockSend).toHaveBeenCalledWith('Test with `code` and **bold** and "quotes"');
    });

    it('handles newlines in input', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2' } });

      // Shift+Enter should not send
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
      expect(mockSend).not.toHaveBeenCalled();

      // Enter should send
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      expect(mockSend).toHaveBeenCalledWith('Line 1\nLine 2');
    });
  });

  describe('Image Attachment removal (issue #156)', () => {
    it('renders no attach button, file input, or image affordance', () => {
      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument();
      expect(document.querySelector('input[type="file"]')).toBeNull();
    });

    it('calls onSend with the text argument only', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question… (Enter to send, Shift+Enter for a new line)');
      fireEvent.change(textarea, { target: { value: 'Text only message' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      expect(mockSend).toHaveBeenCalledWith('Text only message');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]).toHaveLength(1);
    });
  });

  // Lumen phase 5 review (F2): the composer's icon-only controls are IconButtons
  // (accessible name + tooltip, design-language.md section 4). The composer sits at the
  // bottom of the page, so the tooltips open upward (placement 'top').
  describe('Icon button tooltips', () => {
    it('Send, Clear and Stop show an upward tooltip on focus', () => {
      const { rerender } = render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Message input' }), { target: { value: 'hi' } });

      for (const name of ['Send message', 'Clear input']) {
        const btn = screen.getByRole('button', { name });
        fireEvent.focus(btn);
        const tip = screen.getByRole('tooltip');
        expect(tip).toHaveTextContent(name);
        expect(tip).toHaveClass('ui-tooltip--top');
        fireEvent.blur(btn);
        expect(screen.queryByRole('tooltip')).toBeNull();
      }

      rerender(<ChatInput onSend={vi.fn()} isLoading={true} onCancel={vi.fn()} />);
      const stop = screen.getByRole('button', { name: 'Stop generation' });
      fireEvent.focus(stop);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Stop generation');
      expect(screen.getByRole('tooltip')).toHaveClass('ui-tooltip--top');
    });
  });
});
