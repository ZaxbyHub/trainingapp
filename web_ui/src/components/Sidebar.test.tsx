/**
 * Tests for Sidebar component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  const defaultProps = {
    onNewChat: vi.fn(),
    onSelectConversation: vi.fn(),
    onNavigate: vi.fn(),
  };

  const conversations = [
    { id: 'conv-1', title: 'First Chat', updatedAt: '2026-06-27T10:00:00Z' },
    { id: 'conv-2', title: 'Second Chat', updatedAt: '2026-06-27T09:00:00Z' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('renders "New Chat" button', () => {
      render(<Sidebar {...defaultProps} />);

      expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    });

    it('renders navigation icons for chat, documents, and settings', () => {
      render(<Sidebar {...defaultProps} />);

      // Use exact name matching to avoid "New Chat" being matched by /chat/i
      expect(screen.getByRole('button', { name: /^chat$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^documents$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^settings$/i })).toBeInTheDocument();
    });

    it('renders conversation list', () => {
      render(<Sidebar {...defaultProps} conversations={conversations} />);

      expect(screen.getByText('First Chat')).toBeInTheDocument();
      expect(screen.getByText('Second Chat')).toBeInTheDocument();
    });

    it('puts the primary nav first, then a labelled Conversations section', () => {
      render(<Sidebar {...defaultProps} conversations={conversations} />);

      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      const section = screen.getByRole('region', { name: 'Conversations' });
      // Primary nav at the TOP (design-language.md section 5): nav precedes the list.
      expect(nav.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
        'Chat',
        'Documents',
        'Training',
        'Settings',
      ]);
      expect(within(section).getByRole('button', { name: /new chat/i })).toBeInTheDocument();
      expect(within(section).getByText('First Chat')).toBeInTheDocument();
    });

    it('does not show the old "Menu" header', () => {
      render(<Sidebar {...defaultProps} />);

      expect(screen.queryByText('Menu')).not.toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('renders empty state message when no conversations', () => {
      render(<Sidebar {...defaultProps} conversations={[]} />);

      expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('calls onNavigate with "chat" when chat icon clicked', () => {
      render(<Sidebar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));

      expect(defaultProps.onNavigate).toHaveBeenCalledWith('chat');
    });

    it('calls onNavigate with "documents" when documents icon clicked', () => {
      render(<Sidebar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /^documents$/i }));

      expect(defaultProps.onNavigate).toHaveBeenCalledWith('documents');
    });

    it('calls onNavigate with "settings" when settings icon clicked', () => {
      render(<Sidebar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));

      expect(defaultProps.onNavigate).toHaveBeenCalledWith('settings');
    });

    it('highlights chat nav item when currentPage is "chat"', () => {
      render(<Sidebar {...defaultProps} currentPage="chat" />);

      const chatButton = screen.getByRole('button', { name: /^chat$/i });
      expect(chatButton).toHaveAttribute('aria-current', 'page');
    });

    it('highlights documents nav item when currentPage is "documents"', () => {
      render(<Sidebar {...defaultProps} currentPage="documents" />);

      const documentsButton = screen.getByRole('button', { name: /^documents$/i });
      expect(documentsButton).toHaveAttribute('aria-current', 'page');
    });
  });

  describe('New Chat', () => {
    it('calls onNewChat when New Chat button is clicked', () => {
      render(<Sidebar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /new chat/i }));

      expect(defaultProps.onNewChat).toHaveBeenCalled();
    });
  });

  describe('Conversation Selection', () => {
    it('calls onSelectConversation with id when a conversation is clicked', () => {
      render(<Sidebar {...defaultProps} conversations={conversations} />);

      // Click on the first conversation item
      fireEvent.click(screen.getByText('First Chat'));

      expect(defaultProps.onSelectConversation).toHaveBeenCalledWith('conv-1');
    });

    it('highlights selected conversation', () => {
      render(
        <Sidebar
          {...defaultProps}
          conversations={conversations}
          currentConversationId="conv-1"
        />
      );

      const firstConv = screen.getByText('First Chat');
      expect(firstConv.closest('button')).toHaveAttribute('aria-current', 'true');
    });

    it('with a selected conversation on the Chat page, exactly one element is aria-current="page" (the Chat nav item)', () => {
      const { container } = render(
        <Sidebar {...defaultProps} currentPage="chat" conversations={conversations} currentConversationId="conv-2" />
      );
      const pageCurrent = container.querySelectorAll('[aria-current="page"]');
      expect(pageCurrent).toHaveLength(1);
      expect(pageCurrent[0]).toBe(screen.getByRole('button', { name: /^chat$/i }));
      const selectedRow = screen.getByText('Second Chat').closest('button');
      expect(selectedRow).toHaveAttribute('aria-current', 'true');
      expect(screen.getByText('First Chat').closest('button')).not.toHaveAttribute('aria-current');
    });
  });

  describe('Load More', () => {
    it('renders "Load more..." button when hasMore is true', () => {
      render(<Sidebar {...defaultProps} conversations={conversations} hasMore={true} />);

      expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
    });

    it('does not render "Load more..." button when hasMore is false', () => {
      render(<Sidebar {...defaultProps} conversations={conversations} hasMore={false} />);

      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });

    it('calls onLoadMore when Load more button is clicked', () => {
      const onLoadMore = vi.fn();
      render(
        <Sidebar
          {...defaultProps}
          conversations={conversations}
          hasMore={true}
          onLoadMore={onLoadMore}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /load more/i }));

      expect(onLoadMore).toHaveBeenCalled();
    });
  });

  // Collapse/expand moved to the AppShell (ui/AppShell.test.tsx covers the toggle,
  // the rail and the drawer); the sidebar body only reads the shell state.

  describe('Edge Cases', () => {
    it('handles undefined conversations prop', () => {
      render(<Sidebar {...defaultProps} conversations={undefined} />);

      expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    });

    it('calls onRenameConversation when rename handler is triggered', () => {
      const onRenameConversation = vi.fn();
      render(
        <Sidebar
          {...defaultProps}
          conversations={conversations}
          onRenameConversation={onRenameConversation}
        />
      );

      // Hover and open menu for first conversation
      const firstConv = screen.getByText('First Chat');
      fireEvent.mouseEnter(firstConv);

      // Get the kebab button for the first conversation
      const firstConvContainer = firstConv.closest('.app-conv');
      const kebabButton = firstConvContainer?.querySelector('button[aria-label="Conversation options"]') as HTMLButtonElement;
      fireEvent.click(kebabButton);

      // Click Rename
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

      // Enter new name
      const input = screen.getByRole('textbox', { name: /edit conversation title/i });
      fireEvent.change(input, { target: { value: 'Renamed Chat' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onRenameConversation).toHaveBeenCalledWith('conv-1', 'Renamed Chat');
    });

    it('calls onDeleteConversation when delete handler is triggered', () => {
      const onDeleteConversation = vi.fn();
      render(
        <Sidebar
          {...defaultProps}
          conversations={conversations}
          onDeleteConversation={onDeleteConversation}
        />
      );

      // Hover and open menu for first conversation
      const firstConv = screen.getByText('First Chat');
      fireEvent.mouseEnter(firstConv);

      // Get the kebab button for the first conversation
      const firstConvContainer = firstConv.closest('.app-conv');
      const kebabButton = firstConvContainer?.querySelector('button[aria-label="Conversation options"]') as HTMLButtonElement;
      fireEvent.click(kebabButton);

      // Click Delete
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

      // Confirm
      fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm' }));

      expect(onDeleteConversation).toHaveBeenCalledWith('conv-1');
    });
  });
});
