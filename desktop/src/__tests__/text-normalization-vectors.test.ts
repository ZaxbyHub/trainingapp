// text-normalization-vectors.test.ts — E-AC1 (issue #281): the desktop
// normalizeForSearch twin must produce exactly each vector's expected output.
// Full-vector parity: every vector in the shared file runs on every runtime
// (critic r1: narrow subsets allowed quote/dash/Greek/superscript drift).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForSearch } from '../../main/backend/ingest/normalize.js';

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
const VECTORS_PATH = path.join(REPO_ROOT, 'contracts', 'text-normalization-vectors.json');

interface Vector {
  id: string;
  input: string;
  expected: string;
  note: string;
}

const corpus = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) as {
  version: number;
  vectors: Vector[];
};

// Self-describing floor: the vector file must stay at least as rich as the
// contract requires (>= 24 vectors covering the listed families; a deletion
// here is a contract shrink, not cleanup).
const REQUIRED_IDS = [
  'soft-hyphen-word',
  'zwsp-word',
  'word-joiner',
  'bom',
  'ligature-fl',
  'ligature-ffi',
  'fullwidth-letter',
  'fullwidth-word',
  'fullwidth-quote',
  'superscript',
  'en-dash',
  'minus-sign',
  'curly-quotes',
  'double-quotes',
  'ellipsis',
  'nbsp',
  'greek-preserved',
  'cjk-preserved',
  'whitespace-collapse',
  'ignorable-only-with-space',
];

describe('text normalization vectors (issue #281 E-AC1)', () => {
  it('the vector corpus carries the contract-required families', () => {
    expect(corpus.version).toBe(1);
    expect(corpus.vectors.length).toBeGreaterThanOrEqual(24);
    const ids = new Set(corpus.vectors.map((v) => v.id));
    for (const required of REQUIRED_IDS) {
      expect(ids.has(required), `missing required vector ${required}`).toBe(true);
    }
    // Unique ids (a duplicated id would silently halve a family's coverage).
    expect(ids.size).toBe(corpus.vectors.length);
  });

  it('normalizeForSearch produces exactly each vector expected string', () => {
    for (const v of corpus.vectors) {
      expect(normalizeForSearch(v.input), `vector ${v.id}: ${v.note}`).toBe(v.expected);
    }
  });
});
