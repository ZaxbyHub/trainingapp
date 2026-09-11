// B9 spec (issue #67): CORS-preflight exemption in the B2 loopback guard.
//
// A browser preflight (OPTIONS + Access-Control-Request-Method) never carries
// custom headers by spec, so the token cannot be present on it. The guard's
// reserved `method` field (issue #61) now exempts exactly that shape — AFTER
// the origin and loopback-host gates — while every real request still
// requires the token. Pins the whole delta:
//   - allowed-origin preflight without token          -> passes (server: 204 + ACAO)
//   - disallowed-origin preflight without token       -> 403
//   - plain OPTIONS (no preflight header) w/o token   -> 401 (still guarded)
//   - GET without token                               -> 401 (unchanged)
import { describe, expect, it } from 'vitest';
import { createLoopbackGuard } from '../../main/security/loopback-guard';

const TOKEN = 'b9-preflight-spec-token';

function req(
  method: string,
  origin?: string,
  extraHeaders: Record<string, string> = {},
) {
  const headers = new Headers(extraHeaders);
  if (origin !== undefined) headers.set('origin', origin);
  return {
    url: 'http://127.0.0.1:4567/documents',
    headers,
    method,
  };
}

describe('b9-loopback-preflight: token exemption is preflight-only', () => {
  const guard = createLoopbackGuard({
    token: TOKEN,
    allowedOrigins: ['app://*', 'http://127.0.0.1:4173'],
  });

  it('allowed-origin preflight WITHOUT token passes (null verdict)', () => {
    const verdict = guard(
      req('OPTIONS', 'http://127.0.0.1:4173', {
        'access-control-request-method': 'GET',
      }),
    );
    expect(verdict).toBeNull();
  });

  it('DISALLOWED-origin preflight without token is still 403', () => {
    const verdict = guard(
      req('OPTIONS', 'http://evil.example', {
        'access-control-request-method': 'GET',
      }),
    );
    expect(verdict?.status).toBe(403);
  });

  it('plain OPTIONS without the preflight header still requires the token', () => {
    const verdict = guard(req('OPTIONS', 'http://127.0.0.1:4173'));
    expect(verdict?.status).toBe(401);
  });

  it('GET without token is still 401 (the exemption never touches real requests)', () => {
    const verdict = guard(req('GET', 'http://127.0.0.1:4173'));
    expect(verdict?.status).toBe(401);
  });

  it('GET with the token still passes (no regression)', () => {
    const verdict = guard(req('GET', 'http://127.0.0.1:4173', {
      'x-desktop-token': TOKEN,
    }));
    expect(verdict).toBeNull();
  });
});
