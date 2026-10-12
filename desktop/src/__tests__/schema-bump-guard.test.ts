// schema-bump-guard.test.ts — the SCHEMA-BUMP-CONTRACT made mechanical
// (issue #100 item 3; acknowledgment of the same-commit ladder rule: item 4).
//
// contracts/store.schema.sql states that ANY DDL change MUST bump the
// meta.schema_version seed and extend BOTH migrate ladders — previously a
// comment nobody enforced: a DDL edit with the seed untouched kept the entire
// suite green (Phase 2 mutation probe), and a python CURRENT_SCHEMA_VERSION
// drift was compared to nothing. This guard binds the three independent
// copies of the version (file seed, migrate.ts, migrate.py) AND pins the DDL
// body to the version it was frozen under, so:
//   - mutation A (DDL edit, seed untouched)  -> hash mismatch under seed 3;
//   - mutation B (migrate.py const 3 -> 4)   -> seed 3 != python 4.
// A legitimate schema change therefore requires: bump the seed, extend
// migrate.ts AND migrate.py in the same commit (#100), and add the new
// version's DDL hash below — one conscious, review-visible edit set.
//
// The literal SCHEMA-BUMP-CONTRACT also appears in the failure messages, so
// the frozen check C3's candidate grep (tests referencing the contract) finds
// this file.
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_SCHEMA_VERSION } from '../../main/backend/store/migrate.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('repo root not found (marker contracts/api.openapi.yaml)');
}
const REPO_ROOT = findRepoRoot(path.join(THIS_DIR, '..', '..', '..'));

const SCHEMA_PATH = path.join(REPO_ROOT, 'contracts', 'store.schema.sql');
const MIGRATE_PY_PATH = path.join(REPO_ROOT, 'contracts', 'tests', 'store-interop', 'migrate.py');

/**
 * sha256 of the DDL body (from the first CREATE TABLE to EOF, CRLF-normalized)
 * per schema version. Keyed BY VERSION on purpose: editing the current
 * version's entry instead of bumping is a visible tamper with a frozen pin,
 * while the correct path (seed bump + both ladders + new entry) is exactly
 * what SCHEMA-BUMP-CONTRACT demands.
 */
const DDL_SHA_BY_VERSION: Record<number, string> = {
  3: '745dc3c54a3c661dc6a9573a26d5f72f6d4b1f5c6814672d14c68f3e85296497',
};

function schemaText(): string {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function ddlBodyHash(text: string): string {
  const body = text.slice(text.indexOf('CREATE TABLE'));
  return crypto.createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function schemaSeed(text: string): number {
  const m = text.match(/\('schema_version',\s*'(\d+)'\)/);
  if (m === null) throw new Error('SCHEMA-BUMP-CONTRACT: meta.schema_version seed not found in contracts/store.schema.sql');
  return Number(m[1]);
}

function pythonConst(): number {
  const src = fs.readFileSync(MIGRATE_PY_PATH, 'utf8');
  const m = src.match(/^CURRENT_SCHEMA_VERSION = (\d+)$/m);
  if (m === null) throw new Error('SCHEMA-BUMP-CONTRACT: CURRENT_SCHEMA_VERSION not found in migrate.py');
  return Number(m[1]);
}

describe('SCHEMA-BUMP-CONTRACT (issue #100 item 3): version copies agree', () => {
  it('schema seed == migrate.ts CURRENT_SCHEMA_VERSION == migrate.py CURRENT_SCHEMA_VERSION', () => {
    const seed = schemaSeed(schemaText());
    expect(
      seed,
      `SCHEMA-BUMP-CONTRACT: contracts/store.schema.sql seed (${seed}) must equal ` +
        `migrate.ts CURRENT_SCHEMA_VERSION (${CURRENT_SCHEMA_VERSION}) and migrate.py's ` +
        `(${pythonConst()}) — land both ladders in the same commit (#100)`,
    ).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      pythonConst(),
      `SCHEMA-BUMP-CONTRACT: migrate.py CURRENT_SCHEMA_VERSION (${pythonConst()}) must equal ` +
        `the schema seed (${seed}) — land both migrate.ts and migrate.py in the same commit (#100)`,
    ).toBe(seed);
  });

  it('DDL body hash matches the pin frozen for the current seed', () => {
    const text = schemaText();
    const seed = schemaSeed(text);
    const pinned = DDL_SHA_BY_VERSION[seed];
    expect(pinned, `SCHEMA-BUMP-CONTRACT: no DDL hash pinned for schema version ${seed}`).toBeDefined();
    const actual = ddlBodyHash(text);
    expect(
      actual,
      `SCHEMA-BUMP-CONTRACT: DDL body changed under schema version ${seed} — bump the ` +
        'meta.schema_version seed, extend migrate.ts AND migrate.py in the same commit (#100), ' +
        `and pin the new version's DDL hash (actual=${actual})`,
    ).toBe(pinned);
  });
});
