// Security configuration for the desktop transport (issue #60, Workstream B2).
//
// Config keys (issue-required names):
//   security.tokenHeaderName — the custom header carrying the per-launch token
//     (default 'X-Desktop-Token'; deliberately NOT Authorization: Bearer, which
//     the web_ui ApiClient reserves for its server-mode JWT flow).
//   security.allowedOrigins — origins allowed to talk to the desktop transport
//     (default ['app://*'] — every app:// origin; 'app://index.html' is what
//     the packaged renderer's origin resolves to under WHATWG non-special-
//     scheme parsing, see desktop/main/protocol.ts).
//
// Dev-only origin additions are gated so a PACKAGED build categorically cannot
// gain extra origins regardless of its environment: additions require BOTH
// app.isPackaged === false AND an explicit TRAININGAPP_DESKTOP_DEV_ORIGINS
// opt-in. This is the build/packaging-time gate equivalent for an Electron
// main process, which has no compile-time define machinery in this repo.
import { app } from 'electron';
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_TOKEN_HEADER_NAME } from './defaults.js';

// Re-exported for import compatibility: B2 modules and specs import these
// constants from './config.js'. The canonical definitions live in
// './defaults.js' so the B3 backend can share them without importing
// electron (see defaults.ts).
export { DEFAULT_ALLOWED_ORIGINS, DEFAULT_TOKEN_HEADER_NAME };

export interface SecurityConfig {
  tokenHeaderName: string;
  allowedOrigins: string[];
}

export const DEV_ORIGINS_ENV = 'TRAININGAPP_DESKTOP_DEV_ORIGINS';

/**
 * Resolve the transport security configuration.
 * Pure and overridable for tests; defaults read the real environment and
 * `app.isPackaged`.
 */
export function resolveSecurityConfig(opts?: {
  env?: Record<string, string | undefined>;
  isPackaged?: boolean;
}): SecurityConfig {
  const env = opts?.env ?? process.env;
  const isPackaged = opts?.isPackaged ?? app.isPackaged;

  // Appends only: the default app://* origin is never dropped, so a dev opt-in
  // can widen but never replace the packaged baseline.
  const allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS];
  if (!isPackaged) {
    const raw = env[DEV_ORIGINS_ENV];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      for (const part of raw.split(',')) {
        const origin = part.trim();
        if (origin.length > 0) allowedOrigins.push(origin);
      }
    }
  }

  return { tokenHeaderName: DEFAULT_TOKEN_HEADER_NAME, allowedOrigins };
}
