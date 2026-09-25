// app:// file protocol for the TrainingApp Electron shell (issue #59).
//
// The renderer is the built web_ui dist, copied into the package as
// <resources>/web_ui at build time (see desktop/electron-builder.yml
// extraResources and the desktop:build script). This module maps app://<path>
// requests onto that root with correct MIME types and refuses anything that
// resolves outside it.
//
// Issue #81 (D5) adds the reserved app://training/<packId>/ namespace: pack
// player assets are served from <packsDir>/<packId>/assets/player/<rest>
// (the pack layout of packtool build-storyline). Pack documents carry the
// training CSP profile (security/csp.ts); every other discipline — path
// validation, containment, realpath re-check, COOP/COEP/CORP headers — is
// identical to the renderer route.
//
// Deeper transport hardening (CSP, loopback token, renderer policy) is
// Workstream B2 / issue #60; this handler only guarantees baseline path safety.
import fs, { promises as fsp, realpathSync } from 'node:fs';
import path from 'node:path';
import { protocol } from 'electron';
import { buildCspPolicy, buildTrainingCspPolicy } from './security/csp.js';

/**
 * Mirror of packtool/build/pack-json.ts PACK_ID_PATTERN (that package is a
 * separate npm project, so the pattern is re-declared here). Keep in sync:
 * packtool build-storyline refuses ids this pattern refuses.
 */
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;

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
  // Storyline pack media (issue #81): the player's AudioClipBase elements
  // refuse to load narration/media served as application/octet-stream.
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Attach the B2 transport-security headers to a response. Applied to EVERY
 * response this handler constructs — success and error alike — matching the
 * "every response, including errors" header discipline of the airgapped
 * server (web_ui/scripts/start.ps1):
 *   - Content-Security-Policy: the strict policy from security/csp.ts
 *     (relaxations documented inline there).
 *   - COOP/COEP/CORP: cross-origin isolation for the renderer, which is what
 *     makes crossOriginIsolated true under app:// so onnxruntime-web may use
 *     wasm.numThreads > 1 (web_ui/src/lib/models/offline-env.ts) — parity
 *     with start.ps1's SharedArrayBuffer setup.
 */
function withSecurityHeaders(
  response: Response,
  csp: string = buildCspPolicy(),
  corp: 'same-origin' | 'cross-origin' = 'same-origin',
  allowCrossOrigin: boolean = false,
): Response {
  response.headers.set('content-security-policy', csp);
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  response.headers.set('cross-origin-embedder-policy', 'require-corp');
  response.headers.set('cross-origin-resource-policy', corp);
  if (allowCrossOrigin) {
    // Pack documents are a different app:// host from the renderer and are
    // embedded as a frame in a COEP require-corp document; their media and
    // subresource fetches are therefore cross-origin and need a CORS pass
    // (the app: scheme is private to this app, so '*' exposes nothing).
    response.headers.set('access-control-allow-origin', '*');
  }
  return response;
}

function forbidden(): Response {
  return withSecurityHeaders(new Response('Forbidden', { status: 403 }));
}

function notFound(): Response {
  return withSecurityHeaders(new Response('Not Found', { status: 404 }));
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
  // The renderer page is loaded from the host-only URL app://index.html (no
  // path component), so the browser resolves index.html's RELATIVE asset URLs
  // (`./assets/...` from the vite build) against the host: a subresource
  // request arrives as app://index.html/assets/<file>. `index.html` is a
  // file, never a directory, so a longer path with that leading segment can
  // only be this relative-resolution form — strip the page segment and serve
  // the rest from the root, keeping the same segment validation as any other
  // request (`..`/`.` after the prefix are still refused below).
  if (segments.length > 1 && segments[0] === 'index.html') {
    segments.shift();
  }
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
 * Resolve a training-route request (`app://training/<packId>/<rest>`) against
 * the packs root. Returns `null` when the request is not a training-route
 * path (caller falls through to the renderer mapping), a `Response` refusal,
 * or the absolute file path to serve. `<rest>` maps under the pack directory
 * three ways (#133 widened the first two so bundled DOCUMENT packs are
 * readable from the Training tab, not just Storyline courses):
 *   - `pack.json`            → <pack>/pack.json (the pack manifest)
 *   - `docs/<rel>`           → <pack>/docs/<rel>  (the pack's source files)
 *   - anything else          → <pack>/assets/player/<rest> (the pack layout
 *     of `packtool build-storyline`, PLAYER_ASSETS_PREFIX — unchanged)
 * The validation discipline mirrors resolveWithinRoot exactly — decode
 * refusal, backslash/NUL refusal (catches percent-encoded backslashes too,
 * because the check runs AFTER decode), `.`/`..` segment refusal, containment
 * — with the packId additionally constrained to PACK_ID_PATTERN before it is
 * ever joined onto the filesystem path.
 */
function resolveTrainingRequest(
  packsAbs: string,
  requestUrl: string,
): string | Response | null {
  const schemeEnd = requestUrl.indexOf('://');
  let rest = schemeEnd >= 0 ? requestUrl.slice(schemeEnd + 3) : requestUrl;
  const suffix = rest.search(/[?#]/);
  if (suffix >= 0) rest = rest.slice(0, suffix);

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return notFound();
  }
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments[0] !== 'training') return null;
  if (segments.length < 3) return notFound(); // training/<packId>/<rest> needs all three parts

  const packId = segments[1];
  if (packId === undefined || !PACK_ID_PATTERN.test(packId)) return forbidden();
  const restSegments = segments.slice(2);
  if (restSegments.some((segment) => segment === '.' || segment === '..')) {
    return forbidden();
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return forbidden();

  // Map a pack-relative URL tail onto <packRootDir>/<pack.json | docs/… |
  // assets/player/…> for a given on-disk pack directory.
  const relativeFor = (packDir: string, tail: string[]): string => {
    const first = tail[0];
    if (first === 'pack.json' && tail.length === 1) {
      return path.join(packDir, 'pack.json');
    }
    if (first === 'docs') {
      return path.join(packDir, 'docs', ...tail.slice(1));
    }
    return path.join(packDir, 'assets', 'player', ...tail);
  };

  // Two managed layouts exist: flat (<packs>/<id>/…, packtool zip output and
  // the d5 player contract) and versioned (<packs>/<id>/<version>/…,
  // PackManager managed copies — what first-run activation installs). When
  // the segment after the id looks like a version and the flat candidate is
  // absent, fall back to the versioned layout; flat stays authoritative when
  // both exist (frozen d5 contract).
  const VERSION_SEGMENT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  const contained = (candidate: string): boolean =>
    candidate !== packsAbs && candidate.startsWith(packsAbs + path.sep);
  let resolved = path.resolve(packsAbs, relativeFor(packId, restSegments));
  if (!contained(resolved)) {
    return forbidden();
  }
  const versionDir = restSegments[0];
  if (!fs.existsSync(resolved) && versionDir !== undefined && VERSION_SEGMENT.test(versionDir)) {
    const versioned = path.resolve(
      packsAbs,
      relativeFor(path.join(packId, versionDir), restSegments.slice(1)),
    );
    if (contained(versioned) && fs.existsSync(versioned)) {
      resolved = versioned;
    }
  }
  return resolved;
}

/**
 * Stat, realpath re-check, and read a resolved path under `rootAbs`, applying
 * `csp` and the `corp` resource policy plus the shared transport-security
 * headers. Shared by the renderer and pack routes so both keep identical
 * serving semantics. The pack route passes corp='cross-origin': the player
 * frame (app://training/<packId>) is a DIFFERENT host from the embedding
 * renderer (app://index.html), so the frame response must be embeddable
 * cross-origin (the app: scheme is private to this app; see csp.ts).
 * `rangeHeader` enables HTTP Range serving: the player's media elements issue
 * Range requests, and a plain 200 full-body response makes Chromium's media
 * pipeline abort with MEDIA_ELEMENT_ERROR (Format error) — narrated slides
 * then never complete their timeline and navigation gates up.
 */
async function serveUnderRoot(
  resolved: string,
  rootAbs: string,
  csp: string,
  corp: 'same-origin' | 'cross-origin' = 'same-origin',
  allowCrossOrigin: boolean = false,
  rangeHeader: string | null = null,
): Promise<Response> {
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
    const bytes = new Uint8Array(data);
    const total = bytes.byteLength;
    const baseHeaders: Record<string, string> = {
      'content-type': mimeTypeFor(real),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
      'accept-ranges': 'bytes',
    };
    if (rangeHeader !== null) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match !== null && (match[1] !== '' || match[2] !== '')) {
        let start: number;
        let end: number;
        if (match[1] === '') {
          // suffix range: bytes=-N (last N bytes)
          start = Math.max(0, total - Number(match[2]));
          end = total - 1;
        } else {
          start = Number(match[1]);
          end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
        }
        if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && start < total) {
          return withSecurityHeaders(new Response(bytes.slice(start, end + 1), {
            status: 206,
            headers: {
              ...baseHeaders,
              'content-range': 'bytes ' + start + '-' + end + '/' + total,
            },
          }), csp, corp, allowCrossOrigin);
        }
        return withSecurityHeaders(new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'content-range': 'bytes */' + total },
        }), csp, corp, allowCrossOrigin);
      }
    }
    return withSecurityHeaders(new Response(bytes, {
      headers: baseHeaders,
    }), csp, corp, allowCrossOrigin);
  } catch {
    return notFound();
  }
}

/**
 * Create the pure request handler served under the app:// scheme.
 * Testable without Electron: `(request: Request) => Promise<Response>`.
 * `packsDir` enables the reserved app://training/<packId>/ route (issue #81);
 * without it, training paths fall through to the renderer mapping and 404.
 */
export function createAppFileHandler(opts: { root: string; packsDir?: string }) {
  const rootAbs = path.resolve(opts.root);
  const packsAbs = opts.packsDir === undefined ? null : path.resolve(opts.packsDir);
  return async function handleAppRequest(request: Request): Promise<Response> {
    const url = typeof request?.url === 'string' ? request.url : '';
    const rangeHeader = typeof request?.headers?.get === 'function' ? request.headers.get('range') : null;

    if (packsAbs !== null) {
      const packResolved = resolveTrainingRequest(packsAbs, url);
      if (packResolved !== null) {
        if (typeof packResolved !== 'string') return packResolved;
        return serveUnderRoot(packResolved, packsAbs, buildTrainingCspPolicy(), 'cross-origin', true, rangeHeader);
      }
    }

    const resolved = resolveWithinRoot(rootAbs, url);
    if (typeof resolved !== 'string') return resolved;
    return serveUnderRoot(resolved, rootAbs, buildCspPolicy(), 'same-origin', false, rangeHeader);
  };
}

/**
 * Register the app:// handler with the real Electron runtime.
 * Call after `app` is ready. Must be called exactly once.
 */
export function registerAppProtocol(opts: { root: string; packsDir?: string }): void {
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
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Streaming: required so media elements (the embedded Storyline
        // player's narration audio, issue #81) can consume responses served
        // by protocol.handle — without it Chromium's media pipeline rejects
        // the source with MEDIA_ELEMENT_ERROR (Format error).
        stream: true,
      },
    },
  ]);
}
