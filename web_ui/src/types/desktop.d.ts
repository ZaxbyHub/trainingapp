/**
 * Ambient declaration for the Electron preload bridge (issue #67, B2).
 *
 * `window.desktopApi` is exposed by desktop/preload/index.ts via
 * contextBridge.exposeInMainWorld and is therefore present ONLY inside the
 * Electron shell (production app:// renderer AND the dev vite server loaded
 * by Electron). Its absence is the renderer's signal that it runs as a pure
 * browser page and must keep the browser-local behavior (the browser app has
 * no remote Python server mode since settings-wiring-honesty).
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
    | 'traversal'
    | 'unreadable';
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
    /** #133: why the pack lifecycle is down (named gates contract) — null
     *  when tools are available; optional so older status literals compile. */
    unavailableReason?: string | null;
    required: Array<{
      id: string;
      version?: string;
      dir?: string;
      resolvedDir: string | null;
      /** #133 round 8: the backend's single-source-of-truth satisfaction
       *  verdict (installed+active at this version OR NEWER — a user who
       *  updated via a newer zip satisfies the manifest). Optional so status
       *  literals predating the field compile; the wizard falls back to its
       *  legacy strict-equality check when absent. */
      satisfied?: boolean;
    }>;
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

/** Payload of desktop:updates:status / updates:available (E5, issue #88).
 * Mirrors the main-process UpdatesStatusPayload shape. Update checks are
 * opt-in; a fresh install reports optIn:false with empty results and the
 * main process makes zero network calls until setUpdateOptIn(true). */
export interface UpdateStatus {
  optIn: boolean;
  feedUrl: string;
  checkedAt: string | null;
  candidates: Array<{
    packId: string;
    currentVersion: string;
    availableVersion: string;
    publishedAt: string;
    downloadUrl: string;
    sha256: string;
    sizeBytes: number;
  }>;
  refused: Array<{ packId: string; version: string; reason: string }>;
  error: string | null;
  appUpdate: {
    currentVersion: string;
    availableVersion: string;
    publishedAt: string;
    downloadUrl: string;
    sha256: string;
    sizeBytes: number;
    notesUrl?: string;
  } | null;
  lastApply: { packId: string; applied: boolean; version?: string; reason?: string; appliedAt: string } | null;
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
  /** E5 (issue #88): current update status (never networked on its own). */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** E5 (issue #88): flip the opt-in. Enabling triggers one check. */
  setUpdateOptIn(enabled: boolean): Promise<{ ok: boolean; detail?: string; status?: UpdateStatus }>;
  /** E5 (issue #88): force a check (refused while opted out). */
  checkForUpdates(): Promise<{ ok: boolean; detail?: string; status?: UpdateStatus }>;
  /** E5 (issue #88): download-verify-install a checked pack update through
   *  the loopback pack-install route (C8 guards apply). */
  applyPackUpdate(packId: string): Promise<{ ok: boolean; detail?: string; status?: UpdateStatus }>;
  /** E5 (issue #88): subscribe to the updates:available push. Returns an
   *  unsubscribe function. */
  onUpdateAvailable(callback: (status: UpdateStatus) => void): () => void;
  /** E5 (issue #88): open an allowlisted (GitHub Releases https) update URL
   *  in the OS browser. The shell deny-alls renderer-initiated navigation. */
  openUpdateExternal(url: string): Promise<{ ok: boolean; detail?: string }>;
}

declare global {
  interface Window {
    desktopApi?: DesktopApiBridge;
  }
}

export {};
