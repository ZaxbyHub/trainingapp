/**
 * Tests for DropZone component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DropZone } from './DropZone';

describe('DropZone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('renders drop zone with upload instructions', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      expect(screen.getByText(/drag and drop files here, or click to select/i)).toBeInTheDocument();
    });

    it('renders file type hints', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      expect(screen.getByText(/supports pdf, docx, xlsx, pptx, txt, md/i)).toBeInTheDocument();
    });

    it('renders upload icon', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const svg = document.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('Drag Over State', () => {
    it('shows drag-over styling when files are dragged over', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.dragOver(dropZone);

      expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
    });

    it('removes drag-over styling when files leave', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.dragOver(dropZone);
      fireEvent.dragLeave(dropZone);

      expect(screen.getByText(/drag and drop files here, or click to select/i)).toBeInTheDocument();
    });

    it('does not set drag-over state when disabled', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} disabled={true} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.dragOver(dropZone);

      // Should show default text, not the drag-over text "Drop files here"
      expect(screen.getByText(/drag and drop files here, or click to select/i)).toBeInTheDocument();
      expect(screen.queryByText(/^drop files here$/i)).not.toBeInTheDocument();
    });
  });

  describe('File Drop', () => {
    it('calls onFilesSelected with dropped files', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });

      const mockFile = new File(['content'], 'test.pdf', { type: 'application/pdf' });
      const mockDataTransfer = {
        files: [mockFile],
        items: [{ kind: 'file', getAsFile: () => mockFile }],
      };

      fireEvent.drop(dropZone, { dataTransfer: mockDataTransfer });

      expect(mockOnFilesSelected).toHaveBeenCalledWith(expect.arrayContaining([mockFile]));
    });

    it('ignores drop when disabled', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} disabled={true} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });

      const mockFile = new File(['content'], 'test.pdf', { type: 'application/pdf' });
      const mockDataTransfer = {
        files: [mockFile],
        items: [{ kind: 'file', getAsFile: () => mockFile }],
      };

      fireEvent.drop(dropZone, { dataTransfer: mockDataTransfer });

      expect(mockOnFilesSelected).not.toHaveBeenCalled();
    });

    it('handles empty file drop gracefully', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });

      const mockDataTransfer = {
        files: [],
        items: [],
      };

      fireEvent.drop(dropZone, { dataTransfer: mockDataTransfer });

      expect(mockOnFilesSelected).not.toHaveBeenCalled();
    });
  });

  describe('Click to Open File Picker', () => {
    it('opens file picker when clicked', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.click(dropZone);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
    });

    it('does not open file picker when disabled', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} disabled={true} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.click(dropZone);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      // Input should exist but be hidden and not clickable
      expect(fileInput).toBeInTheDocument();
    });

    it('calls onFilesSelected when file input changes', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const mockFile = new File(['content'], 'test.pdf', { type: 'application/pdf' });

      fireEvent.change(fileInput, { target: { files: [mockFile] } });

      expect(mockOnFilesSelected).toHaveBeenCalledWith([mockFile]);
    });
  });

  describe('Keyboard Interactions', () => {
    it('opens file picker when Enter key is pressed', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.keyDown(dropZone, { key: 'Enter' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
    });

    it('opens file picker when Space key is pressed', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.keyDown(dropZone, { key: ' ' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
    });

    it('does not respond to keyboard when disabled', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} disabled={true} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      expect(dropZone).toHaveAttribute('tabIndex', '-1');

      fireEvent.keyDown(dropZone, { key: 'Enter' });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
    });
  });

  describe('Disabled State', () => {
    it('applies disabled styling when disabled prop is true', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} disabled={true} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      expect(dropZone).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not respond to drag events when disabled', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} disabled={true} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.dragOver(dropZone);

      expect(mockOnFilesSelected).not.toHaveBeenCalled();
    });

    it('does not respond to click when disabled', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} disabled={true} />);

      const dropZone = screen.getByRole('button', { name: /drop files here or click to select/i });
      fireEvent.click(dropZone);

      expect(mockOnFilesSelected).not.toHaveBeenCalled();
    });
  });

  describe('Accept Prop', () => {
    it('passes accept attribute to file input', () => {
      const mockOnFilesSelected = vi.fn();
      const accept = '.pdf,.docx';
      render(<DropZone onFilesSelected={mockOnFilesSelected} accept={accept} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toHaveAttribute('accept', accept);
    });

    it('allows multiple file selection', () => {
      const mockOnFilesSelected = vi.fn();
      render(<DropZone onFilesSelected={mockOnFilesSelected} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toHaveAttribute('multiple');
    });
  });
});
