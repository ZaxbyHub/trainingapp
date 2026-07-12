import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vite plugin to handle edgevec WASM package internal imports.
 * edgevec's JS bundle imports from ./snippets/ which may not resolve
 * during Rollup production builds.
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
        getReq.onsuccess = () => resolve(getReq.result || null);
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

export default defineConfig(({ command }) => ({
  // Relative base so the built bundle's own asset URLs (JS/CSS) work when the
  // self-contained archive is served from any path. Model assets under /models
  // are loaded same-origin and the archive is served at the origin root (the
  // bundled FastAPI server, or a static host) — see PACKAGING.md.
  base: './',
  plugins: [react(), edgevecSnippetPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers', '@mlc-ai/web-llm', 'edgevec'],
  },
  server: {
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
