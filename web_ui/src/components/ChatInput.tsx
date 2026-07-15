/**
 * Message input component with send and cancel functionality.
 * Supports multiline input with auto-resize behavior.
 */

import React, { useRef, useCallback, useState, useEffect } from 'react';
import {
  prepareImage,
  validateImageFile,
  type AttachedImage,
} from '../lib/processing/image-input';

interface ChatInputProps {
  onSend: (message: string, images?: AttachedImage[]) => void;
  isLoading: boolean;
  onCancel: () => void;
  disabled?: boolean;
  /** Show the image-attach control (only for multimodal engines, e.g. wllama). */
  imageUploadEnabled?: boolean;
  /** Max images attachable to a single message. */
  maxImages?: number;
  /** Notifies the parent of the current draft text so a global shortcut
   *  (Ctrl+Enter) can send it without owning the input state. */
  onDraftChange?: (text: string) => void;
}

const MAX_HEIGHT = 150;
const MIN_HEIGHT = 40;

export const ChatInput: React.FC<ChatInputProps> = React.memo(({
  onSend,
  isLoading,
  onCancel,
  disabled = false,
  imageUploadEnabled = false,
  maxImages = 3,
  onDraftChange,
}) => {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

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

  return (
    <div
      style={{
        padding: 'var(--spacing-md)',
        borderTop: '1px solid var(--color-bubble-system)',
        backgroundColor: 'var(--color-bubble-assistant)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {/* Attached-image previews */}
      {images.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-sm)',
            maxWidth: '800px',
            margin: '0 auto var(--spacing-sm)',
          }}
        >
          {images.map((img) => (
            <div key={img.id} style={{ position: 'relative' }}>
              <img
                src={img.dataUrl}
                alt={img.fileName}
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 'var(--radius-sm)', display: 'block' }}
              />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                aria-label={`Remove ${img.fileName}`}
                style={{
                  position: 'absolute', top: -6, right: -6, width: 18, height: 18,
                  borderRadius: '50%', border: 'none', cursor: 'pointer', lineHeight: 1,
                  background: 'var(--color-danger)', color: 'var(--color-text-on-primary)', fontSize: 12,
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && (
        <div
          role="alert"
          style={{
            maxWidth: '800px', margin: '0 auto var(--spacing-sm)',
            color: 'var(--color-danger)', fontSize: 'var(--font-size-caption)',
          }}
        >
          {attachError}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onChange={(e) => void handleFilesSelected(e.target.files)}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--spacing-sm)',
          maxWidth: '800px',
          margin: '0 auto',
        }}
      >
        {imageUploadEnabled && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || disabled || images.length >= maxImages}
            title="Attach image"
            aria-label="Attach image"
            style={{
              height: MIN_HEIGHT, width: MIN_HEIGHT, flexShrink: 0,
              backgroundColor: 'var(--color-bubble-user)',
              color: 'var(--color-text-on-bubble-user)',
              border: '1px solid var(--color-bubble-system)', borderRadius: 'var(--radius-md)',
              cursor: isLoading || disabled || images.length >= maxImages ? 'not-allowed' : 'pointer',
              fontSize: 'var(--font-size-body)',
            }}
          >
            📎
          </button>
        )}
        <div style={{ position: 'relative', flex: 1 }}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              const next = e.target.value;
              setValue(next);
              onDraftChange?.(next);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Ask a question..."
            disabled={isLoading || disabled}
            rows={1}
            style={{
              width: '100%',
              minHeight: `${MIN_HEIGHT}px`,
              maxHeight: `${MAX_HEIGHT}px`,
              padding: 'var(--spacing-md)',
              paddingRight: value ? 'var(--spacing-xxl)' : 'var(--spacing-md)',
              fontSize: 'var(--font-size-body)',
              fontFamily: 'var(--font-family)',
              border: `1px solid ${isFocused ? 'var(--color-primary)' : 'var(--color-bubble-system)'}`,
              borderRadius: 'var(--radius-lg)',
        boxShadow: isFocused
          ? 'var(--shadow-md)'
          : 'var(--shadow-sm)',
              resize: 'none',
              overflowY: 'hidden',
              lineHeight: 1.4,
              backgroundColor: 'var(--color-bubble-user)',
              color: 'var(--color-text-on-bubble-user)',
            }}
            aria-label="Message input"
          />
          {value && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              style={{
                position: 'absolute',
                right: 'var(--spacing-sm)',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 'var(--spacing-xs)',
                color: 'var(--color-text-muted)',
                fontSize: 'var(--font-size-body)',
                lineHeight: 1,
              }}
              aria-label="Clear input"
            >
              ✕
            </button>
          )}
        </div>

        {isLoading ? (
          <button
            type="button"
            onClick={handleCancel}
            style={{
              height: MIN_HEIGHT,
              padding: 'var(--spacing-sm) var(--spacing-lg)',
              fontSize: 'var(--font-size-body)',
              fontFamily: 'var(--font-family)',
              backgroundColor: 'var(--color-danger)',
              color: 'var(--color-text-on-primary)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              fontWeight: 500,
            }}
            aria-label="Stop generation"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim() || disabled}
            style={{
              height: MIN_HEIGHT,
              padding: 'var(--spacing-sm) var(--spacing-lg)',
              fontSize: 'var(--font-size-body)',
              fontFamily: 'var(--font-family)',
              backgroundColor: value.trim() ? 'var(--color-primary)' : 'var(--color-secondary)',
              color: 'var(--color-text-on-primary)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: value.trim() ? 'pointer' : 'not-allowed',
              fontWeight: 500,
              opacity: value.trim() ? 1 : 0.6,
            }}
            aria-label="Send message"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
