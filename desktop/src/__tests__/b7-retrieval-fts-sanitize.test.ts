// b7-retrieval-fts-sanitize.test.ts — SUPPLEMENTARY spec (issue #65, AC1 edge
// cases; NOT a frozen acceptance check). Pins the FTS5 leg sanitization: user
// queries containing FTS5 operators/quotes/stars must never throw; plain
// tokens behave identically to the raw MATCH form.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../main/backend/store/sqlite-store.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { hybridRetrieve, sanitizeFtsQuery } from '../../main/backend/retrieval/hybrid.js';

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
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;
const DIMS = 8;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seed(prefix: string): ReturnType<typeof Object> | any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'store.sqlite');
  const store = openStore({ dbPath, dims: DIMS, repoRoot: REPO_ROOT });
  const text = 'travel policy mileage rate guidance';
  store.db
    .prepare("INSERT INTO docs (id, source_class, path, sha256) VALUES ('d1', 'test', ?, ?)")
    .run(path.join(dir, 'travel-policy.md'), 'sha');
  store.db
    .prepare("INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES ('c1', 'd1', 0, ?, ?)")
    .run(text, 'sha');
  store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run('c1', text);
  return { store, embedder: new HashEmbedder({ dims: DIMS }) };
}

describe('b7 supplementary: FTS5 query sanitization (issue #65 AC1 edge case)', () => {
  it('sanitizeFtsQuery quotes plain tokens and drops operator/bare-quote/star tokens', () => {
    expect(sanitizeFtsQuery('travel policy')).toBe('"travel" "policy"');
    expect(sanitizeFtsQuery('"travel"')).toBeNull();
    expect(sanitizeFtsQuery('travel*')).toBeNull();
    expect(sanitizeFtsQuery('AND OR NOT')).toBeNull();
    expect(sanitizeFtsQuery('a AND b')).toBe('"a" "b"');
    expect(sanitizeFtsQuery('col:val ^x NEAR(y,z)')).toBeNull();
    expect(sanitizeFtsQuery('   ')).toBeNull();
  });

  itReal('operator-heavy queries never throw and plain queries still match', async () => {
    const fx = seed('b7-fts-');
    try {
      const plain = await hybridRetrieve('travel policy', {
        store: fx.store,
        embedder: fx.embedder,
        topK: 4,
        candidateMultiplier: 1,
      });
      expect(plain.length).toBeGreaterThanOrEqual(1);
      expect(plain[0].text).toContain('travel policy');

      for (const dirty of ['"travel"', 'travel*', 'AND OR NOT', 'a: NEAR(b c) ^', '   ']) {
        const rows = await hybridRetrieve(dirty, {
          store: fx.store,
          embedder: fx.embedder,
          topK: 4,
          candidateMultiplier: 1,
        });
        expect(Array.isArray(rows)).toBe(true);
      }
    } finally {
      fx.store.close();
    }
  });
});
