// b7-fts-normalized-mirror.test.ts — E-AC2 (issue #281): a document whose text
// carries a soft hyphen, a zero-width space, a ligature or fullwidth letters is
// found by the plain ASCII query, and a plain document is found by a variant
// query, through the real openStore + IngestPipeline write path and
// chunks_fts MATCH sanitizeFtsQuery(query). The lexical leg is asserted on the
// FTS table directly (hybrid retrieval always fuses a k=30 vector leg that
// would mask a five-document store's misses).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../main/backend/store/sqlite-store.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { IngestPipeline } from '../../main/backend/ingest/pipeline.js';
import { DEFAULT_INGEST_CONFIG } from '../../main/backend/ingest/config.js';
import { sanitizeFtsQuery } from '../../main/backend/retrieval/hybrid.js';
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
const itReal = nativeDepsIt('b7-fts-normalized-mirror');
const DIMS = 8;

const SOFT = String.fromCharCode(0x00ad);
const ZWSP = String.fromCharCode(0x200b);
const LIG_FFI = String.fromCharCode(0xfb03);
const FW_A = String.fromCharCode(0xff21);
const FW_B = String.fromCharCode(0xff22);
const FW_G = String.fromCharCode(0xff27);
const FW_Q = String.fromCharCode(0xff02);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Five fixture documents: four variant-text producers and one plain control.
// Each document is padded past the chunker's minimum so a chunk lands.
const pad = (word: string): string => Array.from({ length: 40 }, () => word).join(' ');
const DOCS: Array<{ name: string; text: string; query: string }> = [
  { name: 'plain.txt', text: `efficacy protocol notes ${pad('protocol')}`, query: 'protocol' },
  { name: 'softhyphen.txt', text: `ef${SOFT}ficacy notes ${pad('filler')}`, query: 'efficacy' },
  { name: 'zwsp.txt', text: `he${ZWSP}moglobin notes ${pad('filler2')}`, query: 'hemoglobin' },
  { name: 'ligature.txt', text: `e${LIG_FFI}cacy trial ${pad('filler3')}`, query: 'efficacy' },
  { name: 'fullwidth.txt', text: `${FW_A}${FW_B}${FW_G} ordering ${pad('filler4')}`, query: 'ABG' },
];

async function seedIngested(): Promise<ReturnType<typeof openStore>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-fts-norm-'));
  tempDirs.push(dir);
  const store = openStore({ dbPath: path.join(dir, 'store.sqlite'), dims: DIMS, repoRoot: REPO_ROOT });
  const pipeline = new IngestPipeline({
    store,
    embedder: new HashEmbedder({ dims: DIMS }),
    config: { ...DEFAULT_INGEST_CONFIG },
  });
  for (const doc of DOCS) {
    const res = await pipeline.ingestFile({ name: path.join(dir, doc.name), data: Buffer.from(doc.text, 'utf8') });
    expect(res.success, `ingest ${doc.name}: ${res.message ?? ''}`).toBe(true);
  }
  return store;
}

function ftsHit(store: ReturnType<typeof openStore>, query: string): string[] {
  const sanitized = sanitizeFtsQuery(query);
  if (sanitized === null) return [];
  const rows = store.db
    .prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ?')
    .all(sanitized) as Array<{ chunk_id: string }>;
  return rows.map((r) => r.chunk_id);
}

function docIds(store: ReturnType<typeof openStore>, fragment: string): string[] {
  const rows = store.db.prepare('SELECT id FROM docs WHERE path LIKE ?').all(`%${fragment}`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

describe('b7 E-AC2: the lexical mirror and query are search-normalized (issue #281)', () => {
  itReal('a variant-text document answers its plain ASCII query through the real ingest writer', async () => {
    const store = await seedIngested();
    try {
      for (const doc of DOCS) {
        const hits = ftsHit(store, doc.query);
        const docChunks = store.db
          .prepare('SELECT c.id FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.path LIKE ?')
          .all(`%${doc.name}`) as Array<{ id: string }>;
        const expected = docChunks.map((c) => c.id);
        for (const chunkId of expected) {
          expect(hits, `query ${doc.query} must find chunk ${chunkId} of ${doc.name}`).toContain(chunkId);
        }
      }
      // Identity: chunks.text keeps the raw variant bytes; only the mirror is
      // normalized (ADR-0004).
      const raw = store.db
        .prepare('SELECT c.text FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.path LIKE ?')
        .get('%softhyphen.txt') as { text: string };
      expect(raw.text).toContain(SOFT);
      const mirror = store.db
        .prepare(
          'SELECT f.text FROM chunks_fts f JOIN chunks c ON c.id = f.chunk_id JOIN docs d ON d.id = c.doc_id WHERE d.path LIKE ?',
        )
        .get('%softhyphen.txt') as { text: string };
      expect(mirror.text).not.toContain(SOFT);
      expect(mirror.text).toContain('efficacy');
    } finally {
      store.close();
    }
  });

  itReal('a plain document answers a variant query (query side normalized)', async () => {
    const store = await seedIngested();
    try {
      const plain = docIds(store, 'plain.txt');
      expect(plain).toHaveLength(1);
      // Soft hyphen inside the query word; the plain document must answer.
      const hits = ftsHit(store, `ef${SOFT}ficacy`);
      const plainChunks = store.db
        .prepare('SELECT id FROM chunks WHERE doc_id = ?')
        .all(plain[0]) as Array<{ id: string }>;
      for (const chunk of plainChunks) {
        expect(hits, 'variant query must find the plain chunk').toContain(chunk.id);
      }
      // U+FF02 fullwidth quote normalizes to an ASCII double quote; the
      // sanitized query must stay syntactically valid FTS5 (no unterminated
      // string) without DROPPING the term (pr323 review PRR-003: base kept
      // smart-quoted terms and matched; the sanitize strips inner syntax
      // chars instead of discarding the token).
      expect(() => ftsHit(store, `query${FW_Q}x`)).not.toThrow();
      const smartHits = ftsHit(store, `“efficacy”`);
      expect(smartHits.length, 'a smart-quoted term must still match the variant doc').toBeGreaterThan(0);
      // An ignorable-only token normalizes to empty and is skipped, not quoted.
      expect(ftsHit(store, `${SOFT} ${ZWSP}`)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
