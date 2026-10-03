/**
 * Tests for Sidebar component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
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

  describe('Focus after a confirmed delete (round 4 LOW-2)', () => {
    function Live({ initial, withSearch = false }: { initial: typeof conversations; withSearch?: boolean }) {
      const [items, setItems] = useState(initial);
      return (
        <Sidebar
          {...defaultProps}
          conversations={items}
          onDeleteConversation={(id) => setItems((prev) => prev.filter((c) => c.id !== id))}
          {...(withSearch ? { searchQuery: '', onSearchChange: () => {} } : {})}
        />
      );
    }
    const three = [
      { id: 'a', title: 'Alpha', updatedAt: '2026-06-27T10:00:00Z' },
      { id: 'b', title: 'Bravo', updatedAt: '2026-06-27T09:00:00Z' },
      { id: 'c', title: 'Charlie', updatedAt: '2026-06-27T08:00:00Z' },
    ];
    const deleteRow = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
      const row = screen.getByText(title).closest('.app-conv') as HTMLElement;
      await user.click(row.querySelector('button[aria-label="Conversation options"]') as HTMLElement);
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
      await user.click(screen.getByRole('menuitem', { name: 'Confirm' }));
    };

    it('moves focus to the next row', async () => {
      const user = userEvent.setup();
      render(<Live initial={three} />);
      await deleteRow(user, 'Alpha');
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
      expect(screen.getByText('Bravo').closest('button')).toHaveFocus();
    });

    it('falls back to the previous row when the last row was deleted', async () => {
      const user = userEvent.setup();
      render(<Live initial={three} />);
      await deleteRow(user, 'Charlie');
      expect(screen.getByText('Bravo').closest('button')).toHaveFocus();
    });

    it('with no rows left, focuses the search field (or New chat when there is no search field)', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<Live initial={[three[0]]} withSearch />);
      await deleteRow(user, 'Alpha');
      expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveFocus();
      unmount();
      render(<Live initial={[three[0]]} />);
      await deleteRow(user, 'Alpha');
      expect(screen.getByRole('button', { name: /new chat/i })).toHaveFocus();
      expect(document.activeElement).not.toBe(document.body);
    });

    it('rescues focus within the search results when deleting during an active search', async () => {
      const user = userEvent.setup();
      function Searching() {
        const [items, setItems] = useState(three);
        return (
          <Sidebar
            {...defaultProps}
            conversations={[{ id: 'z', title: 'Zulu', updatedAt: '2026-06-27T07:00:00Z' }]}
            searchResults={items}
            searchQuery="a"
            onSearchChange={() => {}}
            onDeleteConversation={(id) => setItems((prev) => prev.filter((c) => c.id !== id))}
          />
        );
      }
      render(<Searching />);
      await deleteRow(user, 'Bravo');
      expect(screen.getByText('Charlie').closest('button')).toHaveFocus();
      expect(screen.queryByText('Zulu')).not.toBeInTheDocument();
    });

    it('defers the rescue while the list is inert and lands focus once busy clears', async () => {
      const user = userEvent.setup();
      let setBusy: (b: boolean) => void = () => {};
      function Racing() {
        const [items, setItems] = useState(three);
        const [busy, setBusyState] = useState(false);
        setBusy = setBusyState;
        return (
          <Sidebar
            {...defaultProps}
            conversations={items}
            searchQuery="a"
            isSearching={busy}
            onSearchChange={() => {}}
            onDeleteConversation={(id) => {
              // A save-triggered search re-run lands together with the removal.
              setItems((prev) => prev.filter((c) => c.id !== id));
              setBusyState(true);
            }}
          />
        );
      }
      render(<Racing />);
      await deleteRow(user, 'Alpha');
      expect(screen.getByText('Bravo').closest('.app-sidebar__list')).toHaveAttribute('inert');
      expect(document.activeElement).toBe(document.body);
      act(() => setBusy(false));
      expect(screen.getByText('Bravo').closest('button')).toHaveFocus();
    });

    it.each([
      ['rejects', () => vi.fn().mockRejectedValue(new Error('nope'))],
      ['resolves false', () => vi.fn().mockResolvedValue(false)],
    ])('drops the pending rescue when the delete %s, so a later list change does not steal focus', async (_n, make) => {
      const user = userEvent.setup();
      const onDelete = make();
      const { rerender } = render(<Sidebar {...defaultProps} conversations={three} onDeleteConversation={onDelete} />);
      await deleteRow(user, 'Alpha');
      await act(async () => {
        await Promise.resolve();
      });
      expect(onDelete).toHaveBeenCalledWith('a');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      (document.activeElement as HTMLElement | null)?.blur();
      // The row disappears later for an unrelated reason (e.g. another tab).
      rerender(<Sidebar {...defaultProps} conversations={three.slice(1)} onDeleteConversation={onDelete} />);
      expect(document.activeElement).toBe(document.body);
    });

    it('B-1: keeps the rescue after a successful async delete while a search drops the row later', async () => {
      const user = userEvent.setup();
      let startSearch: () => void = () => {};
      let landResults: (ids: string[]) => void = () => {};
      function Searching() {
        const [items, setItems] = useState(three);
        const [busy, setBusy] = useState(false);
        startSearch = () => setBusy(true);
        landResults = (ids) => {
          setItems(three.filter((c) => ids.includes(c.id)));
          setBusy(false);
        };
        return (
          <Sidebar
            {...defaultProps}
            conversations={three}
            searchResults={items}
            searchQuery="a"
            isSearching={busy}
            onSearchChange={() => {}}
            // Resolves true after a microtask; the search results land later.
            onDeleteConversation={async () => {
              await Promise.resolve();
              return true;
            }}
          />
        );
      }
      render(<Searching />);
      await deleteRow(user, 'Alpha');
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Alpha')).toBeInTheDocument(); // promise settled, row still shown
      // The post-delete refresh starts a search (focus is still in the list, so it
      // is not made inert) and the results, minus Alpha, land afterwards.
      act(() => startSearch());
      act(() => landResults(['b', 'c']));
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
      expect(screen.getByText('Bravo').closest('button')).toHaveFocus();
    });

    it('L-1: drops the entry after one attempt even when the target cannot take focus', async () => {
      const user = userEvent.setup();
      let setItemsExt: (items: typeof three) => void = () => {};
      function Harness() {
        const [items, setItems] = useState([three[0]]);
        setItemsExt = setItems;
        return (
          <Sidebar
            {...defaultProps}
            conversations={items}
            onDeleteConversation={(id) => setItems((prev) => prev.filter((c) => c.id !== id))}
          />
        );
      }
      render(<Harness />);
      const row = screen.getByText('Alpha').closest('.app-conv') as HTMLElement;
      await user.click(row.querySelector('button[aria-label="Conversation options"]') as HTMLElement);
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
      try {
        await user.click(screen.getByRole('menuitem', { name: 'Confirm' }));
        expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
        expect(focusSpy).toHaveBeenCalled(); // the one attempt (New chat), which silently failed
        expect(document.activeElement).toBe(document.body);
      } finally {
        focusSpy.mockRestore();
      }
      // A much later list change must not pull focus: the entry is gone.
      act(() => setItemsExt([three[1]]));
      expect(screen.getByText('Bravo')).toBeInTheDocument();
      expect(document.activeElement).toBe(document.body);
    });
  });

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
