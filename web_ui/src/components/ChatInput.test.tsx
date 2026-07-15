/**
 * Tests for ChatInput component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatInput } from './ChatInput';

// Mock image processing for attach tests
const mockPrepareImage = vi.fn();
const mockValidateImageFile = vi.fn();

vi.mock('../lib/processing/image-input', () => ({
  validateImageFile: (...args: unknown[]) => mockValidateImageFile(...args),
  prepareImage: (...args: unknown[]) => mockPrepareImage(...args),
}));

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockPrepareImage.mockReset();
    mockValidateImageFile.mockReset();
    // Default: images are valid and prepareImage returns a stub AttachedImage
    mockValidateImageFile.mockReturnValue({ valid: true });
    mockPrepareImage.mockResolvedValue({
      id: 'img-1',
      dataUrl: 'data:image/png;base64,abc',
      data: new ArrayBuffer(0),
      mimeType: 'image/png',
      fileName: 'test.png',
      width: 100,
      height: 100,
    });
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

    it('does not call onSend when Enter is pressed during IME composition (issue #25 F11)', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
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

  describe('Image Attachment', () => {
    it('does not render attach button when imageUploadEnabled is false (default)', () => {
      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument();
    });

    it('renders attach button when imageUploadEnabled is true', () => {
      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} imageUploadEnabled />);
      expect(screen.getByRole('button', { name: /attach image/i })).toBeInTheDocument();
    });

    it('calls onSend with images when files are attached then sent', async () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} imageUploadEnabled />);

      // Trigger file selection via the hidden input
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([''], 'test.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', { value: [file], writable: false });
      fireEvent.change(fileInput);

      // Wait for prepareImage promise
      await act(async () => { await Promise.resolve(); });

      // Type and send
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Describe this image' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      expect(mockSend).toHaveBeenCalledWith('Describe this image', expect.arrayContaining([
        expect.objectContaining({ id: 'img-1', mimeType: 'image/png' }),
      ]));
    });

    it('calls onSend with text only when no images attached', () => {
      const mockSend = vi.fn();
      render(<ChatInput onSend={mockSend} isLoading={false} onCancel={vi.fn()} imageUploadEnabled />);

      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Text only message' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      // onSend called with just text, no second argument
      expect(mockSend).toHaveBeenCalledWith('Text only message');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]).toHaveLength(1);
    });

    it('clears images after send', async () => {
      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} imageUploadEnabled />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([''], 'test.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', { value: [file], writable: false });
      fireEvent.change(fileInput);
      await act(async () => { await Promise.resolve(); });

      // Send
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'hi' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      // Image preview should be gone
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('shows error when maxImages exceeded on multi-select', async () => {
      // Set up prepareImage to return unique ids for each call
      let callCount = 0;
      mockPrepareImage.mockImplementation(async () => ({
        id: `img-${++callCount}`,
        dataUrl: 'data:image/png;base64,abc',
        data: new ArrayBuffer(0),
        mimeType: 'image/png',
        fileName: `test${callCount}.png`,
        width: 100,
        height: 100,
      }));

      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} imageUploadEnabled maxImages={2} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const files = [
        new File([''], 'a.png', { type: 'image/png' }),
        new File([''], 'b.png', { type: 'image/png' }),
        new File([''], 'c.png', { type: 'image/png' }),
      ];
      Object.defineProperty(fileInput, 'files', { value: files, writable: false });
      fireEvent.change(fileInput);
      await act(async () => { await new Promise(r => setTimeout(r, 10)); });

      expect(screen.getByRole('alert')).toHaveTextContent(/at most 2 images/i);
    });

    it('shows error when file validation fails', async () => {
      mockValidateImageFile.mockReturnValue({ valid: false, error: 'File too large.' });

      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} imageUploadEnabled />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([''], 'bad.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', { value: [file], writable: false });
      fireEvent.change(fileInput);
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByRole('alert')).toHaveTextContent('File too large.');
    });

    it('removes image when remove button clicked', async () => {
      render(<ChatInput onSend={vi.fn()} isLoading={false} onCancel={vi.fn()} imageUploadEnabled />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([''], 'test.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', { value: [file], writable: false });
      fireEvent.change(fileInput);
      await act(async () => { await Promise.resolve(); });

      // Image preview should appear
      const removeBtn = screen.getByRole('button', { name: /remove test\.png/i });
      expect(removeBtn).toBeInTheDocument();
      fireEvent.click(removeBtn);

      expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    });
  });
});
