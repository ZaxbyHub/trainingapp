// Preload bridge for the TrainingApp desktop shell (issues #59 + #60).
//
// Two contextBridge namespaces, nothing else:
//   - `trainingapp` (issue #59): the shell's namespaced, non-privileged
//     object. Kept for compatibility (the runtime smoke and B1 spec pin it).
//   - `desktopApi` (issue #60, B2): the ONLY channel the per-launch auth token
//     takes to the renderer. The token lives in main-process memory; this
//     bridge hands it over on demand via IPC. It is never put in web storage
//     (localStorage/sessionStorage) and never in a URL — enforced by the
//     structural grep in desktop/repro/check-b2.sh (token-bridge id) and
//     documented in docs/security/desktop.md.
//
// contextIsolation keeps both namespaces non-privileged; sandbox:true keeps
// this file CommonJS (the compile chain emits dist/preload/index.cjs —
// verified by desktop/scripts/verify-preload-format.mjs).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('trainingapp', {});

contextBridge.exposeInMainWorld('desktopApi', {
  getAuthToken: () => ipcRenderer.invoke('desktop:get-token'),
  // Backend port discovery (issue #61, B3): the renderer learns the guarded
  // loopback backend address ONLY through this IPC (never web storage, never
  // a URL). B9 consumes it; the token still travels via getAuthToken and is
  // sent under the X-Desktop-Token header, not Authorization.
  getBackendInfo: () => ipcRenderer.invoke('desktop:get-backend'),
  // E2 (issue #85): first-run validation wizard. Status/complete/reset mirror
  // the store-backup pattern (renderer-reachable main-process capability);
  // onFirstRunRequired subscribes to the push fired when a needed first run
  // (or drift re-run) is detected at boot.
  getFirstRunStatus: () => ipcRenderer.invoke('desktop:first-run:status'),
  activateFirstRunPacks: () => ipcRenderer.invoke('desktop:first-run:activate-packs'),
  completeFirstRun: (payload: { selectedProfile: string; acknowledgedLicenses: boolean }) =>
    ipcRenderer.invoke('desktop:first-run:complete', payload),
  resetFirstRun: () => ipcRenderer.invoke('desktop:first-run:reset'),
  onFirstRunRequired: (callback: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown): void => callback(status);
    ipcRenderer.on('first-run:required', listener);
    return () => {
      ipcRenderer.removeListener('first-run:required', listener);
    };
  },
});
