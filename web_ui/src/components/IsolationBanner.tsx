/**
 * Issue #37 P3: persistent dismissible banner shown when the deployment is NOT
 * cross-origin isolated. Without COOP/COEP headers, wllama AND onnxruntime-web
 * silently run single-threaded (~3-4× slower decode; minutes of TTFT on the
 * target i5). The banner surfaces the misconfiguration in the chat flow (not
 * just the passive Settings badge) so an operator notices immediately.
 *
 * Dismissal is per-session (module-level state, not persisted) — the banner
 * returns on reload until the underlying misconfiguration is fixed.
 */

import { useState, useEffect, type CSSProperties } from 'react';

// Module-level dismissal so the banner stays hidden for the rest of the session
// after the user dismisses it, but re-appears on a fresh page load if the
// misconfiguration persists.
let sessionDismissed = false;

const bannerStyle: CSSProperties = {
  backgroundColor: 'var(--color-warning)',
  color: 'var(--color-text-on-warning, #1a1300)',
  padding: 'var(--spacing-sm) var(--spacing-md)',
  fontSize: 'var(--font-size-caption)',
  fontFamily: 'var(--font-family)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--spacing-md)',
  borderBottom: '1px solid rgba(0,0,0,0.1)',
};

const dismissButtonStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid currentColor',
  color: 'inherit',
  fontSize: 'var(--font-size-caption)',
  padding: '2px var(--spacing-sm)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

/**
 * Banner component. Reads `crossOriginIsolated` once at mount (it cannot change
 * without a reload, since the headers are response-time). Hidden when isolated,
 * when previously dismissed this session, or when running in a non-browser
 * context (SSR/tests without `globalThis`).
 */
export function IsolationBanner(): JSX.Element | null {
  const [isolated, setIsolated] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(sessionDismissed);

  useEffect(() => {
    if (typeof globalThis !== 'undefined') {
      setIsolated(globalThis.crossOriginIsolated === true);
    } else {
      setIsolated(true); // non-browser: don't show
    }
  }, []);

  if (isolated === null || isolated || dismissed || sessionDismissed) {
    return null;
  }

  const handleDismiss = () => {
    sessionDismissed = true;
    setDismissed(true);
  };

  return (
    <div role="alert" style={bannerStyle}>
      <span>
        This deployment is misconfigured — responses will be several times slower.
        Cross-Origin Isolation is off. See the packaging guide.
      </span>
      <button
        type="button"
        style={dismissButtonStyle}
        onClick={handleDismiss}
        aria-label="Dismiss misconfiguration banner"
      >
        Dismiss
      </button>
    </div>
  );
}
