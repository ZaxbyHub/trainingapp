// app:// file protocol for the TrainingApp Electron shell (issue #59).
//
// The renderer is the built web_ui dist, copied into the package as
// <resources>/web_ui at build time (see desktop/electron-builder.yml
// extraResources and the desktop:build script). This module maps app://<path>
// requests onto that root with correct MIME types and refuses anything that
// resolves outside it.
//
// Deeper transport hardening (CSP, loopback token, renderer policy) is
// Workstream B2 / issue #60; this handler only guarantees baseline path safety.
import { promises as fsp, realpathSync } from 'node:fs';
import path from 'node:path';
import { protocol } from 'electron';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.gguf': 'application/octet-stream',
};

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

/**
 * Resolve and validate a request path against `rootAbs`.
 * Returns the absolute path to serve, or a Response to refuse with.
 */
function resolveWithinRoot(rootAbs: string, requestUrl: string): string | Response {
  // Parse the RAW url string rather than `new URL()`: for non-special schemes
  // like app://, WHATWG URL parsing treats everything up to the first `/` as
  // the host (app://index.html has host="index.html"), which would corrupt
  // single-segment paths. app:// is an opaque file-mapping scheme here.
  const schemeEnd = requestUrl.indexOf('://');
  let rest = schemeEnd >= 0 ? requestUrl.slice(schemeEnd + 3) : requestUrl;
  const suffix = rest.search(/[?#]/);
  if (suffix >= 0) rest = rest.slice(0, suffix);

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // Malformed percent-encoding is not a resource we can name.
    return notFound();
  }
  // Backslashes are Windows separators and never legitimate in a web path;
  // NUL bytes are never legitimate anywhere. Refuse both before touching the
  // filesystem.
  if (decoded.includes('\\') || decoded.includes('\0')) return forbidden();

  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return forbidden();
  }
  const relative = segments.length === 0 ? 'index.html' : path.join(...segments);
  const resolved = path.resolve(rootAbs, relative);
  // Defense in depth: segment validation above should make this unreachable,
  // but a containment check on the resolved path is cheap and closes any gap
  // between our segment model and path.resolve semantics (e.g. drive letters
  // on Windows make paths absolute again).
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    return forbidden();
  }
  return resolved;
}

/**
 * Create the pure request handler served under the app:// scheme.
 * Testable without Electron: `(request: Request) => Promise<Response>`.
 */
export function createAppFileHandler(opts: { root: string }) {
  const rootAbs = path.resolve(opts.root);
  return async function handleAppRequest(request: Request): Promise<Response> {
    const url = typeof request?.url === 'string' ? request.url : '';
    const resolved = resolveWithinRoot(rootAbs, url);
    if (typeof resolved !== 'string') return resolved;

    try {
      const stats = await fsp.stat(resolved);
      let filePath = resolved;
      if (stats.isDirectory()) {
        filePath = path.join(resolved, 'index.html');
      }
      // Re-resolve through the filesystem so a symlink inside root cannot
      // serve content from outside it, and open the realpath result (not the
      // pre-realpath path) so a post-check swap cannot escape either.
      const real = realpathSync(filePath);
      if (real !== rootAbs && !real.startsWith(rootAbs + path.sep)) {
        return forbidden();
      }
      const data = await fsp.readFile(real);
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': mimeTypeFor(real),
          // Baseline response hygiene for the custom scheme (CSP itself is
          // Workstream B2 / issue #60).
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return notFound();
    }
  };
}

/**
 * Register the app:// handler with the real Electron runtime.
 * Call after `app` is ready. Must be called exactly once.
 */
export function registerAppProtocol(opts: { root: string }): void {
  protocol.handle('app', createAppFileHandler(opts));
}

/**
 * Grant app:// standard secure-origin privileges (relative asset resolution,
 * localStorage, fetch). MUST be called before the app `ready` event.
 */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}
