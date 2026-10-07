/**
 * Message input component with send and cancel functionality.
 * Supports multiline input with auto-resize behavior.
 */

import React, { useRef, useCallback, useState, useEffect, type ReactNode } from 'react';
import {
  prepareImage,
  validateImageFile,
  type AttachedImage,
} from '../lib/processing/image-input';
import { IconButton } from '../ui';
import '../pages/chat.css';

interface ChatInputProps {
  onSend: (message: string, images?: AttachedImage[]) => void;
  isLoading: boolean;
  onCancel: () => void;
  disabled?: boolean;
  /** Element id explaining WHY the input is disabled (e.g. the chat
   *  model-loading banner) — wired to aria-describedby on the textarea so
   *  assistive tech announces the gate reason (PRR-229). */
  disabledReasonId?: string;
  /** Show the image-attach control (only for multimodal engines, e.g. wllama). */
  imageUploadEnabled?: boolean;
  /** Max images attachable to a single message. */
  maxImages?: number;
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
  imageUploadEnabled = false,
  maxImages = 3,
  onDraftChange,
  status,
}) => {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    // Only pass the 2nd arg when images are attached, to preserve the simple
    // onSend(text) call shape for the common (text-only) path.
    if (images.length > 0) {
      onSend(trimmed, images);
    } else {
      onSend(trimmed);
    }
    setValue('');
    onDraftChange?.('');
    setImages([]);
    setAttachError(null);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isLoading, onSend, images]);

  const handleFilesSelected = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setAttachError(null);
      const incoming = Array.from(fileList);
      // Track count locally so the overflow error fires correctly during multi-select.
      // The closure images.length is accurate at callback-creation time (correct start
      // value), but setImages is async and won't update it mid-loop.
      let runningCount = images.length;

      for (const file of incoming) {
        if (runningCount >= maxImages) {
          setAttachError(`You can attach at most ${maxImages} images.`);
          break;
        }
        const check = validateImageFile(file);
        if (!check.valid) {
          setAttachError(check.error ?? 'Invalid image.');
          continue;
        }
        try {
          const prepared = await prepareImage(file);
          setImages((prev) => (prev.length < maxImages ? [...prev, prepared] : prev));
          runningCount++;
        } catch {
          setAttachError(`Could not read "${file.name}".`);
        }
      }
      // Allow re-selecting the same file.
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [images.length, maxImages]
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

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

  const attachDisabled = isLoading || disabled || images.length >= maxImages;
  const sendDisabled = !value.trim() || disabled;

  return (
    <div className="chat-composer">
      <div className="chat-composer__card" data-loading={isLoading || undefined}>
        {/* Attached-image previews */}
        {images.length > 0 && (
          <div className="chat-composer__previews">
            {images.map((img) => (
              <div key={img.id} className="chat-composer__preview">
                <img src={img.dataUrl} alt={img.fileName} className="chat-composer__thumb" />
                <IconButton
                  icon="x"
                  iconSize={14}
                  variant="danger"
                  size="sm"
                  tooltipPlacement="top"
                  className="chat-composer__remove"
                  onClick={() => removeImage(img.id)}
                  aria-label={`Remove ${img.fileName}`}
                />
              </div>
            ))}
          </div>
        )}
        {attachError && (
          <div role="alert" className="chat-composer__error">
            {attachError}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(e) => void handleFilesSelected(e.target.files)}
          hidden
          aria-hidden="true"
          tabIndex={-1}
        />
        <div className="chat-composer__row">
          {imageUploadEnabled && (
            <IconButton
              icon="paperclip"
              variant="ghost"
              tooltipPlacement="top"
              className="chat-composer__attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachDisabled}
              aria-disabled={attachDisabled || undefined}
              aria-label="Attach image"
            />
          )}
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
