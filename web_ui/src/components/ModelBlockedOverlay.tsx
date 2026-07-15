/**
 * ModelBlockedOverlay — full-blocking modal shown when the browser model is not
 * ready. Extracted from ChatPage (issue #25) so the shared ChatPage.tsx file
 * stays a thin caller, and so the overlay can carry proper dialog semantics:
 * role="alertdialog", aria-modal="true", a focus trap, and focus restoration.
 *
 * (issue #21 F10 originally mounted the overlay as an inline IIFE; #25 lifts
 * it into its own component and adds the a11y guarantees.)
 */

import React, { useEffect, useRef } from 'react';
import type { ReadinessResult } from '../lib/llm/model-readiness';
import type { BrowserEngine } from '../types/llm';

interface ModelBlockedOverlayProps {
  readinessResult: ReadinessResult | null;
  browserEngine: BrowserEngine;
  modelLoadingProgress: number;
  onRetry: () => void;
  onOpenSettings: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ModelBlockedOverlay({
  readinessResult,
  browserEngine,
  modelLoadingProgress,
  onRetry,
  onOpenSettings,
}: ModelBlockedOverlayProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  // Remember the element that had focus before the overlay opened so we can
  // restore it when the overlay unmounts.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // Move focus into the dialog on open.
    retryRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !dialog.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the trigger on close.
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  const failures = readinessResult?.failures ?? [];
  const recommendations = readinessResult?.recommendations ?? [];
  const hasRealFailure = failures.length > 0;
  const headline = hasRealFailure
    ? (browserEngine === 'wllama'
        ? 'This build is missing the packaged model. See the Packaging guide or contact your administrator.'
        : 'The browser model is not available. Use Settings to download it, or switch engines.')
    : 'Preparing the model…';

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // Above the header (zIndex 101) so the scrim covers header controls,
        // reinforcing the blocking intent alongside aria-modal.
        zIndex: 200,
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="Model not ready"
        style={{
          backgroundColor: 'var(--color-surface)',
          padding: 'var(--spacing-xl)',
          borderRadius: '8px',
          textAlign: 'center',
          maxWidth: '460px',
        }}
      >
        <p
          style={{
            fontSize: 'var(--font-size-body)',
            color: 'var(--color-text-on-bubble-assistant)',
            fontFamily: 'var(--font-family)',
            marginBottom: 'var(--spacing-md)',
          }}
        >
          {headline}
        </p>
        {!hasRealFailure && modelLoadingProgress > 0 && (
          <>
            <div
              role="progressbar"
              aria-valuenow={modelLoadingProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Model loading progress"
              style={{
                width: '100%',
                height: '8px',
                backgroundColor: 'var(--color-bubble-system)',
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${modelLoadingProgress}%`,
                  height: '100%',
                  backgroundColor: 'var(--color-success-strong)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <p
              style={{
                fontSize: 'var(--font-size-caption)',
                color: 'var(--color-text-muted)',
                fontFamily: 'var(--font-family)',
                marginTop: 'var(--spacing-sm)',
              }}
            >
              {modelLoadingProgress}%
            </p>
          </>
        )}
        {failures.length > 0 && (
          <ul
            style={{
              textAlign: 'left',
              color: 'var(--color-danger)',
              fontSize: 'var(--font-size-caption)',
              fontFamily: 'var(--font-family)',
              margin: 'var(--spacing-sm) 0',
              padding: '0 var(--spacing-md)',
            }}
          >
            {failures.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        )}
        {recommendations.length > 0 && (
          <ul
            style={{
              textAlign: 'left',
              color: 'var(--color-text-muted)',
              fontSize: 'var(--font-size-caption)',
              fontFamily: 'var(--font-family)',
              margin: 'var(--spacing-sm) 0',
              padding: '0 var(--spacing-md)',
            }}
          >
            {recommendations.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', justifyContent: 'center', marginTop: 'var(--spacing-md)' }}>
          <button
            ref={retryRef}
            type="button"
            onClick={onRetry}
            style={{
              backgroundColor: 'var(--color-primary)',
              color: 'var(--color-text-on-primary)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: 'var(--spacing-xs) var(--spacing-sm)',
              fontFamily: 'var(--font-family)',
              fontSize: 'var(--font-size-caption)',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            style={{
              backgroundColor: 'transparent',
              color: 'var(--color-text-muted)',
              border: '1px solid var(--color-text-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: 'var(--spacing-xs) var(--spacing-sm)',
              fontFamily: 'var(--font-family)',
              fontSize: 'var(--font-size-caption)',
              cursor: 'pointer',
            }}
          >
            Open Settings
          </button>
        </div>
      </div>
    </div>
  );
}

export default ModelBlockedOverlay;
