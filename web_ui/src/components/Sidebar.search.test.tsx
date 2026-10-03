/**
 * Sidebar conversation search (Lumen phase 3, design-language.md section 5):
 * the field, its keyboard behaviour, the empty state, clearing, the rail and the
 * drawer, and an end-to-end path through the real useConversations hook to a
 * match that sits beyond the first loaded page.
 */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { AppShell, DRAWER_MEDIA_QUERY } from '../ui';
import { useConversations } from '../hooks/useConversations';

vi.mock('../db/conversations', () => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
  countConversations: vi.fn(),
  searchConversations: vi.fn(),
}));
import * as db from '../db/conversations';

const list = (n: number, prefix = 'Recent') =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `${prefix} ${i}`, updatedAt: '2026-06-27T10:00:00Z' }));

function Controlled(props: Partial<React.ComponentProps<typeof Sidebar>> & { initial?: string }) {
  const [q, setQ] = useState(props.initial ?? '');
  return (
    <Sidebar
      onNewChat={() => {}}
      onSelectConversation={() => {}}
      onNavigate={() => {}}
      conversations={list(3)}
      hasMore
      {...props}
      searchQuery={q}
      onSearchChange={(next) => {
        props.onSearchChange?.(next);
        setQ(next);
      }}
    />
  );
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe('Sidebar search field', () => {
  it('is a labelled search box at the top of the Conversations section, above the list', () => {
    render(<Controlled />);
    const section = screen.getByRole('region', { name: 'Conversations' });
    const box = within(section).getByRole('searchbox', { name: 'Search conversations' });
    expect(within(section).getByRole('search')).toContainElement(box);
    const firstRow = within(section).getByText('Recent 0');
    expect(box.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('shows the search results instead of the loaded page, and hides "Load more"', () => {
    render(<Controlled initial="budget" searchResults={[{ id: 'c110', title: 'Quarterly budget', updatedAt: '2026-01-01T00:00:00Z' }]} />);
    expect(screen.getByText('Quarterly budget')).toBeInTheDocument();
    expect(screen.queryByText('Recent 0')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 conversation found');
  });

  it('no matches: "No conversations match" empty state and a status message', () => {
    render(<Controlled initial="zzz" searchResults={[]} />);
    expect(screen.getByText('No conversations match')).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No conversations found');
  });

  it('says when only the most recent matches are shown', () => {
    render(<Controlled initial="re" searchResults={list(2)} searchTruncated />);
    expect(screen.getByText(/showing the most recent matches/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 or more conversations found');
  });

  it('the clear button empties the query and returns focus to the field', async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    render(<Controlled initial="budget" onSearchChange={onSearchChange} />);
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onSearchChange).toHaveBeenLastCalledWith('');
    const box = screen.getByRole('searchbox', { name: 'Search conversations' });
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('keyboard: typing updates the query; Escape clears a non-empty field without bubbling, and bubbles when empty', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const onSearchChange = vi.fn();
    render(
      <div onKeyDown={(e) => outer(e.key)}>
        <Controlled onSearchChange={onSearchChange} />
      </div>
    );
    const box = screen.getByRole('searchbox', { name: 'Search conversations' });
    await user.click(box);
    await user.keyboard('bud');
    expect(onSearchChange).toHaveBeenLastCalledWith('bud');
    expect(box).toHaveValue('bud');
    outer.mockClear();
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
    expect(outer).not.toHaveBeenCalledWith('Escape');
    await user.keyboard('{Escape}');
    expect(outer).toHaveBeenCalledWith('Escape');
  });

  it('busy: aria-busy on the results, a spinner in the field, and no stale count announced', () => {
    const results = [{ id: 'c110', title: 'Quarterly budget', updatedAt: '2026-01-01T00:00:00Z' }];
    const { rerender, container } = render(<Controlled initial="budg" searchResults={results} isSearching />);
    const list = container.querySelector('.app-sidebar__list') as HTMLElement;
    expect(list).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('search-spinner')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Searching…');
    expect(screen.getByRole('status')).not.toHaveTextContent(/found/);

    rerender(<Controlled initial="budg" searchResults={results} isSearching={false} />);
    expect(list).not.toHaveAttribute('aria-busy');
    expect(screen.queryByTestId('search-spinner')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 conversation found');
  });

  it('busy is ignored once the query is cleared (clearing is immediate)', () => {
    const { container } = render(<Controlled initial="" isSearching />);
    expect(container.querySelector('.app-sidebar__list')).not.toHaveAttribute('aria-busy');
    expect(screen.queryByTestId('search-spinner')).not.toBeInTheDocument();
  });

  it('is hidden in the 64px rail (the expand button brings it back)', () => {
    render(
      <AppShell productName="TrainingApp" collapsed onToggleCollapsed={() => {}} sidebar={<Controlled />}>
        <p>page</p>
      </AppShell>
    );
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('works inside the open drawer', async () => {
    const user = userEvent.setup();
    window.matchMedia = ((query: string) => ({
      matches: query === DRAWER_MEDIA_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    render(
      <AppShell productName="TrainingApp" collapsed={false} onToggleCollapsed={() => {}} sidebar={<Controlled />}>
        <p>page</p>
      </AppShell>
    );
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    const box = within(drawer).getByRole('searchbox', { name: 'Search conversations' });
    await user.click(box);
    await user.keyboard('x');
    expect(box).toHaveValue('x');
    // Escape on a non-empty field clears it and keeps the drawer open.
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
  });
});

describe('Sidebar search through the real useConversations hook', () => {
  const page = Array.from({ length: 50 }, (_, i) => ({
    id: `conv-${i}`,
    title: `Recent ${i}`,
    messages: [],
    createdAt: 0,
    updatedAt: 10_000 - i,
    mode: 'wllama' as const,
    modelUsed: 'm',
  }));
  const beyond = { ...page[0], id: 'conv-110', title: 'Quarterly budget review', updatedAt: 5 };

  beforeEach(() => {
    vi.mocked(db.listConversations).mockImplementation(async (offset = 0, size = 50) =>
      page.slice(offset, offset + size)
    );
    vi.mocked(db.countConversations).mockResolvedValue(120);
    vi.mocked(db.getConversation).mockResolvedValue(undefined);
    vi.mocked(db.searchConversations).mockImplementation(async (q: string) => ({
      matches: 'quarterly budget review'.includes(q.trim().toLowerCase()) ? [beyond] : [],
      truncated: false,
    }));
  });

  function Wired() {
    const c = useConversations();
    return (
      <Sidebar
        onNewChat={c.newChat}
        onSelectConversation={c.selectConversation}
        onNavigate={() => {}}
        conversations={c.conversations}
        hasMore={c.hasMore}
        onLoadMore={c.loadMore}
        searchQuery={c.searchQuery}
        onSearchChange={c.setSearchQuery}
        searchResults={c.searchResults}
        searchTruncated={c.searchTruncated}
        isSearching={c.isSearching}
      />
    );
  }

  it('finds a conversation that is not in the loaded page, then clearing restores the page', async () => {
    const user = userEvent.setup();
    render(<Wired />);
    await screen.findByText('Recent 0');
    expect(screen.queryByText('Quarterly budget review')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'budget');
    // Pending (debounce) then running: the busy cue is up and no stale count is announced.
    expect(screen.getByTestId('search-spinner')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Searching…');
    expect(await screen.findByText('Quarterly budget review')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('search-spinner')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('1 conversation found');
    expect(screen.queryByText('Recent 0')).not.toBeInTheDocument();
    expect(db.searchConversations).toHaveBeenLastCalledWith('budget', expect.objectContaining({ isCancelled: expect.any(Function) }));

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(screen.getByText('Recent 0')).toBeInTheDocument());
    expect(screen.queryByText('Quarterly budget review')).not.toBeInTheDocument();
  });

  it('no match shows the empty state', async () => {
    render(<Wired />);
    await screen.findByText('Recent 0');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), { target: { value: 'nothing here' } });
    expect(await screen.findByText('No conversations match')).toBeInTheDocument();
    await act(async () => {});
  });
});
