/**
 * First-run validation wizard client (E2, issue #85).
 *
 * Thin, typed access to the desktop bridge's first-run surface. Browser mode
 * (no Electron) never sees the wizard: every call here requires
 * window.desktopApi and the caller renders nothing without it — the wizard is
 * a desktop-only surface, exactly like the B9 model-presence gate.
 */
import type { FirstRunStatus } from '../types/desktop';

export type { FirstRunStatus, FirstRunManifestFailure } from '../types/desktop';

function requireBridge(): NonNullable<Window['desktopApi']> {
  const bridge = typeof window !== 'undefined' ? window.desktopApi : undefined;
  if (bridge === undefined) {
    throw new Error('first-run wizard requires the desktop bridge (Electron only)');
  }
  return bridge;
}

/** Fetch the wizard status; null when the bridge or handler is not ready yet
 *  (the handlers register only after the backend host started). */
export async function fetchFirstRunStatus(): Promise<FirstRunStatus | null> {
  if (typeof window === 'undefined' || window.desktopApi === undefined) return null;
  try {
    return await requireBridge().getFirstRunStatus();
  } catch {
    // Handler not registered yet (backend still starting) — retryable.
    return null;
  }
}

export async function completeFirstRun(payload: {
  selectedProfile: 'quality' | 'fast';
  acknowledgedLicenses: boolean;
}): Promise<{ ok: boolean; detail?: string; reason?: string }> {
  return requireBridge().completeFirstRun(payload);
}

export async function resetFirstRun(): Promise<{ ok: boolean }> {
  return requireBridge().resetFirstRun();
}

export function onFirstRunRequired(callback: (status: FirstRunStatus) => void): () => void {
  return requireBridge().onFirstRunRequired(callback);
}

// ---- re-open bus (Settings "Re-run setup" -> App overlay) -------------------
// Module-level pub/sub so the Settings page can reopen the App-owned wizard
// overlay after a reset without a new React context or window events.

type ReopenListener = () => void;
const reopenListeners = new Set<ReopenListener>();

export function emitFirstRunReopen(): void {
  for (const listener of reopenListeners) listener();
}

export function onFirstRunReopen(listener: ReopenListener): () => void {
  reopenListeners.add(listener);
  return () => {
    reopenListeners.delete(listener);
  };
}

/**
 * Activate the manifest-required packs (the wizard's activate-packs step).
 * Idempotent: packs already installed and active are skipped.
 */
export async function activateRequiredPacks(): Promise<{
  ok: boolean;
  detail?: string;
  results: Array<{ id: string; ok: boolean; detail: string }>;
}> {
  return requireBridge().activateFirstRunPacks();
}
