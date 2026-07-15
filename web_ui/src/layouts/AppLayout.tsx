import React from 'react';
import { Sidebar } from '../components/Sidebar';

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
  return (
    <div
      style={{
        display: 'flex',
        height: '100dvh',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      <Sidebar
        currentPage={currentPage}
        onNavigate={onNavigate}
        currentConversationId={currentConversationId}
        conversations={conversations}
        onNewChat={onNewChat || (() => {})}
        onSelectConversation={onSelectConversation || (() => {})}
        onRenameConversation={onRenameConversation}
        onDeleteConversation={onDeleteConversation}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
      />
      <main
        style={{
          flex: 1,
          overflow: 'auto',
          backgroundColor: 'var(--color-bubble-assistant)',
        }}
      >
        {children}
      </main>
    </div>
  );
}
