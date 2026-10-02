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
