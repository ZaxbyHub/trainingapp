#!/usr/bin/env node
/**
 * serve-offline.mjs — zero-dependency static file server for the offline web UI.
 *
 * Serves the dist/ folder with the cross-origin isolation headers required for
 * SharedArrayBuffer (multi-threaded WASM inference). This is the ONLY way to
 * run the app from the desktop without a full Python/FastAPI backend — browsers
 * block dynamic import() of WASM/JS modules from file:// URLs.
 *
 * Usage:
 *   node serve-offline.mjs              # serves on http://localhost:8080
 *   node serve-offline.mjs 9000         # custom port
 *
 * The companion start.bat / start.command / start.sh wrapper auto-opens the
 * browser, so the user just double-clicks.
 *
 * Requires only Node.js (no npm install, no dependencies).
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, dirname } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, 'dist');
const PORT = parseInt(process.argv[2] || '8080', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gguf': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

if (!existsSync(DIST_DIR)) {
  console.error('Error: dist/ folder not found. Run "npm run build:offline" first.');
  process.exit(1);
}

// COOP/COEP/CORP headers applied to ALL responses (including errors) for
// consistent cross-origin isolation (required for SharedArrayBuffer).
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const server = createServer((req, res) => {
  try {
    // Parse the URL and prevent path traversal.
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Normalize and prevent directory traversal.
    const filePath = normalize(join(DIST_DIR, pathname));
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403, COI_HEADERS);
      res.end('Forbidden');
      return;
    }

    // If the path has no extension and isn't a real file, serve index.html
    // (SPA fallback — but NOT for /models/ or /assets/ which are real files).
    let resolvedPath = filePath;
    const ext = extname(filePath);
    if (!ext && !existsSync(filePath)) {
      resolvedPath = join(DIST_DIR, 'index.html');
    }

    // If file doesn't exist, try index.html (SPA routing).
    if (!existsSync(resolvedPath)) {
      resolvedPath = join(DIST_DIR, 'index.html');
    }

    if (!existsSync(resolvedPath)) {
      res.writeHead(404, COI_HEADERS);
      res.end('Not found');
      return;
    }

    const contentType = MIME_TYPES[extname(resolvedPath)] || 'application/octet-stream';
    const fileLen = statSync(resolvedPath).size;

    // HEAD request: headers only, no body (used by readiness probes).
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...COI_HEADERS, 'Content-Type': contentType, 'Content-Length': fileLen, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }

    // Range request support (wllama/ONNX use byte-range fetches).
    const range = req.headers['range'];
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileLen - 1;
        if (start < fileLen && end < fileLen && start <= end) {
          res.writeHead(206, {
            ...COI_HEADERS,
            'Content-Type': contentType,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${fileLen}`,
            'Cache-Control': 'no-cache',
          });
          const stream = createReadStream(resolvedPath, { start, end });
          stream.on('error', (err) => { console.error(err); try { res.writeHead(500, COI_HEADERS); res.end('Internal server error'); } catch {} });
          res.on('error', () => stream.destroy());
          stream.pipe(res);
          return;
        }
      }
      res.writeHead(416, COI_HEADERS);
      res.end('Range Not Satisfiable');
      return;
    }

    // Full GET: stream the file (avoid loading large GGUF into memory).
    res.writeHead(200, {
      ...COI_HEADERS,
      'Content-Type': contentType,
      'Content-Length': fileLen,
      'Cache-Control': 'no-cache',
    });
    const stream = createReadStream(resolvedPath);
    stream.on('error', (err) => { console.error(err); try { res.writeHead(500, COI_HEADERS); res.end('Internal server error'); } catch {} });
    res.on('error', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    res.writeHead(500, COI_HEADERS);
    res.end('Internal server error');
    console.error(err);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  Document Q&A — Offline Edition');
  console.log('  ─────────────────────────────────');
  console.log(`  Open this URL in your browser:`);
  console.log('');
  console.log(`    ${url}`);
  console.log('');
  console.log('  Press Ctrl+C to stop the server.');
  console.log('');

  // Auto-open the browser (best-effort, platform-specific).
  const platform = process.platform;
  const openCmd =
    platform === 'win32' ? `start "" "${url}"` :
    platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  try {
    exec(openCmd);
  } catch {
    // Non-fatal — the URL is printed above.
  }
});
