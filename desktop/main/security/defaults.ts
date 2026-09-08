// Electron-free security defaults (issue #61, B3).
//
// config.ts owns the resolvable SecurityConfig, but it imports `electron`
// (app.isPackaged) — and the npm `electron` package is a CommonJS STRING
// export, so any module that statically imports config.ts cannot boot under
// plain node. The B3 backend host and its headless dev-server entry must boot
// under plain node (CI conformance, acceptance checks), so the constant
// DEFAULTS live here, electron-free, and both config.ts and loopback-guard.ts
// consume them. Values are frozen by the B2 regression family
// (desktop/src/__tests__/b2-security-config.test.ts) — do not change them.

export const DEFAULT_TOKEN_HEADER_NAME = 'X-Desktop-Token';
export const DEFAULT_ALLOWED_ORIGINS = ['app://*'];
