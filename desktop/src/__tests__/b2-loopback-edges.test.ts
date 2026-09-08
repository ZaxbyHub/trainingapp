// Edge-case acceptance coverage for the loopback guard (issue #60 feedback
// round; additive — does not modify the frozen b2-loopback-guard /
// b2-loopback-origin specs). Pins the decision rules the original matrix left
// open: IPv6 loopback forms (allow path for bracketed, fail-closed for
// malformed/unbracketed), unparseable URLs, port-less loopback hosts, empty
// Host headers, duplicate token headers (first-wins per Headers.get), and
// R5 backend isolation under a custom token header name.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub';
import { createLoopbackGuard } from '../../main/security/loopback-guard';

const TOKEN = 'edge-case-launch-token-0123456789abcdef0123456789abcdef';
const ALLOWED_ORIGIN = 'app://index.html';

type GuardRequest = { url: string; headers: { get(name: string): string | null } };

function req(url: string, headers: Record<string, string> = {}): GuardRequest {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { url, headers: { get: (n) => lower.get(n.toLowerCase()) ?? null } };
}

const delegate = vi.fn(async () => new Response('backend-ok', { status: 200 }));

async function runGate(gate: ReturnType<typeof createLoopbackGuard>, request: GuardRequest): Promise<Response> {
  const verdict = await gate(request);
  if (verdict === null || verdict === undefined) return await delegate(request);
  return verdict;
}

beforeEach(() => {
  __resetElectronStub();
  delegate.mockClear();
});

describe('R3 host gate: IPv6 loopback forms', () => {
  it('ALLOWS bracketed IPv6 loopback [::1]:<port> with valid origin + token (documented allow half)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://[::1]:8765/api', { Origin: ALLOWED_ORIGIN, Host: '[::1]:8765', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED on a malformed bracketed host [::1:8765 (unclosed bracket)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    // http(s) URL so the R3 Host gate engages (app:// requests skip R3).
    const res = await runGate(
      gate,
      req('http://[::1:8765/api', { Origin: ALLOWED_ORIGIN, Host: '[::1:8765', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED on an unbracketed bare IPv6 host ::1 (never produced by WHATWG parsing)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://127.0.0.1:8765/api', { Origin: ALLOWED_ORIGIN, Host: '::1', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });
});

describe('R3 host gate: URL parse and port forms', () => {
  it('FAILS CLOSED on an unparseable request URL (catch branch -> 403)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(gate, req('not a url at all', { Origin: ALLOWED_ORIGIN, 'X-Desktop-Token': TOKEN }));
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('ALLOWS a port-less loopback URL http://127.0.0.1/api with valid origin + token', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://127.0.0.1/api', { Origin: ALLOWED_ORIGIN, Host: '127.0.0.1', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED on an empty-string Host header (falls through to a non-loopback effective host)', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const res = await runGate(
      gate,
      req('http://127.0.0.1:8765/api', { Origin: ALLOWED_ORIGIN, Host: '', 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(delegate).not.toHaveBeenCalled();
  });
});

describe('R1 token gate: header shapes', () => {
  it('first-wins on duplicate token headers (Headers.get contract): first value valid -> pass', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    // WHATWG Headers.get returns the FIRST value; model duplicates by a
    // multi-entry map whose first entry wins.
    const headers = {
      get: (n: string) => {
        const values: Record<string, string[]> = {
          origin: [ALLOWED_ORIGIN],
          'x-desktop-token': [TOKEN, 'wrong-value'],
        };
        const list = values[n.toLowerCase()];
        return list ? (list[0] ?? null) : null;
      },
    };
    const verdict = gate({ url: 'app://index.html', headers });
    expect(verdict).toBeNull();
    expect(delegate).not.toHaveBeenCalled();
  });

  it('first-wins on duplicate token headers: first value wrong -> 401 even if a later value would match', async () => {
    const gate = createLoopbackGuard({ token: TOKEN });
    const headers = {
      get: (n: string) => {
        const values: Record<string, string[]> = {
          origin: [ALLOWED_ORIGIN],
          'x-desktop-token': ['wrong-value', TOKEN],
        };
        const list = values[n.toLowerCase()];
        return list ? (list[0] ?? null) : null;
      },
    };
    const res = await gate({ url: 'app://index.html', headers });
    expect(res?.status).toBe(401);
    expect(delegate).not.toHaveBeenCalled();
  });
});

describe('R5 backend isolation under a custom token header name', () => {
  it('wrong-place rejection (right value, wrong header) does NOT reach the backend delegate', async () => {
    const gate = createLoopbackGuard({ token: TOKEN, tokenHeaderName: 'X-Custom-Token' });
    const res = await runGate(
      gate,
      req('app://index.html', { Origin: ALLOWED_ORIGIN, 'X-Desktop-Token': TOKEN }),
    );
    expect(res.status).toBe(401);
    expect(delegate).not.toHaveBeenCalled();
  });
});
