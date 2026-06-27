/**
 * Tests for SidebarConversationItem component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SidebarConversationItem } from './SidebarConversationItem';

// Mock formatRelativeTime to control timestamp display
vi.mock('../utils/relativeTime', () => ({
  formatRelativeTime: vi.fn((ts: string) => {
    if (!ts) return '';
    const date = new Date(ts);
    const now = new Date('2026-06-27T12:00:00Z').getTime();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}h ago`;
    return 'Over a day ago';
  }),
}));

describe('SidebarConversationItem', () => {
  const defaultProps = {
    id: 'conv-1',
    title: 'Test Conversation',
    timestamp: '2026-06-27T10:00:00Z',
    isSelected: false,
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  const renderComponent = (props = defaultProps) => {
    const utils = render(<SidebarConversationItem {...props} />);
    // Get the main container (div with role="button")
    const container = utils.getByRole('button', { name: /test conversation/i });
    return { ...utils, container };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('renders title and relative time when not selected', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
      expect(screen.getByText(/ago$/)).toBeInTheDocument();
    });

    it('renders with selected styling when isSelected=true', () => {
      render(<SidebarConversationItem {...defaultProps} isSelected={true} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      expect(container).toHaveAttribute('aria-current', 'page');
    });

    it('renders "Untitled conversation" when title is empty', () => {
      render(<SidebarConversationItem {...defaultProps} title="" />);

      expect(screen.getByText('Untitled conversation')).toBeInTheDocument();
    });

    it('truncates long title with ellipsis', () => {
      const longTitle = 'A'.repeat(200);
      render(<SidebarConversationItem {...defaultProps} title={longTitle} />);

      const titleSpan = screen.getByText(longTitle);
      const overflow = titleSpan.style.overflow;
      const textOverflow = titleSpan.style.textOverflow;
      expect(overflow === 'hidden' || textOverflow === 'ellipsis').toBeTruthy();
    });

    it('renders kebab menu button', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      // Hover to reveal kebab button
      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);

      expect(screen.getByRole('button', { name: /conversation options/i })).toBeInTheDocument();
    });
  });

  describe('Selection', () => {
    it('calls onSelect with id when item is clicked', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.click(container);

      expect(defaultProps.onSelect).toHaveBeenCalledWith('conv-1');
    });

    it('does not call onSelect when isRenaming is true', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      // Enter rename mode
      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      // Try to select while renaming
      fireEvent.click(container);

      expect(defaultProps.onSelect).not.toHaveBeenCalled();
    });

    it('calls onSelect with Enter key when not renaming', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.keyDown(container, { key: 'Enter' });

      expect(defaultProps.onSelect).toHaveBeenCalledWith('conv-1');
    });

    it('calls onSelect with Space key when not renaming', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.keyDown(container, { key: ' ' });

      expect(defaultProps.onSelect).toHaveBeenCalledWith('conv-1');
    });
  });

  describe('Context Menu', () => {
    it('opens menu when kebab button is clicked', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    });

    it('closes menu when Escape is pressed', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));

      expect(screen.getByRole('menu')).toBeInTheDocument();

      fireEvent.keyDown(container, { key: 'Escape' });

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('Rename Flow', () => {
    it('enters edit mode when Rename is clicked', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      expect(screen.getByRole('textbox', { name: /edit conversation title/i })).toBeInTheDocument();
    });

    it('input is focused when entering rename mode', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      expect(document.activeElement).toBe(input);
    });

    it('saves via onRename when Enter is pressed', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      fireEvent.change(input, { target: { value: 'New Title' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(defaultProps.onRename).toHaveBeenCalledWith('conv-1', 'New Title');
    });

    it('saves trimmed title when Enter is pressed', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      fireEvent.change(input, { target: { value: '  Trimmed Title  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(defaultProps.onRename).toHaveBeenCalledWith('conv-1', 'Trimmed Title');
    });

    it('uses original title when Enter pressed with empty input', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(defaultProps.onRename).toHaveBeenCalledWith('conv-1', 'Test Conversation');
    });

    it('cancels rename when Escape is pressed', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      fireEvent.change(input, { target: { value: 'Changed Title' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(defaultProps.onRename).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('saves via onRename when input loses focus with non-empty trimmed value', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      fireEvent.change(input, { target: { value: 'Blurred Title' } });
      fireEvent.blur(input);

      expect(defaultProps.onRename).toHaveBeenCalledWith('conv-1', 'Blurred Title');
    });

    it('does not save when blur with empty trimmed value', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.blur(input);

      expect(defaultProps.onRename).not.toHaveBeenCalled();
    });
  });

  describe('Delete Flow', () => {
    it('opens confirmation when Delete is clicked', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

      expect(screen.getByRole('alert')).toHaveTextContent(/Delete this conversation/i);
      expect(screen.getByRole('menuitem', { name: 'Confirm' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('calls onDelete with id when Confirm is clicked', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm' }));

      expect(defaultProps.onDelete).toHaveBeenCalledWith('conv-1');
    });

    it('closes confirmation when Cancel is clicked', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(defaultProps.onDelete).not.toHaveBeenCalled();
    });
  });

  describe('Click Outside', () => {
    it('closes open menu when clicking outside', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));

      expect(screen.getByRole('menu')).toBeInTheDocument();

      // Click outside using mousedown event
      fireEvent.mouseDown(document.body);

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('closes delete confirmation when clicking outside', () => {
      render(<SidebarConversationItem {...defaultProps} />);

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Click outside using mousedown event
      fireEvent.mouseDown(document.body);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles very old timestamp', () => {
      const oldTimestamp = '2020-01-01T00:00:00Z';
      render(<SidebarConversationItem {...defaultProps} timestamp={oldTimestamp} />);

      // Should still render without error
      expect(screen.getByText(/ago$/)).toBeInTheDocument();
    });

    it('handles empty timestamp string', () => {
      render(<SidebarConversationItem {...defaultProps} timestamp="" />);

      // Should still render without error
      const titleSpan = screen.getByText('Test Conversation');
      expect(titleSpan).toBeInTheDocument();
    });

    it('stops propagation on kebab click', () => {
      const parentClick = vi.fn();
      render(
        <div onClick={parentClick}>
          <SidebarConversationItem {...defaultProps} />
        </div>
      );

      const container = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.mouseEnter(container);
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));

      expect(parentClick).not.toHaveBeenCalled();
    });
  });
});
