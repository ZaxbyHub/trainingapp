// C4 / AC5 (issue #60, Workstream B2): every app:// response — including 403
// traversal refusals and 404 misses — must carry a strict Content-Security-
// Policy that blocks injected inline scripts while allowing the renderer's
// legitimate needs (self, app:, WASM via 'wasm-unsafe-eval', the pinned
// sha256 hash of the ONE inline theme-bootstrap script, and loopback
// connect-src for the B3 backend).
//
// Seam contract (frozen; desktop/main/protocol.ts createAppFileHandler —
// EXISTS at base but serves no CSP header, so these fail at base for the right
// reason: header missing):
//   every Response the handler returns (200, 403, 404) has a
//   'content-security-policy' header whose directives satisfy:
//     default-src 'self' app:                        (exact prefix, issue text)
//     script-src 'self' 'wasm-unsafe-eval' sha256-<pin>
//       - and NEVER 'unsafe-inline' or 'unsafe-eval' (inline-script injection
//         attempts must be blocked; only the pinned hash may run inline)
//     object-src 'none'
//     connect-src ... 'self' ... app: ... http://127.0.0.1:* ...
// Deliberately NOT asserted here (beyond the frozen minimum): COOP/COEP.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub';
import { createAppFileHandler } from '../../main/protocol';

let root = '';

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'b2-csp-'));
  root = path.join(base, 'dist-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body>csp-fixture</body></html>');
  // Outside root: traversal requests must 403 on it, never serve it.
  writeFileSync(path.join(base, 'secret.txt'), 'CSP-FIXTURE-SECRET');
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

/** Build a Request like Electron's protocol.handle delivers (duck-typed fallback). */
function req(url: string): Request {
  try {
    return new Request(url);
  } catch {
    return { url } as Request;
  }
}

function cspOf(res: Response): string {
  const value = res.headers.get('content-security-policy');
  expect(value, `response ${res.status} must carry a content-security-policy header`).toBeTypeOf('string');
  return (value as string).toLowerCase();
}

/** Parse a CSP policy string into a lowercase directive-name -> value map. */
function directives(policy: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(/\s+/);
    map[name.toLowerCase()] = rest.join(' ');
  }
  return map;
}

/** The frozen strictness checks every CSP-carrying response must satisfy. */
function expectStrictCsp(policy: string): void {
  // default-src: exactly the issue's strict default, 'self' then app:.
  expect(policy, "default-src must start with \"default-src 'self' app:\"").toMatch(
    /default-src\s+'self'\s+app:/,
  );
  const d = directives(policy);
  // object-src 'none' — no plugin content ever (source token is quoted).
  expect(d['object-src'], "object-src must be 'none'").toContain("'none'");
  // script-src: self + WASM + ONE pinned inline script; never arbitrary inline.
  expect(d['script-src'], 'script-src directive must exist').toBeTypeOf('string');
  const scriptSrc = d['script-src'] ?? '';
  expect(scriptSrc, "script-src must include 'self'").toContain("'self'");
  expect(scriptSrc, "script-src must include 'wasm-unsafe-eval' for ONNX/wllama WASM").toContain("'wasm-unsafe-eval'");
  expect(scriptSrc, 'script-src must pin the one inline theme-bootstrap script (sha256-)').toMatch(/sha256-/);
  expect(scriptSrc, "script-src must NOT contain 'unsafe-inline' (blocks injected inline scripts)").not.toContain(
    "'unsafe-inline'",
  );
  expect(scriptSrc, "script-src must NOT contain 'unsafe-eval'").not.toContain("'unsafe-eval'");
  // connect-src: self + app: + loopback backend on any port.
  expect(d['connect-src'], 'connect-src directive must exist').toBeTypeOf('string');
  const connectSrc = d['connect-src'] ?? '';
  expect(connectSrc, "connect-src must include 'self'").toContain("'self'");
  expect(connectSrc, 'connect-src must include app:').toContain('app:');
  expect(connectSrc, 'connect-src must allow the loopback backend http://127.0.0.1:*').toMatch(
    /http:\/\/127\.0\.0\.1:\*/,
  );
}

describe('C4 Content-Security-Policy on app:// responses (AC5)', () => {
  it('serves app://index.html with a strict content-security-policy header (inline injection blocked)', async () => {
    __resetElectronStub();
    const handler = createAppFileHandler({ root });
    const res = await handler(req('app://index.html'));
    expect(res.status).toBe(200);
    expectStrictCsp(cspOf(res));
  });

  it('403 traversal refusals ALSO carry the strict content-security-policy header', async () => {
    __resetElectronStub();
    const handler = createAppFileHandler({ root });
    const res = await handler(req('app://../secret.txt'));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('CSP-FIXTURE-SECRET');
    expectStrictCsp(cspOf(res));
  });

  it('404 responses ALSO carry the strict content-security-policy header', async () => {
    __resetElectronStub();
    const handler = createAppFileHandler({ root });
    const res = await handler(req('app://missing.html'));
    expect(res.status).toBe(404);
    expectStrictCsp(cspOf(res));
  });

  it('negative control: the strictness parser rejects a permissive script-src', () => {
    // Proof the assertions above are discriminative: a CSP with 'unsafe-inline'
    // and no sha256 pin / no wasm allowance must fail expectStrictCsp.
    const permissive = "default-src 'self' app:; script-src 'self' 'unsafe-inline'; object-src 'none'; connect-src 'self' app: http://127.0.0.1:*";
    expect(() => expectStrictCsp(permissive.toLowerCase())).toThrow();
    const noWasm = "default-src 'self' app:; script-src 'self' sha256-AAA; object-src 'none'; connect-src 'self' app: http://127.0.0.1:*";
    expect(() => expectStrictCsp(noWasm.toLowerCase())).toThrow();
    const noObjectSrc = "default-src 'self' app:; script-src 'self' 'wasm-unsafe-eval' sha256-AAA; connect-src 'self' app: http://127.0.0.1:*";
    expect(() => expectStrictCsp(noObjectSrc.toLowerCase())).toThrow();
  });
});
