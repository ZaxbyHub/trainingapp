/**
 * Tests for SourceCitation component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SourceCitation } from './SourceCitation';

// Mock clipboard API
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
  configurable: true,
});

describe('SourceCitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('renders nothing when sources array is empty', () => {
      const { container } = render(<SourceCitation sources={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when sources is null', () => {
      // @ts-ignore - testing edge case
      const { container } = render(<SourceCitation sources={null} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders source pills when sources provided', () => {
      render(<SourceCitation sources={['doc1.pdf', 'doc2.pdf']} />);

      expect(screen.getByText('doc1.pdf')).toBeInTheDocument();
      expect(screen.getByText('doc2.pdf')).toBeInTheDocument();
    });

    it('extracts filename from full path', () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      expect(screen.getByText('document.pdf')).toBeInTheDocument();
    });

    it('handles Windows-style paths', () => {
      render(<SourceCitation sources={['C:\\Users\\Test\\Documents\\file.pdf']} />);

      expect(screen.getByText('file.pdf')).toBeInTheDocument();
    });

    it('renders copy button for each source', () => {
      render(<SourceCitation sources={['doc1.pdf']} />);

      expect(screen.getByRole('button', { name: /copy source path/i })).toBeInTheDocument();
    });

    it('renders multiple pills with individual copy buttons', () => {
      render(<SourceCitation sources={['doc1.pdf', 'doc2.pdf', 'doc3.pdf']} />);

      const copyButtons = screen.getAllByRole('button', { name: /copy source path/i });
      expect(copyButtons).toHaveLength(3);
    });
  });

  describe('Expand/Collapse Functionality', () => {
    it('shows full path on click', async () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const pill = screen.getByText('document.pdf').closest('[role="button"]');
      fireEvent.click(pill!);

      await waitFor(() => {
        expect(screen.getByText('/path/to/document.pdf')).toBeInTheDocument();
      });
    });

    it('toggles expand on second click', async () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const pill = screen.getByText('document.pdf').closest('[role="button"]');
      fireEvent.click(pill!);

      await waitFor(() => {
        expect(screen.getByText('/path/to/document.pdf')).toBeInTheDocument();
      });

      fireEvent.click(pill!);

      await waitFor(() => {
        expect(screen.queryByText('/path/to/document.pdf')).not.toBeInTheDocument();
      });
    });

    it('expands only the clicked source', async () => {
      render(<SourceCitation sources={['/path/doc1.pdf', '/path/doc2.pdf']} />);

      const pill1 = screen.getByText('doc1.pdf').closest('[role="button"]');
      fireEvent.click(pill1!);

      await waitFor(() => {
        expect(screen.getByText('/path/doc1.pdf')).toBeInTheDocument();
        expect(screen.queryByText('/path/doc2.pdf')).not.toBeInTheDocument();
      });
    });
  });

  describe('Keyboard Accessibility', () => {
    it('toggles expand on Enter key', async () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const pill = screen.getByText('document.pdf').closest('[role="button"]');
      fireEvent.keyDown(pill!, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByText('/path/to/document.pdf')).toBeInTheDocument();
      });
    });

    it('toggles expand on Space key', async () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const pill = screen.getByText('document.pdf').closest('[role="button"]');
      fireEvent.keyDown(pill!, { key: ' ' });

      await waitFor(() => {
        expect(screen.getByText('/path/to/document.pdf')).toBeInTheDocument();
      });
    });

    it('prevents default on Space key', () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const pill = screen.getByText('document.pdf').closest('[role="button"]');
      const preventDefaultSpy = vi.fn();
      fireEvent.keyDown(pill!, { key: ' ', preventDefault: preventDefaultSpy });

      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });

  describe('Copy Functionality', () => {
    it('copies full path to clipboard', async () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const copyButton = screen.getByRole('button', { name: /copy source path/i });
      fireEvent.click(copyButton);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/path/to/document.pdf');
    });

    it('shows checkmark after successful copy', async () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const copyButton = screen.getByRole('button', { name: /copy source path/i });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(screen.getByText('✓')).toBeInTheDocument();
      });
    });

    it('calls onCopySource callback', async () => {
      const mockOnCopy = vi.fn();
      render(<SourceCitation sources={['/path/to/document.pdf']} onCopySource={mockOnCopy} />);

      const copyButton = screen.getByRole('button', { name: /copy source path/i });
      fireEvent.click(copyButton);

      expect(mockOnCopy).toHaveBeenCalledWith('/path/to/document.pdf');
    });

    it('does not trigger expand when clicking copy button', async () => {
      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const copyButton = screen.getByRole('button', { name: /copy source path/i });
      fireEvent.click(copyButton);

      // Copy button click should not expand the tooltip
      await waitFor(() => {
        expect(screen.queryByText('/path/to/document.pdf')).not.toBeInTheDocument();
      });
    });

    it('handles clipboard API failure gracefully', async () => {
      mockClipboard.writeText.mockRejectedValueOnce(new Error('Clipboard not available'));

      render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const copyButton = screen.getByRole('button', { name: /copy source path/i });
      fireEvent.click(copyButton);

      // Should not throw, no feedback shown
      await waitFor(() => {
        expect(screen.queryByText('✓')).not.toBeInTheDocument();
      });
    });

    it('only copies the clicked source when multiple sources exist', async () => {
      render(<SourceCitation sources={['/path/doc1.pdf', '/path/doc2.pdf']} />);

      const copyButtons = screen.getAllByRole('button', { name: /copy source path/i });
      fireEvent.click(copyButtons[0]);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/path/doc1.pdf');
    });
  });

  describe('Timer Cleanup', () => {
    it('clears copy timer on unmount', () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const { unmount } = render(<SourceCitation sources={['/path/to/document.pdf']} />);

      const copyButton = screen.getByRole('button', { name: /copy source path/i });
      fireEvent.click(copyButton);

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('handles source with no path separator', () => {
      render(<SourceCitation sources={['document.pdf']} />);

      expect(screen.getByText('document.pdf')).toBeInTheDocument();
    });

    it('handles source with trailing slash', () => {
      render(<SourceCitation sources={['/path/to/']} />);

      expect(screen.getByText('/path/to/')).toBeInTheDocument();
    });

    it('handles empty string source', () => {
      render(<SourceCitation sources={['']} />);

      expect(screen.getByText('')).toBeInTheDocument();
    });

    it('handles source with special characters in filename', () => {
      render(<SourceCitation sources={['/path/to/file (1) [copy].pdf']} />);

      expect(screen.getByText('file (1) [copy].pdf')).toBeInTheDocument();
    });

    it('respects max-width on pills', () => {
      const { container } = render(<SourceCitation sources={['/very/long/path/to/document.pdf']} />);

      const pill = container.querySelector('[style*="maxWidth: 200px"]');
      expect(pill).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Structured citations (F7): numbered [1] pills with filename/page/click-
  // through to chunk text. Numbers align with the model's context order.
  // -------------------------------------------------------------------------
  describe('structured citations (F7)', () => {
    it('renders numbered pills [1] [2] aligned to citations array order', () => {
      render(
        <SourceCitation
          citations={[
            { docId: 'd1', chunkIndex: 0, source: 'alpha.pdf', page: 3, text: 'first chunk' },
            { docId: 'd2', chunkIndex: 0, source: 'beta.md', page: 7, text: 'second chunk' },
          ]}
        />
      );

      // Numbering matches array index (model's [1] -> citations[0]).
      expect(screen.getByText('[1]')).toBeInTheDocument();
      expect(screen.getByText('[2]')).toBeInTheDocument();
      // Filename (basename) + page suffix render.
      expect(screen.getByText('alpha.pdf (p. 3)')).toBeInTheDocument();
      expect(screen.getByText('beta.md (p. 7)')).toBeInTheDocument();
    });

    it('omits the page suffix when page is not provided', () => {
      render(
        <SourceCitation
          citations={[{ docId: 'd1', chunkIndex: 0, source: 'no-page.txt', text: 't' }]}
        />
      );
      expect(screen.getByText('no-page.txt')).toBeInTheDocument();
      // No "(p. N)" suffix anywhere.
      expect(screen.queryByText(/p\./)).toBeNull();
    });

    it('falls back to docId when source filename is absent', () => {
      render(
        <SourceCitation
          citations={[{ docId: '1700000000-abc', chunkIndex: 0, text: 't' }]}
        />
      );
      expect(screen.getByText('1700000000-abc')).toBeInTheDocument();
    });

    it('shows a Copy button only when chunk text is present', () => {
      const { rerender } = render(
        <SourceCitation
          citations={[{ docId: 'd1', chunkIndex: 0, source: 'has-text.pdf', text: 'real text' }]}
        />
      );
      expect(screen.getByRole('button', { name: 'Copy source text' })).toBeInTheDocument();

      // No text → no Copy button.
      rerender(
        <SourceCitation
          citations={[{ docId: 'd2', chunkIndex: 0, source: 'no-text.pdf' }]}
        />
      );
      expect(screen.queryByRole('button', { name: 'Copy source text' })).toBeNull();
    });

    it('expands to show chunk text on click', () => {
      render(
        <SourceCitation
          citations={[{ docId: 'd1', chunkIndex: 0, source: 'x.pdf', page: 1, text: 'the full chunk body' }]}
        />
      );
      // Popover hidden initially.
      expect(screen.queryByText('the full chunk body')).toBeNull();

      // Click the pill (role=button) to expand.
      const pill = screen.getByText('[1]').closest('[role="button"]')!;
      fireEvent.click(pill);

      expect(screen.getByText('the full chunk body')).toBeInTheDocument();
    });

    it('prefers structured citations over legacy sources when both are provided', () => {
      render(
        <SourceCitation
          sources={['legacy.pdf']}
          citations={[{ docId: 'd1', chunkIndex: 0, source: 'structured.pdf', text: 't' }]}
        />
      );
      // Structured mode wins: the [1] label appears, legacy filename does not.
      expect(screen.getByText('[1]')).toBeInTheDocument();
      expect(screen.queryByText('legacy.pdf')).toBeNull();
    });
  });
});
