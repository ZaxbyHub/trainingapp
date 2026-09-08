// C1 / AC1 + AC2 (issue #60, Workstream B2): the loopback guard must reject
// requests whose Origin/Host mismatch the allowed set, or whose token header is
// missing/wrong, BEFORE any backend delegate runs.
//
// Seam contract (frozen; desktop/main/security/loopback-guard.ts — NEW module):
//   export function createLoopbackGuard(opts: {
//     token: string;                    // the per-launch minted token
//     tokenHeaderName?: string;         // default: the security-config default
//                                       //   'X-Desktop-Token'
//     allowedOrigins?: string[];        // default: ['app://*']
//   }): (request: GuardRequest) => Response | null | Promise<Response | null>
//
//   GuardRequest is the minimal shape Electron's protocol.handle Requests and
//   the WHATWG fetch Request share:
//     { url: string; headers: { get(name: string): string | null } }
//
// Frozen decision rules (statuses are exact):
//   R1 TOKEN (AC1): request.headers.get(tokenHeaderName) must EQUAL opts.token.
//      Missing header or wrong value -> Response with status 401, and the
//      rejection body must not echo the token.
//   R2 ORIGIN (AC2): when an Origin header is present, its value must match an
//      allowedOrigins pattern ('app://*' matches every app:// origin).
//      Mismatch (e.g. Origin: http://evil.example) -> status 403 REGARDLESS of
//      token validity.
//   R3 HOST: the effective host (Host header when present, else the URL host)
//      of a request whose URL scheme is NOT covered by allowedOrigins (i.e.
//      http(s):// requests bound for the loopback backend) is allowed only
//      when it is the literal loopback address 127.0.0.1 or [::1] on any port.
//      The NAME 'localhost:<port>' is NOT allowed (DNS-rebinding hardening)
//      and LAN/private IPs are NOT allowed -> status 403 even with a valid
//      token. app:// requests are governed by allowedOrigins (R2) instead.
//   R4 PASS: all checks pass -> null (or undefined): no rejection, the caller
//      may forward to its backend delegate.
//   R5 BACKEND ISOLATION: the guard is backend-agnostic — it is a pure
//      request -> Response|null gate; on every rejection path the backend
//      delegate must NOT be invoked (asserted here via a spy delegate).
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias), though
// this seam is expected to stay Electron-free.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub';
import { createLoopbackGuard } from '../../main/security/loopback-guard';

const TOKEN = 'unit-test-launch-token-0123456789abcdef0123456789abcdef';
const ALLOWED_ORIGIN = 'app://index.html';

type GuardRequest = { url: string; headers: { get(name: string): string | null } };

/** Minimal fetch-Request-shaped fixture (case-insensitive header lookup). */
function req(url: string, headers: Record<string, string> = {}): GuardRequest {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { url, headers: { get: (n) => lower.get(n.toLowerCase()) ?? null } };
}

/** Backend delegate the guard must protect: only reached when the gate passes. */
const delegate = vi.fn(async () => new Response('backend-ok', { status: 200 }));

/** Compose gate + delegate exactly as a backend-agnostic caller would. */
async function runGate(
  gate: (r: GuardRequest) => Response | null | Promise<Response | null>,
  request: GuardRequest,
): Promise<Response> {
  const verdict = await gate(request);
  if (verdict === null || verdict === undefined) return await delegate(request);
  return verdict;
}

beforeEach(() => {
  __resetElectronStub();
  delegate.mockClear();
});

describe('C1 loopback guard: AC1 token gate', () => {
  it('rejects a request whose X-Desktop-Token header is MISSING with 401, before any backend call', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(gate, req('app://index.html', { Origin: ALLOWED_ORIGIN }));
    expect(res.status).toBe(401);
    expect(delegate).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain(TOKEN);
  });

  it('rejects a request with the WRONG token value with 401, before any backend call', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Desktop-Token': 'wrong-token-value' }),
    );
    expect(res.status).toBe(401);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('reads the token from the CONFIG-DEFAULT header name X-Desktop-Token, not any other header', async () => {
    const gate = createLoopbackGuard({ token: TOKEN }); // no explicit header name
    // Same value under a decoy header, X-Desktop-Token absent -> still 401.
    const decoy = await runGate(
      gate,
      req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Api-Token': TOKEN }),
    );
    expect(decoy.status).toBe(401);
    expect(delegate).not.toHaveBeenCalled();
    // And under the default name with an allowed origin it passes.
    const ok = await runGate(
      gate,
      req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Desktop-Token': TOKEN }),
    );
    expect(ok.status).toBe(200);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit tokenHeaderName override', async () => {
    const gate = createLoopbackGuard({ token: TOKEN, tokenHeaderName: 'X-Custom-Token' });
    const ok = await runGate(
      gate,
      req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Custom-Token': TOKEN }),
    );
    expect(ok.status).toBe(200);
    const wrongPlace = await runGate(
      gate,
      req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Desktop-Token': TOKEN }),
    );
    expect(wrongPlace.status).toBe(401);
  });
});

describe('C1 loopback guard: AC2 origin/host gate', () => {
  it('rejects Origin: http://evil.example with 403 EVEN WITH a valid token, before any backend call', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('app://index.html', { Origin: 'http://evil.example', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example', 'http://127.0.0.1.evil.example', 'null'])(
    'rejects forged Origin %s with 403 even with a valid token',
    async (origin) => {
      const gate = createLoopbackGuard({ token: TOKEN });
      const res = await runGate(gate, req('app://index.html', { Origin: origin, 'X-Desktop-Token': TOKEN }));
      expect(res.status).toBe(403);
      expect(delegate).not.toHaveBeenCalled();
    },
  );

  it('rejects a present-but-EMPTY Origin header with 403 even with a valid token (fail closed)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(gate, req('app://index.html', { Origin: '', 'X-Desktop-Token': TOKEN }));
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('rejects an EMPTY token header value with 401 (empty is just a wrong value)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(gate, req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Desktop-Token': '' }));
    expect(res.status).toBe(401);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('rejects a request directed at Host localhost:<port> with 403 even with valid token and allowed Origin', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://localhost:9999/api', { Origin: ALLOWED_ORIGIN, Host: 'localhost:9999', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('rejects a Host-header mismatch (LAN IP) with 403 even with valid token and allowed Origin', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://192.168.1.5:8080/api', { Origin: ALLOWED_ORIGIN, Host: '192.168.1.5:8080', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });
});

describe('C1 loopback guard: pass-through (R4)', () => {
  it('returns null (no rejection) for app:// request + valid token -> backend delegate reached', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(200); // served by the delegate
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('passes a same-origin app:// request that omits the Origin header (classic subresource loads send none)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const verdict = await gate(req('app://assets/app.js', { 'X-Desktop-Token': TOKEN }));
    expect(verdict == null).toBe(true); // null/undefined => allowed
    expect(delegate).not.toHaveBeenCalled(); // gate is pure; the caller composes
  });

  it('is backend-agnostic: passes the loopback host 127.0.0.1:<any port> with an allowed app:// Origin + token', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://127.0.0.1:8765/api/v1/models', {
        Origin: ALLOWED_ORIGIN,
        Host: '127.0.0.1:8765',
        'X-Desktop-Token': TOKEN,
      }),
    );
    expect(res.status).toBe(200);
    expect(delegate).toHaveBeenCalledTimes(1);
  });
});
