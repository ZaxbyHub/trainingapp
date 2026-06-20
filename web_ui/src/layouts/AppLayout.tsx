import React from 'react';
import { NavigationRail } from '../components/NavigationRail';

interface AppLayoutProps {
  children: React.ReactNode;
  currentPage: string;
  onNavigate: (page: string) => void;
}

export function AppLayout({ children, currentPage, onNavigate }: AppLayoutProps) {
  return (
    <div
      style={{
        display: 'flex',
        height: '100dvh',
        width: '100vw',
        overflow: 'hidden',
      }}
    >
      <NavigationRail currentPage={currentPage} onNavigate={onNavigate} />
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
