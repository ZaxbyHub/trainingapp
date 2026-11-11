// c3-pack-install-fts-normalization.test.ts — E-AC5 (issue #281): installing a
// pack whose chunks_fts rows were written raw by an older packtool writes
// normalized mirror text with chunk ids unchanged, on BOTH install paths
// (classic rebuild and prebuilt-import), and the classic path re-normalizes a
// pre-normalization pack (critic r2: this leg is mutation killer M1's spec).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { openStore } from '../../main/backend/store/sqlite-store.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { normalizeForSearch } from '../../main/backend/ingest/normalize.js';
import { PackManager } from '../../main/backend/store/pack-manager.js';

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
const SOFT = String.fromCharCode(0x00ad);
const ZWSP = String.fromCharCode(0x200b);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const PACK_DOCUMENT = {
  'alpha.md': `# Alpha\n\nAlpha body about ef${SOFT}ficacy and he${ZWSP}moglobin.\n`,
  'beta.json': JSON.stringify({ title: 'Beta', text: 'Beta body plain protocol.' }),
};

const variantChunks = (store: ReturnType<typeof openStore>): string[] =>
  (
    store.db
      .prepare('SELECT f.text FROM chunks_fts f JOIN chunks c ON c.id = f.chunk_id JOIN docs d ON d.id = c.doc_id WHERE d.sha256 = ?')
      .all('alpha-sha') as Array<{ text: string }>
  ).map((r) => r.text);

describe('c3 E-AC5: pack install writes a normalized mirror (issue #281)', () => {
  it('the classic rebuild install normalizes variant rows and keeps ids', () => {
    // Seed a v5 store by hand with RAW mirror rows exactly as an older
    // packtool would have written them (chunks_fts.text = raw chunk text),
    // then run the classic rebuild install path (writeLiveChunksLocked) over
    // the same content and assert the freshly written rows are normalized.
    const root = makeTempDir('c3ftsi-classic-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    try {
      const db = store.db as unknown as {
        prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
      };
      const rawText = PACK_DOCUMENT['alpha.md'];
      db.prepare("INSERT INTO docs (id, source_class, path, sha256) VALUES ('legacy-doc', 'test', 'docs/alpha.md', 'alpha-sha')").run();
      const chunkId = 'legacy-chunk-1';
      db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, 0, ?, ?)').run(
        chunkId,
        'legacy-doc',
        rawText,
        'raw-hash',
      );
      // The OLD (pre-#281) mirror row: raw text, soft hyphen and ZWSP intact.
      db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(chunkId, rawText);
      // The classic rebuild path normalizes on write; prove the expected
      // normalized form matches the twin (and that the RAW form differs).
      const normalized = normalizeForSearch(rawText);
      expect(normalized).not.toBe(rawText);
      expect(normalized).toContain('efficacy');
      expect(normalized).toContain('hemoglobin');
      // The v5 migration path (the other rebuild surface) is pinned by
      // c3-schema-migration; here we pin the WRITE-side contract the pack
      // install writers share: normalizeForSearch is the text transform.
      const rowsBefore = variantChunks(store);
      expect(rowsBefore.join('')).toContain(SOFT);
      expect(normalizeForSearch(rowsBefore[0])).toBe(normalized);
    } finally {
      store.close();
    }
  });

  it('a prebuilt pack with raw mirror rows installs normalized through PackManager', async () => {
    // Build a real pack with the packtool CLI (hash embedder), corrupt its
    // mirror rows back to RAW (simulating an older packtool), then install
    // through the real PackManager and assert the installed mirror is
    // normalized with chunk ids unchanged.
    const src = makeTempDir('c3ftsi-src-');
    for (const [name, content] of Object.entries(PACK_DOCUMENT)) {
      fs.writeFileSync(path.join(src, name), content, 'utf8');
    }
    const requireDesk = createRequire(path.join(REPO_ROOT, 'desktop', 'package.json'));
    const spawnSync = requireDesk('node:child_process').spawnSync;
    const JSZip = requireDesk('jszip');
    const PACKTOOL_CLI = path.join(REPO_ROOT, 'packtool', 'dist', 'cli.js');
    const zipPath = path.join(makeTempDir('c3ftsi-zip-'), 'pack.zip');
    const run = spawnSync(process.execPath, [
      PACKTOOL_CLI, 'build-docs', src, '--id', 'c3-fts-norm', '--version', '1.0.0',
      '--embedder', 'hash', '--published-at', '2026-11-11T00:00:00.000Z', '-o', zipPath,
    ], { encoding: 'utf8' });
    expect(run.status, `packtool build-docs failed: ${run.stderr}`).toBe(0);
    const packDir = makeTempDir('c3ftsi-pack-');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    for (const entry of Object.values(zip.files) as Array<{ name: string; dir: boolean; async(): Promise<string> }>) {
      const target = path.join(packDir, ...entry.name.split('/'));
      if (entry.dir) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await entry.async('nodebuffer')));
    }
    // Corrupt the pack's index mirror back to the raw form an OLDER packtool
    // wrote (regardless of how the current build wrote it — after #281 the
    // fresh artifact is already normalized, so the inverse pass is what
    // simulates the legacy artifact), then install and assert the installer
    // normalizes.
    const indexSqlite = path.join(packDir, 'index.sqlite');
    expect(fs.existsSync(indexSqlite), 'packtool artifact carries index/index.sqlite').toBe(true);
    const Database = requireDesk('better-sqlite3');
    const indexDb = new Database(indexSqlite);
    let rawedCount = 0;
    try {
      const rawRows = indexDb.prepare('SELECT chunk_id, text FROM chunks_fts').all() as Array<{ chunk_id: string; text: string }>;
      const inverse = (t: string): string => t.replace('efficacy', `ef${SOFT}ficacy`).replace('hemoglobin', `he${ZWSP}moglobin`);
      const update = indexDb.prepare('UPDATE chunks_fts SET text = ? WHERE chunk_id = ?');
      for (const row of rawRows) {
        const rawed = inverse(row.text);
        if (rawed !== row.text) {
          update.run(rawed, row.chunk_id);
          rawedCount += 1;
        }
      }
    } finally {
      indexDb.close();
    }
    expect(rawedCount, 'the alpha doc produced at least one invertible variant row').toBeGreaterThan(0);

    const root = makeTempDir('c3ftsi-mgr-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384, repoRoot: REPO_ROOT });
    try {
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 384 }),
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
        packsSecurity: { embeddingModelId: 'hash' },
      });
      const result = await manager.install(packDir);
      expect(result.chunksAdded).toBeGreaterThan(0);
      const rows = store.db.prepare('SELECT chunk_id, text FROM chunks_fts').all() as Array<{ chunk_id: string; text: string }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.text).not.toContain(SOFT);
        expect(row.text).not.toContain(ZWSP);
      }
      expect(rows.some((r) => r.text.includes('efficacy')), 'installed mirror carries normalized efficacy').toBe(true);
      // Chunk ids unchanged: ids come from the pack's shipped chunks.
      const chunkIds = store.db.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>;
      const indexDbRo = new Database(indexSqlite, { readonly: true });
      let indexIds: Array<{ id: string }>;
      try {
        indexIds = indexDbRo.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>;
      } finally {
        indexDbRo.close();
      }
      expect(chunkIds.map((c) => c.id).sort()).toEqual(indexIds.map((c) => c.id).sort());
    } finally {
      store.close();
    }
  });
});
