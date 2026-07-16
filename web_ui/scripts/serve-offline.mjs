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
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, dirname } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, 'dist');
const PORT = parseInt(process.argv[2] || '8080', 10);

const MIME_TYPES: Record<string, string> = {
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

const server = createServer(async (req, res) => {
  try {
    // Parse the URL and prevent path traversal.
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Normalize and prevent directory traversal.
    const filePath = normalize(join(DIST_DIR, pathname));
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
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
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const data = await readFile(resolvedPath);
    const contentType = MIME_TYPES[extname(resolvedPath)] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      // Cross-origin isolation headers — required for SharedArrayBuffer,
      // which enables multi-threaded WASM (ONNX Runtime, wllama).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
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
  const { exec } = await import('node:child_process');
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
