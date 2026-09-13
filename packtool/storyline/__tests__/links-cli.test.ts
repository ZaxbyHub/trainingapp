// links-cli.test.ts — the `packtool links` verb (D4/#80).
// Drives the exported runLinks (the CLI entry is dist/cli.js; tests import
// modules): success on directory and zip doc packs, and every comparability
// guard refusal.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { runLinks } from '../../cli.js';
import { buildStorylinePack } from '../../build/compose.js';
import { findRepoRoot, writePackIndex } from '../../build/index-writer.js';
import { chunkIdFor, contentHashFor, docIdFor, normalizedText } from '../../build/chunk.js';
import {
  DOC_MIME,
  INDEX_FILE_NAME,
  PACK_JSON_NAME,
  SQLITE_VEC_PIN,
  STORE_SCHEMA_VERSION,
  serializePackJson,
  type PackManifest,
} from '../../build/pack-json.js';
import { makeSyntheticPublish } from './helpers/build-fixture.js';

const require = createRequire(import.meta.url);
interface TestDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}
const Database = require('better-sqlite3') as new (dbPath: string, options?: { readonly?: boolean }) => TestDb;
const sqliteVec = require('sqlite-vec') as { load(db: TestDb): void };

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DIMS = 384;
const PUBLISHED_AT = '2026-09-13T00:00:00.000Z';

const scratchRoots: string[] = [];
let root = '';
let repoRoot = '';
let slideVector: number[] = [];
let trainingEmbedding: PackManifest['embedding'];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'd4cli-'));
  // NOTE: root survives every test (it holds the shared training pack); only
  // per-test staging dirs registered in scratchRoots are cleaned by afterEach.
  repoRoot = findRepoRoot(REPO_ROOT) as string;
  const { publishDir } = makeSyntheticPublish(root);
  const build = await buildStorylinePack({
    publishDir,
    out: join(root, 'training-pack.zip'),
    embedder: 'hash',
    id: 'd4-cli-training-pack',
    version: '1.0.0',
    publishedAt: PUBLISHED_AT,
  });
  const scratch = mkdtempSync(join(tmpdir(), 'd4cli-tidx-'));
  scratchRoots.push(scratch);
  const zip = await JSZip.loadAsync(readFileSync(build.packPath));
  const entry = zip.file(INDEX_FILE_NAME);
  if (entry === null) throw new Error('training index missing');
  const indexPath = join(scratch, 'index.sqlite');
  writeFileSync(indexPath, Buffer.from(await entry.async('nodebuffer')));
  const db = new Database(indexPath, { readonly: true });
  try {
    sqliteVec.load(db);
    const row = db
      .prepare(
        "SELECT e.embedding AS embedding FROM docs d JOIN chunks c ON c.doc_id = d.id JOIN embeddings e ON e.chunk_id = c.id WHERE d.path = 'docs/slide-001-S1.json' LIMIT 1",
      )
      .get() as { embedding: Buffer } | undefined;
    if (row === undefined) throw new Error('slide S1 embedding missing');
    const f32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    slideVector = Array.from(f32);
    trainingEmbedding = { model_id: 'hash', dims: DIMS, normalize: true };
  } finally {
    db.close();
  }
}, 120_000);

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface DocPackOptions {
  id: string;
  asZip?: boolean;
  modelId?: string;
  dims?: number;
  normalize?: boolean;
  sourceClass?: 'user' | 'bundled' | 'training';
  /** Override the chunk vector (needed when dims differ from the slides'). */
  chunkVector?: number[];
}

/** Stage a minimal doc pack (dir or zip) with one chunk carrying slideVector. */
async function stageDocPack(options: DocPackOptions): Promise<string> {
  const staging = mkdtempSync(join(tmpdir(), 'd4cli-doc-'));
  scratchRoots.push(staging);
  const docPackId = options.id;
  const text = 'doc chunk mirroring slide S1';
  const docBytes = Buffer.from(JSON.stringify({ text }), 'utf8');
  const docId = docIdFor(docBytes);
  const chunkId = chunkIdFor(docId, 0, normalizedText(text));
  const manifest: PackManifest = {
    id: docPackId,
    name: `D4 CLI ${docPackId}`,
    version: '1.0.0',
    published_at: PUBLISHED_AT,
    source_class: options.sourceClass ?? 'user',
    embedding: {
      model_id: options.modelId ?? 'hash',
      dims: options.dims ?? DIMS,
      normalize: options.normalize ?? true,
    },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
    docs: [{ path: 'docs/handbook.json', sha256: docId, title: 'Handbook', mime: DOC_MIME }],
    index: { path: INDEX_FILE_NAME, schema_version: STORE_SCHEMA_VERSION, sqlite_vec_version: SQLITE_VEC_PIN },
  };
  mkdirSync(join(staging, 'docs'), { recursive: true });
  mkdirSync(join(staging, 'assets', 'player'), { recursive: true });
  writeFileSync(join(staging, 'docs', 'handbook.json'), docBytes);
  writeFileSync(join(staging, 'assets', 'player', 'story.html'), '<html></html>');
  writePackIndex({
    dbPath: join(staging, INDEX_FILE_NAME),
    repoRoot,
    dims: options.dims ?? DIMS,
    manifest,
    docs: [{ docId, path: 'docs/handbook.json', sha256: docId, title: 'Handbook', publishedAt: PUBLISHED_AT }],
    chunks: [
      {
        chunkId,
        docId,
        chunkIndex: 0,
        text,
        contentHash: contentHashFor(normalizedText(text)),
        vector: options.chunkVector ?? slideVector,
      },
    ],
  });
  writeFileSync(join(staging, PACK_JSON_NAME), serializePackJson(manifest));
  if (options.asZip !== true) return staging;
  const zip = new JSZip();
  const zipDate = new Date(PUBLISHED_AT);
  zip.file(PACK_JSON_NAME, readFileSync(join(staging, PACK_JSON_NAME)), { date: zipDate, createFolders: false });
  zip.file('docs/handbook.json', readFileSync(join(staging, 'docs', 'handbook.json')), { date: zipDate, createFolders: false });
  zip.file('assets/player/story.html', readFileSync(join(staging, 'assets', 'player', 'story.html')), { date: zipDate, createFolders: false });
  zip.file(INDEX_FILE_NAME, readFileSync(join(staging, INDEX_FILE_NAME)), { date: zipDate, createFolders: false });
  const outZip = join(staging, `${docPackId}.zip`);
  writeFileSync(outZip, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
  return outZip;
}

function linkRowsFor(packPath: string): Array<Record<string, unknown>> {
  const db = new Database(join(packPath, INDEX_FILE_NAME), { readonly: true });
  try {
    sqliteVec.load(db);
    return db
      .prepare('SELECT chunk_id, slide_id, pack_id, score, rank, computed_at FROM links ORDER BY rank')
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

async function linkRowsForZip(zipPath: string): Promise<Array<Record<string, unknown>>> {
  const scratch = mkdtempSync(join(tmpdir(), 'd4cli-read-'));
  scratchRoots.push(scratch);
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  const entry = zip.file(INDEX_FILE_NAME);
  if (entry === null) throw new Error('index missing from zip');
  const indexPath = join(scratch, 'index.sqlite');
  writeFileSync(indexPath, Buffer.from(await entry.async('nodebuffer')));
  const db = new Database(indexPath, { readonly: true });
  try {
    sqliteVec.load(db);
    return db
      .prepare('SELECT chunk_id, slide_id, pack_id, score, rank, computed_at FROM links ORDER BY rank')
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe('links CLI verb (D4, issue #80)', () => {
  it('populates links rows in a directory doc pack', { timeout: 60_000 }, async () => {
    const docPack = await stageDocPack({ id: 'd4-cli-dir-doc' });
    const exit = await runLinks(['links', '--pack', docPack, '--training', join(root, 'training-pack.zip')]);
    expect(exit).toBe(0);
    const rows = linkRowsFor(docPack);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.slide_id).toBe('S1');
    expect(rows[0]?.pack_id).toBe('d4-cli-dir-doc');
    const rankOne = rows.find((r) => r.rank === 1);
    expect(rankOne === undefined ? -1 : Number(rankOne.score)).toBeCloseTo(1, 6);
    expect(typeof rankOne?.computed_at).toBe('string');
  });

  it('populates links rows in a zip doc pack (entry rewritten in place)', { timeout: 60_000 }, async () => {
    const docPack = await stageDocPack({ id: 'd4-cli-zip-doc', asZip: true });
    const exit = await runLinks(['links', '--pack', docPack, '--training', join(root, 'training-pack.zip')]);
    expect(exit).toBe(0);
    const rows = await linkRowsForZip(docPack);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.slide_id).toBe('S1');
  });

  it('honors --top 1', { timeout: 60_000 }, async () => {
    const docPack = await stageDocPack({ id: 'd4-cli-top1-doc' });
    const exit = await runLinks(['links', '--pack', docPack, '--training', join(root, 'training-pack.zip'), '--top', '1']);
    expect(exit).toBe(0);
    const rows = linkRowsFor(docPack);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rank).toBe(1);
  });

  it('refuses a model_id mismatch', { timeout: 60_000 }, async () => {
    const docPack = await stageDocPack({ id: 'd4-cli-mismatch-doc', modelId: 'other-model' });
    const exit = await runLinks(['links', '--pack', docPack, '--training', join(root, 'training-pack.zip')]);
    expect(exit).toBe(1);
  });

  it('refuses a dims mismatch', { timeout: 60_000 }, async () => {
    // The doc pack must be internally consistent (128-dim index + 128-dim
    // vector); the refusal fires on the doc-vs-training dims comparison.
    const dims = 128;
    const unit128: number[] = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
    const docPack = await stageDocPack({ id: 'd4-cli-dims-doc', dims, chunkVector: unit128 });
    const exit = await runLinks(['links', '--pack', docPack, '--training', join(root, 'training-pack.zip')]);
    expect(exit).toBe(1);
  });

  it('refuses normalize:false embeddings (cosine assumption enforced structurally)', { timeout: 60_000 }, async () => {
    const docPack = await stageDocPack({ id: 'd4-cli-nonnorm-doc', normalize: false });
    const exit = await runLinks(['links', '--pack', docPack, '--training', join(root, 'training-pack.zip')]);
    expect(exit).toBe(1);
  });

  it('refuses a training pack as the doc pack', { timeout: 60_000 }, async () => {
    const docPack = await stageDocPack({ id: 'd4-cli-self-doc', sourceClass: 'training' });
    const exit = await runLinks(['links', '--pack', docPack, '--training', join(root, 'training-pack.zip')]);
    expect(exit).toBe(1);
  });

  it('fails loud on a missing pack path', { timeout: 60_000 }, async () => {
    const docPack = await stageDocPack({ id: 'd4-cli-missing-doc' });
    const exit = await runLinks(['links', '--pack', join(docPack, 'nope'), '--training', join(root, 'training-pack.zip')]);
    expect(exit).toBe(1);
  });
});
