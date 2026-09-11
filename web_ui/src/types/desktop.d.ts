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
export interface DesktopApiBridge {
  /** Per-launch backend token (never persisted; rotates every app start). */
  getAuthToken(): Promise<string>;
  /** Loopback backend address { mode, port, url }; address only, no secrets. */
  getBackendInfo(): Promise<{ mode: string; port: number; url: string }>;
}

declare global {
  interface Window {
    desktopApi?: DesktopApiBridge;
  }
}

export {};
