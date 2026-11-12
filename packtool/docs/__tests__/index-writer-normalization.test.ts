// index-writer-normalization.test.ts — E-AC4 (issue #281): packtool writes
// normalized text into chunks_fts at BUILD (writePackIndex) and at COMPOSE
// (installPackRows, which normalizes rows copied from packs built by older
// packtool — critic r2's explicit compose leg), while chunks.text, chunk ids
// and content_hash stay byte-identical to the pre-change output for the same
// input. Full-vector parity: the twins consume every vector in the shared
// contract file (critic r1).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writePackIndex, installPackRows } from '../../build/index-writer.js';
import { normalizeForSearch } from '../../build/normalize.js';

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

const requireLocal = createRequire(path.join(REPO_ROOT, 'packtool', 'package.json'));
const Database = requireLocal('better-sqlite3');
const sqliteVec = requireLocal('sqlite-vec') as { load(db: unknown): void };

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // an open handle in a caller is the caller's leak; never mask it
      }
    }
  }
});

const VARIANT_DOC = `# Variant\n\nAlpha body about ef${SOFT}ficacy and he${ZWSP}moglobin.\n`;
const PLAIN_DOC = 'Plain body about protocol vocabulary.\n';

interface ChunkRow {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  vector: number[];
}

// One shared real-DB corpus for both legs: build a source db the same shape
// writePackIndex produces, with RAW (pre-#281) mirror rows for the compose leg.
function makeSourceDb(dbPath: string): { db: InstanceType<typeof Database>; chunks: ChunkRow[] } {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  const schema = fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'store.schema.sql'), 'utf8');
  db.exec(schema.split('__EMBEDDING_DIMS__').join('8'));
  return { db, chunks: [] };
}

describe('index-writer normalization (issue #281 E-AC4)', () => {
  it('build writes normalized mirror text and byte-identical identity columns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-norm-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'index.sqlite');
    const chunks: ChunkRow[] = [
      {
        chunkId: 'chk-variant',
        docId: 'doc-variant',
        chunkIndex: 0,
        text: VARIANT_DOC,
        contentHash: 'variant-hash',
        vector: new Array(8).fill(0.5),
      },
      {
        chunkId: 'chk-plain',
        docId: 'doc-variant',
        chunkIndex: 1,
        text: PLAIN_DOC,
        contentHash: 'plain-hash',
        vector: new Array(8).fill(0.25),
      },
    ];
    writePackIndex({
      dbPath,
      repoRoot: REPO_ROOT,
      dims: 8,
      manifest: {
        id: 'iw-norm-pack',
        version: '1.0.0',
        name: 'iw-norm-pack',
        published_at: '2026-11-11T00:00:00.000Z',
        embedding: { model_id: 'hash', dims: 8 },
        source_class: 'general',
      } as never,
      docs: [
        { docId: 'doc-variant', path: 'docs/variant.md', sha256: 'doc-sha', title: 'Variant', publishedAt: null },
      ],
      chunks,
      links: [],
    });
    const db = new Database(dbPath);
    try {
      const fts = db.prepare('SELECT chunk_id, text FROM chunks_fts ORDER BY chunk_id').all() as Array<{ chunk_id: string; text: string }>;
      const byId = new Map(fts.map((r) => [r.chunk_id, r.text]));
      // The mirror is normalized: soft hyphen and ZWSP gone.
      expect(byId.get('chk-variant')).not.toContain(SOFT);
      expect(byId.get('chk-variant')).not.toContain(ZWSP);
      expect(byId.get('chk-variant')).toContain('efficacy');
      expect(byId.get('chk-variant')).toContain('hemoglobin');
      // Identity columns byte-identical to the pre-change output.
      const chunk = db.prepare("SELECT id, text, content_hash FROM chunks WHERE id = 'chk-variant'").get() as { id: string; text: string; content_hash: string };
      expect(chunk.text).toBe(VARIANT_DOC);
      expect(chunk.text).toContain(SOFT);
      expect(chunk.content_hash).toBe('variant-hash');
      expect(chunk.id).toBe('chk-variant');
    } finally {
      db.close();
    }
  });

  it('compose normalizes mirror rows copied from a pre-normalization pack', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-compose-'));
    tempDirs.push(dir);
    // Source db: a v3-era pack whose mirror rows carry the RAW variant text.
    const sourcePath = path.join(dir, 'source.sqlite');
    const { db: source } = makeSourceDb(sourcePath);
    source.exec(`
      INSERT INTO packs (id, version, name, published_at, source_class) VALUES ('old-pack', '1.0.0', 'Old Pack', NULL, 'bundled');
      INSERT INTO docs (id, source_class, path, sha256) VALUES ('doc-old', 'bundled', 'docs/old.md', 'old-sha');
      INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES ('chk-old', 'doc-old', 0, '${VARIANT_DOC.replace(/'/g, "''")}', 'old-hash');
      INSERT INTO embeddings (chunk_id, embedding) VALUES ('chk-old', '${JSON.stringify(new Array(8).fill(0.5)).replace(/"/g, '""')}');
      INSERT INTO chunks_fts (chunk_id, text) VALUES ('chk-old', '${VARIANT_DOC.replace(/'/g, "''")}');
    `);
    source.close();
    // Target: a fresh store; compose copies the old pack's rows in.
    const targetPath = path.join(dir, 'target.sqlite');
    const target = new Database(targetPath);
    try {
      sqliteVec.load(target as never);
      const schema = fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'store.schema.sql'), 'utf8');
      target.exec(schema.split('__EMBEDDING_DIMS__').join('8'));
      const result = installPackRows(target as never, sourcePath);
      expect(result.chunks).toBe(1);
      const fts = target.prepare('SELECT chunk_id, text FROM chunks_fts').all() as Array<{ chunk_id: string; text: string }>;
      expect(fts).toHaveLength(1);
      expect(fts[0].text).not.toContain(SOFT);
      expect(fts[0].text).not.toContain(ZWSP);
      expect(fts[0].text).toContain('efficacy');
      // Identity row copied byte-identical.
      const chunk = target.prepare("SELECT id, text, content_hash FROM chunks WHERE id = 'chk-old'").get() as { text: string; content_hash: string };
      expect(chunk.text).toBe(VARIANT_DOC);
      expect(chunk.content_hash).toBe('old-hash');
    } finally {
      target.close();
    }
  });

  it('the packtool twin matches every vector in the shared contract file', () => {
    const corpus = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'text-normalization-vectors.json'), 'utf8'),
    ) as { version: number; vectors: Array<{ id: string; input: string; expected: string }> };
    expect(corpus.version).toBe(1);
    expect(corpus.vectors.length, 'twin legs must refuse a silently shrunken corpus').toBeGreaterThanOrEqual(33);
    for (const v of corpus.vectors) {
      expect(normalizeForSearch(v.input), `vector ${v.id}`).toBe(v.expected);
    }
  });
});
