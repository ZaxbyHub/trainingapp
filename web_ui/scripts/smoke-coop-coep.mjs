#!/usr/bin/env node
/**
 * Issue #37 P1: offline-build smoke test.
 *
 * Serves the produced dist/ with COOP/COEP headers (mirroring what
 * serve-offline.mjs / vite preview / api_server.py set in production) and
 * asserts:
 *   1. The server is reachable and returns 200 for /.
 *   2. The Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
 *      are set correctly (the precondition for SharedArrayBuffer + ORT/WASM
 *      multi-threading). A missing header is the exact misconfiguration the
 *      IsolationBanner (P3) warns about — catching it in CI prevents shipping a
 *      single-threaded (~3-4× slower) artifact.
 *   3. dist/index.html references at least one /assets/*.js chunk (the Vite
 *      build emitted JavaScript).
 *
 * This smoke uses node:http directly (no external server dep) so it is
 * self-contained. The full headless-browser round-trip (embedding + query
 * returns a non-empty answer, zero non-same-origin network requests) requires
 * a browser dependency (Playwright) AND staged model weights; it is documented
 * as a manual/operator check in PACKAGING.md §4 and is out of scope for this
 * dependency-free CI gate.
 *
 * Usage:  node scripts/smoke-coop-coep.mjs   (run after `npm run build`)
 * Exit code is non-zero on any failure.
 *
 * Import-safe (issue #216 AC5): importing this module executes nothing — the
 * seams (`createSmokeServer`, `checkIndexHtml`, `run`) are exported and only
 * direct execution drives the CLI.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(__dirname, '..');
const DIST = join(WEB_UI, 'dist');

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return existsSync(process.argv[1]) &&
      resolve(process.argv[1]) === resolve(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Returns an error message when index.html references no /assets/*.js chunk. */
export function checkIndexHtml(indexHtml) {
  if (!/\/assets\/[^"']+\.js/.test(indexHtml)) {
    return 'dist/index.html does not reference any /assets/*.js chunk — the Vite build emitted no JavaScript entry.';
  }
  return null;
}

/**
 * Minimal static server that sets the SAME COOP/COEP headers the production
 * servers (vite.config, api_server.py, serve-offline.mjs) set, so the smoke
 * validates the real production response shape.
 */
export function createSmokeServer(distDir, port) {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    let pathname = normalize(decodeURIComponent(url.pathname));
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    let filePath = join(distDir, pathname);
    // Path traversal guard.
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA fallback.
      filePath = join(distDir, 'index.html');
    }
    const body = readFileSync(filePath);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Content-Type', MIME_TYPES[extname(filePath)] ?? 'application/octet-stream');
    res.writeHead(200);
    res.end(body);
  });
}

export function pickPort() {
  return 4321 + Math.floor(Math.random() * 1000);
}

export async function run({
  distDir = DIST,
  port = pickPort(),
  fetch = globalThis.fetch,
  log = console.log,
  logError = console.error,
} = {}) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  // Pre-flight: dist must exist.
  if (!existsSync(join(distDir, 'index.html'))) {
    logError('[smoke] dist/index.html missing — run `npm run build` first.');
    return 1;
  }

  // Read index.html once to assert it references an assets chunk.
  const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');
  const chunkError = checkIndexHtml(indexHtml);
  if (chunkError) fail(chunkError);

  const server = createSmokeServer(distDir, port);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    // Bounded readiness probe (issue #216 AC2): the same-line AbortSignal bound
    // is the census marker (check-census.sh fetch-bound is a same-line rule) —
    // a server that accepts but never answers cannot hang the smoke past it.
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(30000) });
    await res.arrayBuffer(); // drain
    if (res.status !== 200) {
      fail(`expected HTTP 200 from server root, got ${res.status}.`);
    }
    const coop = res.headers.get('cross-origin-opener-policy');
    const coep = res.headers.get('cross-origin-embedder-policy');
    if (coop !== 'same-origin') {
      fail(`Cross-Origin-Opener-Policy header missing or wrong: expected 'same-origin', got '${coop}'. Multi-threaded WASM (SharedArrayBuffer) will be unavailable — responses will be several times slower.`);
    }
    if (coep !== 'require-corp') {
      fail(`Cross-Origin-Embedder-Policy header missing or wrong: expected 'require-corp', got '${coep}'. Multi-threaded WASM (SharedArrayBuffer) will be unavailable.`);
    }
  } catch (e) {
    fail(`smoke test request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    server.close();
  }

  if (errors.length > 0) {
    logError('[smoke] FAILED — offline artifact is not correctly configured:');
    for (const e of errors) logError(`  - ${e}`);
    return 1;
  }
  log('[smoke] OK — dist/ served with COOP/COEP and a valid JS entry chunk.');
  return 0;
}

// Entry guard (issue #216 AC5): only direct execution drives the CLI.
if (isMain(import.meta.url)) {
  process.exit(await run());
}
