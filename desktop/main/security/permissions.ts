// Renderer permission policy for the default session (issue #276 AC4).
//
// Deny by default: the shell registers BOTH Electron permission handlers on
// session.defaultSession before any window exists, so every permission-gated
// web API a renderer (or a frame inside it) asks for is refused unless it is
// named here. Electron's own default with no handler is to GRANT most
// requests, which is why an explicit pair is required.
//
// Allowed, each named for its concrete consumer in the app's own renderer:
//   - clipboard-sanitized-write: navigator.clipboard.writeText for the copy
//     actions (PR #259).
//   - persistent-storage: navigator.storage.persist() for durable document
//     storage (web_ui/src/pages/DocumentsPage.tsx).
// Everything else (media, geolocation, notifications, fullscreen, midi, ...)
// is denied by the request handler AND answered false by the check handler,
// so a check-then-request renderer sees one consistent answer.
import type { Session } from 'electron';

export const ENABLED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'persistent-storage',
]);

export function isPermissionEnabled(permission: string): boolean {
  return ENABLED_PERMISSIONS.has(permission);
}

/** Register the deny-by-default request + check handlers on `ses`. */
export function registerPermissionHandlers(
  ses: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isPermissionEnabled(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => isPermissionEnabled(permission));
}
