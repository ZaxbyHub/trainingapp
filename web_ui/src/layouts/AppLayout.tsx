import React from 'react';
import { Sidebar, type SidebarPage } from '../components/Sidebar';
import { useSidebarState } from '../hooks/useSidebarState';
import { AppShell } from '../ui';
import './shell.css';

/** The one product name (docs/design/design-language.md section 5); also index.html <title>. */
export const PRODUCT_NAME = 'TrainingApp';

interface AppLayoutProps {
  children: React.ReactNode;
  currentPage: string;
  onNavigate: (page: string) => void;
  currentConversationId?: string;
  conversations?: Array<{ id: string; title: string; updatedAt: string }>;
  onNewChat?: () => void;
  onSelectConversation?: (id: string) => void;
  onRenameConversation?: (id: string, newTitle: string) => void;
  onDeleteConversation?: (id: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

/**
 * App frame: the Lumen AppShell (sidebar / rail / drawer + <main>) around the
 * current page. The desktop collapse state persists (useSidebarState: collapsed
 * by default at <= 1024px, section 3.5); the drawer state does not.
 */
export function AppLayout({
  children,
  currentPage,
  onNavigate,
  currentConversationId,
  conversations,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  hasMore,
  onLoadMore,
}: AppLayoutProps) {
  const { isOpen, toggle } = useSidebarState();
  return (
    <AppShell
      productName={PRODUCT_NAME}
      collapsed={!isOpen}
      onToggleCollapsed={toggle}
      sidebar={
        <Sidebar
          currentPage={currentPage}
          onNavigate={(page: SidebarPage) => onNavigate(page)}
          currentConversationId={currentConversationId}
          conversations={conversations}
          onNewChat={onNewChat || (() => {})}
          onSelectConversation={onSelectConversation || (() => {})}
          onRenameConversation={onRenameConversation}
          onDeleteConversation={onDeleteConversation}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
        />
      }
    >
      {children}
    </AppShell>
  );
}
