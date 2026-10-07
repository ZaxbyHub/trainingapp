import { useState, useEffect } from 'react';
import { SIDEBAR_OPEN_KEY } from '../lib/storage/persisted-keys';

export interface SidebarState {
  isOpen: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

/** The open state when nothing usable is persisted: open on wide windows, closed on narrow ones. */
function defaultOpen(): boolean {
  return window.innerWidth > 1024;
}

export function useSidebarState(): SidebarState {
  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      // Web storage can throw on access (a SecurityError where storage is blocked). The sidebar
      // state is a convenience, so a failed read falls back to the default instead of crashing
      // the shell (critic-final-2 D1).
      let saved: string | null;
      try {
        saved = localStorage.getItem(SIDEBAR_OPEN_KEY);
      } catch {
        return defaultOpen();
      }
      if (saved !== null) return saved === 'true';
      return defaultOpen();
    }
    return true;
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, isOpen.toString());
    } catch {
      // Blocked or full storage: the state just is not remembered across reloads.
    }
  }, [isOpen]);

  const toggle = () => setIsOpen((prev) => !prev);
  const setOpen = (open: boolean) => setIsOpen(open);

  return { isOpen, toggle, setOpen };
}
