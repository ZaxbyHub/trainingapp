/**
 * Message input component with send and cancel functionality.
 * Supports multiline input with auto-resize behavior.
 *
 * Issue #156: the image-attach control was removed with the Gemma 4 + mmproj
 * multimodal surface — the packaged browser LLM (LFM2-1.2B-RAG) is text-only.
 */

import React, { useRef, useCallback, useState, useEffect, type ReactNode } from 'react';
import { IconButton } from '../ui';
import '../pages/chat.css';

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading: boolean;
  onCancel: () => void;
  disabled?: boolean;
  /** Element id explaining WHY the input is disabled (e.g. the chat
   *  model-loading banner) — wired to aria-describedby on the textarea so
   *  assistive tech announces the gate reason (PRR-229). */
  disabledReasonId?: string;
  /** Notifies the parent of the current draft text so a global shortcut
   *  (Ctrl+Enter) can send it without owning the input state. */
  onDraftChange?: (text: string) => void;
  /** Status row rendered INSIDE the composer card (Lumen phase 5): the streaming /
   *  model-load indicator. The row collapses when this renders nothing. */
  status?: ReactNode;
}

const MAX_HEIGHT = 150;
const MIN_HEIGHT = 40;

export const ChatInput: React.FC<ChatInputProps> = React.memo(({
  onSend,
  isLoading,
  onCancel,
  disabled = false,
  disabledReasonId,
  onDraftChange,
  status,
}) => {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    // Height is a measured value (CSSOM, not a style prop); whether the content
    // overflows the cap is a state the stylesheet acts on (pages/chat.css).
    textarea.style.height = `${newHeight}px`;
    textarea.dataset.overflow = textarea.scrollHeight > MAX_HEIGHT ? 'scroll' : 'none';
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // The auto-resize measures the (placeholder) text, so it must re-measure once the
  // web font is in: measured against the fallback font the placeholder fits on one
  // line, and at narrow widths the composer stays one line tall with the real
  // font's second line clipped. (Which weights are already loaded when the chat
  // mounts depends on what the boot screen rendered, so this is a latent race.)
  // Lazily fetched unicode-range subsets (Greek/Cyrillic/Vietnamese) land after `ready`
  // has resolved, so `loadingdone` re-measures too.
  useEffect(() => {
    // adjustHeight is a no-op once the textarea ref is cleared, so a late-resolving
    // promise after unmount needs no cancel flag.
    void document.fonts?.ready.then(adjustHeight);
    const fonts = document.fonts;
    fonts?.addEventListener?.('loadingdone', adjustHeight);
    return () => fonts?.removeEventListener?.('loadingdone', adjustHeight);
  }, [adjustHeight]);

  // Pasted text can need glyphs whose font has not loaded yet: re-measure once it has.
  const handlePaste = useCallback(() => {
    void document.fonts?.ready.then(adjustHeight);
  }, [adjustHeight]);

  // Focus restoration: sending a message disables the textarea (isLoading),
  // which drops focus to <body>. When generation ends and the textarea
  // re-enables, move focus back so keyboard users aren't stranded on body.
  useEffect(() => {
    if (!isLoading) {
      textareaRef.current?.focus();
    }
  }, [isLoading]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;

    onSend(trimmed);
    setValue('');
    onDraftChange?.('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isLoading, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition guard: when the user is mid-composition (CJK/Vietnamese
      // input methods), Enter confirms a candidate — it must NOT send the
      // message. Check before any Enter-to-send logic.
      if (e.key === 'Enter' && e.nativeEvent.isComposing) {
        return;
      }
      // Enter (no Shift): send. Ctrl/Cmd+Enter also sends — the global
      // useKeyboardShortcuts handler bails on TEXTAREA targets, so without
      // handling Ctrl/Cmd+Enter here it would do nothing while the input is
      // focused (the primary "send from chat input" case, AC6). The first
      // branch already covers plain Ctrl/Cmd+Enter (shiftKey is false); the
      // else-if extends send to Shift+Ctrl/Cmd+Enter so the modifier wins over
      // the "Shift+Enter = newline" reading. (PR #28 PRR-002)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const handleClear = useCallback(() => {
    setValue('');
    // Keep the parent's draft mirror in sync so a subsequent Ctrl+Enter
    // (global shortcut, focus outside the textarea) doesn't send stale text.
    // (PR #28 PRR-007)
    onDraftChange?.('');
    textareaRef.current?.focus();
  }, [onDraftChange]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const sendDisabled = !value.trim() || disabled;

  return (
    <div className="chat-composer">
      <div className="chat-composer__card" data-loading={isLoading || undefined}>
        <div className="chat-composer__row">
          <textarea
            ref={textareaRef}
            className="chat-composer__input"
            value={value}
            onChange={(e) => {
              const next = e.target.value;
              setValue(next);
              onDraftChange?.(next);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
            disabled={isLoading || disabled}
            rows={1}
            aria-label="Message input"
            aria-describedby={disabledReasonId}
          />
          {value && !isLoading && (
            <IconButton
              icon="x"
              iconSize={18}
              variant="ghost"
              tooltipPlacement="top"
              className="chat-composer__clear"
              onClick={handleClear}
              aria-label="Clear input"
            />
          )}
          {isLoading ? (
            <IconButton
              icon="square"
              iconSize={16}
              variant="secondary"
              tooltipPlacement="top"
              className="chat-composer__stop"
              onClick={handleCancel}
              aria-label="Stop generation"
            />
          ) : (
            <IconButton
              icon="arrow-up"
              variant="primary"
              tooltipPlacement="top"
              className="chat-composer__send"
              onClick={handleSubmit}
              disabled={sendDisabled}
              aria-disabled={sendDisabled || undefined}
              aria-label="Send message"
            />
          )}
        </div>
        {/* Status row inside the card (streaming / model-load progress). Hidden by
            CSS (:empty) when the status element renders nothing. */}
        <div className="chat-composer__status">{status}</div>
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
