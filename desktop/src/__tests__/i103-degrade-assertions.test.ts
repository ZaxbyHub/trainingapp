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
// title (a shared title carrying both tokens would make each `vitest -t`
// driver select both tests and fail its `Tests 1 passed` pin).
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// AC5: force the reranker-null catch to fire. resolveRerankerModelDir is a
// pure fs walk that never throws and every constructor on the start() path is
// lazy, so the catch is unreachable without injection; spreading the real
// module keeps ResumableReranker / WorkerReranker / the constants intact.
vi.mock('../../main/backend/retrieval/reranker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/retrieval/reranker.js')>();
  return {
    ...actual,
    resolveRerankerModelDir: () => {
      throw new Error('injected reranker resolve failure');
    },
  };
});

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

// Artifact-guarded skip (b5 convention): the native store addon must exist;
// CI always installs it.
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itWithDeps = NATIVE_DEPS_PRESENT ? it : it.skip;

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
}

itWithDeps(
  'embedder-null degrade boot is logged and the host still starts',
  async () => {
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
      expect(
        errorSpy.mock.calls.some((args) =>
          String(args[0]).includes('embedding model unavailable (store surface degrades to embedder-less)'),
        ),
      ).toBe(true);
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
