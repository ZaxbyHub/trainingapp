// AC5: the custom `app://` protocol serves the built web_ui renderer from a
// dist root with correct MIME types and refuses path traversal outside it.
//
// Seam contract (desktop/main/protocol.ts):
//   export function createAppFileHandler(opts: { root: string }):
//     (request: Request) => Response | Promise<Response>
//     - PURE handler: maps `app://<path>` to files under opts.root ('/' and
//       '' map to index.html), serves correct MIME types for at least
//       .html/.js/.css/.svg/.png/.woff2, and refuses any request whose
//       resolved path escapes root (403 or 404 Response, never a file read).
//   export function registerAppProtocol(opts: { root: string }): void
//     - wires protocol.handle('app', handler) for the real Electron runtime.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { protocol, __resetElectronStub } from '../../test/electron-stub';
import { createAppFileHandler, registerAppProtocol } from '../../main/protocol';

const SECRET = 'TOP-SECRET-DO-NOT-SERVE';
// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WOFF2_BYTES = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]);

let root = '';

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'app-protocol-'));
  root = path.join(base, 'dist-root');
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body>app-root index</body></html>');
  writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("app-asset");');
  writeFileSync(path.join(root, 'assets', 'style.css'), 'body{color:red}');
  writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(root, 'assets', 'icon.png'), PNG_BYTES);
  writeFileSync(path.join(root, 'assets', 'font.woff2'), WOFF2_BYTES);
  // A file OUTSIDE root (one level above) that traversal must never reach.
  writeFileSync(path.join(base, 'secret.txt'), SECRET);
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

beforeEach(() => {
  __resetElectronStub();
});

// Build a Request like Electron's protocol.handle delivers. undici may refuse
// some adversarial URL shapes; fall back to a minimal duck-typed Request so the
// handler is still exercised with the raw url.
function req(url: string): Request {
  try {
    return new Request(url);
  } catch {
    return { url } as Request;
  }
}

describe('AC5 app:// protocol handler', () => {
  const handler = () => createAppFileHandler({ root });

  it('serves app://index.html with text/html and the right body', async () => {
    const res = await handler()(req('app://index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('app-root index');
  });

  it("maps the root path '/' to index.html", async () => {
    const res = await handler()(req('app:///'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('app-root index');
  });

  it('serves app://assets/app.js with a JavaScript MIME type and the right body', async () => {
    const res = await handler()(req('app://assets/app.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/(javascript|ecmascript)|text\/javascript/);
    expect(await res.text()).toContain('app-asset');
  });

  it.each([
    ['app://assets/style.css', /text\/css/],
    ['app://assets/logo.svg', /image\/svg\+xml/],
    ['app://assets/icon.png', /image\/png/],
    ['app://assets/font.woff2', /font\/woff2/],
  ])('serves %s with the correct MIME type', async (url, mime) => {
    const res = await handler()(req(url));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(mime);
  });

  it('answers 404 for a file that does not exist under root', async () => {
    const res = await handler()(req('app://missing.html'));
    expect(res.status).toBe(404);
  });

  const TRAVERSALS = [
    'app://../secret.txt',
    'app://..%2f..%2fsecret.txt',
    'app://%2e%2e/secret.txt',
    'app://./../secret.txt',
    'app://../../secret.txt',
    'app://..%5c..%5csecret.txt',
  ];

  it.each(TRAVERSALS)('refuses traversal request %s with 403', async (url) => {
    const res = await handler()(req(url));
    // Sharpened per plan-critic Round 1: traversal must be explicitly refused
    // (403). The former `body !== SECRET` disjunct let a 200-empty-body handler
    // pass.
    expect(res.status).toBe(403);
    const body = await res.text().catch(() => '');
    expect(body).not.toContain(SECRET);
  });

  it('refuses a percent-encoded NUL byte with 403', async () => {
    const res = await handler()(req('app://index%00.html'));
    expect(res.status).toBe(403);
  });

  it('never serves an absolute drive-letter target (app://C:/...)', async () => {
    // On Windows, path.resolve(root, 'C:/...') jumps outside root; on POSIX the
    // segment simply does not exist. Either way the request must never be 200.
    const res = await handler()(req('app://C:/Windows/notepad.exe'));
    expect([403, 404]).toContain(res.status);
  });

  it('refuses a symlink under root that points outside root (403)', async () => {
    // Creating symlinks on Windows requires developer mode/admin privileges, so
    // the fixture degrades to a guarded skip when the filesystem forbids it.
    let linkPath = '';
    try {
      linkPath = path.join(root, 'assets', 'link.txt');
      symlinkSync(path.join(path.dirname(root), 'secret.txt'), linkPath, 'file');
    } catch {
      console.warn('symlink-escape fixture unavailable on this filesystem; skipping');
      return;
    }
    const res = await handler()(req('app://assets/link.txt'));
    expect(res.status).toBe(403);
    expect(linkPath.length).toBeGreaterThan(0);
  });

  it("registerAppProtocol wires protocol.handle('app', <the same handler>)", async () => {
    registerAppProtocol({ root });
    expect(protocol.handle).toHaveBeenCalledTimes(1);
    const [scheme, registered] = protocol.handle.mock.calls[0] as [
      string,
      (request: Request) => Response | Promise<Response>,
    ];
    expect(scheme).toBe('app');
    expect(typeof registered).toBe('function');
    const res = await registered(req('app://index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });
});
