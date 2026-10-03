/**
 * Tests for SidebarConversationItem component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
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
    // The row's select button (a native <button>; the options button is its sibling)
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
      expect(container).toHaveAttribute('aria-current', 'true');
    });

    it('renders "Untitled conversation" when title is empty', () => {
      render(<SidebarConversationItem {...defaultProps} title="" />);

      expect(screen.getByText('Untitled conversation')).toBeInTheDocument();
    });

    it('a long title is truncated visually but its full text stays available', () => {
      const longTitle = 'A'.repeat(200);
      render(<SidebarConversationItem {...defaultProps} title={longTitle} />);

      // Truncation is CSS (layouts/shell.css .app-conv__title: ellipsis); the
      // full title stays in the accessible name and in the hover title.
      const titleSpan = screen.getByText(longTitle);
      expect(titleSpan).toHaveClass('app-conv__title');
      expect(titleSpan).toHaveAttribute('title', longTitle);
      expect(screen.getByRole('button', { name: new RegExp(longTitle) })).toBeInTheDocument();
    });

    it('selection is conveyed by aria-current plus the shared selected state, not inline styles', () => {
      const { rerender } = render(<SidebarConversationItem {...defaultProps} />);
      const select = screen.getByRole('button', { name: /test conversation/i });
      const row = select.closest('.app-conv') as HTMLElement;
      expect(select).not.toHaveAttribute('aria-current');
      expect(row).not.toHaveClass('ui-selected');
      expect(row).not.toHaveAttribute('style');
      expect(select).not.toHaveAttribute('style');

      rerender(<SidebarConversationItem {...defaultProps} isSelected={true} />);
      expect(select).toHaveAttribute('aria-current', 'true');
      expect(row).toHaveClass('ui-selected');
      expect(select).toHaveClass('ui-focusable');
    });

    it('the select and options controls are sibling native buttons (no nested interactive)', () => {
      render(<SidebarConversationItem {...defaultProps} />);
      const select = screen.getByRole('button', { name: /test conversation/i });
      const kebab = screen.getByRole('button', { name: /conversation options/i });
      expect(select.tagName).toBe('BUTTON');
      expect(select.contains(kebab)).toBe(false);
      expect(kebab.contains(select)).toBe(false);
      expect(select.closest('[role="button"]')).toBeNull();
      expect(select.parentElement).toBe(kebab.parentElement);
    });

    it('Escape that closes the options menu does not bubble to an enclosing drawer', () => {
      const outer = vi.fn();
      render(
        <div onKeyDown={(e) => outer(e.key)}>
          <SidebarConversationItem {...defaultProps} />
        </div>
      );
      const row = screen.getByRole('button', { name: /test conversation/i });
      fireEvent.click(screen.getByRole('button', { name: /conversation options/i }));
      fireEvent.keyDown(row, { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(outer).not.toHaveBeenCalled();
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

    it('calls onSelect with Enter key when not renaming', async () => {
      const user = userEvent.setup();
      render(<SidebarConversationItem {...defaultProps} />);

      screen.getByRole('button', { name: /test conversation/i }).focus();
      await user.keyboard('{Enter}');

      expect(defaultProps.onSelect).toHaveBeenCalledWith('conv-1');
    });

    it('calls onSelect with Space key when not renaming', async () => {
      const user = userEvent.setup();
      render(<SidebarConversationItem {...defaultProps} />);

      screen.getByRole('button', { name: /test conversation/i }).focus();
      await user.keyboard(' ');

      expect(defaultProps.onSelect).toHaveBeenCalledWith('conv-1');
    });
  });

  describe('Context Menu', () => {
    it.each([
      ['Enter', '{Enter}'],
      ['Space', ' '],
    ])('%s on the options button opens the menu and does not select the row (WCAG 2.1.1)', async (_name, key) => {
      const user = userEvent.setup();
      render(<SidebarConversationItem {...defaultProps} />);
      const kebab = screen.getByRole('button', { name: /conversation options/i });
      kebab.focus();
      await user.keyboard(key);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(kebab).toHaveAttribute('aria-expanded', 'true');
      expect(defaultProps.onSelect).not.toHaveBeenCalled();
    });

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

  describe('Options menu keyboard pattern and focus return (PR #147 review PRR-002, PRR-026)', () => {
    const openWithKeyboard = async (user: ReturnType<typeof userEvent.setup>) => {
      const kebab = screen.getByRole('button', { name: /conversation options/i });
      kebab.focus();
      await user.keyboard('{Enter}');
      return kebab;
    };

    it('opening the menu moves focus to its first item; arrows, Home and End move between items', async () => {
      const user = userEvent.setup();
      render(<SidebarConversationItem {...defaultProps} />);
      await openWithKeyboard(user);
      const rename = screen.getByRole('menuitem', { name: 'Rename' });
      const del = screen.getByRole('menuitem', { name: 'Delete' });
      expect(rename).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(del).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(rename).toHaveFocus(); // wraps
      await user.keyboard('{ArrowUp}');
      expect(del).toHaveFocus(); // wraps back
      await user.keyboard('{Home}');
      expect(rename).toHaveFocus();
      await user.keyboard('{End}');
      expect(del).toHaveFocus();
    });

    it('Tab out of the menu (past its last item) closes it; moving between the button and the items does not (round 4 LOW-1)', async () => {
      const user = userEvent.setup();
      render(
        <>
          <SidebarConversationItem {...defaultProps} />
          <button type="button">After</button>
        </>
      );
      const kebab = await openWithKeyboard(user);
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
      await user.tab({ shift: true }); // back to the options button: still open
      expect(kebab).toHaveFocus();
      expect(screen.getByRole('menu')).toBeInTheDocument();
      await user.tab(); // Rename
      await user.tab(); // Delete
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
      await user.tab(); // leaves the menu
      expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(kebab).toHaveAttribute('aria-expanded', 'false');
    });

    it('Escape from a menu item closes the menu and returns focus to the options button', async () => {
      const user = userEvent.setup();
      render(<SidebarConversationItem {...defaultProps} />);
      const kebab = await openWithKeyboard(user);
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(kebab).toHaveFocus();
      expect(kebab).toHaveAttribute('aria-expanded', 'false');
    });

    it('Delete swaps to the confirmation without dropping focus (focus goes to the options button)', async () => {
      const user = userEvent.setup();
      render(<SidebarConversationItem {...defaultProps} />);
      const kebab = await openWithKeyboard(user);
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('alert')).toHaveTextContent(/Delete this conversation/i);
      expect(kebab).toHaveFocus();
      expect(document.activeElement).not.toBe(document.body);
    });

    it('Escape and Cancel in the delete confirmation return focus to the options button', async () => {
      const user = userEvent.setup();
      render(<SidebarConversationItem {...defaultProps} />);
      const kebab = await openWithKeyboard(user);
      await user.keyboard('{ArrowDown}{Enter}');
      screen.getByRole('menuitem', { name: 'Cancel' }).focus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(kebab).toHaveFocus();

      await user.keyboard('{Enter}{ArrowDown}{Enter}');
      await user.click(screen.getByRole('menuitem', { name: 'Cancel' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(kebab).toHaveFocus();
      expect(defaultProps.onDelete).not.toHaveBeenCalled();
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
