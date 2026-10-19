// i103-degrade-assertions.test.ts — issue #103 AC4/AC5 (PRR-002/PRR-003).
//
// Pins the two B7 degrade contracts that were previously covered only
// implicitly on every host boot:
//   AC4: the embedder-null catch (backend/index.ts) logs the degrade line and
//        the host still starts embedder-less (store surface survives).
//   AC5: the reranker-null catch (backend/index.ts) logs "degrades to fused
//        ordering" and the host still starts when reranker resolution throws.
//
// NAME CONTRACT (frozen acceptance drivers depend on it): exactly one test
// full-name contains "embedder" and exactly one contains "reranker"; the
// tokens appear ONLY in these two test names — never in a describe/suite
// title. The frozen C3/C4 drivers scope `vitest run <this file> -t <token>`;
// that file scoping is LOAD-BEARING — an UNSCOPED `-t embedder` also matches
// 3 pre-existing tests and `-t reranker` matches 4 (b6-supplementary, b7-*,
// settings-wiring-*), breaking the drivers' "Tests 1 passed" pin. Future
// drivers must keep passing the file path.
//
// MOCK SCOPE: the reranker mock is applied per-test (vi.doMock + a fresh
// module graph via vi.resetModules) so the AC4 test never sees it — the two
// degrade contracts are asserted independently (AC4 also asserts the
// reranker degrade line is ABSENT).
import { afterEach, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = (() => {
  let current = THIS_DIR;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
})();

const itWithDeps = nativeDepsIt('i103-degrade-assertions');

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i103-degrade-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Force the embedder resolve to fail on EVERY machine: with
 * TRAININGAPP_DESKTOP_REPO_ROOT truthy the moduleWalkUp fallback is skipped
 * (embedder.ts repoRoot ternary), so a nonexistent root plus empty model env
 * candidates yields ModelNotConfiguredError deterministically — a bogus
 * TRAININGAPP_EMBEDDING_MODEL_DIR alone would fall through to staged repo
 * weights on a dev box.
 */
function stubNoWeightsEnv(dir: string): void {
  vi.stubEnv('TRAININGAPP_DESKTOP_REPO_ROOT', path.join(dir, 'no-such-repo-root'));
  vi.stubEnv('TRAININGAPP_EMBEDDING_MODEL_DIR', '');
  vi.stubEnv('TRAININGAPP_DESKTOP_EMBEDDER', '');
  vi.stubEnv('TRAININGAPP_RERANKER_MODEL_DIR', '');
  // Explicitly empty: a host config.env is what the stub-reranker seam reads,
  // and stubbing it here keeps ambient values from changing what is measured.
  vi.stubEnv('TRAININGAPP_DESKTOP_RERANKER_STUB', '');
}

itWithDeps(
  'embedder-null degrade boot is logged and the host still starts',
  async () => {
    vi.resetModules(); // fresh graph, NO reranker mock — contracts asserted independently
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const dir = makeTempDir();
    stubNoWeightsEnv(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storePath = path.join(dir, 'store.sqlite');
    const host = new NodeBackendHost({ token: 'test-token', storePath, storeEmbeddingDims: 8 });
    try {
      const handle = await host.start();
      // The frozen B3 contract: degrade, never fail host start.
      expect(handle.mode).toBe('node');
      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(
        messages.some((m) =>
          m.includes('embedding model unavailable (store surface degrades to embedder-less)'),
        ),
      ).toBe(true);
      // Independence from the AC5 contract: with no reranker mock applied,
      // natural resolution returns null (no throw) so the reranker catch
      // must NOT fire during this boot.
      expect(messages.some((m) => m.includes('reranker unavailable'))).toBe(false);
      // The degrade is embedder-only: the store surface survived.
      expect(fs.existsSync(storePath)).toBe(true);
    } finally {
      await host.stop();
    }
  },
  60_000,
);

itWithDeps(
  'reranker-null catch degrades to fused ordering when resolution throws',
  async () => {
    vi.resetModules();
    // Scoped mock (AC5 only): force resolveRerankerModelDir to throw so the
    // otherwise-unreachable catch (every constructor on its try path is
    // lazy) is exercised. Disclosed limitation: the throw fires
    // pre-construction, so the catch's teardown half (reranker/resumable/
    // idle resets) is a no-op here and remains unexercised.
    vi.doMock('../../main/backend/retrieval/reranker.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../main/backend/retrieval/reranker.js')>();
      return {
        ...actual,
        resolveRerankerModelDir: () => {
          throw new Error('injected reranker resolve failure');
        },
      };
    });
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const dir = makeTempDir();
    stubNoWeightsEnv(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = new NodeBackendHost({
      token: 'test-token',
      storePath: path.join(dir, 'store.sqlite'),
      storeEmbeddingDims: 8,
    });
    try {
      const handle = await host.start();
      expect(handle.mode).toBe('node');
      expect(
        errorSpy.mock.calls.some((args) =>
          String(args[0]).includes('reranker unavailable (retrieval degrades to fused ordering)'),
        ),
      ).toBe(true);
    } finally {
      await host.stop();
    }
  },
  60_000,
);
