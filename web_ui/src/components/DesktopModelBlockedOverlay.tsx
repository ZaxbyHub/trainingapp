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
import { MODEL_CONNECTION_SECTION_ID } from '../lib/settings-sections';

export interface DesktopModelBlockedOverlayProps {
  open: boolean;
  /**
   * Open Settings; with a section id, Settings scrolls to and focuses it
   * (the same section-aware seam ModelBlockedOverlay uses). When provided,
   * the overlay offers "Open Settings" and "Use a local server or cloud
   * model" (universal-provider-settings-overhaul: parity with the browser
   * overlay — an external model needs no staged GGUF).
   */
  onOpenSettings?: (section?: string) => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const secondaryButtonStyle: React.CSSProperties = {
  backgroundColor: 'transparent',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border, #ddd)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--spacing-xs) var(--spacing-sm)',
  fontFamily: 'var(--font-family)',
  fontSize: 'var(--font-size-caption)',
  cursor: 'pointer',
};

export function DesktopModelBlockedOverlay({ open, onOpenSettings }: DesktopModelBlockedOverlayProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
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
    if (e.key !== 'Tab') return;
    // Keep Tab inside the dialog: cycle through its actions (the heading is
    // focusable only programmatically). With no actions, Tab stays put.
    const dialog = dialogRef.current;
    const focusables = dialog === null ? [] : Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    const active = document.activeElement;
    const inside = active !== null && focusables.includes(active as HTMLElement);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
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
          {onOpenSettings !== undefined && ' Or connect an external model (a local server or a cloud provider) in Settings.'}
        </p>
        {onOpenSettings !== undefined && (
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => onOpenSettings()} style={secondaryButtonStyle}>
              Open Settings
            </button>
            <button
              type="button"
              onClick={() => onOpenSettings(MODEL_CONNECTION_SECTION_ID)}
              style={{
                ...secondaryButtonStyle,
                backgroundColor: 'var(--color-primary)',
                color: 'var(--color-text-on-primary)',
                border: 'none',
              }}
            >
              Use a local server or cloud model
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
