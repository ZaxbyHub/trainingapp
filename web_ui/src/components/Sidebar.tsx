import { useSidebarState } from '../hooks/useSidebarState';
import { SidebarConversationItem } from './SidebarConversationItem';

interface SidebarConversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface SidebarProps {
  currentConversationId?: string;
  conversations?: SidebarConversation[];
  currentPage?: string;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onNavigate: (page: 'chat' | 'documents' | 'settings') => void;
  onToggle?: () => void;
  onRenameConversation?: (id: string, newTitle: string) => void;
  onDeleteConversation?: (id: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

const ChatIcon = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const DocumentsIcon = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </svg>
);

const SettingsIcon = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const navItems = [
  { id: 'chat' as const, label: 'Chat', icon: <ChatIcon /> },
  { id: 'documents' as const, label: 'Documents', icon: <DocumentsIcon /> },
  { id: 'settings' as const, label: 'Settings', icon: <SettingsIcon /> },
];

export function Sidebar({
  currentConversationId,
  conversations = [],
  currentPage = 'chat',
  onNewChat,
  onSelectConversation,
  onNavigate,
  onToggle,
  onRenameConversation,
  onDeleteConversation,
  hasMore,
  onLoadMore,
}: SidebarProps) {
  const { isOpen, toggle } = useSidebarState();

  const handleToggle = () => {
    toggle();
    onToggle?.();
  };

  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: isOpen ? '260px' : '64px',
        height: '100%',
        backgroundColor: 'var(--color-surface)',
        boxShadow: 'var(--shadow-sm)',
        borderRight: '1px solid var(--color-secondary)',
        transition: 'width 200ms ease',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: isOpen ? 'space-between' : 'center',
          padding: 'var(--spacing-md)',
          borderBottom: '1px solid var(--color-secondary)',
        }}
      >
        {isOpen && (
          <span
            style={{
              fontSize: 'var(--font-size-body)',
              fontFamily: 'var(--font-family)',
              fontWeight: 600,
              color: 'var(--color-text-on-bubble-assistant)',
            }}
          >
            Menu
          </span>
        )}
        <button
          type="button"
          onClick={handleToggle}
          aria-label={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '32px',
            height: '32px',
            padding: 0,
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'transparent',
            color: 'var(--color-text-on-bubble-assistant)',
            cursor: 'pointer',
            transition: 'background-color 150ms ease',
          }}
        >
          {isOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </button>
      </div>

      {/* New Chat Button */}
      <div style={{ padding: 'var(--spacing-sm)' }}>
        <button
          type="button"
          onClick={onNewChat}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: isOpen ? 'flex-start' : 'center',
            width: '100%',
            padding: isOpen ? 'var(--spacing-sm) var(--spacing-md)' : 'var(--spacing-sm)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--color-primary)',
            color: 'var(--color-text-on-primary)',
            cursor: 'pointer',
            fontSize: 'var(--font-size-small)',
            fontFamily: 'var(--font-family)',
            fontWeight: 500,
            gap: 'var(--spacing-sm)',
            transition: 'background-color 150ms ease',
          }}
        >
          <span style={{ fontSize: '18px', lineHeight: 1 }}>+</span>
          {isOpen && <span>New Chat</span>}
        </button>
      </div>

      {/* Conversation List */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 'var(--spacing-sm)',
        }}
      >
        {conversations.length === 0 ? (
          isOpen && (
            <div
              style={{
                padding: 'var(--spacing-md)',
                textAlign: 'center',
                color: 'var(--color-text-muted)',
                fontSize: 'var(--font-size-small)',
                fontFamily: 'var(--font-family)',
              }}
            >
              No conversations yet
            </div>
          )
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--spacing-xs)',
            }}
          >
            {conversations.map((conversation) => (
              <SidebarConversationItem
                key={conversation.id}
                id={conversation.id}
                title={conversation.title}
                timestamp={conversation.updatedAt}
                isSelected={currentConversationId === conversation.id}
                onSelect={onSelectConversation}
                onRename={onRenameConversation || (() => {})}
                onDelete={onDeleteConversation || (() => {})}
              />
            ))}
            {isOpen && hasMore && (
              <button
                type="button"
                onClick={onLoadMore || (() => {})}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: 'var(--spacing-sm)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'transparent',
                  color: 'var(--color-text-muted)',
                  fontSize: 'var(--font-size-small)',
                  fontFamily: 'var(--font-family)',
                  cursor: 'pointer',
                  textAlign: 'center',
                  marginTop: 'var(--spacing-xs)',
                }}
              >
                Load more...
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom Navigation */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: 'var(--spacing-sm)',
          gap: 'var(--spacing-xs)',
          borderTop: '1px solid var(--color-secondary)',
        }}
      >
        {navItems.map((item) => {
          const isActive = currentPage === item.id;
          return (
            <button
              type="button"
              key={item.id}
              onClick={() => onNavigate(item.id)}
              aria-current={isActive ? 'page' : undefined}
              title={item.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: isOpen ? 'flex-start' : 'center',
                padding: isOpen ? 'var(--spacing-sm) var(--spacing-md)' : 'var(--spacing-sm)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: isActive ? 'var(--color-primary)' : 'transparent',
                color: isActive
                  ? 'var(--color-text-on-primary)'
                  : 'var(--color-text-on-bubble-assistant)',
                cursor: 'pointer',
                fontSize: 'var(--font-size-small)',
                fontFamily: 'var(--font-family)',
                gap: 'var(--spacing-sm)',
                transition: 'background-color 150ms ease',
                width: '100%',
              }}
            >
              <span style={{ flexShrink: 0 }}>{item.icon}</span>
              {isOpen && <span>{item.label}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
