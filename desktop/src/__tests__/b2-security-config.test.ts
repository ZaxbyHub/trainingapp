// C6 / AC8 (issue #60, Workstream B2): security config — exact defaults, and
// dev-only extra origins are IMPOSSIBLE in packaged builds (gate: not
// app.isPackaged AND explicit env opt-in).
//
// Seam contract (frozen; desktop/main/security/config.ts — NEW module):
//   export interface SecurityConfig { tokenHeaderName: string; allowedOrigins: string[]; }
//   export function resolveSecurityConfig(opts?: {
//     env?: Record<string, string | undefined>;  // default: process.env
//     isPackaged?: boolean;                      // default: app.isPackaged
//   }): SecurityConfig
//
// Frozen rules:
//   D1 defaults (exact): tokenHeaderName === 'X-Desktop-Token',
//      allowedOrigins === ['app://*'].
//   D2 dev-origin opt-in env var: TRAININGAPP_DESKTOP_DEV_ORIGINS — a
//      comma-separated list of extra origins. Extras are accepted ONLY when
//      isPackaged === false AND the env var is present and NON-EMPTY.
//   D3 when accepted, extras are APPENDED to the defaults (the default
//      app://* origin is never dropped).
//   D4 packaged builds refuse extras unconditionally (defaults only), even
//      with the env var set.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub';
import { resolveSecurityConfig } from '../../main/security/config';

const DEV_ORIGINS_ENV = 'TRAININGAPP_DESKTOP_DEV_ORIGINS';
const EXTRA_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';

beforeEach(() => {
  __resetElectronStub();
  delete process.env[DEV_ORIGINS_ENV];
});

afterEach(() => {
  delete process.env[DEV_ORIGINS_ENV];
});

describe('C6 security config defaults (AC8)', () => {
  it('defaults: tokenHeaderName X-Desktop-Token, allowedOrigins ["app://*"] (exact)', () => {
    const cfg = resolveSecurityConfig({ env: {}, isPackaged: false });
    expect(cfg.tokenHeaderName).toBe('X-Desktop-Token');
    expect(cfg.allowedOrigins).toEqual(['app://*']);
  });

  it('ambient call with no opts resolves the same defaults when the opt-in env var is unset', () => {
    const cfg = resolveSecurityConfig();
    expect(cfg.tokenHeaderName).toBe('X-Desktop-Token');
    expect(cfg.allowedOrigins).toEqual(['app://*']);
  });
});

describe('C6 dev-origin gating (AC8)', () => {
  it('PACKAGED build + env opt-in present -> extras REFUSED (defaults only)', () => {
    const cfg = resolveSecurityConfig({ env: { [DEV_ORIGINS_ENV]: EXTRA_ORIGINS }, isPackaged: true });
    expect(cfg.allowedOrigins).toEqual(['app://*']);
  });

  it('UNPACKAGED + env opt-in present -> extras ACCEPTED and appended to the defaults', () => {
    const cfg = resolveSecurityConfig({ env: { [DEV_ORIGINS_ENV]: EXTRA_ORIGINS }, isPackaged: false });
    expect(cfg.allowedOrigins).toEqual(expect.arrayContaining(['app://*', 'http://localhost:5173', 'http://127.0.0.1:5173']));
    expect(cfg.tokenHeaderName).toBe('X-Desktop-Token');
  });

  it('no env opt-in -> extras never accepted, regardless of packaging', () => {
    const packaged = resolveSecurityConfig({ env: {}, isPackaged: true });
    const unpackaged = resolveSecurityConfig({ env: {}, isPackaged: false });
    expect(packaged.allowedOrigins).toEqual(['app://*']);
    expect(unpackaged.allowedOrigins).toEqual(['app://*']);
  });

  it('EMPTY env value is not an opt-in -> defaults only', () => {
    const cfg = resolveSecurityConfig({ env: { [DEV_ORIGINS_ENV]: '' }, isPackaged: false });
    expect(cfg.allowedOrigins).toEqual(['app://*']);
  });
});
