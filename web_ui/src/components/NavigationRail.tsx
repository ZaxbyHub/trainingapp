import React, { useState } from 'react';

interface NavigationRailProps {
  currentPage: string;
  onNavigate: (page: string) => void;
}

const navItems = [
  { id: 'chat', label: 'Chat' },
  { id: 'documents', label: 'Documents' },
  { id: 'settings', label: 'Settings' },
];

// Simple inline SVG icons
const ChatIcon = () => (
  <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const DocumentsIcon = () => (
  <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const SettingsIcon = () => (
  <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const icons: Record<string, React.ReactNode> = {
  chat: <ChatIcon />,
  documents: <DocumentsIcon />,
  settings: <SettingsIcon />,
};

export function NavigationRail({ currentPage, onNavigate }: NavigationRailProps) {
  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '64px',
        height: '100%',
        backgroundColor: 'var(--color-bubble-system)',
        padding: 'var(--spacing-md) var(--spacing-sm)',
        gap: 'var(--spacing-md)',
        borderRight: '1px solid var(--color-secondary)',
      }}
    >
      {navItems.map((item) => {
        const isActive = currentPage === item.id;
        const [hovered, setHovered] = useState(false);
        return (
          <button
            type="button"
            key={item.id}
            onClick={() => onNavigate(item.id)}
            aria-current={isActive ? 'page' : undefined}
            title={item.label}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'var(--spacing-md)',
              border: 'none',
              borderRadius: 'var(--spacing-sm)',
              backgroundColor: isActive ? 'var(--color-primary)' : hovered ? 'var(--color-secondary)' : 'transparent',
              color: isActive ? 'var(--color-text-on-primary)' : 'var(--color-text-on-bubble-assistant)',
              cursor: 'pointer',
              transition: 'background-color 200ms ease, color 200ms ease',
              fontSize: 'var(--font-size-small)',
              fontFamily: 'var(--font-family)',
              minHeight: '56px',
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <span style={{ marginBottom: 'var(--spacing-xs)' }}>{icons[item.id]}</span>
            <span style={{ fontSize: 'var(--font-size-small)' }}>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
