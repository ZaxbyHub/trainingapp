import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vite plugin to handle edgevec WASM package internal imports.
 * edgevec's JS bundle imports from ./snippets/ which may not resolve
 * during Rollup production builds (edgevec 0.6.0 ships without its snippets/
 * directory), so we stub the storage backend it imports.
 *
 * Contract note (F17): the stub must match the real edgevec backend's miss
 * behavior. The real IndexedDbBackend lives at the content-addressed snippet
 * path `edgevec-98e271a617b3aceb` (the hash edgevec.js:1 imports). That exact
 * directory is shipped in edgevec 0.9.0 on npm; its `read(name)` REJECTS with
 * "File <name> not found" when there is no saved index, and resolves with the
 * Uint8Array data on hit. The previous stub resolved `null` on miss, which the
 * Rust `edgevec_load` deserializer treated as truncated/corrupt data and
 * rejected with ERR_CORRUPTION on every fresh boot. Rejecting on miss makes
 * `edgevec_load` reject cleanly, which VectorIndex.load() already catches as
 * the "no index yet" path — no console error on a fresh boot.
 */
function edgevecSnippetPlugin(): Plugin {
  const VIRTUAL_SNIPPET_ID = '\0edgevec-snippet';
  return {
    name: 'edgevec-snippet-stub',
    resolveId(source, importer) {
      if (source.startsWith('./snippets/') && importer?.includes('edgevec')) {
        return VIRTUAL_SNIPPET_ID;
      }
    },
    load(id) {
      if (id === VIRTUAL_SNIPPET_ID) {
        return `
export class IndexedDbBackend {
  static async read(dbName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('edgevec-db', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('data');
      req.onsuccess = () => {
        const tx = req.result.transaction('data', 'readonly');
        const store = tx.objectStore('data');
        const getReq = store.get(dbName);
        getReq.onsuccess = () => {
          if (getReq.result) {
            resolve(getReq.result);
          } else {
            // Match the real edgevec backend contract (content-addressed
            // snippet edgevec-98e271a617b3aceb, shipped in 0.9.0): reject on
            // miss so the Rust edgevec_load surfaces a Promise rejection
            // (clean "no index" path) rather than resolving null, which the
            // WASM deserializer treats as corrupt data (ERR_CORRUPTION).
            reject(new Error('EdgeVec index not found: ' + dbName));
          }
        };
        getReq.onerror = () => reject(getReq.error);
      };
      req.onerror = () => reject(req.error);
    });
  }
  static async write(dbName, data) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('edgevec-db', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('data');
      req.onsuccess = () => {
        const tx = req.result.transaction('data', 'readwrite');
        const store = tx.objectStore('data');
        const putReq = store.put(data, dbName);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      req.onerror = () => reject(req.error);
    });
  }
}
export default IndexedDbBackend;
`;
      }
    },
  };
}

/**
 * Player-origin routes (browser-training-parity, ADR-0012). The course player
 * runs on the app server's loopback alias (app http://localhost:PORT, player
 * http://127.0.0.1:PORT, or the reverse); this server therefore also answers
 * as the PLAYER origin, where:
 *   - /training-boot.html and /training-boot.js (the boot frame embedded by
 *     the COEP require-corp app page) carry CORP cross-origin + COEP
 *     require-corp, nosniff and no-cache;
 *   - /training/sw.js (the course service worker, scope /training/) carries
 *     nosniff and no-cache;
 *   - every other /training/* request is 404 — never the SPA shell — because
 *     course paths are answered by the player-origin service worker only;
 *   - EVERY other response (the app shell and its assets) carries
 *     `Content-Security-Policy: frame-ancestors 'none'` and
 *     `X-Frame-Options: DENY`: the app is never frameable by anyone, so
 *     untrusted course content on the player origin (which shares this
 *     server) can never load a live app instance in a frame (desktop parity:
 *     desktop/main/security/csp.ts frame-ancestors 'none').
 * Mirrored by scripts/serve-offline.mjs, scripts/start.ps1 and api_server.py;
 * pinned by src/lib/packs/__tests__/player-origin-hosting.test.ts.
 */
export const TRAINING_BOOT_PATHS = new Set(['/training-boot.html', '/training-boot.js']);
export const TRAINING_SW_PATH = '/training/sw.js';
/** Anti-framing headers for every app-shell (non-player-route) response. */
export const APP_SHELL_FRAME_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

export function trainingRouteMiddleware(
  req: { url?: string },
  res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
  next: () => void,
): void {
  const path = (req.url ?? '').split(/[?#]/)[0] ?? '';
  if (TRAINING_BOOT_PATHS.has(path)) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    next();
    return;
  }
  if (path === TRAINING_SW_PATH) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    next();
    return;
  }
  if (path === '/training' || path.startsWith('/training/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end('Not Found');
    return;
  }
  for (const [name, value] of Object.entries(APP_SHELL_FRAME_HEADERS)) res.setHeader(name, value);
  next();
}

function trainingPlayerOriginPlugin(): Plugin {
  return {
    name: 'trainingapp-player-origin-routes',
    configureServer(server) {
      server.middlewares.use(trainingRouteMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(trainingRouteMiddleware);
    },
  };
}

export default defineConfig(({ command }) => ({
  // Relative base so the built bundle's own asset URLs (JS/CSS) work when the
  // self-contained archive is served from any path. Model assets under /models
  // are loaded same-origin and the archive is served at the origin root (the
  // bundled FastAPI server, or a static host) — see PACKAGING.md.
  base: './',
  plugins: [react(), edgevecSnippetPlugin(), trainingPlayerOriginPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers', '@mlc-ai/web-llm', 'edgevec'],
  },
  server: {
    // Bind the IPv4 loopback explicitly (never 0.0.0.0, which would expose
    // the LAN): both loopback names must reach this one listener, because the
    // course player runs on the app origin's alias (localhost <-> 127.0.0.1).
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Same cross-origin isolation for `vite preview`, so the packaged build can be
  // validated with the SharedArrayBuffer/threads it needs for WASM inference.
  preview: {
    host: '127.0.0.1',
    // No proxy (final-critic FC1): preview.proxy otherwise inherits
    // server.proxy, and this server also answers the course player origin,
    // whose uncontrolled same-origin documents (the boot page) course JS can
    // open. A player host must serve only static files.
    proxy: {},
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: 'dist',
    // Dev (`vite` / `vite dev`) keeps sourcemaps for a good debugging experience.
    // Production (`vite build`) drops them: the offline archive is a STIG-
    // scannable artifact, and shipping `.map` files bloats it and exposes source.
    // Pass `-p sourcemap` or set `build.sourcemap` explicitly to override for a
    // debug build.
    sourcemap: command === 'serve',
    // Never inline model/wasm assets into JS — they live in public/models/ and
    // must remain discrete, same-origin files for the offline archive.
    assetsInlineLimit: 0,
  },
}));
