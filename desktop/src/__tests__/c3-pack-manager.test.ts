// c3-pack-manager.test.ts — C3 acceptance checks for issue #70.
//
// Subjects of frozen checks C2 (stale-chunk), C3 (supersede/rollback) and
// C4 (schema-version mismatch refusal). The scenarios mirror the Python
// reference suite (tests/test_pack_manager.py) run against the SQLite store:
// openStore (B5) + the REAL PackManager with the deterministic HashEmbedder
// (chunk ids never depend on embedder output, so the fixture is honest).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

/** Temp dirs created per test; removed in afterEach (after stores close — an
 * open better-sqlite3 handle makes rmSync EPERM on Windows). */
const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed by the test itself
      }
    }
  }
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

async function loadModules() {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const managerMod = await import('../../main/backend/store/pack-manager.js');
  const embedderMod = await import('../../main/backend/ingest/embedder.js');
  return { openStore: storeMod.openStore, PackManager: managerMod.PackManager, PackManagerError: managerMod.PackManagerError, HashEmbedder: embedderMod.HashEmbedder };
}

interface SqlDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

async function makeWorkspace() {
  const { openStore, PackManager, HashEmbedder } = await loadModules();
  const root = makeTempDir('c3-packmgr-');
  const dbPath = path.join(root, 'store.db');
  const store = openStore({ dbPath, dims: 8 });
  openStores.push(store);
  const manager = new PackManager({
    store,
    embedder: new HashEmbedder({ dims: 8 }),
    packsRoot: path.join(root, 'packs'),
    repoRoot: REPO_ROOT,
  });
  return { root, store, manager, db: store.db as unknown as SqlDb };
}

/** Copy a fixture pack into the workspace and rewrite its manifest freely. */
function copyFixture(root: string, name: string, destName = name): string {
  const dest = path.join(root, destName);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function readManifest(packDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8')) as Record<string, unknown>;
}

function writeManifest(packDir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/** Rewrite a doc's JSON content AND its manifest sha (C2 write_doc parity). */
function writeDoc(packDir: string, relPath: string, text: string): void {
  const docPath = path.join(packDir, relPath);
  fs.writeFileSync(docPath, JSON.stringify({ text }, null, 2), 'utf8');
  const sha = createHash('sha256').update(fs.readFileSync(docPath)).digest('hex');
  const manifest = readManifest(packDir) as { docs: Array<{ path: string; sha256: string }> };
  for (const entry of manifest.docs) {
    if (entry.path === relPath) entry.sha256 = sha;
  }
  writeManifest(packDir, manifest);
}

function liveChunkIds(db: SqlDb): Set<string> {
  return new Set(
    (db.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>).map((r) => r.id),
  );
}

function packRows(db: SqlDb): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM packs ORDER BY id, version').all() as Array<
    Record<string, unknown>
  >;
}

describe('c3 PackManager lifecycle (issue #70)', () => {
  itReal('stale-chunk: edit-in-place re-supersede removes the old chunk id on SQLite', async () => {
    const { manager, db } = await makeWorkspace();
    // Install 1.0.0 with doc content A.
    const v1 = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-1.0.0');
    writeDoc(v1, 'docs/a.json', 'Stale chunk content BEFORE the edit-in-place reinstall.');
    const install1 = await manager.install(v1);
    expect(install1.chunksAdded).toBe(1);
    const idsBefore = liveChunkIds(db);
    expect(idsBefore.size).toBe(1);

    // Install 2.0.0 of the SAME pack: same doc path, CHANGED content — the
    // old chunk id must be gone from the live store.
    const v2 = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-2.0.0');
    writeDoc(v2, 'docs/a.json', 'Fresh chunk content AFTER the edit-in-place reinstall.');
    const install2 = await manager.install(v2);
    expect(install2.chunksAdded).toBe(1);
    expect(install2.superseded).toContain('versioned-a@1.0.0');
    expect(install2.replacedDocIds).toHaveLength(1);

    const idsAfter = liveChunkIds(db);
    expect(idsAfter.size).toBe(1);
    expect([...idsBefore].some((id) => idsAfter.has(id))).toBe(false);
    const versions = packRows(db).map((r) => `${r.id}@${r.version}${r.active === 1 ? ' active' : ''}`);
    expect(versions).toContain('versioned-a@2.0.0 active');
  });

  itReal('supersede: cross-id target deactivates, chunks go, managed files stay', async () => {
    const { manager, db } = await makeWorkspace();
    const a1 = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-1.0.0');
    await manager.install(a1);
    const idsBefore = liveChunkIds(db);

    // Pack B supersedes versioned-a@1.0.0 (cross-id target).
    const bDir = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-1.0.0', 'pack-b');
    // writeDoc first (it re-reads the manifest from disk), THEN the id
    // mutations, then a single writeManifest.
    writeDoc(bDir, 'docs/a.json', 'Pack B superseding content, distinct from pack A.');
    const manifest = readManifest(bDir) as Record<string, unknown>;
    manifest.id = 'pack-b';
    manifest.name = 'Pack B';
    manifest.supersedes = ['versioned-a@1.0.0'];
    writeManifest(bDir, manifest);
    const result = await manager.install(bDir);
    expect(result.superseded).toContain('versioned-a@1.0.0');

    // A's chunk ids are gone (paths differ -> delete-before-reingest fired).
    const idsAfter = liveChunkIds(db);
    for (const id of idsBefore) expect(idsAfter.has(id)).toBe(false);

    // A's managed files are retained, its row inactive.
    const aRow = packRows(db).find((r) => r.id === 'versioned-a') as Record<string, unknown>;
    expect(aRow.active).toBe(0);
    expect(fs.existsSync(String(aRow.install_path))).toBe(true);
    expect(fs.existsSync(path.join(String(aRow.install_path), 'pack.json'))).toBe(true);
  });

  itReal('rollback: restores the exact prior version chunk-id set', async () => {
    const { manager, db } = await makeWorkspace();
    const v1 = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-1.0.0');
    await manager.install(v1);
    const v1Ids = new Set(liveChunkIds(db));

    const v2 = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-2.0.0');
    writeDoc(v2, 'docs/a.json', 'Version two content, different from version one.');
    await manager.install(v2);
    expect(liveChunkIds(db).size).toBe(1);

    await manager.rollback('versioned-a', '1.0.0');
    expect(liveChunkIds(db)).toEqual(v1Ids);
    const rows = packRows(db);
    const v1Row = rows.find((r) => r.version === '1.0.0') as Record<string, unknown>;
    const v2Row = rows.find((r) => r.version === '2.0.0') as Record<string, unknown>;
    expect(v1Row.active).toBe(1);
    expect(v2Row.active).toBe(0);
  });

  itReal('supersede and rollback verbs are symmetric (round-trips chunk sets)', async () => {
    const { manager, db } = await makeWorkspace();
    const v1 = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-1.0.0');
    await manager.install(v1);
    const v1Ids = new Set(liveChunkIds(db));
    const v2 = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-2.0.0');
    writeDoc(v2, 'docs/a.json', 'Round trip content for the symmetry check.');
    await manager.install(v2);
    const v2Ids = new Set(liveChunkIds(db));

    await manager.rollback('versioned-a', '1.0.0');
    expect(liveChunkIds(db)).toEqual(v1Ids);
    await manager.supersede('versioned-a', '1.0.0', '2.0.0');
    expect(liveChunkIds(db)).toEqual(v2Ids);
  });

  itReal('refusals: downgrade, equal version, unknown rollback target, active rollback, missing supersede pair', async () => {
    const { manager } = await makeWorkspace();
    const { PackManagerError } = await loadModules();
    const root = makeTempDir('c3-fixture-root-');
    const v1 = copyFixture(root, 'versioned-a-1.0.0');
    await manager.install(v1);
    const v2 = copyFixture(root, 'versioned-a-2.0.0');
    writeDoc(v2, 'docs/a.json', 'Higher version content for refusal checks.');
    await manager.install(v2);

    // Downgrade refused (2.0.0 active).
    const v3down = copyFixture(root, 'versioned-a-2.0.0', 'downgrade-copy');
    writeDoc(v3down, 'docs/a.json', 'Downgrade attempt content.');
    const dm = readManifest(v3down) as Record<string, unknown>;
    dm.version = '1.5.0';
    writeManifest(v3down, dm);
    await expect(manager.install(v3down)).rejects.toThrow(PackManagerError);
    await expect(manager.install(v3down)).rejects.toThrow(/refusing downgrade/);

    // Equal-version reinstall refused.
    await expect(manager.install(v2)).rejects.toThrow(/already installed and active/);

    // Rollback to an unknown version refused.
    await expect(manager.rollback('versioned-a', '9.9.9')).rejects.toThrow(/is not installed/);

    // Rollback to the already-active version refused.
    await expect(manager.rollback('versioned-a', '2.0.0')).rejects.toThrow(/already the active version/);

    // Supersede with a missing pair refused.
    await expect(manager.supersede('versioned-a', '1.0.0', '9.9.9')).rejects.toThrow(
      /supersede requires both versions installed/,
    );

    // Remove of a non-installed pack refused.
    await expect(manager.remove('no-such-pack')).rejects.toThrow(/nothing installed matches/);
  });

  itReal('schema-version mismatch: index.schema_version != store version refuses explicitly', async () => {
    const { manager } = await makeWorkspace();
    const { PackManagerError } = await loadModules();
    const dir = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-1.0.0');
    // The shipped fixtures carry no index block; build the mismatch: the
    // store is at schema v3, the pack claims a prebuilt index for v2.
    const manifest = readManifest(dir) as Record<string, unknown>;
    manifest.index = { path: 'index.sqlite', schema_version: 2, sqlite_vec_version: '0.1.9' };
    writeManifest(dir, manifest);
    await expect(manager.install(dir)).rejects.toThrow(PackManagerError);
    await expect(manager.install(dir)).rejects.toThrow(/schema_version/);
    // Matching version installs cleanly.
    manifest.index = { path: 'index.sqlite', schema_version: 3, sqlite_vec_version: '0.1.9' };
    writeManifest(dir, manifest);
    const result = await manager.install(dir);
    expect(result.chunksAdded).toBeGreaterThan(0);
  });

  itReal('validation refusals: traversal, duplicate paths, missing/corrupt pack.json, mime, strategy, overlap', async () => {
    const { manager } = await makeWorkspace();
    const { PackManagerError } = await loadModules();
    const root = makeTempDir('c3-fixture-root-');

    // Path traversal doc refused.
    const traversal = copyFixture(root, 'versioned-a-1.0.0', 'traversal');
    const tm = readManifest(traversal) as { docs: Array<{ path: string }> };
    tm.docs[0]!.path = '../escape.json';
    writeManifest(traversal, tm);
    await expect(manager.install(traversal)).rejects.toThrow(PackManagerError);

    // Duplicate docs[].path refused.
    const dup = copyFixture(root, 'versioned-a-1.0.0', 'dup');
    const dm = readManifest(dup) as { docs: Array<Record<string, unknown>> };
    dm.docs.push({ ...dm.docs[0] });
    writeManifest(dup, dm);
    await expect(manager.install(dup)).rejects.toThrow(/duplicate docs\[\].path/);

    // Missing pack.json refused.
    const missing = copyFixture(root, 'versioned-a-1.0.0', 'missing');
    fs.rmSync(path.join(missing, 'pack.json'));
    await expect(manager.install(missing)).rejects.toThrow(/pack.json is missing/);

    // Corrupt pack.json refused.
    const corrupt = copyFixture(root, 'versioned-a-1.0.0', 'corrupt');
    fs.writeFileSync(path.join(corrupt, 'pack.json'), '{not json', 'utf8');
    await expect(manager.install(corrupt)).rejects.toThrow(/not valid UTF-8 JSON/);

    // Tampered doc sha refused (validator parity with C2's semantic checks).
    const tampered = copyFixture(root, 'versioned-a-1.0.0', 'tampered');
    writeDocRaw(tampered, 'docs/a.json', 'Tampered bytes without a manifest sha update.');
    await expect(manager.install(tampered)).rejects.toThrow(/sha256 mismatch/);

    // Unsupported mime refused (schema requires mime; use text/* for text and
    // something unsupported for the refusal).
    const mime = copyFixture(root, 'versioned-a-1.0.0', 'mime');
    const mm = readManifest(mime) as { docs: Array<Record<string, unknown>> };
    mm.docs[0]!.mime = 'application/octet-stream';
    writeManifest(mime, mm);
    await expect(manager.install(mime)).rejects.toThrow(/unsupported doc mime/);

    // Non-fixed-words strategy over size refused (C6 path); the strategy
    // value must be schema-valid (pack.schema.json enum) so the refusal comes
    // from the manager, not the schema validator.
    const bigText = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const strategy = copyFixture(root, 'versioned-a-1.0.0', 'strategy');
    const sm = readManifest(strategy) as Record<string, unknown>;
    sm.chunking = { strategy: 'slide-aware', size: 256, overlap: 0 };
    writeManifest(strategy, sm);
    writeDoc(strategy, 'docs/a.json', bigText);
    await expect(manager.install(strategy)).rejects.toThrow(/over size is not built here/);

    // overlap >= size refused.
    const overlap = copyFixture(root, 'versioned-a-1.0.0', 'overlap');
    const om = readManifest(overlap) as Record<string, unknown>;
    om.chunking = { strategy: 'fixed-words', size: 256, overlap: 256 };
    writeManifest(overlap, om);
    writeDoc(overlap, 'docs/a.json', bigText);
    await expect(manager.install(overlap)).rejects.toThrow(/overlap must be smaller than size/);
  });

  itReal('embedder length mismatch refuses before any write', async () => {
    const { openStore, PackManager, HashEmbedder } = await loadModules();
    const root = makeTempDir('c3-embed-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
    openStores.push(store);
    const badEmbedder = {
      modelId: 'bad-count',
      embed: async (texts: string[]) => texts.slice(0, Math.max(0, texts.length - 1)).map(() => new Array<number>(8).fill(0.1)),
    };
    const manager = new PackManager({
      store,
      embedder: badEmbedder as unknown as InstanceType<typeof HashEmbedder>,
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
    });
    const dir = copyFixture(root, 'versioned-a-1.0.0');
    await expect(manager.install(dir)).rejects.toThrow(/refusing partial install/);
    const db = store.db as unknown as SqlDb;
    expect(liveChunkIds(db).size).toBe(0);
    expect(packRows(db).filter((r) => r.id === 'versioned-a')).toHaveLength(0);
  });

  itReal('remove: deletes files, chunks and rows; version-scoped remove keeps other versions', async () => {
    const { manager, db } = await makeWorkspace();
    const root = makeTempDir('c3-fixture-root-');
    const v1 = copyFixture(root, 'versioned-a-1.0.0');
    writeDoc(v1, 'docs/a.json', 'Version one content kept after scoped remove.');
    await manager.install(v1);
    const v2 = copyFixture(root, 'versioned-a-2.0.0');
    writeDoc(v2, 'docs/a.json', 'Version two content, currently active.');
    await manager.install(v2);

    // Remove the inactive v1 only; v2 stays active.
    const removed = await manager.remove('versioned-a', '1.0.0');
    expect(removed).toBe(1);
    expect(packRows(db).map((r) => r.version)).toEqual(['2.0.0']);
    expect(liveChunkIds(db).size).toBe(1);

    // Remove everything; store is empty for this pack.
    const removedAll = await manager.remove('versioned-a');
    expect(removedAll).toBe(1);
    expect(packRows(db).filter((r) => r.id === 'versioned-a')).toHaveLength(0);
    expect(liveChunkIds(db).size).toBe(0);
  });

  itReal('zip source refused cleanly (C2 parity: folder-form packs only)', async () => {
    const { manager } = await makeWorkspace();
    const { PackManagerError } = await loadModules();
    const root = makeTempDir('c3-zip-');
    // A file with a zip magic header: the refusal is about the SOURCE SHAPE
    // (not a directory), matching C2's folder-form-only contract.
    const fakeZip = path.join(root, 'pack.zip');
    fs.writeFileSync(fakeZip, Buffer.from('PK not a real central directory'));
    await expect(manager.install(fakeZip)).rejects.toThrow(PackManagerError);
    await expect(manager.install(fakeZip)).rejects.toThrow(/folder-form packs only/);
  });

  itReal('semver pre-release ordering: pre-release sorts below release, numeric below alphanumeric', async () => {
    const managerMod = await import('../../main/backend/store/pack-manager.js');
    const { compareVersionKeys, versionKey } = managerMod;
    // Pre-release binds LOWER than its release (semver 11).
    expect(compareVersionKeys(versionKey('1.0.0-alpha'), versionKey('1.0.0'))).toBeLessThan(0);
    // Numeric identifiers compare numerically and sort below alphanumeric.
    expect(compareVersionKeys(versionKey('1.0.0-1'), versionKey('1.0.0-alpha'))).toBeLessThan(0);
    expect(compareVersionKeys(versionKey('1.0.0-2'), versionKey('1.0.0-10'))).toBeLessThan(0);
    // Longer identifier sets win on equal prefixes.
    expect(compareVersionKeys(versionKey('1.0.0-alpha'), versionKey('1.0.0-alpha.1'))).toBeLessThan(0);
    // Release equality.
    expect(compareVersionKeys(versionKey('2.0.0'), versionKey('2.0.0'))).toBe(0);
    // Install-level consequence: 1.0.0-beta over active 1.0.0 is an UPGRADE
    // (pre-release binds lower, so beta > release? NO — beta < release, so
    // installing 1.0.0-beta over active 1.0.0 must be a downgrade refusal).
    const { manager } = await makeWorkspace();
    const root = makeTempDir('c3-semver-');
    const v1 = copyFixture(root, 'versioned-a-1.0.0');
    await manager.install(v1);
    const pre = copyFixture(root, 'versioned-a-2.0.0', 'pre-copy');
    writeDoc(pre, 'docs/a.json', 'Pre-release content over an active release.');
    const pm = readManifest(pre) as Record<string, unknown>;
    pm.version = '1.0.0-beta';
    writeManifest(pre, pm);
    await expect(manager.install(pre)).rejects.toThrow(/refusing downgrade/);
  });

  itReal('supersedes warning recorded for absent target (C2 parity)', async () => {
    const { manager } = await makeWorkspace();
    const root = makeTempDir('c3-sups-');
    // Pack B supersedes a version that is NOT installed.
    const bDir = copyFixture(root, 'versioned-a-1.0.0', 'pack-b-warning');
    writeDoc(bDir, 'docs/a.json', 'Pack B warning-scenario content.');
    const manifest = readManifest(bDir) as Record<string, unknown>;
    manifest.id = 'pack-b';
    manifest.name = 'Pack B';
    manifest.supersedes = ['ghost-pack@9.9.9'];
    writeManifest(bDir, manifest);
    const result = await manager.install(bDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('ghost-pack@9.9.9');
    // Recorded on the new row only: listInstalled reports it.
    const records = await manager.listInstalled();
    expect(records[0]?.supersedes).toEqual(['ghost-pack@9.9.9']);
  });

  itReal('installed rows persist across store close/reopen', async () => {
    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const { PackManager } = await import('../../main/backend/store/pack-manager.js');
    const { HashEmbedder } = await import('../../main/backend/ingest/embedder.js');
    const root = makeTempDir('c3-reopen-');
    const dbPath = path.join(root, 'store.db');
    const packsRoot = path.join(root, 'packs');
    const fixture = copyFixture(root, 'versioned-a-1.0.0');

    const first = openStore({ dbPath, dims: 8 });
    try {
      const manager = new PackManager({
        store: first,
        embedder: new HashEmbedder({ dims: 8 }),
        packsRoot,
        repoRoot: REPO_ROOT,
      });
      await manager.install(fixture);
    } finally {
      first.close();
    }

    // Reopen: registry rows survive (C2 registry-persistence parity), and a
    // NEW manager instance over the reopened store sees them.
    const second = openStore({ dbPath, dims: 8 });
    openStores.push(second);
    const manager2 = new PackManager({
      store: second,
      embedder: new HashEmbedder({ dims: 8 }),
      packsRoot,
      repoRoot: REPO_ROOT,
    });
    const records = await manager2.listInstalled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ packId: 'versioned-a', version: '1.0.0', active: true });
    // And the lifecycle continues to work across the reopen boundary.
    await expect(manager2.rollback('versioned-a', '1.0.0')).rejects.toThrow(/already the active version/);
  });

  itReal('index.schema_version NEWER than the store also refuses explicitly', async () => {
    const { manager } = await makeWorkspace();
    const { PackManagerError } = await loadModules();
    const dir = copyFixture(makeTempDir('c3-fixture-'), 'versioned-a-1.0.0');
    const manifest = readManifest(dir) as Record<string, unknown>;
    manifest.index = { path: 'index.sqlite', schema_version: 99, sqlite_vec_version: '0.1.9' };
    writeManifest(dir, manifest);
    await expect(manager.install(dir)).rejects.toThrow(PackManagerError);
    await expect(manager.install(dir)).rejects.toThrow(/schema_version/);
  });

  itReal('listInstalled reports id, version, active, install_path, supersedes and doc shas', async () => {
    const { manager } = await makeWorkspace();
    const root = makeTempDir('c3-fixture-root-');
    const v1 = copyFixture(root, 'versioned-a-1.0.0');
    await manager.install(v1);
    const v2 = copyFixture(root, 'versioned-a-2.0.0');
    writeDoc(v2, 'docs/a.json', 'Listed content for the second version.');
    const v2Manifest = readManifest(v2) as { docs: Array<{ sha256: string; path: string }> };
    await manager.install(v2);

    const records = await manager.listInstalled();
    expect(records).toHaveLength(2);
    const v1Rec = records.find((r) => r.version === '1.0.0');
    const v2Rec = records.find((r) => r.version === '2.0.0');
    expect(v1Rec?.packId).toBe('versioned-a');
    expect(v1Rec?.active).toBe(false);
    expect(v1Rec?.installPath).toBeTruthy();
    expect(fs.existsSync(path.join(v1Rec?.installPath ?? '', 'docs', 'a.json'))).toBe(true);
    expect(v2Rec?.active).toBe(true);
    expect(v2Rec?.docs['docs/a.json']).toEqual({
      doc_sha256: v2Manifest.docs[0]!.sha256,
      doc_id: v2Manifest.docs[0]!.sha256,
    });
  });
});

/** Rewrite doc bytes WITHOUT updating the manifest (tamper scenario). */
function writeDocRaw(packDir: string, relPath: string, text: string): void {
  fs.writeFileSync(path.join(packDir, relPath), JSON.stringify({ text }, null, 2), 'utf8');
}
