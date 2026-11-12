/**
 * BundledPacksBoot — the browser app's every-boot bundled-pack ensure (#266,
 * plan B4).
 *
 * Mounted inside AppContent (UNDER ToastProvider — main.tsx is outside the
 * toast context), never inside Electron or a framed context: the desktop app
 * has its own ensure (main/index.ts), and a framed app has no pack runtime
 * (ADR-0012 framing rules).
 *
 * Surfaces:
 *   - an ALWAYS-MOUNTED polite status region whose text appears when pack
 *     work starts ("Preparing knowledge packs…") and clears when it ends —
 *     a live region must exist before its text changes, and a boot status is
 *     not an interruption (no alert role);
 *   - per-pack failure TOASTS that name the pack (non-blocking; the app stays
 *     usable — per-pack isolation lives in bundled-packs-boot.ts).
 *
 * The ensure is scheduled post-commit (requestAnimationFrame) so the first
 * paint is never blocked, and the module-level single-flight in
 * bundled-packs-boot.ts makes StrictMode's double-mounted effect join one run.
 */

import { useEffect, useState } from 'react';
import { useToast } from './ToastProvider';
import { getBrowserPackManager } from '../lib/packs/browser-pack-manager';
import { ensureBundledPacksInBrowser, isBundledPacksBootEligible } from '../lib/packs/bundled-packs-boot';

export function BundledPacksBoot(): React.ReactElement | null {
  const { showToast } = useToast();
  const [statusText, setStatusText] = useState<string | null>(null);

  useEffect(() => {
    // Browser app only, never Electron, never framed — the eligibility
    // predicate is exported and pinned by bundled-packs-boot.test.ts.
    if (!isBundledPacksBootEligible()) return undefined;
    let cancelled = false;
    // Post-commit scheduling: the boot ensure never blocks first paint.
    const raf = requestAnimationFrame(() => {
      void ensureBundledPacksInBrowser({
        manager: getBrowserPackManager(),
        onStatus: (text) => {
          if (!cancelled) setStatusText(text);
        },
        onPackFailure: (packId, detail) => {
          showToast(`Could not install the bundled pack "${packId}": ${detail}`, 'error');
        },
      }).catch((error: unknown) => {
        // Never expected (the ensure itself never throws) — belt only.
        console.warn('[packs] bundled pack boot ensure failed:', error);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [showToast]);

  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="bundled-packs-status"
      className="ui-visually-hidden"
    >
      {statusText}
    </p>
  );
}
