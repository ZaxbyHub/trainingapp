import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vite plugin to handle edgevec WASM package internal imports.
 * edgevec's JS bundle imports from ./snippets/ which may not resolve
 * during Rollup production builds.
 */
function edgevecSnippetPlugin(): Plugin {
  return {
    name: 'edgevec-snippet-stub',
    resolveId(source, importer) {
      if (source.startsWith('./snippets/') && importer?.includes('edgevec')) {
        return source;
      }
    },
    load(id) {
      if (id.startsWith('./snippets/') && id.includes('edgevec')) {
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

export default defineConfig({
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
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        sourcemapPathTransform: (relativeSourcePath) => {
          return relativeSourcePath;
        },
      },
    },
  },
});
