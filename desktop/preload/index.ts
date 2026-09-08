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
});
