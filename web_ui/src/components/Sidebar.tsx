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
}: SidebarProps) {
  const { collapsed, drawer, closeDrawer } = useAppShell();
  const headingId = useId();

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
          <div className="app-sidebar__list">
            {conversations.length === 0 ? (
              <p className="app-sidebar__empty">No conversations yet</p>
            ) : (
              conversations.map((conversation) => (
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
            {conversations.length > 0 && hasMore ? (
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
