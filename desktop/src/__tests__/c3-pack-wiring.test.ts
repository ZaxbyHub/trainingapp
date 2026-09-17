// c3-pack-wiring.test.ts — C3 acceptance check for issue #70 AC5.
//
// Proves the PackManager is wired to a REAL production entry point: the
// backend host start path (desktop/main/backend/index.ts) constructs it after
// openStore + embedder resolution and hands it to the engine via the
// established optional-attach pattern (attachPackManager, parallel to
// attachDocumentSurface). The test starts the real node host (stub engine +
// hash embedder, both explicit CI fixtures), then reads the host's internal
// instance field (b3 pin: prototypes expose exactly start/stop — instance
// fields are the sanctioned extension shape, and TS `private` is compile-time
// only) and drives the full lifecycle through THAT object — the same instance
// the engine and API layer receive.
import { afterEach, describe, expect, it } from 'vitest';
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
const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const tempDirs: string[] = [];
const startedHosts: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (startedHosts.length > 0) {
    const host = startedHosts.pop();
    if (host !== undefined) await host.stop().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('c3 pack wiring (issue #70 AC5)', () => {
  itReal('host start attaches a working PackManager; the lifecycle runs through it', async () => {
    const { createBackendHost } = await import('../../main/backend/index.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-wiring-'));
    tempDirs.push(root);
    const host = createBackendHost({
      mode: 'node',
      token: 'c3-wiring-token',
      storePath: path.join(root, 'profiles', 'test', 'store.sqlite'),
      storeEmbeddingDims: 8,
      env: {
        TRAININGAPP_DESKTOP_ENGINE: 'stub',
        TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
      },
    });
    startedHosts.push(host);
    const handle = await host.start();
    expect(handle.port).toBeGreaterThan(0);

    // The start path's construction: read the host instance fields (TS
    // private is compile-time only; the b3 pin forbids prototype members).
    const internals = host as unknown as {
      packManager: unknown;
      engine: { attachedPackManager?: unknown };
    };
    const manager = internals.packManager as
      | import('../../main/backend/store/pack-manager.js').PackManager
      | null;
    expect(manager).toBeInstanceOf(Object);
    expect(manager).not.toBeNull();

    // The engine received the SAME instance via the optional-attach seam.
    expect(internals.engine.attachedPackManager).toBe(manager);

    // Drive the full lifecycle through the attached instance.
    const fixture = path.join(root, 'versioned-a-1.0.0');
    fs.cpSync(path.join(FIXTURES, 'versioned-a-1.0.0'), fixture, { recursive: true });
    const installed = await manager!.install(fixture);
    expect(installed.chunksAdded).toBeGreaterThan(0);

    let records = await manager!.listInstalled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ packId: 'versioned-a', version: '1.0.0', active: true });

    // Supersede/rollback through the wired manager (shared fixtures).
    const v2 = path.join(root, 'versioned-a-2.0.0');
    fs.cpSync(path.join(FIXTURES, 'versioned-a-2.0.0'), v2, { recursive: true });
    await manager!.install(v2);
    await manager!.rollback('versioned-a', '1.0.0');
    records = await manager!.listInstalled();
    expect(records.find((r) => r.version === '1.0.0')?.active).toBe(true);
    expect(records.find((r) => r.version === '2.0.0')?.active).toBe(false);

    const removed = await manager!.remove('versioned-a');
    expect(removed).toBe(2);
    expect(await manager!.listInstalled()).toHaveLength(0);
  });
});
