/**
 * edgevec import-resolution pin (issue #348 AC2).
 *
 * The published `edgevec@0.6.0` package ships `edgevec.js` importing
 * `./snippets/edgevec-98e271a617b3aceb/src/js/storage.js`, but its package
 * `files` list omits `snippets/` entirely. The production build answers that
 * with `web_ui/vite.config.ts`'s `edgevecSnippetPlugin()`; the test pipeline
 * must answer it too (plugin + `test.server.deps.inline: ['edgevec']`),
 * otherwise every spec whose module graph reaches
 * `src/lib/search/vector-index.ts` dies at import.
 *
 * This test is the durable pin for that config. It resolves the REAL package
 * (no `vi.mock`) without executing WASM: it asserts the wasm-bindgen exports
 * are reachable. If the plugin or the inline setting is removed, module
 * resolution fails here instead of silently re-quarantining three page specs.
 */
import { describe, it, expect } from 'vitest';

describe('edgevec import resolution under vitest (issue #348)', () => {
  it('resolves the real edgevec package through the snippet stub plugin', async () => {
    const mod = (await import('edgevec')) as unknown as Record<string, unknown>;

    // wasm-bindgen surface actually imported by src/lib/search/vector-index.ts:10
    expect(typeof mod.default).toBe('function'); // initWasm
    expect(typeof mod.EdgeVec).toBe('function');
    expect(typeof mod.EdgeVecConfig).toBe('function');
  });
});
