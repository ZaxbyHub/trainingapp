/**
 * B9 (issue #67): blocking, informative state for the Electron first-run
 * model check. Shown when the desktop backend reports `engine !== 'stub'`
 * AND neither the Quality nor the Fast GGUF is staged on disk — the state
 * where the first /ask would 503. Extracted into its own component per the
 * shared-file convention (ModelBlockedOverlay extraction, PR #32): ChatPage
 * renders it as a one-liner and never grows overlay logic of its own.
 *
 * A11y parity with ModelBlockedOverlay (PR-review F8): remembers and restores
 * the previously focused element, traps Tab within the dialog, and closes on
 * Escape. Documents/Settings remain reachable through the nav rail after
 * close; this overlay blocks only the chat send path, matching AC5's
 * "informative state instead of a silently failing /ask".
 */
import React, { useEffect, useRef } from 'react';

export interface DesktopModelBlockedOverlayProps {
  open: boolean;
}

export function DesktopModelBlockedOverlay({ open }: DesktopModelBlockedOverlayProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
    }
    // The dialog has a single focusable element (the heading); keep Tab from
    // escaping into the blocked page beneath.
    if (e.key === 'Tab') e.preventDefault();
  };

  if (!open) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="desktop-model-gate-title"
      aria-describedby="desktop-model-gate-body"
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
        fontFamily: 'var(--font-family)',
      }}
    >
      <div
        style={{
          maxWidth: 460,
          margin: 'var(--spacing-lg)',
          padding: 'var(--spacing-xl)',
          backgroundColor: 'var(--color-bg-primary, #fff)',
          color: 'var(--color-text-primary)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border, #ddd)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-md)',
        }}
      >
        <h2
          id="desktop-model-gate-title"
          ref={headingRef}
          tabIndex={-1}
          style={{ margin: 0, fontSize: 'var(--font-size-h3, 1.25rem)', outline: 'none' }}
        >
          AI models are not installed yet
        </h2>
        <p id="desktop-model-gate-body" style={{ margin: 0, fontSize: 'var(--font-size-body)', lineHeight: 1.5 }}>
          Neither the Quality nor the Fast language model was found in this app&apos;s
          model directory, so asking questions is unavailable right now. Documents and
          Settings remain available. Re-run the app installer or add the model files to
          the models directory, then restart the app.
        </p>
      </div>
    </div>
  );
}
