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

import { useState, useEffect } from 'react';
import { Banner, Button } from '../ui';
import '../pages/chat.css';

// Module-level dismissal so the banner stays hidden for the rest of the session
// after the user dismisses it, but re-appears on a fresh page load if the
// misconfiguration persists.
let sessionDismissed = false;

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

  // Lumen phase 5: the ui Banner (tone warning keeps role="alert").
  return (
    <Banner
      tone="warning"
      className="chat-isolation"
      action={
        <Button size="sm" onClick={handleDismiss} aria-label="Dismiss misconfiguration banner">
          Dismiss
        </Button>
      }
    >
      This deployment is misconfigured — responses will be several times slower.
      Cross-Origin Isolation is off. See the packaging guide.
    </Banner>
  );
}
