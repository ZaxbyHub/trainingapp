/**
 * Ambient declaration for the Electron preload bridge (issue #67, B2).
 *
 * `window.desktopApi` is exposed by desktop/preload/index.ts via
 * contextBridge.exposeInMainWorld and is therefore present ONLY inside the
 * Electron shell (production app:// renderer AND the dev vite server loaded
 * by Electron). Its absence is the renderer's signal that it runs as a pure
 * browser page (or pointed at a remote Python server) and must keep the
 * browser-local behavior.
 *
 * FROZEN IPC shape (desktop/main/backend/types.ts): getBackendInfo returns
 * ADDRESS ONLY — credentials travel exclusively via getAuthToken().
 */

/** Integrity-manifest failure (E2, issue #85). Mirrors
 * desktop/main/first-run/manifest-verifier.ts's ManifestFailure — the reason
 * is a closed union so a generic "something failed" message is not
 * representable. */
export interface FirstRunManifestFailure {
  path: string;
  reason:
    | 'missing'
    | 'hash-mismatch'
    | 'size-mismatch'
    | 'sha256-required'
    | 'manifest-unreadable'
    | 'traversal';
  expected: string;
  actual: string;
}

/** Payload of desktop:first-run:status (E2, issue #85). Mirrors the
 * main-process buildFirstRunStatus() shape. */
export interface FirstRunStatus {
  needed: boolean;
  reason: 'not-completed' | 'drift' | 'reset' | 'complete';
  rerun: boolean;
  engine: string;
  hardware: { freeBytes: number };
  profile: {
    recommended: 'quality' | 'fast';
    warning: { detail: string; requiredBytes: number; freeBytes: number } | null;
    stored: 'quality' | 'fast';
    contextSize: number;
    models: {
      quality: { path: string; bytes: number } | null;
      fast: { path: string; bytes: number } | null;
    };
  };
  manifest: {
    staged: boolean;
    packaged: boolean;
    failures: FirstRunManifestFailure[];
    verifiedCount: number;
  };
  packs: {
    toolsAvailable: boolean;
    required: Array<{ id: string; version?: string; dir?: string; resolvedDir: string | null }>;
    installed: Array<{ id: string; version: string; active: boolean }>;
  };
  licenses: { available: boolean; path: string | null; content: string | null };
  state: {
    completed: boolean;
    selectedProfile: string;
    completedAt: string;
    acknowledgedLicenses: boolean;
  };
}

export interface DesktopApiBridge {
  /** Per-launch backend token (never persisted; rotates every app start). */
  getAuthToken(): Promise<string>;
  /** Loopback backend address { mode, port, url }; address only, no secrets. */
  getBackendInfo(): Promise<{ mode: string; port: number; url: string }>;
  /** E2 (issue #85): first-run wizard status (hardware, manifest verify,
   *  pack snapshot, license availability, stored state). */
  getFirstRunStatus(): Promise<FirstRunStatus>;
  /** E2 (issue #85): install/activate every manifest-required pack
   *  (idempotent — already-active packs are skipped). */
  activateFirstRunPacks(): Promise<{
    ok: boolean;
    detail?: string;
    results: Array<{ id: string; ok: boolean; detail: string }>;
  }>;
  /** E2 (issue #85): complete the wizard. Refuses (ok:false + reason) unless
   *  every gate passes — the license acknowledgment cannot be skipped. */
  completeFirstRun(payload: {
    selectedProfile: 'quality' | 'fast';
    acknowledgedLicenses: boolean;
  }): Promise<{ ok: boolean; detail?: string; reason?: string }>;
  /** E2 (issue #85): clear first-run state ("Re-run setup" in Settings). */
  resetFirstRun(): Promise<{ ok: boolean }>;
  /** E2 (issue #85): subscribe to the boot push fired when a first run or
   *  drift re-run is needed. Returns an unsubscribe function. */
  onFirstRunRequired(callback: (status: FirstRunStatus) => void): () => void;
}

declare global {
  interface Window {
    desktopApi?: DesktopApiBridge;
  }
}

export {};
