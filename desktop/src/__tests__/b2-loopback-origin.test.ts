// AC2 ONLY (issue #60, Workstream B2): a request whose Origin/Host mismatches
// the allowed set is rejected (403-class) REGARDLESS of token validity — even
// a perfectly valid per-launch token must not buy a wrong-origin request
// through the gate. Split out from C1 (b2-loopback-guard.test.ts, which owns
// AC1 token gating) so every acceptance criterion maps 1:1 to a check id;
// this spec re-freezes the SAME seam contract.
//
// Seam contract (frozen; desktop/main/security/loopback-guard.ts — NEW module,
// identical contract to b2-loopback-guard.test.ts):
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
// Frozen decision rules exercised here (AC2 subset; statuses exact):
//   ORIGIN: when an Origin header is present, its value must match an
//     allowedOrigins pattern ('app://*' matches every app:// origin). A
//     mismatched Origin (http://evil.example, https://evil.example, 'null',
//     subdomain tricks like http://127.0.0.1.evil.example) -> Response with
//     status 403 EVEN THOUGH the X-Desktop-Token header carries the correct
//     token, and the backend delegate is NOT invoked.
//   HOST: for a request whose URL scheme is not covered by allowedOrigins
//     (http(s):// loopback-backend requests), the effective host (Host header
//     when present, else the URL host) is allowed only when it is the literal
//     loopback address 127.0.0.1 or [::1] on any port. The NAME
//     'localhost:<port>' and LAN/private IPs -> status 403 even with a valid
//     token and an allowed Origin; the backend delegate is NOT invoked.
//   PASS (control): valid token + allowed app:// Origin -> null/undefined (no
//     rejection) so the caller may reach its backend delegate.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias), though
// this seam is expected to stay Electron-free.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub';
import { createLoopbackGuard } from '../../main/security/loopback-guard';

const TOKEN = 'ac2-valid-launch-token-0123456789abcdef0123456789abcdef';
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

/** Every request in this spec carries the CORRECT token: rejection must be
 *  attributable to the origin/host ALONE (AC2: "regardless of token validity"). */
function validAuth(extra: Record<string, string>): Record<string, string> {
  return { 'X-Desktop-Token': TOKEN, ...extra };
}

beforeEach(() => {
  __resetElectronStub();
  delegate.mockClear();
});

describe('AC2 loopback origin gate: wrong origin rejected regardless of token validity', () => {
  it.each([
    'http://evil.example',
    'https://evil.example',
    'http://127.0.0.1.evil.example', // subdomain trick around a loopback-prefix check
    'null', // sandboxed/opaque origin marker
  ])('rejects Origin %s with 403 EVEN WITH a valid token, before any backend call', async (origin) => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('app://index.html', validAuth({ Origin: origin })),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('rejects a LAN-IP host with 403 even with a valid token and an allowed Origin', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://192.168.1.5:8080/api', validAuth({ Origin: ALLOWED_ORIGIN, Host: '192.168.1.5:8080' })),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects the NAME 'localhost:<port>' (wrong host:port, non-literal loopback) with 403 even with a valid token", async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://localhost:9999/api', validAuth({ Origin: ALLOWED_ORIGIN, Host: 'localhost:9999' })),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });
});

describe('AC2 loopback origin gate: control (valid token + allowed origin passes)', () => {
  it('returns null (no rejection) for an allowed app:// Origin with a valid token', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const verdict = await gate(req('app://index.html', validAuth({ Origin: ALLOWED_ORIGIN })));
    expect(verdict == null).toBe(true); // null/undefined => allowed
    expect(delegate).not.toHaveBeenCalled(); // gate is pure; the caller composes
  });

  it('passes the literal loopback host 127.0.0.1:<port> with an allowed app:// Origin + valid token', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://127.0.0.1:8765/api/v1/models', validAuth({ Origin: ALLOWED_ORIGIN, Host: '127.0.0.1:8765' })),
    );
    expect(res.status).toBe(200); // served by the delegate
    expect(delegate).toHaveBeenCalledTimes(1);
  });
});
