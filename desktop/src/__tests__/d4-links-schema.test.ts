// d4-links-schema.test.ts — D4 SCHEMA acceptance check (issue #80).
//
// The issue's required scope names the links columns chunk_id, slide_id,
// pack_id, score, rank, computed_at with PK(chunk_id, slide_id). The reserved
// table at contracts/store.schema.sql:84-91 currently carries only (chunk_id,
// slide_id, score), and adding columns triggers the file's own
// SCHEMA-BUMP-CONTRACT (lines 15-20): the meta.schema_version seed MUST be
// bumped from '1' to '2' and both migrate ladders extended. This check
// asserts, through openStore (the production schema application path):
//   - the three new columns exist on links alongside the original three;
//   - the primary key is still exactly (chunk_id, slide_id);
//   - meta.schema_version == '2'.
//
// RED AT BASE: the columns are missing and the version seed is '1'; both
// assertions fail after the [D4SCHEMA] marker line. Requires
// desktop/node_modules (better-sqlite3); CI always has it.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root discovery via the established contracts marker (b4/b5 convention). */
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

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-links-schema-'));
  tempDirs.push(dir);
  return path.join(dir, 'store.db');
}

async function loadStoreModule() {
  return import('../../main/backend/store/sqlite-store.js');
}

describe('d4 SCHEMA (issue #80): links columns and schema_version 2', () => {
  itReal('links carries chunk_id, slide_id, pack_id, score, rank, computed_at and the seed is version 2', async () => {
    const { openStore } = await loadStoreModule();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 8, repoRoot: REPO_ROOT });
    try {
      console.log('[D4SCHEMA] asserting links schema carries pack_id/rank/computed_at and schema_version 2');

      const columns = (
        store.db.prepare('PRAGMA table_info(links)').all() as Array<{
          cid: number;
          name: string;
          notnull: number;
          pk: number;
        }>
      ).sort((a, b) => a.cid - b.cid);
      const names = columns.map((col) => col.name);

      // The three original columns plus the three the issue requires.
      for (const expected of ['chunk_id', 'slide_id', 'score', 'pack_id', 'rank', 'computed_at']) {
        expect(names, `links columns: ${names.join(', ')}`).toContain(expected);
      }

      // PK is exactly (chunk_id, slide_id), in that order.
      const pkColumns = columns
        .filter((col) => col.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((col) => col.name);
      expect(pkColumns).toEqual(['chunk_id', 'slide_id']);

      // SCHEMA-BUMP-CONTRACT: the seed version moved 1 -> 2.
      const version = store.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(version.value).toBe('2');
    } finally {
      store.close();
    }
  });
});
