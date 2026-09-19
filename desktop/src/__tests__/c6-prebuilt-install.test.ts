// c6-prebuilt-install.test.ts — issue #73 AC2: installing a pack that SHIPS a
// prebuilt index.sqlite must not invoke the embedder at all.
//
// The spy embedder is a real HashEmbedder whose `embed` method is wrapped
// with a counting proxy and passed INTO the PackManager options — the wrapped
// method is the exact call site the manager holds (`this.embedder.embed`), so
// a counter at 0 after install proves the fast path never re-embeds (the
// build-storyline.ac3 pattern, wired through the constructor). The negative
// control (no index in the pack) proves the spy itself is live: the same
// harness MUST count calls there.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';

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
const PACKTOOL_CLI = path.join(REPO_ROOT, 'packtool', 'dist', 'cli.js');
/** Desktop's native Database (better-sqlite3), resolved the same way
 * sqlite-store.ts resolves it. */
const desktopRequire = createRequire(path.join(REPO_ROOT, 'desktop', 'package.json'));

const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows EPERM on a still-open handle: the OS temp cleaner gets it.
      }
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface SqlDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

async function loadModules() {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const managerMod = await import('../../main/backend/store/pack-manager.js');
  const embedderMod = await import('../../main/backend/ingest/embedder.js');
  return {
    openStore: storeMod.openStore,
    PackManager: managerMod.PackManager,
    PackManagerError: managerMod.PackManagerError,
    HashEmbedder: embedderMod.HashEmbedder,
  };
}

/** Build a real doc pack with the packtool CLI (hash embedder: deterministic,
 * no model weights) and unpack it — the folder form PackManager installs. */
async function buildAndUnpackPack(id: string, version: string, marker = 'prebuilt install test'): Promise<string> {
  const src = makeTempDir('c6-src-');
  fs.writeFileSync(
    path.join(src, 'alpha.md'),
    `# Alpha\n\nAlpha body used by the ${marker}.\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(src, 'beta.json'),
    JSON.stringify({ title: 'Beta', text: `Beta body for the ${marker}.` }),
    'utf8',
  );
  const zipPath = path.join(makeTempDir('c6-zip-'), 'pack.zip');
  const run = spawnSync(
    process.execPath,
    [
      PACKTOOL_CLI,
      'build-docs',
      src,
      '--id',
      id,
      '--version',
      version,
      '--embedder',
      'hash',
      '--published-at',
      '2026-09-19T00:00:00.000Z',
      '-o',
      zipPath,
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    throw new Error(`packtool build-docs failed (status ${String(run.status)}): ${run.stderr}`);
  }
  const packDir = makeTempDir('c6-pack-');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  for (const entry of Object.values(zip.files)) {
    const target = path.join(packDir, ...entry.name.split('/'));
    if (entry.dir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
  }
  return packDir;
}

function injectShippedLink(packDir: string, slideId: string): void {
  // The native Database for tamper work comes from the desktop dependency
  // tree, resolved the same way sqlite-store.ts resolves it.
    const Database = desktopRequire('better-sqlite3') as new (p: string) => {
    prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
    exec(sql: string): void;
    close(): void;
  };
  const db = new Database(path.join(packDir, 'index.sqlite'));
  try {
    const chunk = db.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: string } | undefined;
    if (chunk === undefined) throw new Error('pack index has no chunks to link from');
    const pack = db.prepare('SELECT id FROM packs LIMIT 1').get() as { id: string } | undefined;
    db.prepare(
      'INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(chunk.id, slideId, pack?.id ?? null, 0.9, 1, '2026-09-19T00:00:00.000Z');
  } finally {
    db.close();
  }
}

describe('c6 PackManager prebuilt-index install (issue #73 AC2)', () => {
  itReal(
    'installing a prebuilt-index pack imports rows with ZERO embedder calls, preserves shipped links',
    { timeout: 60_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder } = await loadModules();
      const packDir = await buildAndUnpackPack('c6-prebuilt', '1.0.0');
      injectShippedLink(packDir, 'slide-SHIPPED');

      const sourceCounts = (() => {
                const Database = desktopRequire('better-sqlite3') as new (p: string) => {
          prepare(sql: string): { get(...params: unknown[]): unknown };
          close(): void;
        };
        const db = new Database(path.join(packDir, 'index.sqlite'));
        try {
          const count = (table: string): number =>
            (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
          return { chunks: count('chunks'), docs: count('docs'), links: count('links') };
        } finally {
          db.close();
        }
      })();
      expect(sourceCounts.links).toBeGreaterThan(0);

      // The spy IS the embedder the manager is constructed with: a counter at
      // zero can only mean the manager never embedded.
      const spy = new HashEmbedder({ dims: 384 });
      let embedCalls = 0;
      const original = spy.embed.bind(spy);
      spy.embed = (texts: string[]) => {
        embedCalls += 1;
        return original(texts);
      };

      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: spy,
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      const result = await manager.install(packDir);
      expect(result.chunksAdded).toBe(sourceCounts.chunks);

      expect(embedCalls).toBe(0);
      const db = store.db as unknown as SqlDb;
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('docs')).toBe(sourceCounts.docs);
      expect(count('chunks')).toBe(sourceCounts.chunks);
      expect(count('embeddings')).toBe(sourceCounts.chunks);
      expect(count('chunks_fts')).toBe(sourceCounts.chunks);
      const packRow = db.prepare('SELECT active, install_path FROM packs').get() as {
        active: number;
        install_path: string;
      };
      expect(packRow.active).toBe(1);
      // The managed copy (NOT the source dir) is what deactivate/reactivate
      // re-read - the prebuilt row must keep the managed-dir lifecycle.
      expect(packRow.install_path).toBe(path.join(root, 'packs', 'c6-prebuilt', '1.0.0'));
      // Recompute would have DELETED this row (recomputeLinksForDocs clears
      // links for the docs' chunks before rewriting); surviving proves the
      // shipped links were treated as authoritative.
      const shipped = db
        .prepare("SELECT COUNT(*) AS n FROM links WHERE slide_id = 'slide-SHIPPED'")
        .get() as { n: number };
      expect(shipped.n).toBe(1);
    },
  );

  itReal('negative control: a pack WITHOUT an index takes the embed path (spy is live)', { timeout: 60_000 }, async () => {
    const { openStore, PackManager, HashEmbedder } = await loadModules();
    // The shipped versioned fixture carries no index block (C3's own fixture).
    const plainDir = makeTempDir('c6-plain-');
    fs.cpSync(path.join(FIXTURES, 'versioned-a-1.0.0'), plainDir, { recursive: true });

    const spy = new HashEmbedder({ dims: 8 });
    let embedCalls = 0;
    const original = spy.embed.bind(spy);
    spy.embed = (texts: string[]) => {
      embedCalls += 1;
      return original(texts);
    };

    const root = makeTempDir('c6-ws-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
    openStores.push(store);
    const manager = new PackManager({
      store,
      embedder: spy,
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
    });
    await manager.install(plainDir);
    expect(embedCalls).toBeGreaterThan(0);
  });

  itReal('refuses a prebuilt pack whose embedding dims do not match the store', { timeout: 60_000 }, async () => {
    const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
    const packDir = await buildAndUnpackPack('c6-dims', '1.0.0');
    const spy = new HashEmbedder({ dims: 8 });
    const root = makeTempDir('c6-ws-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
    openStores.push(store);
    const manager = new PackManager({
      store,
      embedder: spy,
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
    });
    await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
    await expect(manager.install(packDir)).rejects.toThrow(/embedding_dims/);
  });

  itReal('refuses a prebuilt pack from a different embedding space over a non-empty store', { timeout: 60_000 }, async () => {
    const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
    const spy = new HashEmbedder({ dims: 384 });
    let embedCalls = 0;
    const original = spy.embed.bind(spy);
    spy.embed = (texts: string[]) => {
      embedCalls += 1;
      return original(texts);
    };
    const root = makeTempDir('c6-ws-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
    openStores.push(store);
    const manager = new PackManager({
      store,
      embedder: spy,
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
    });

    const first = await buildAndUnpackPack('c6-model', '1.0.0');
    await manager.install(first);
    expect(embedCalls).toBe(0);

    // Tamper a second pack into a different (consistent) embedding space.
    const second = await buildAndUnpackPack('c6-model2', '1.0.0');
        const Database = desktopRequire('better-sqlite3') as new (p: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      exec(sql: string): void;
      close(): void;
    };
    const indexDb = new Database(path.join(second, 'index.sqlite'));
    try {
      indexDb.prepare("UPDATE meta SET value = 'other-model' WHERE key = 'embedding_model_id'").run();
    } finally {
      indexDb.close();
    }
    const manifestPath = path.join(second, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      embedding: { model_id: string };
    };
    manifest.embedding.model_id = 'other-model';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await expect(manager.install(second)).rejects.toThrow(PackManagerError);
    await expect(manager.install(second)).rejects.toThrow(/mix embedding spaces/);
  });

  itReal('equal-version reinstall of a prebuilt pack is refused by the version policy', { timeout: 60_000 }, async () => {
    const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
    const spy = new HashEmbedder({ dims: 384 });
    const root = makeTempDir('c6-ws-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
    openStores.push(store);
    const manager = new PackManager({
      store,
      embedder: spy,
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
    });
    const packDir = await buildAndUnpackPack('c6-equal', '1.0.0');
    await manager.install(packDir);
    await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
    await expect(manager.install(packDir)).rejects.toThrow(/already installed and active/);
  });

  itReal('rollback between prebuilt versions re-imports with zero embedder calls', { timeout: 60_000 }, async () => {
    const { openStore, PackManager, HashEmbedder } = await loadModules();
    const spy = new HashEmbedder({ dims: 384 });
    let embedCalls = 0;
    const original = spy.embed.bind(spy);
    spy.embed = (texts: string[]) => {
      embedCalls += 1;
      return original(texts);
    };
    const root = makeTempDir('c6-ws-');
    const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
    openStores.push(store);
    const manager = new PackManager({
      store,
      embedder: spy,
      packsRoot: path.join(root, 'packs'),
      repoRoot: REPO_ROOT,
    });

    const v1 = await buildAndUnpackPack('c6-rollback', '1.0.0');
    await manager.install(v1);
    expect(embedCalls).toBe(0);

    // v1.0.1 with genuinely different content (content-hash identity).
    const src2 = makeTempDir('c6-src2-');
    fs.writeFileSync(
      path.join(src2, 'alpha.md'),
      '# Alpha\n\nRewritten body for version one point one.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(src2, 'beta.json'),
      JSON.stringify({ title: 'Beta', text: 'Second-version beta body.' }),
      'utf8',
    );
    const zip2 = path.join(makeTempDir('c6-zip-'), 'pack.zip');
    const run = spawnSync(
      process.execPath,
      [PACKTOOL_CLI, 'build-docs', src2, '--id', 'c6-rollback', '--version', '1.0.1', '--embedder', 'hash', '--published-at', '2026-09-19T01:00:00.000Z', '-o', zip2],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    const pack2 = makeTempDir('c6-pack2-');
    const zip = await JSZip.loadAsync(fs.readFileSync(zip2));
    for (const entry of Object.values(zip.files)) {
      const target = path.join(pack2, ...entry.name.split('/'));
      if (entry.dir) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await entry.async('nodebuffer'));
    }
    await manager.install(pack2);
    expect(embedCalls).toBe(0);

    // Rollback activates the 1.0.0 row through the prebuilt re-import path.
    await manager.rollback('c6-rollback', '1.0.0');
    expect(embedCalls).toBe(0);
    const rows = (
      store.db as unknown as SqlDb
    ).prepare('SELECT active FROM packs WHERE id = ? AND version = ?').all('c6-rollback', '1.0.0') as Array<{ active: number }>;
    expect(rows[0]?.active).toBe(1);
  });

  itReal(
    'refuses a prebuilt pack whose shipped links rows violate verify bounds (PRR-120-F2)',
    { timeout: 60_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
      const packDir = await buildAndUnpackPack('c6-badlink', '1.0.0');
      // Inject a link row whose score is not a cosine in [-1, 1].
      const Database = desktopRequire('better-sqlite3') as new (p: string) => {
        prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
        close(): void;
      };
      const indexDb = new Database(path.join(packDir, 'index.sqlite'));
      try {
        const chunk = indexDb.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: string } | undefined;
        if (chunk === undefined) throw new Error('pack index has no chunks to link from');
        indexDb
          .prepare('INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(chunk.id, 'slide-BAD', null, 5, 1, '2026-09-19T00:00:00.000Z');
      } finally {
        indexDb.close();
      }

      const spy = new HashEmbedder({ dims: 384 });
      let embedCalls = 0;
      const original = spy.embed.bind(spy);
      spy.embed = (texts: string[]) => {
        embedCalls += 1;
        return original(texts);
      };
      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: spy,
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
      await expect(manager.install(packDir)).rejects.toThrow(/not a finite cosine/);
      // Refusal happens before any write: no embed, no rows.
      expect(embedCalls).toBe(0);
      const count = (
        store.db as unknown as SqlDb
      ).prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      expect(count.n).toBe(0);
    },
  );

  itReal(
    'supersede between prebuilt versions re-imports with zero embeds and deactivates only the from-version (PRR-120-F3)',
    { timeout: 90_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder } = await loadModules();
      const spy = new HashEmbedder({ dims: 384 });
      let embedCalls = 0;
      const original = spy.embed.bind(spy);
      spy.embed = (texts: string[]) => {
        embedCalls += 1;
        return original(texts);
      };
      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: spy,
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });

      const v1 = await buildAndUnpackPack('c6-super', '1.0.0', 'supersede marker one');
      const v2 = await buildAndUnpackPack('c6-super', '1.0.1', 'supersede marker two');
      const v3 = await buildAndUnpackPack('c6-super', '1.0.2', 'supersede marker three');
      await manager.install(v1);
      await manager.install(v2);
      await manager.install(v3);
      expect(embedCalls).toBe(0);

      // Supersede rolls the active claim from 1.0.2 back to the installed-but
      // -inactive 1.0.1 through the prebuilt re-import path, deactivating ONLY
      // the from-version (1.0.0 must stay inactive, untouched).
      await manager.supersede('c6-super', '1.0.2', '1.0.1');
      expect(embedCalls).toBe(0);
      const db = store.db as unknown as SqlDb;
      const activeOf = (version: string): number | undefined => {
        const rows = db
          .prepare('SELECT active FROM packs WHERE id = ? AND version = ?')
          .all('c6-super', version) as Array<{ active: number }>;
        return rows[0]?.active;
      };
      expect(activeOf('1.0.1')).toBe(1);
      expect(activeOf('1.0.2')).toBe(0);
      expect(activeOf('1.0.0')).toBe(0);
    },
  );

  itReal(
    'refuses a manifest-declared index path escaping the pack (PRR-120-F6 traversal)',
    { timeout: 60_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
      const packDir = await buildAndUnpackPack('c6-traversal', '1.0.0');
      const manifestPath = path.join(packDir, 'pack.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        index: { path: string };
      };
      manifest.index.path = '../outside.sqlite';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 384 }),
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
      await expect(manager.install(packDir)).rejects.toThrow(/dot segment/);
    },
  );

  itReal(
    'refuses a symlinked index.sqlite in the source pack (PRR-120-F6)',
    { timeout: 60_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
      const packDir = await buildAndUnpackPack('c6-symlink', '1.0.0');
      // A second, unrelated store file outside the pack with DIFFERENT content
      // (different content-hash chunk ids): the junction target.
      const outsidePack = await buildAndUnpackPack('c6-outside', '1.0.0', 'unique outside marker');
      const outsideIndex = path.join(outsidePack, 'index.sqlite');
      fs.rmSync(path.join(packDir, 'index.sqlite'), { force: true });
      fs.symlinkSync(outsideIndex, path.join(packDir, 'index.sqlite'), 'junction');

      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 384 }),
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      // The refusing walker rejects the junction at the managed-copy step, so
      // neither the outside content nor any rebuilt content reaches the store.
      await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
      await expect(manager.install(packDir)).rejects.toThrow(/refusing symlink\/junction in pack source/);
      const count = (
        store.db as unknown as SqlDb
      ).prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      expect(count.n).toBe(0);
      void outsideIndex;
    },
  );

  itReal(
    'refuses a directory junction in the pack source (PRR-120-F6 round 4: cpSync follows dir junctions)',
    { timeout: 60_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
      const packDir = await buildAndUnpackPack('c6-dirjunction', '1.0.0');
      // A junctioned subdirectory whose target carries an index the manifest
      // then declares: cpSync would follow the junction and copy the outside
      // bytes into the managed copy as regular files, so the copy itself must
      // refuse.
      const outsidePack = await buildAndUnpackPack('c6-dirjunction-target', '1.0.0', 'junction target marker');
      fs.symlinkSync(outsidePack, path.join(packDir, 'foreign'), 'junction');
      const manifestPath = path.join(packDir, 'pack.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        index: { path: string };
      };
      manifest.index.path = 'foreign/index.sqlite';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 384 }),
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
      await expect(manager.install(packDir)).rejects.toThrow(/refusing symlink\/junction in pack source/);
      // Nothing leaked into the store from the junction target.
      const count = (
        store.db as unknown as SqlDb
      ).prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      expect(count.n).toBe(0);
    },
  );

  itReal(
    'refuses shipped chunks whose identity does not match their content (PRR-120-F7)',
    { timeout: 60_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
      const packDir = await buildAndUnpackPack('c6-tamper', '1.0.0');
      const Database = desktopRequire('better-sqlite3') as new (p: string) => {
        prepare(sql: string): { run(...params: unknown[]): unknown };
        exec(sql: string): void;
        close(): void;
      };
      const indexDb = new Database(path.join(packDir, 'index.sqlite'));
      try {
        indexDb.exec("UPDATE chunks SET text = text || ' tampered with evil content'");
      } finally {
        indexDb.close();
      }
      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 384 }),
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
      await expect(manager.install(packDir)).rejects.toThrow(/identity does not match its content/);
    },
  );

  itReal(
    'refuses shipped chunks referencing a doc the manifest does not carry (PRR-120-F7)',
    { timeout: 60_000 },
    async () => {
      const { openStore, PackManager, HashEmbedder, PackManagerError } = await loadModules();
      const packDir = await buildAndUnpackPack('c6-foreigndoc', '1.0.0');
      const foreignSha = 'f'.repeat(64);
      const Database = desktopRequire('better-sqlite3') as new (p: string) => {
        prepare(sql: string): { run(...params: unknown[]): unknown };
        exec(sql: string): void;
        close(): void;
      };
      const indexDb = new Database(path.join(packDir, 'index.sqlite'));
      try {
        // Deliberately craft an invalid pack: disable FK enforcement so the
        // UPDATE can point chunks at a doc the manifest does not carry.
        indexDb.exec('PRAGMA foreign_keys = OFF');
        indexDb
          .prepare('UPDATE chunks SET doc_id = ? WHERE rowid = (SELECT MIN(rowid) FROM chunks)')
          .run(foreignSha);
      } finally {
        indexDb.close();
      }
      const root = makeTempDir('c6-ws-');
      const store = openStore({ dbPath: path.join(root, 'store.db'), dims: 384 });
      openStores.push(store);
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 384 }),
        packsRoot: path.join(root, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await expect(manager.install(packDir)).rejects.toThrow(PackManagerError);
      await expect(manager.install(packDir)).rejects.toThrow(/the manifest does not carry/);
    },
  );
});
