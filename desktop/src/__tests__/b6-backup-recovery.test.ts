// b6-backup-recovery.test.ts — B6 backup/restore checks (issue #64, C3; AC5).
//
// Covers, against the REAL store (better-sqlite3 + sqlite-vec):
//   - createBackup: timestamp dirs that sort lexicographically = chronologically,
//     never colliding across rapid successive backups;
//   - restoreBackup: validates meta.schema_version / embedding_dims BEFORE
//     replacing the active store — a future-versioned backup is refused and
//     the active file stays byte-identical.
//
// (Corruption recovery and clear-cache live in b6-corruption-recovery.test.ts
// and b6-clear-cache.test.ts — the phase-2.5 gate needs one check id per AC.)
//
// RED AT BASE: statically imports the not-yet-existing store/backup.js —
// the intended failing-first state. Requires desktop/node_modules
// (better-sqlite3); CI always has it.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';
import { createBackup, latestBackup, restoreBackup } from '../../main/backend/store/backup.js';

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

const nodeRequire = createRequire(import.meta.url);
// Raw better-sqlite3 handle for hand-tampering a backup file's meta (the same
// native addon sqlite-store.ts resolves; structural typing only).
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native addon resolved at runtime
const RawDatabase = nodeRequire('better-sqlite3') as new (
  dbPath: string,
) => { exec(sql: string): void; close(): void };

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256File(filePath: string): string {
  return sha256hex(fs.readFileSync(filePath));
}

function normalized(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

function countRows(store: StoreHandle, table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Seed one doc + chunk + embeddings + fts row directly (interop insert rules). */
function seedDoc(store: StoreHandle, docId: string, marker: string): void {
  const chunkId = `${docId}-chunk0`;
  const text = `${marker} seeded chunk text for backup and recovery roundtrips.`;
  const vector = JSON.stringify(Array.from({ length: store.dims }, (_, i) => ((i % 7) + 1) / 8));
  store.db
    .prepare("INSERT INTO docs (id, source_class, path, sha256) VALUES (?, 'general', ?, ?)")
    .run(docId, `${docId}.txt`, sha256hex(text));
  store.db
    .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, 0, ?, ?)')
    .run(chunkId, docId, text, sha256hex(normalized(text)));
  store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(chunkId, text);
  store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(chunkId, vector);
}

describe('b6 C3 (AC5): backup and restore', () => {
  itReal('createBackup snapshots under collidable-free timestamp dirs; restoreBackup roundtrips the corpus', async () => {
    const root = makeTempDir('b6-c3-backup-');
    const dbPath = path.join(root, 'store.sqlite');
    const backupsDir = path.join(root, 'backups');
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    const seededMarker = 'BACKUP-ROUNDTRIP';
    const seededText = `${seededMarker} seeded chunk text for backup and recovery roundtrips.`;
    seedDoc(store, 'doc-seed-1', seededMarker);

    const first = await createBackup(store, backupsDir);
    expect(fs.existsSync(first.path)).toBe(true);
    expect(first.bytes).toBeGreaterThan(0);
    // A second backup immediately after must NOT collide, and its timestamp
    // dir sorts lexicographically after the first (chronological order).
    const second = await createBackup(store, backupsDir);
    expect(fs.existsSync(second.path)).toBe(true);
    expect(path.dirname(second.path)).not.toBe(path.dirname(first.path));
    expect(path.dirname(second.path) > path.dirname(first.path)).toBe(true);
    expect(latestBackup(backupsDir)).toBe(second.path);

    store.close();
    fs.rmSync(dbPath);
    expect(fs.existsSync(dbPath)).toBe(false);

    const restored = await restoreBackup({ backupPath: second.path, dbPath, repoRoot: REPO_ROOT, dims: 8 });
    expect(restored.schemaVersion).toBe(1);
    const reopened = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(countRows(reopened, 'docs')).toBe(1);
      expect(countRows(reopened, 'chunks_fts')).toBe(1);
      const sha = reopened.db.prepare('SELECT sha256 FROM docs').get() as { sha256: string };
      // Same content identity survived the backup -> restore roundtrip.
      expect(sha.sha256).toBe(sha256hex(seededText));
      expect(reopened.schemaVersion).toBe(1);
    } finally {
      reopened.close();
    }
  });

  itReal('restoreBackup refuses a schema-version-from-the-future backup WITHOUT touching the active store', async () => {
    const root = makeTempDir('b6-c3-refuse-');
    const dbPath = path.join(root, 'store.sqlite');
    const backupsDir = path.join(root, 'backups');
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    seedDoc(store, 'doc-active-1', 'ACTIVE-CONTENT');
    const backup = await createBackup(store, backupsDir);
    store.close();

    // Hand-edit the BACKUP to claim a schema version beyond CURRENT_SCHEMA_VERSION.
    const tampered = new RawDatabase(backup.path);
    tampered.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    tampered.close();

    const before = sha256File(dbPath);
    await expect(restoreBackup({ backupPath: backup.path, dbPath, repoRoot: REPO_ROOT, dims: 8 })).rejects.toThrow();
    expect(sha256File(dbPath)).toBe(before);
    const probe = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(countRows(probe, 'docs')).toBe(1);
    } finally {
      probe.close();
    }
  });
});
