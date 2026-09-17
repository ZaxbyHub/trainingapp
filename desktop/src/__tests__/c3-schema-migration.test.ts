// c3-schema-migration.test.ts — C3 acceptance check for issue #70 AC6.
//
// Proves the v2 -> v3 ladder (per-version packs + active/install_path; docs
// FK drop) on a REAL seeded v2 store via the production openStore path, and
// that the Python mirror (contracts/tests/store-interop/migrate.py) agrees
// via its --selftest. The DDL shape parity between the ladder and the
// authoritative contracts/store.schema.sql is asserted here too — the same
// discipline the d4-links-store pin established for v2.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface SqlDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

/** Build a minimal v2-shaped store: meta(v2), packs (v2 DDL with the lone-id
 * PK and the supersedes FK), docs (v2 DDL with the docs.pack_id FK), plus one
 * installed row and one doc row to prove lossless migration. */
function seedV2Store(dbPath: string): SqlDb {
  const Database = (
    require('better-sqlite3') as new (p: string) => SqlDb
  );
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES
      ('schema_version', '2'),
      ('embedding_dims', '8');
    CREATE TABLE packs (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      version      TEXT NOT NULL,
      published_at TEXT,
      source_class TEXT NOT NULL,
      supersedes   TEXT REFERENCES packs(id)
    );
    CREATE TABLE docs (
      id           TEXT PRIMARY KEY,
      source_class TEXT NOT NULL,
      path         TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      title        TEXT,
      published_at TEXT,
      pack_id      TEXT REFERENCES packs(id)
    );
    INSERT INTO packs (id, name, version, published_at, source_class, supersedes)
      VALUES ('legacy-pack', 'Legacy Pack', '1.0.0', NULL, 'bundled', NULL);
    INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id)
      VALUES ('legacy-doc-sha', 'bundled', 'docs/a.json', 'legacy-doc-sha', 'A', NULL, 'legacy-pack');
  `);
  return db;
}

describe('c3 store schema migration (issue #70 AC6)', () => {
  itReal('openStore migrates a v2 store to v3: shape, mapping, and data preserved', async () => {
    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../../main/backend/store/migrate.js');
    expect(CURRENT_SCHEMA_VERSION).toBe(3);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-migrate-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.db');
    const seeded = seedV2Store(dbPath);
    seeded.close();

    // Production open path: schema apply is skipped (meta exists), the ladder
    // runs 2 -> 3.
    const store = openStore({ dbPath, dims: 8 });
    try {
      const db = store.db as unknown as SqlDb;
      expect(store.schemaVersion).toBe(3);
      expect(
        (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      ).toBe('3');

      // packs: v3 shape — PK (id, version) + active/install_path.
      const packCols = (
        db.prepare('PRAGMA table_info(packs)').all() as Array<{ name: string; pk: number }>
      ).sort((a, b) => a.pk - b.pk);
      const packNames = packCols.map((c) => c.name);
      for (const expected of ['id', 'version', 'name', 'published_at', 'source_class', 'active', 'install_path', 'supersedes']) {
        expect(packNames).toContain(expected);
      }
      const pk = packCols.filter((c) => c.pk > 0).map((c) => c.name);
      expect(pk).toEqual(['id', 'version']);

      // Row mapping: a v2 row was a live install -> active=1, install_path
      // NULL, supersedes carried verbatim (NULL stays NULL).
      const rows = db.prepare('SELECT * FROM packs').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'legacy-pack',
        version: '1.0.0',
        active: 1,
        install_path: null,
        supersedes: null,
      });

      // docs: v3 shape (columns intact, rows preserved).
      const docCols = (
        db.prepare('PRAGMA table_info(docs)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(docCols).toEqual([
        'id',
        'source_class',
        'path',
        'sha256',
        'title',
        'published_at',
        'pack_id',
      ]);
      const docs = db.prepare('SELECT * FROM docs').all() as Array<Record<string, unknown>>;
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ id: 'legacy-doc-sha', pack_id: 'legacy-pack' });

      // DDL parity: the migrated packs shape must equal a FRESH v3 apply.
      const freshPath = path.join(dir, 'fresh.db');
      const fresh = openStore({ dbPath: freshPath, dims: 8 });
      try {
        const migratedDdl = (
          db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'packs'").get() as {
            sql: string;
          }
        ).sql;
        const freshDdl = (
          fresh.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'packs'").get() as {
            sql: string;
          }
        ).sql;
        // Normalize: ALTER TABLE RENAME quotes the table name and the fresh
        // apply stores the schema file's CRLF text verbatim — compare the
        // semantic DDL, not byte storage artifacts.
        const norm = (s: string): string =>
          s.replace(/\r\n/g, '\n').replace(/"/g, '').replace(/\s+/g, ' ').trim();
        expect(norm(migratedDdl)).toBe(norm(freshDdl));
      } finally {
        fresh.close();
      }
    } finally {
      store.close();
    }
  });

  itReal('the Python mirror ladder agrees (migrate.py --selftest)', () => {
    const script = path.join(REPO_ROOT, 'contracts', 'tests', 'store-interop', 'migrate.py');
    expect(fs.existsSync(script)).toBe(true);
    const out = execFileSync('python', [script, '--selftest'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(out).toContain('selftest OK');
  });
});
