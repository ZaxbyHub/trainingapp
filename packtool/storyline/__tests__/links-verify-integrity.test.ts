// links-verify-integrity.test.ts — verify.ts links validation + writer
// roundtrip (D4/#80). The links integrity checks are the defect-class
// guardrail: a shipped pack whose links rows orphan or misrank must FAIL
// verify. Also proves writePackIndex carries links and installPackRows
// copies them (the install stays lossless).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRoot, installPackRows, openStoreWithSchema, writePackIndex } from '../../build/index-writer.js';
import { verifyPack } from '../../build/verify.js';
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

const require = createRequire(import.meta.url);
interface TestDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}
const Database = require('better-sqlite3') as new (dbPath: string, options?: { readonly?: boolean }) => TestDb;
const sqliteVec = require('sqlite-vec') as { load(db: TestDb): void };

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DIMS = 8;
const PUBLISHED_AT = '2026-09-13T00:00:00.000Z';
const PACK_ID = 'verify-guard-pack';
const COMPUTED_AT = '2026-09-13T00:00:00.000Z';

const scratchRoots: string[] = [];
afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const UNIT_V = [1, 0, 0, 0, 0, 0, 0, 0];
const ORTHO_V = [0, 1, 0, 0, 0, 0, 0, 0];

// The fixture content is fixed, so chunk ids are derivable before staging.
const TEXT0 = 'doc text for verify';
const TEXT1 = 'doc text for verify 1';
const DOC_BYTES = Buffer.from(JSON.stringify({ text: TEXT0 }), 'utf8');
const DOC_ID = docIdFor(DOC_BYTES);
const CHUNK0 = chunkIdFor(DOC_ID, 0, normalizedText(TEXT0));
const CHUNK1 = chunkIdFor(DOC_ID, 1, normalizedText(TEXT1));
const CHUNK_IDS = [CHUNK0, CHUNK1];

function validLinks(): Array<Record<string, unknown>> {
  return [
    { chunk_id: CHUNK0, slide_id: 'S1', pack_id: PACK_ID, score: 0.97, rank: 1, computed_at: COMPUTED_AT },
    { chunk_id: CHUNK0, slide_id: 'S2', pack_id: PACK_ID, score: 0.81, rank: 2, computed_at: COMPUTED_AT },
    { chunk_id: CHUNK0, slide_id: 'S3', pack_id: PACK_ID, score: 0.66, rank: 3, computed_at: COMPUTED_AT },
    { chunk_id: CHUNK1, slide_id: 'S1', pack_id: PACK_ID, score: 0.42, rank: 1, computed_at: COMPUTED_AT },
  ];
}

/** Stage a minimal verifiable doc pack directory with the given links rows. */
function stagePack(root: string, links: Array<Record<string, unknown>>): string {
  const staging = join(root, `pack-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(staging, 'docs'), { recursive: true });
  mkdirSync(join(staging, 'assets', 'player'), { recursive: true });
  const manifest: PackManifest = {
    id: PACK_ID,
    name: 'D4 verify guard fixture',
    version: '1.0.0',
    published_at: PUBLISHED_AT,
    source_class: 'user',
    embedding: { model_id: 'hash', dims: DIMS, normalize: true },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
    docs: [{ path: 'docs/handbook.json', sha256: DOC_ID, title: 'Handbook', mime: DOC_MIME }],
    index: { path: INDEX_FILE_NAME, schema_version: STORE_SCHEMA_VERSION, sqlite_vec_version: SQLITE_VEC_PIN },
  };
  writeFileSync(join(staging, 'docs', 'handbook.json'), DOC_BYTES);
  writeFileSync(join(staging, 'assets', 'player', 'story.html'), '<html></html>');
  writeFileSync(join(staging, PACK_JSON_NAME), serializePackJson(manifest));
  writePackIndex({
    dbPath: join(staging, INDEX_FILE_NAME),
    repoRoot: findRepoRoot(REPO_ROOT) as string,
    dims: DIMS,
    manifest,
    docs: [{ docId: DOC_ID, path: 'docs/handbook.json', sha256: DOC_ID, title: 'Handbook', publishedAt: PUBLISHED_AT }],
    chunks: [
      { chunkId: CHUNK0, docId: DOC_ID, chunkIndex: 0, text: TEXT0, contentHash: contentHashFor(normalizedText(TEXT0)), vector: UNIT_V },
      { chunkId: CHUNK1, docId: DOC_ID, chunkIndex: 1, text: TEXT1, contentHash: contentHashFor(normalizedText(TEXT1)), vector: ORTHO_V },
    ],
    links: links.map((row) => ({
      chunkId: String(row.chunk_id),
      slideId: String(row.slide_id),
      packId: row.pack_id === null ? null : String(row.pack_id),
      score: Number(row.score),
      rank: Number(row.rank),
      computedAt: String(row.computed_at),
    })),
  });
  return staging;
}

function corrupt(packDir: string, sql: string): void {
  const db = new Database(join(packDir, INDEX_FILE_NAME));
  try {
    // The corruption injections deliberately create rows verify must catch
    // (orphan chunk/pack references) — FK enforcement (better-sqlite3 enables
    // it by default) would refuse the very rows the guardrail exists to
    // detect, so injection runs with FKs off, exactly like the C3 check.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe('links writer roundtrip + install copy (D4, issue #80)', () => {
  it('writePackIndex carries links; installPackRows copies them into a store', () => {
    const root = mkdtempSync(join(tmpdir(), 'd4roundtrip-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    const store = openStoreWithSchema(join(root, 'store.sqlite'), DIMS, findRepoRoot(REPO_ROOT) as string);
    try {
      const result = installPackRows(store, join(packDir, INDEX_FILE_NAME));
      expect(result.links).toBe(validLinks().length);
      const counted = store.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number };
      expect(counted.n).toBe(validLinks().length);
      const sample = store
        .prepare('SELECT slide_id, pack_id, rank FROM links WHERE rank = 1 ORDER BY slide_id LIMIT 1')
        .get() as { slide_id: string; pack_id: string; rank: number };
      expect(sample.slide_id).toBe('S1');
      expect(sample.pack_id).toBe(PACK_ID);
    } finally {
      store.close();
    }
  });
});

describe('links integrity guardrail in verifyPack (D4, issue #80)', () => {
  it('a pack with well-formed links verifies OK', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const result = await verifyPack(stagePack(root, validLinks()));
    expect(result.ok).toBe(true);
  });

  it('rejects a manifest stamp / index meta schema_version mismatch (PRR-020)', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    // Downgrade ONLY the index meta stamp: pack.json still declares
    // index.schema_version = STORE_SCHEMA_VERSION, so verify's
    // stamp check AND its manifest cross-check must both fire. The expected
    // message strings template over the constant so the pin cannot drift
    // when the store schema version bumps (C3/#70 moved it to 3).
    corrupt(packDir, "UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    const result = await verifyPack(packDir);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.includes(`index meta.schema_version is 1, want ${STORE_SCHEMA_VERSION}`)),
    ).toBe(true);
    expect(
      result.problems.some((p) => p.includes(`!= manifest index.schema_version ${STORE_SCHEMA_VERSION}`)),
    ).toBe(true);
  });

  it('rejects an orphan chunk reference', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    corrupt(packDir, "INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES ('missing-chunk', 'S1', 'verify-guard-pack', 0.9, 1, '2026-09-13T00:00:00.000Z')");
    const result = await verifyPack(packDir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('missing chunk id missing-chunk'))).toBe(true);
  });

  it('rejects a broken pack_id reference', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    corrupt(packDir, "INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) SELECT id, 'S3', 'ghost-pack', 0.5, 3, '2026-09-13T00:00:00.000Z' FROM chunks LIMIT 1");
    const result = await verifyPack(packDir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('missing pack id ghost-pack'))).toBe(true);
  });

  it('rejects a rank cap violation (4 rows for one chunk)', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    corrupt(packDir, "INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) SELECT id, 'outline', 'verify-guard-pack', 0.55, 4, '2026-09-13T00:00:00.000Z' FROM chunks WHERE id = '" + CHUNK0 + "'");
    const result = await verifyPack(packDir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('top-3 cap'))).toBe(true);
  });

  it('rejects a rank order that breaks descending scores', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    corrupt(packDir, 'UPDATE links SET score = 0.99 WHERE rank = 2');
    const result = await verifyPack(packDir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('descending score'))).toBe(true);
  });

  it('rejects an out-of-range cosine score', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    corrupt(packDir, 'UPDATE links SET score = 1.5 WHERE rank = 1');
    const result = await verifyPack(packDir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('[-1, 1]'))).toBe(true);
  });

  it('rejects an unparseable computed_at', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4verify-'));
    scratchRoots.push(root);
    const packDir = stagePack(root, validLinks());
    corrupt(packDir, "UPDATE links SET computed_at = 'not-a-date' WHERE rank = 1");
    const result = await verifyPack(packDir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('computed_at'))).toBe(true);
  });
});
