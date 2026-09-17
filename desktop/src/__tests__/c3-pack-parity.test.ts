// c3-pack-parity.test.ts — Node leg of the cross-backend chunk-id parity
// proof (issue #70 AC1). The PYTHON leg (contracts/tests/test_pack_parity.py)
// installs contracts/fixtures/packs/versioned-a-1.0.0 with the real C2
// PackManager, then spawns THIS test with:
//   C3_PARITY_FIXTURE — absolute path of the fixture copy to install;
//   C3_PARITY_OUT     — absolute JSON dump path (parent dir pre-created).
// This leg installs the same fixture with the Node PackManager into a temp
// SQLite store and writes the chunk-id set. The Python leg diffs the two sets
// and fails on any mismatch. Without the env vars the test skips so plain
// `npm test` stays hermetic.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);

describe('c3 pack parity (issue #70 AC1, Node leg)', () => {
  // 120s per-test budget: cold better-sqlite3/sqlite-vec loads on CI (PRR-010).
  it('installs the fixture and dumps its chunk-id set', { timeout: 120_000 }, async () => {
    const fixture = process.env.C3_PARITY_FIXTURE;
    const out = process.env.C3_PARITY_OUT;
    if (fixture === undefined || out === undefined) {
      // Standalone run: nothing to prove parity against. Skipped by design.
      return;
    }
    expect(fs.existsSync(path.join(fixture, 'pack.json'))).toBe(true);

    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const { PackManager } = await import('../../main/backend/store/pack-manager.js');
    const { HashEmbedder } = await import('../../main/backend/ingest/embedder.js');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-parity-node-'));
    const store = openStore({ dbPath: path.join(root, 'store.db') });
    try {
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder(), // store default dims; ids never depend on vectors
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      const result = await manager.install(fixture);
      expect(result.docsInstalled).toBeGreaterThan(0);

      const ids = (
        store.db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(ids.length).toBeGreaterThan(0);
      fs.writeFileSync(out, JSON.stringify(ids), 'utf8');
    } finally {
      store.close();
    }
  });
});
