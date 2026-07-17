import { useEffect, useCallback } from 'react';

interface UseKeyboardShortcutsProps {
  onSendMessage?: () => void;
  onClearChat?: () => void;
  onOpenSettings: () => void;
}

export function useKeyboardShortcuts({
  onSendMessage,
  onClearChat,
  onOpenSettings,
}: UseKeyboardShortcutsProps) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) {
        return;
      }

      const isCtrl = event.ctrlKey || event.metaKey;

      if (!isCtrl) return;

      switch (event.key) {
        case 'Enter':
          if (onSendMessage) {
            event.preventDefault();
            onSendMessage();
          }
          break;
        // U7d: Ctrl+Shift+L clears the chat. Plain Ctrl+L is the browser's
        // focus-address-bar shortcut and must NOT be hijacked (the previous
        // binding overrode it app-wide and double-press cleared the chat).
        case 'l':
        case 'L':
          if (event.shiftKey && onClearChat) {
            event.preventDefault();
            onClearChat();
          }
          break;
        case ',':
          event.preventDefault();
          onOpenSettings();
          break;
      }
    },
    [onSendMessage, onClearChat, onOpenSettings]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
