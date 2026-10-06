import { useState, useEffect } from 'react';
import { SIDEBAR_OPEN_KEY } from '../lib/storage/persisted-keys';

export interface SidebarState {
  isOpen: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

export function useSidebarState(): SidebarState {
  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      // COUPLING: this read is unguarded, so storage that throws here crashes the app into the
      // App-level ErrorBoundary. web_ui/e2e/visual/lumen-baseline.spec.ts (crash-page) relies on
      // exactly that to render the crash fallback; guarding this read needs a new crash seam there.
      const saved = localStorage.getItem(SIDEBAR_OPEN_KEY);
      if (saved !== null) return saved === 'true';
      return window.innerWidth > 1024;
    }
    return true;
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_OPEN_KEY, isOpen.toString());
  }, [isOpen]);

  const toggle = () => setIsOpen((prev) => !prev);
  const setOpen = (open: boolean) => setIsOpen(open);

  return { isOpen, toggle, setOpen };
}
