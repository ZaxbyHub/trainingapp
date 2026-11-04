// c3-pack-user-shared-docs.test.ts — claimant-aware lifetime across PACK
// and USER claims on the same content (issue #278, AC4 + the PC2-4
// path-replacement leg).
//
// RED at base, GREEN after the fix. Real IngestPipeline (user claims) +
// real PackManager (pack claims) on one temp store. Legs: user-first ingest
// then pack install; pack-first install then user re-ingest (the dedupe
// no-op must still stamp the user claim); and the reachable same-path
// replacement — a user re-upload at a path whose stale doc is ALSO
// pack-claimed releases only the user claim, so the pack-claimed stale doc
// SURVIVES the replacement.
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
const itReal = nativeDepsIt('c3-pack-user-shared-docs');

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

const SHARED_TEXT = 'Shared plain text bytes claimed by the user and a pack.';
const SHARED_BYTES = Buffer.from(SHARED_TEXT, 'utf8');
const SHARED_SHA = createHash('sha256').update(SHARED_BYTES).digest('hex');

async function loadModules() {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const managerMod = await import('../../main/backend/store/pack-manager.js');
  const embedderMod = await import('../../main/backend/ingest/embedder.js');
  const pipelineMod = await import('../../main/backend/ingest/pipeline.js');
  const configMod = await import('../../main/backend/ingest/config.js');
  const hybridMod = await import('../../main/backend/retrieval/hybrid.js');
  return {
    openStore: storeMod.openStore,
    PackManager: managerMod.PackManager,
    HashEmbedder: embedderMod.HashEmbedder,
    IngestPipeline: pipelineMod.IngestPipeline,
    DEFAULT_INGEST_CONFIG: configMod.DEFAULT_INGEST_CONFIG,
    hybridRetrieve: hybridMod.hybridRetrieve,
  };
}

/** Folder-form pack whose docs are RAW text/plain bytes (byte-identical to
 * what the user ingests, so both claimants target the same content sha). */
function makeTextPackDir(root: string, packId: string, version: string, docs: Array<{ path: string; data: Buffer }>): string {
  const dir = path.join(root, `${packId}-${version}`);
  const entries = docs.map((doc, index) => {
    const abs = path.join(dir, ...doc.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, doc.data);
    return {
      path: doc.path,
      sha256: createHash('sha256').update(doc.data).digest('hex'),
      title: `Doc ${index}`,
      mime: 'text/plain',
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
  const { openStore, PackManager, HashEmbedder, IngestPipeline, DEFAULT_INGEST_CONFIG, hybridRetrieve } =
    await loadModules();
  const root = makeTempDir(prefix);
  const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
  openStores.push(store);
  const embedder = new HashEmbedder({ dims: 8 });
  const manager = new PackManager({ store, embedder, packsRoot: path.join(root, 'packs'), repoRoot: REPO_ROOT });
  const pipeline = new IngestPipeline({ store, embedder, config: DEFAULT_INGEST_CONFIG });
  return { root, store, manager, pipeline, embedder, hybridRetrieve, db: store.db as unknown as SqlDb };
}

function claimsFor(db: SqlDb, docId: string): string[] {
  return (
    db.prepare('SELECT claimant FROM doc_claims WHERE doc_id = ? ORDER BY claimant').all(docId) as Array<{
      claimant: string;
    }>
  ).map((row) => row.claimant);
}

describe('c3 pack/user shared documents (issue #278)', () => {
  itReal('user-first: pack install claims the user doc; pack removal keeps it', async () => {
    const ctx = await makeWorkspace('c3-user-first-');
    const ingest = await ctx.pipeline.ingestFile({ name: 'shared.txt', data: new Uint8Array(SHARED_BYTES) });
    expect(ingest.success).toBe(true);
    expect(ingest.documents).toBe(1);

    await ctx.manager.install(
      makeTextPackDir(ctx.root, 'pack-a', '1.0.0', [{ path: 'docs/shared.txt', data: SHARED_BYTES }]),
    );
    const sharedDocId = (
      ctx.db.prepare('SELECT id FROM docs WHERE sha256 = ?').get(SHARED_SHA) as { id: string }
    ).id;
    expect(claimsFor(ctx.db, sharedDocId).sort()).toEqual(['pack:pack-a', 'user']);
    const chunksBefore = new Set(
      (ctx.db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(sharedDocId) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );

    await ctx.manager.remove('pack-a');
    // The user claim keeps the doc, its chunks, and retrievability — now
    // NEUTRAL (no pack attribution) instead of pack-attributed or gone.
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE sha256 = ?').get(SHARED_SHA)).toMatchObject({ n: 1 });
    expect(
      new Set(
        (ctx.db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(sharedDocId) as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      ),
    ).toEqual(chunksBefore);
    expect(claimsFor(ctx.db, sharedDocId)).toEqual(['user']);
    const rows = await ctx.hybridRetrieve('shared plain text bytes', {
      store: ctx.store,
      embedder: ctx.embedder,
      topK: 5,
    });
    const hit = rows.find((row) => row.text.includes(SHARED_TEXT));
    expect(hit).toBeDefined();
    expect(hit?.packId ?? null).toBeNull();
  });

  itReal('pack-first: user re-ingest of pack bytes dedupes AND claims user; pack removal keeps it', async () => {
    const ctx = await makeWorkspace('c3-pack-first-');
    await ctx.manager.install(
      makeTextPackDir(ctx.root, 'pack-a', '1.0.0', [{ path: 'docs/shared.txt', data: SHARED_BYTES }]),
    );
    const chunksBefore = new Set(
      (ctx.db.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>).map((r) => r.id),
    );

    const ingest = await ctx.pipeline.ingestFile({ name: 'shared.txt', data: new Uint8Array(SHARED_BYTES) });
    expect(ingest.success).toBe(true);
    // Content dedupe stays a no-op for content...
    expect(ingest.documents).toBe(0);
    const sharedDocId = (
      ctx.db.prepare('SELECT id FROM docs WHERE sha256 = ?').get(SHARED_SHA) as { id: string }
    ).id;
    // ...but the user CLAIM landed (the dedupe branch records it).
    expect(claimsFor(ctx.db, sharedDocId).sort()).toEqual(['pack:pack-a', 'user']);

    await ctx.manager.remove('pack-a');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE sha256 = ?').get(SHARED_SHA)).toMatchObject({ n: 1 });
    expect(
      new Set((ctx.db.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>).map((r) => r.id)),
    ).toEqual(chunksBefore);
    expect(claimsFor(ctx.db, sharedDocId)).toEqual(['user']);
    const rows = await ctx.hybridRetrieve('shared plain text bytes', {
      store: ctx.store,
      embedder: ctx.embedder,
      topK: 5,
    });
    expect(rows.some((row) => row.text.includes(SHARED_TEXT))).toBe(true);
    expect(rows.find((row) => row.text.includes(SHARED_TEXT))?.packId ?? null).toBeNull();
  });

  itReal('same-path replacement: a pack-claimed stale doc survives the user re-upload', async () => {
    const ctx = await makeWorkspace('c3-user-replace-');
    const replacedBytes = Buffer.from('Replacement revision at the same path, new bytes.', 'utf8');
    const replacedSha = createHash('sha256').update(replacedBytes).digest('hex');
    expect(replacedSha).not.toBe(SHARED_SHA);

    const first = await ctx.pipeline.ingestFile({ name: 'shared.txt', data: new Uint8Array(SHARED_BYTES) });
    expect(first.documents).toBe(1);
    await ctx.manager.install(
      makeTextPackDir(ctx.root, 'pack-a', '1.0.0', [{ path: 'docs/shared.txt', data: SHARED_BYTES }]),
    );
    const sharedDocId = (
      ctx.db.prepare('SELECT id FROM docs WHERE sha256 = ?').get(SHARED_SHA) as { id: string }
    ).id;
    const staleChunkIds = new Set(
      (ctx.db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(sharedDocId) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );

    const second = await ctx.pipeline.ingestFile({ name: 'shared.txt', data: new Uint8Array(replacedBytes) });
    expect(second.success).toBe(true);
    expect(second.documents).toBe(1);

    // The stale doc SURVIVED the replacement: its pack claim was never the
    // user's to release, and the user claim deletion landed atomically with
    // the new revision's insert (same transaction).
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE sha256 = ?').get(SHARED_SHA)).toMatchObject({ n: 1 });
    expect(claimsFor(ctx.db, sharedDocId)).toEqual(['pack:pack-a']);
    expect(
      new Set(
        (ctx.db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(sharedDocId) as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      ),
    ).toEqual(staleChunkIds);
    // The new revision is present and claimed by the user alone.
    const newDocId = (
      ctx.db.prepare('SELECT id FROM docs WHERE sha256 = ?').get(replacedSha) as { id: string }
    ).id;
    expect(claimsFor(ctx.db, newDocId)).toEqual(['user']);
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get(newDocId) as { n: number }).n,
    ).toBeGreaterThan(0);
  });
});
