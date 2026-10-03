import { useId } from 'react';
import { Button, Icon, IconButton, SideNav, useAppShell, type SideNavItem } from '../ui';
import { SidebarConversationItem } from './SidebarConversationItem';
import '../layouts/shell.css';

interface SidebarConversation {
  id: string;
  title: string;
  updatedAt: string;
}

export type SidebarPage = 'chat' | 'documents' | 'training' | 'settings';

interface SidebarProps {
  currentConversationId?: string;
  conversations?: SidebarConversation[];
  currentPage?: string;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onNavigate: (page: SidebarPage) => void;
  onRenameConversation?: (id: string, newTitle: string) => void;
  onDeleteConversation?: (id: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** Conversation search (whole store, see useConversations). Omit to hide the field. */
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  /** null while no search is active; otherwise the matches (newest first). */
  searchResults?: SidebarConversation[] | null;
  /** More matches exist than were returned. */
  searchTruncated?: boolean;
}

/** Primary destinations, at the TOP of the sidebar (design-language.md section 5). */
export const PRIMARY_NAV: readonly (SideNavItem & { id: SidebarPage })[] = [
  { id: 'chat', label: 'Chat', icon: 'message-square' },
  { id: 'documents', label: 'Documents', icon: 'file-text' },
  { id: 'training', label: 'Training', icon: 'layers' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const isSidebarPage = (id: string): id is SidebarPage => PRIMARY_NAV.some((item) => item.id === id);

/**
 * Sidebar body rendered inside the AppShell: primary navigation first, then the
 * "Conversations" section (New chat + list). In the 64px rail only the nav icons
 * and a New chat icon button remain. In the drawer, starting a new chat or
 * choosing a conversation closes the drawer.
 */
export function Sidebar({
  currentConversationId,
  conversations = [],
  currentPage = 'chat',
  onNewChat,
  onSelectConversation,
  onNavigate,
  onRenameConversation,
  onDeleteConversation,
  hasMore,
  onLoadMore,
  searchQuery = '',
  onSearchChange,
  searchResults = null,
  searchTruncated = false,
}: SidebarProps) {
  const { collapsed, drawer, closeDrawer } = useAppShell();
  const headingId = useId();
  const searchId = useId();
  const searching = searchResults !== null;
  const shown = searchResults ?? conversations;
  const clearSearch = () => {
    onSearchChange?.('');
    document.getElementById(searchId)?.focus();
  };

  const startNewChat = () => {
    onNewChat();
    if (drawer) closeDrawer('navigate');
  };
  const selectConversation = (id: string) => {
    onSelectConversation(id);
    if (drawer) closeDrawer('navigate');
  };

  return (
    <>
      <SideNav
        label="Main navigation"
        items={PRIMARY_NAV}
        activeId={currentPage}
        onNavigate={(id) => {
          if (isSidebarPage(id)) onNavigate(id);
        }}
      />
      {collapsed ? (
        <div className="app-sidebar__rail-actions">
          <IconButton icon="plus" aria-label="New chat" onClick={startNewChat} />
        </div>
      ) : (
        <section className="app-sidebar__conversations" aria-labelledby={headingId}>
          <div className="app-sidebar__section-head">
            <h2 id={headingId} className="app-sidebar__section-title">
              Conversations
            </h2>
            <Button size="sm" variant="secondary" onClick={startNewChat}>
              <Icon name="plus" size={16} />
              New chat
            </Button>
          </div>
          {onSearchChange ? (
            <div className="app-sidebar__search" role="search">
              <label htmlFor={searchId} className="ui-visually-hidden">
                Search conversations
              </label>
              <div className="app-sidebar__search-box">
                <Icon name="search" size={16} className="app-sidebar__search-icon" />
                <input
                  id={searchId}
                  type="search"
                  className="ui-input ui-focusable app-sidebar__search-input"
                  placeholder="Search conversations"
                  autoComplete="off"
                  spellCheck={false}
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape clears a non-empty search (and stops there); on an empty
                    // field it falls through, e.g. to close the drawer.
                    if (e.key === 'Escape' && searchQuery !== '') {
                      e.preventDefault();
                      e.stopPropagation();
                      onSearchChange('');
                    }
                  }}
                />
                {searchQuery !== '' ? (
                  <IconButton
                    icon="x"
                    size="sm"
                    aria-label="Clear search"
                    className="app-sidebar__search-clear"
                    onClick={clearSearch}
                  />
                ) : null}
              </div>
              <p className="ui-visually-hidden" role="status">
                {searching
                  ? shown.length === 0
                    ? 'No conversations found'
                    : `${shown.length}${searchTruncated ? ' or more' : ''} conversation${shown.length === 1 && !searchTruncated ? '' : 's'} found`
                  : ''}
              </p>
            </div>
          ) : null}
          <div className="app-sidebar__list">
            {shown.length === 0 ? (
              <p className="app-sidebar__empty">{searching ? 'No conversations match' : 'No conversations yet'}</p>
            ) : (
              shown.map((conversation) => (
                <SidebarConversationItem
                  key={conversation.id}
                  id={conversation.id}
                  title={conversation.title}
                  timestamp={conversation.updatedAt}
                  isSelected={currentConversationId === conversation.id}
                  onSelect={selectConversation}
                  onRename={onRenameConversation || (() => {})}
                  onDelete={onDeleteConversation || (() => {})}
                />
              ))
            )}
            {searching && searchTruncated ? (
              <p className="app-sidebar__note">Showing the most recent matches. Refine your search to see others.</p>
            ) : null}
            {!searching && conversations.length > 0 && hasMore ? (
              <Button size="sm" variant="ghost" className="app-sidebar__more" onClick={onLoadMore || (() => {})}>
                Load more
              </Button>
            ) : null}
          </div>
        </section>
      )}
    </>
  );
}
