// Security-header coverage for app:// responses (issue #60 feedback round;
// additive — the frozen b2-csp.test.ts deliberately pins only CSP, leaving
// COOP/COEP/CORP unpinned until this spec). Invariant: EVERY app:// response
// (success and errors alike) carries the cross-origin-isolation header
// discipline of web_ui/scripts/start.ps1 — set by protocol.ts
// withSecurityHeaders.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __resetElectronStub } from '../../test/electron-stub';
import { createAppFileHandler } from '../../main/protocol';

let root = '';

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'b2-sec-headers-'));
  root = path.join(base, 'dist-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body>hdr-fixture</body></html>');
  writeFileSync(path.join(base, 'secret.txt'), 'SECRET');
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

function req(url: string): Request {
  try {
    return new Request(url);
  } catch {
    return { url } as Request;
  }
}

const ISOLATION_HEADERS: Record<string, string> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

describe('COOP/COEP/CORP on every app:// response (issue #60)', () => {
  it('200 responses carry the full isolation header set plus CSP', async () => {
    __resetElectronStub();
    const handler = createAppFileHandler({ root });
    const res = await handler(req('app://index.html'));
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
      expect(res.headers.get(name), `${name} on 200`).toBe(value);
    }
    expect(res.headers.get('content-security-policy')).toBeTypeOf('string');
  });

  it('403 refusals carry the same isolation headers (fail-open impossible)', async () => {
    __resetElectronStub();
    const handler = createAppFileHandler({ root });
    const res = await handler(req('app://../secret.txt'));
    expect(res.status).toBe(403);
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
      expect(res.headers.get(name), `${name} on 403`).toBe(value);
    }
  });

  it('404 responses carry the same isolation headers', async () => {
    __resetElectronStub();
    const handler = createAppFileHandler({ root });
    const res = await handler(req('app://missing.html'));
    expect(res.status).toBe(404);
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
      expect(res.headers.get(name), `${name} on 404`).toBe(value);
    }
  });
});
