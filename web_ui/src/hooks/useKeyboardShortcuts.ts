import { useEffect, useCallback } from 'react';

interface UseKeyboardShortcutsProps {
  onSendMessage?: () => void;
  onClearChat?: () => void;
  onOpenSettings: () => void;
  /**
   * #267 (AC4): Escape while a generation is in flight calls this exactly
   * once per press (ChatPage wires its handleCancel — the
   * terminalizeStream('stop') path). Optional: without it Escape does
   * nothing.
   */
  onStopGeneration?: () => void;
  /** True while a generation is in flight; Escape only acts while it is. */
  isGenerating?: boolean;
  /**
   * #267 (AC5): focus the chat composer. Bound to Ctrl/Cmd+K from ANY target
   * and to plain '/' when the target is not editable.
   */
  onFocusComposer?: () => void;
}

/**
 * The global shortcut hook (#267 keyboard-first chat). Registered on window
 * (bubble phase).
 *
 * Priority rules:
 *   - An event another handler already prevented (event.defaultPrevented)
 *     returns immediately. The overlay stack resolves Escape at the DOCUMENT
 *     CAPTURE phase — its dismissible path stopImmediatePropagation()s the
 *     event before it can bubble here, and its non-dismissible path
 *     additionally preventDefault()s; the defaultPrevented check is the belt
 *     for panels that only preventDefault (SourceCitation closes an expanded
 *     citation with preventDefault, so Escape there never stops a stream).
 *   - Escape is handled BEFORE the editable/Ctrl bail-outs: stopping a
 *     runaway generation matters regardless of focus, and it acts only while
 *     `isGenerating` is true.
 *   - Editable targets (INPUT/TEXTAREA/SELECT/contentEditable) keep native
 *     behavior EXCEPT the composer carve-outs: Ctrl/Cmd+Shift+L (clear chat)
 *     and Ctrl/Cmd+, (settings) work from the composer
 *     (`[data-chat-composer]`), and Ctrl/Cmd+K focuses the composer from ANY
 *     target. Ctrl/Cmd+Enter stays composer-owned (ChatInput sends it itself,
 *   so this hook ignores it there).
 *   - preventDefault is called ONLY when the hook actually acts.
 */
export function useKeyboardShortcuts({
  onSendMessage,
  onClearChat,
  onOpenSettings,
  onStopGeneration,
  isGenerating = false,
  onFocusComposer,
}: UseKeyboardShortcutsProps) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      // #267 (AC4): Escape stops the in-flight generation. Before every
      // bail-out below; acts only while generating (otherwise Escape belongs
      // to whatever else is on screen and this hook does nothing).
      if (event.key === 'Escape') {
        if (isGenerating && onStopGeneration) {
          event.preventDefault();
          onStopGeneration();
        }
        return;
      }

      const target = event.target as HTMLElement | null;
      const editable =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable === true);
      // The composer carve-out: shortcuts that must work while the user is
      // typing in the chat composer (#267 AC6).
      const inComposer =
        target instanceof Element && target.closest('[data-chat-composer]') !== null;

      const isCtrl = event.ctrlKey || event.metaKey;

      // '/' (no modifiers): focus the composer — never intercepted while the
      // user types in an input (#267 AC5).
      if (!isCtrl && !event.altKey && event.key === '/') {
        if (editable) return;
        if (onFocusComposer) {
          event.preventDefault();
          onFocusComposer();
        }
        return;
      }

      if (!isCtrl) return;

      switch (event.key) {
        case 'Enter':
          // Composer-owned: ChatInput sends Ctrl/Cmd+Enter itself; other
          // editables keep native behavior.
          if (editable) return;
          if (onSendMessage) {
            event.preventDefault();
            onSendMessage();
          }
          break;
        // U7d: Ctrl+Shift+L clears the chat. Plain Ctrl+L is the browser's
        // focus-address-bar shortcut and must NOT be hijacked (the previous
        // binding overrode it app-wide and double-press cleared the chat).
        // #267 (AC6): works from the composer, ignored in other inputs.
        case 'l':
        case 'L':
          if (event.shiftKey && onClearChat && (!editable || inComposer)) {
            event.preventDefault();
            onClearChat();
          }
          break;
        // #267 (AC6): Ctrl/Cmd+, opens Settings — including from the
        // composer; other inputs are ignored.
        case ',':
          if (!editable || inComposer) {
            event.preventDefault();
            onOpenSettings();
          }
          break;
        // #267 (AC5): Ctrl/Cmd+K focuses the composer from ANY target.
        case 'k':
        case 'K':
          if (onFocusComposer) {
            event.preventDefault();
            onFocusComposer();
          }
          break;
      }
    },
    [onSendMessage, onClearChat, onOpenSettings, onStopGeneration, isGenerating, onFocusComposer]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
