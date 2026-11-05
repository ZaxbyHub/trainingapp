// c3-pack-shared-docs.test.ts — claimant-aware pack lifecycle over SHARED
// documents (issue #278, AC1-AC3).
//
// RED at base, GREEN after the fix. Two packs shipping byte-identical doc
// content through the REAL PackManager + HashEmbedder on a temp store: the
// second install must CLAIM the existing doc instead of owning it, and every
// lifecycle verb that would have deleted the doc under single-owner
// semantics (remove / supersede to a version lacking the doc / rollback /
// upgrade past the doc) must keep it while the OTHER pack still claims it.
// Each leg asserts: exactly one docs row for the shared sha, the chunk set
// unchanged, pack B still active, and the document retrievable through the
// hybrid pipeline with pack B's attribution.
import { afterEach, describe, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';

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
const itReal = nativeDepsIt('c3-pack-shared-docs');

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed by the test itself
      }
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface SqlDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

const SHARED_TEXT = 'Shared fixture content claimed by two packs at once.';
const SHARED_SHA = createHash('sha256').update(JSON.stringify({ text: SHARED_TEXT }, null, 2)).digest('hex');

async function loadModules() {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const managerMod = await import('../../main/backend/store/pack-manager.js');
  const embedderMod = await import('../../main/backend/ingest/embedder.js');
  const hybridMod = await import('../../main/backend/retrieval/hybrid.js');
  return {
    openStore: storeMod.openStore,
    PackManager: managerMod.PackManager,
    HashEmbedder: embedderMod.HashEmbedder,
    hybridRetrieve: hybridMod.hybridRetrieve,
  };
}

interface DocSpec {
  path: string;
  text: string;
}

/** Build a folder-form pack with the fixture manifest shape; shared bytes
 * across two packs reproduce AC1's shared-document state. */
function makePackDir(root: string, packId: string, version: string, docs: DocSpec[]): string {
  const dir = path.join(root, `${packId}-${version}`);
  const entries = docs.map((doc, index) => {
    const abs = path.join(dir, ...doc.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({ text: doc.text }, null, 2), 'utf8');
    return {
      path: doc.path,
      sha256: createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
      title: `Doc ${index}`,
      mime: 'application/json',
    };
  });
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify(
      {
        id: packId,
        name: `Pack ${packId}`,
        version,
        published_at: '2026-09-16T00:00:00Z',
        source_class: 'bundled',
        embedding: { model_id: 'bge-small-en-v1.5', dims: 8, normalize: true },
        chunking: { strategy: 'fixed-words', size: 256, overlap: 100 },
        docs: entries,
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

async function makeWorkspace(prefix: string) {
  const { openStore, PackManager, HashEmbedder, hybridRetrieve } = await loadModules();
  const root = makeTempDir(prefix);
  const dbPath = path.join(root, 'store.db');
  const store = openStore({ dbPath, dims: 8 });
  openStores.push(store);
  const embedder = new HashEmbedder({ dims: 8 });
  const manager = new PackManager({
    store,
    embedder,
    packsRoot: path.join(root, 'packs'),
    repoRoot: REPO_ROOT,
  });
  return { root, store, manager, embedder, hybridRetrieve, db: store.db as unknown as SqlDb };
}

/** The shared doc's live chunk ids (content-derived, so identical across
 * every version and pack that carries the same bytes). */
function sharedChunkIds(db: SqlDb): Set<string> {
  const row = db.prepare('SELECT id FROM docs WHERE sha256 = ?').get(SHARED_SHA) as { id: string };
  return new Set(
    (db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(row.id) as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
}

/** The shared leg's common tail assertions (AC1-AC3): one docs row for the
 * shared sha, its chunk set unchanged, pack B active and the sole remaining
 * claimant, and the document retrievable with B's attribution. */
async function assertSharedDocSurvives(
  ctx: Awaited<ReturnType<typeof makeWorkspace>>,
  sharedChunksBefore: Set<string>,
): Promise<void> {
  const sharedRows = ctx.db
    .prepare('SELECT id FROM docs WHERE sha256 = ?')
    .all(SHARED_SHA) as Array<{ id: string }>;
  expect(sharedRows).toHaveLength(1);
  const sharedDocId = sharedRows[0]!.id;
  expect(sharedChunkIds(ctx.db)).toEqual(sharedChunksBefore);
  const bRow = ctx.db
    .prepare('SELECT active FROM packs WHERE id = ? ORDER BY version')
    .all('pack-b') as Array<{ active: number }>;
  expect(bRow.some((row) => row.active === 1)).toBe(true);
  const claims = ctx.db
    .prepare('SELECT claimant FROM doc_claims WHERE doc_id = ?')
    .all(sharedDocId) as Array<{ claimant: string }>;
  expect(claims).toEqual([{ claimant: 'pack:pack-b' }]);

  const rows = await ctx.hybridRetrieve('shared fixture content packs', {
    store: ctx.store,
    embedder: ctx.embedder,
    topK: 5,
  });
  const hit = rows.find((row) => row.text.includes(SHARED_TEXT));
  expect(hit).toBeDefined();
  expect(hit?.packId).toBe('pack-b');
}

describe('c3 shared documents across packs (issue #278)', () => {
  itReal('remove A keeps the shared doc claimed by B', async () => {
    const ctx = await makeWorkspace('c3-shared-remove-');
    await ctx.manager.install(makePackDir(ctx.root, 'pack-a', '1.0.0', [{ path: 'docs/shared.json', text: SHARED_TEXT }]));
    await ctx.manager.install(makePackDir(ctx.root, 'pack-b', '1.0.0', [{ path: 'docs/shared.json', text: SHARED_TEXT }]));
    const chunksBefore = sharedChunkIds(ctx.db);

    const removed = await ctx.manager.remove('pack-a');
    expect(removed).toBe(1);
    await assertSharedDocSurvives(ctx, chunksBefore);
    expect(
      (ctx.db.prepare("SELECT COUNT(*) AS n FROM packs WHERE id = 'pack-a'").get() as { n: number }).n,
    ).toBe(0);
  });

  itReal('supersede A to a version lacking the doc keeps B\'s copy', async () => {
    const ctx = await makeWorkspace('c3-shared-supersede-');
    await ctx.manager.install(makePackDir(ctx.root, 'pack-b', '1.0.0', [{ path: 'docs/shared.json', text: SHARED_TEXT }]));
    await ctx.manager.install(
      makePackDir(ctx.root, 'pack-a', '1.0.0', [
        { path: 'docs/shared.json', text: SHARED_TEXT },
        { path: 'docs/other.json', text: 'Pack A version one additional document.' },
      ]),
    );
    // Upgrade past the doc (install-driven), then roll BACK so v1 (carrying
    // the shared doc) is active again — the explicit supersede verb then
    // deactivates v1 and must release only pack-a's claim.
    await ctx.manager.install(
      makePackDir(ctx.root, 'pack-a', '2.0.0', [
        { path: 'docs/other.json', text: 'Pack A version two additional document.' },
      ]),
    );
    await ctx.manager.rollback('pack-a', '1.0.0');
    const chunksBefore = sharedChunkIds(ctx.db);

    await ctx.manager.supersede('pack-a', '1.0.0', '2.0.0');
    await assertSharedDocSurvives(ctx, chunksBefore);
    const aRows = ctx.db
      .prepare('SELECT version, active FROM packs WHERE id = ? ORDER BY version')
      .all('pack-a') as Array<{ version: string; active: number }>;
    expect(aRows.find((row) => row.version === '2.0.0')?.active).toBe(1);
    expect(aRows.find((row) => row.version === '1.0.0')?.active).toBe(0);
  });

  itReal('roll back A to a version lacking the doc keeps B\'s copy', async () => {
    const ctx = await makeWorkspace('c3-shared-rollback-');
    await ctx.manager.install(
      makePackDir(ctx.root, 'pack-a', '1.0.0', [
        { path: 'docs/other.json', text: 'Pack A version one additional document.' },
      ]),
    );
    await ctx.manager.install(
      makePackDir(ctx.root, 'pack-a', '2.0.0', [
        { path: 'docs/shared.json', text: SHARED_TEXT },
        { path: 'docs/other.json', text: 'Pack A version two additional document.' },
      ]),
    );
    await ctx.manager.install(makePackDir(ctx.root, 'pack-b', '1.0.0', [{ path: 'docs/shared.json', text: SHARED_TEXT }]));
    const chunksBefore = sharedChunkIds(ctx.db);

    await ctx.manager.rollback('pack-a', '1.0.0');
    await assertSharedDocSurvives(ctx, chunksBefore);
    const aRows = ctx.db
      .prepare('SELECT version, active FROM packs WHERE id = ? ORDER BY version')
      .all('pack-a') as Array<{ version: string; active: number }>;
    expect(aRows.find((row) => row.version === '1.0.0')?.active).toBe(1);
    expect(aRows.find((row) => row.version === '2.0.0')?.active).toBe(0);
  });

  itReal('upgrading A past the shared doc (install-driven supersede) keeps B\'s copy', async () => {
    const ctx = await makeWorkspace('c3-shared-upgrade-');
    await ctx.manager.install(makePackDir(ctx.root, 'pack-b', '1.0.0', [{ path: 'docs/shared.json', text: SHARED_TEXT }]));
    await ctx.manager.install(
      makePackDir(ctx.root, 'pack-a', '1.0.0', [
        { path: 'docs/shared.json', text: SHARED_TEXT },
        { path: 'docs/other.json', text: 'Pack A version one additional document.' },
      ]),
    );
    const chunksBefore = sharedChunkIds(ctx.db);

    const result = await ctx.manager.install(
      makePackDir(ctx.root, 'pack-a', '2.0.0', [
        { path: 'docs/other.json', text: 'Pack A version two additional document.' },
      ]),
    );
    expect(result.superseded).toContain('pack-a@1.0.0');
    // The shared doc was NOT "replaced" — it survives under pack-b's claim,
    // so the delete-before-reingest must not report it.
    expect(result.replacedDocIds).not.toContain(SHARED_SHA);
    await assertSharedDocSurvives(ctx, chunksBefore);
    const aRows = ctx.db
      .prepare('SELECT version, active FROM packs WHERE id = ? ORDER BY version')
      .all('pack-a') as Array<{ version: string; active: number }>;
    expect(aRows.find((row) => row.version === '2.0.0')?.active).toBe(1);
  });
});
