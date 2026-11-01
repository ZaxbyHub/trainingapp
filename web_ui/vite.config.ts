import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
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
 * as the PLAYER origin. Untrusted course JS runs on that origin under the
 * relay-built training CSP (connect-src 'self', form-action 'none'), and it
 * can script ANY same-origin document it can reach (a child frame it creates,
 * or the app's own boot frame through window.parent.frames). So every
 * player-origin document must be at least as confined as a course
 * (final-critic FC6):
 *   - framing is denied by default: EVERY response except the boot page
 *     carries `Content-Security-Policy: frame-ancestors 'none'` and
 *     `X-Frame-Options: DENY` (the app shell, its assets, /training-boot.js,
 *     /training/sw.js, the /training/* 404 and any error the server returns),
 *     so course content can never load one of them in a frame (desktop
 *     parity: desktop/main/security/csp.ts frame-ancestors 'none');
 *   - /training-boot.html (the boot frame embedded by the COEP require-corp
 *     app page) is the one embeddable document: it carries a restrictive
 *     HEADER CSP (bootPageCsp: no fetch, no form, no subresource; scripts and
 *     workers pinned to the exact URLs of its own script and the course
 *     worker, because a worker that course JS starts from the boot window
 *     would otherwise run any same-origin script under that script's own,
 *     unrestricted policy) whose frame-ancestors names ONLY the app origin,
 *     i.e. the loopback alias of the Host this request was sent to, so course
 *     content cannot frame it either; a header (not a meta tag) so no
 *     same-origin script can act in the document before the policy applies.
 *     Any Host other than localhost / 127.0.0.1 gets 'none' for all three
 *     (fail closed; a Host is never reflected);
 *   - /training-boot.html and /training-boot.js carry CORP cross-origin +
 *     COEP require-corp, nosniff and no-cache;
 *   - /training/sw.js (the course service worker, scope /training/) carries
 *     nosniff and no-cache;
 *   - every other /training/* request is 404 — never the SPA shell — because
 *     course paths are answered by the player-origin service worker only.
 * Mirrored by scripts/serve-offline.mjs and scripts/start.ps1 (api_server.py
 * is not a player host); pinned by
 * src/lib/packs/__tests__/player-origin-hosting.test.ts and
 * e2e/isolation-browser.spec.ts (FC6).
 */
export const TRAINING_BOOT_PAGE_PATH = '/training-boot.html';
export const TRAINING_BOOT_SCRIPT_PATH = '/training-boot.js';
export const TRAINING_BOOT_PATHS = new Set([TRAINING_BOOT_PAGE_PATH, TRAINING_BOOT_SCRIPT_PATH]);
export const TRAINING_SW_PATH = '/training/sw.js';
/** Anti-framing headers for every response except the boot page. */
export const FRAME_DENY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

/**
 * The player origin the boot page was requested on, when the Host is a
 * loopback name the bundled hosts serve (every bundled host speaks http);
 * null for anything else.
 */
export function bootPagePlayerOrigin(host: string | undefined): string | null {
  const match = LOOPBACK_HOST.exec(host ?? '');
  return match === null ? null : `http://${(match[1] ?? '').toLowerCase()}${match[2] ?? ''}`;
}

/**
 * The only origin allowed to frame the boot page: the app origin, which is
 * the loopback alias of the player Host this request was sent to
 * (localhost <-> 127.0.0.1, same port). Anything else fails closed to 'none'.
 */
export function bootPageFrameAncestor(host: string | undefined): string {
  const match = LOOPBACK_HOST.exec(host ?? '');
  if (match === null) return "'none'";
  const alias = match[1]?.toLowerCase() === 'localhost' ? '127.0.0.1' : 'localhost';
  return `http://${alias}${match[2] ?? ''}`;
}

/** The boot page's header CSP (final-critic FC6). */
export function bootPageCsp(host: string | undefined): string {
  const player = bootPagePlayerOrigin(host);
  return [
    "default-src 'none'",
    `script-src ${player === null ? "'none'" : `${player}${TRAINING_BOOT_SCRIPT_PATH}`}`,
    `worker-src ${player === null ? "'none'" : `${player}${TRAINING_SW_PATH}`}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${bootPageFrameAncestor(host)}`,
  ].join('; ');
}

export function trainingRouteMiddleware(
  req: { url?: string; headers?: { host?: string } },
  res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
  next: () => void,
): void {
  const path = (req.url ?? '').split(/[?#]/)[0] ?? '';
  // Deny framing first, for every response this server sends (errors
  // included); the boot page is the single exception.
  if (path === TRAINING_BOOT_PAGE_PATH) {
    res.setHeader('Content-Security-Policy', bootPageCsp(req.headers?.host));
  } else {
    for (const [name, value] of Object.entries(FRAME_DENY_HEADERS)) res.setHeader(name, value);
  }
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

/**
 * App-shell precache manifest (issue #34 item 7 via #26, plan R2/R4-1/R5-1).
 *
 * Build-only plugin: on writeBundle, emit `dist/sw-precache-manifest.js` — a
 * CLASSIC script whose body executes `self.__PRECACHE_MANIFEST = [...]` — so
 * the app-shell service worker (public/sw.js) can consume it synchronously
 * with importScripts. The list contains ONLY `index.html` and every hashed
 * `assets/**` file the build emits, using exactly the emitted paths.
 *
 * Excluded (belt; public-dir files are not in the rollup bundle anyway, but a
 * stale or relocated output could surface them): `models/**`, `training/**`,
 * `training-boot.*`, `sw.js`, the manifest itself, `player-origin.json`.
 * Runtime model/pack assets are owned by the browser pack manager's own
 * storage (OPFS/IndexedDB) and are deliberately outside the SW cache. Files
 * larger than 10 MB are skipped with a build warning (they would balloon the
 * first-boot precache for no offline benefit).
 *
 * Output-dir aware: resolves the configured build.outDir in configResolved
 * (relative to the project root) and prefers the rollup output dir when the
 * bundle write names one. Harmless for `build:desktop` (that build gets a
 * manifest file it never reads — disclosed in the plan impact analysis).
 */
const PRECACHE_MAX_BYTES = 10 * 1024 * 1024;

function swPrecacheManifestPlugin(): Plugin {
  let resolvedOutDir = 'dist';
  return {
    name: 'trainingapp-sw-precache-manifest',
    apply: 'build',
    configResolved(config) {
      resolvedOutDir = path.isAbsolute(config.build.outDir)
        ? config.build.outDir
        : path.resolve(config.root, config.build.outDir);
    },
    writeBundle(options) {
      const outDir = options.dir !== undefined && options.dir !== null
        ? path.isAbsolute(options.dir)
          ? options.dir
          : path.resolve(process.cwd(), options.dir)
        : resolvedOutDir;
      const root = outDir;
      const entries: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (entry.isDirectory()) {
            // Only assets/ subdirectories can contain manifest members.
            if (rel === 'assets') walk(full);
            continue;
          }
          if (rel !== 'index.html' && !rel.startsWith('assets/')) continue;
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {
            continue;
          }
          if (size > PRECACHE_MAX_BYTES) {
            this.warn(`sw-precache-manifest: skipped ${rel} (${size} bytes > ${PRECACHE_MAX_BYTES})`);
            continue;
          }
          entries.push(rel);
        }
      };
      walk(outDir);
      entries.sort();
      const body = `self.__PRECACHE_MANIFEST = ${JSON.stringify(entries)};\n`;
      // PRR-118 (PR #264 review): a failed manifest write must FAIL THE
      // BUILD loudly with context. A silent writeFileSync failure (locked
      // file, full disk) would otherwise ship an offline bundle whose
      // service worker precaches nothing — an offline shell that cannot
      // boot offline.
      const manifestPath = path.join(outDir, 'sw-precache-manifest.js');
      // Atomic write (PRR-118 final): a truncated manifest (mid-write crash)
      // would otherwise be importable by sw.js — its importScripts try/catch
      // then precaches nothing and the offline shell silently boots empty.
      // Write to a temp file in the same directory and rename over the target
      // so the manifest is never observable half-written.
      const tmpPath = `${manifestPath}.tmp`;
      try {
        fs.writeFileSync(tmpPath, body, 'utf8');
        fs.renameSync(tmpPath, manifestPath);
      } catch (error) {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          /* best-effort temp cleanup */
        }
        throw new Error(
          `sw-precache-manifest: failed to write ${manifestPath} (${entries.length} entries): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.info(`sw-precache-manifest: ${entries.length} entries`);
    },
  };
}

export default defineConfig(({ command }) => ({
  // Relative base so the built bundle's own asset URLs (JS/CSS) work when the
  // self-contained archive is served from any path. Model assets under /models
  // are loaded same-origin and the archive is served at the origin root (the
  // bundled FastAPI server, or a static host) — see PACKAGING.md.
  base: './',
  plugins: [react(), edgevecSnippetPlugin(), trainingPlayerOriginPlugin(), swPrecacheManifestPlugin()],
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
