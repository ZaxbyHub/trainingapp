/**
 * Message input component with send and cancel functionality.
 * Supports multiline input with auto-resize behavior.
 */

import React, { useRef, useCallback, useState, useEffect } from 'react';

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading: boolean;
  onCancel: () => void;
  disabled?: boolean;
}

const MAX_HEIGHT = 150;
const MIN_HEIGHT = 40;

export const ChatInput: React.FC<ChatInputProps> = React.memo(({ onSend, isLoading, onCancel, disabled = false }) => {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;

    onSend(trimmed);
    setValue('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isLoading, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const handleClear = useCallback(() => {
    setValue('');
    textareaRef.current?.focus();
  }, []);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  return (
    <div
      style={{
        padding: 'var(--spacing-md)',
        borderTop: '1px solid var(--color-bubble-system)',
        backgroundColor: 'var(--color-bubble-assistant)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--spacing-sm)',
          maxWidth: '800px',
          margin: '0 auto',
        }}
      >
        <div style={{ position: 'relative', flex: 1 }}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
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
              border: '1px solid var(--color-bubble-system)',
              borderRadius: '8px',
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
              borderRadius: '8px',
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
              borderRadius: '8px',
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
