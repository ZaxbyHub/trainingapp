import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { edgevecSnippetPlugin } from './vite.config';

export default defineConfig({
  // edgevecSnippetPlugin is the same virtual-module stub the production build
  // uses: the published edgevec 0.6.0 tarball omits the wasm-bindgen
  // `snippets/` directory its own edgevec.js imports, so every module graph
  // that reaches src/lib/search/vector-index.ts fails to resolve without it.
  // Registering it here (plus server.deps.inline below) makes those graphs
  // resolvable in the test pipeline instead of forcing a per-spec mock.
  plugins: [react(), edgevecSnippetPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    // edgevec is externalized by default, which bypasses Vite plugins; inline
    // it so the snippet stub above can intercept its internal import.
    server: { deps: { inline: ['edgevec'] } },
    // Centralized test setup: registers jest-dom matchers and stubs jsdom gaps
    // (matchMedia, IntersectionObserver) once for every test file.
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Pool/memory tuning: the default `vitest run` OOMs because some test files
    // accumulate memory (mocked model pipelines, large fixtures). The effective
    // OOM protection comes from `maxForks: 2` + `isolate: true` (each test file
    // gets a FRESH fork, so cross-file leaks can't compound and a leaky file's
    // fork is discarded after it). `memoryLimit: '3GB'` is a latent backstop:
    // note that for `pool: 'forks'`, vitest does not currently forward
    // `memoryLimit` to tinypool's `maxMemoryLimitBeforeRecycle`, AND `isolate:
    // true` short-circuits tinypool's recycle check — so the value is not
    // reached today. It is set correctly (string unit — a bare number is raw
    // bytes per tinypool) so that if `pool` or `isolate` changes, the limit
    // becomes active at the intended size rather than ~3KB.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2,
        minForks: 1,
        memoryLimit: '3GB',
        isolate: true,
      },
    },
    // Generous timeout for tests that load mocked WASM/model pipelines.
    testTimeout: 30000,
    // No src/ spec is quarantined (issue #348 discharged the last seven: the
    // entries that used to live here named CLOSED owners #20-#25 and rotted
    // against a moved product). Any future quarantine must cite a live owner
    // and is rejected by src/test/vitest-quarantine.test.ts until it does.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // C9 (issue #76): Playwright specs under e2e/ are driven by the
      // playwright.config.ts harness (vite preview + chromium), never by
      // vitest — the include glob's `.spec.` branch would otherwise collect
      // them and fail at import.
      'e2e/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
