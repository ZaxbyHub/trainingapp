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

describe('c3 E-AC5: pack install writes a normalized mirror (issue #281)', () => {
  it('the classic rebuild install writes normalized rows through the real PackManager path', async () => {
    // A pack dir WITHOUT an index file takes the classic rebuild path
    // (writeLiveChunksLocked): the real PackManager install re-embeds from the
    // pack docs and writes the mirror. This leg executes that writer (critic
    // r2 / mutant M1: the rebuild writer must have its own discriminating
    // execution, not just a twin assertion).
    const src = makeTempDir('c3ftsi-c-src-');
    for (const [name, content] of Object.entries(PACK_DOCUMENT)) {
      fs.writeFileSync(path.join(src, name), content, 'utf8');
    }
    const requireDesk = createRequire(path.join(REPO_ROOT, 'desktop', 'package.json'));
    const spawnSync = requireDesk('node:child_process').spawnSync;
    const JSZip = requireDesk('jszip');
    const PACKTOOL_CLI = path.join(REPO_ROOT, 'packtool', 'dist', 'cli.js');
    const zipPath = path.join(makeTempDir('c3ftsi-c-zip-'), 'pack.zip');
    const run = spawnSync(process.execPath, [
      PACKTOOL_CLI, 'build-docs', src, '--id', 'c3-fts-classic', '--version', '1.0.0',
      '--embedder', 'hash', '--published-at', '2026-11-11T00:00:00.000Z', '-o', zipPath,
    ], { encoding: 'utf8', timeout: 120_000 });
    expect(run.status, `packtool build-docs failed: ${run.stderr}`).toBe(0);
    const packDir = makeTempDir('c3ftsi-c-pack-');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    for (const entry of Object.values(zip.files) as Array<{ name: string; dir: boolean; async(): Promise<Buffer> }>) {
      const target = path.join(packDir, ...entry.name.split('/'));
      if (entry.dir) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await entry.async('nodebuffer')));
    }
    // Classic path: remove the prebuilt index so installLocked rebuilds.
    fs.rmSync(path.join(packDir, 'index.sqlite'), { force: true });

    const root = makeTempDir('c3ftsi-classic-');
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
      const rows = store.db.prepare('SELECT chunk_id, text FROM chunks_fts').all() as Array<{
        chunk_id: string;
        text: string;
      }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.text).not.toContain(SOFT);
        expect(row.text).not.toContain(ZWSP);
      }
      expect(rows.some((r) => r.text.includes('efficacy')), 'classic mirror carries normalized efficacy').toBe(true);
      // Identity: chunks.text keeps the raw variant bytes (ADR-0004).
      const chunk = store.db
        .prepare("SELECT text FROM chunks WHERE text LIKE '%' || char(173) || '%'")
        .get() as { text: string } | undefined;
      expect(chunk, 'identity chunks.text keeps the raw soft hyphen').toBeDefined();
      // Twin consistency: the normalized form matches the desktop twin.
      const raw = (chunk as { text: string }).text;
      expect(normalizeForSearch(raw)).not.toContain(SOFT);
    } finally {
      store.close();
    }
  });

  it('a prebuilt pack installs normalized through PackManager (mirror re-derived from chunk.text)', async () => {
    // Build a real pack with the packtool CLI (hash embedder), corrupt its
    // mirror rows back to RAW (simulating an older packtool), then install
    // through the real PackManager and assert the installed mirror is
    // normalized with chunk ids unchanged.
    const src = makeTempDir('c3ftsi-src-');
    for (const [name, content] of Object.entries(PACK_DOCUMENT)) {
      fs.writeFileSync(path.join(src, name), content, 'utf8');
    }
    const requireDesk = createRequire(path.join(REPO_ROOT, 'desktop', 'package.json'));
    const Database = requireDesk('better-sqlite3');
    const spawnSync = requireDesk('node:child_process').spawnSync;
    const JSZip = requireDesk('jszip');
    const PACKTOOL_CLI = path.join(REPO_ROOT, 'packtool', 'dist', 'cli.js');
    const zipPath = path.join(makeTempDir('c3ftsi-zip-'), 'pack.zip');
    const run = spawnSync(process.execPath, [
      PACKTOOL_CLI, 'build-docs', src, '--id', 'c3-fts-norm', '--version', '1.0.0',
      '--embedder', 'hash', '--published-at', '2026-11-11T00:00:00.000Z', '-o', zipPath,
    ], { encoding: 'utf8', timeout: 120_000 });
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
    // The prebuilt importer (pack-manager.ts:1230 writeLiveOrImportedChunksLocked)
    // re-derives the mirror from chunk.text at import, so normalization there is
    // pinned by the assertions below — the shipped index.sqlite rows are NOT read
    // (readPrebuiltIndex reads meta/chunks/embeddings/links only, pr323 review
    // PRR-016), which is why no corrupt-to-raw step is needed or present.
    const indexSqlite = path.join(packDir, 'index.sqlite');
    expect(fs.existsSync(indexSqlite), 'packtool artifact carries index.sqlite').toBe(true);

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
