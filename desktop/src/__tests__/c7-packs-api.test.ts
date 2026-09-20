// c7-packs-api.test.ts — C7 (issue #74) supporting route tests (non-frozen):
// the /packs route family over the REAL server + REAL PackManager, mirroring
// the c3 fixture conventions (HashEmbedder dims 8 + contracts fixture packs,
// rewritten manifests) and the b3 server conventions (loopback guard + token
// header on a random port).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const NATIVE_DEPS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'),
);
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const TOKEN = 'c7-packs-api-token';
const TOKEN_HEADER = 'x-desktop-token';

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
const openServers: http.Server[] = [];

afterEach(() => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) {
      try {
        server.close();
      } catch {
        // already closed
      }
    }
  }
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

interface Workspace {
  root: string;
  manager: {
    install(packPath: string): Promise<{ packId: string; version: string }>;
  };
}

async function makeWorkspace(): Promise<Workspace> {
  const storeMod = await import('../../main/backend/store/sqlite-store.js');
  const managerMod = await import('../../main/backend/store/pack-manager.js');
  const embedderMod = await import('../../main/backend/ingest/embedder.js');
  const root = makeTempDir('c7-packs-api-');
  const store = storeMod.openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
  openStores.push(store);
  const manager = new managerMod.PackManager({
    store,
    embedder: new embedderMod.HashEmbedder({ dims: 8 }),
    packsRoot: path.join(root, 'packs'),
    repoRoot: REPO_ROOT,
    // #75 harness alignment (same class as the c6 alignment): stageFixture
    // rewrites the fixture manifests to model_id 'hash-test' — declare that
    // model so the #75 embedding gate targets what these packs were built
    // with. Mirrors production wiring where the host passes the configured
    // model.
    packsSecurity: { embeddingModelId: 'hash-test' },
  });
  return { root, manager };
}

/** Copy a fixture pack and retarget its embedding block to the test
 * HashEmbedder (dims 8), mirroring c3's manifest rewrite. */
function stageFixture(root: string, name: string): string {
  const dest = path.join(root, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  const manifestPath = path.join(dest, 'pack.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.embedding = { model_id: 'hash-test', dims: 8, normalize: false };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  for (const entry of manifest.docs as Array<{ path: string; sha256: string }>) {
    entry.sha256 = createHash('sha256')
      .update(fs.readFileSync(path.join(dest, entry.path)))
      .digest('hex');
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return dest;
}

/** Zip a staged pack folder (jszip — the same prod dep the route uses). */
async function zipPackDir(packDir: string): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const addDir = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) addDir(full, rel);
      else zip.file(rel, fs.readFileSync(full));
    }
  };
  addDir(packDir, '');
  return zip.generateAsync({ type: 'uint8array' });
}

function buildMultipartBody(boundary: string, filename: string, data: Uint8Array): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, Buffer.from(data), tail]);
}

async function startServer(packsProvider?: (() => unknown) | undefined): Promise<{
  port: number;
}> {
  const serverMod = await import('../../main/backend/server.js');
  const guardMod = await import('../../main/security/loopback-guard.js');
  const engineMod = await import('../../main/backend/engine.js');
  const server = serverMod.createBackendServer({
    guard: guardMod.createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    // Node-mode dispatch requires an engine surface even for routes that
    // never touch it (the packs routes read only the packs provider).
    engine: new engineMod.StubEngine(),
    ...(packsProvider !== undefined ? { packs: packsProvider as never } : {}),
  });
  const port = await serverMod.listenOnRandomPort(server);
  openServers.push(server);
  return { port };
}

async function get(port: number, reqPath: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${reqPath}`, {
    headers: { [TOKEN_HEADER]: TOKEN },
  });
}

async function postJson(port: number, reqPath: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${reqPath}`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('c7 packs routes (issue #74)', () => {
  itReal('GET /packs lists installed versions with name/source_class/status', async () => {
    const ws = await makeWorkspace();
    const bundled = stageFixture(ws.root, 'bundled-min');
    await ws.manager.install(bundled);
    const v1 = stageFixture(ws.root, 'versioned-a-1.0.0');
    await ws.manager.install(v1);
    const v2 = stageFixture(ws.root, 'versioned-a-2.0.0');
    await ws.manager.install(v2);
    const surfaceMod = await import('../../main/backend/packs/surface.js');
    const { port } = await startServer(() => surfaceMod.createPackSurface(ws.manager as never));

    const res = await get(port, '/packs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      packs: Array<{
        pack_id: string;
        version: string;
        name: string | null;
        source_class: string | null;
        published_at: string | null;
        active: boolean;
        supersedes: string[];
      }>;
    };
    const bundledRow = body.packs.find((p) => p.pack_id === 'bundled-min');
    expect(bundledRow).toBeDefined();
    expect(bundledRow?.name).toBeTruthy();
    expect(bundledRow?.source_class).toBe('bundled');
    expect(bundledRow?.active).toBe(true);
    const v1Row = body.packs.find((p) => p.pack_id === 'versioned-a' && p.version === '1.0.0');
    const v2Row = body.packs.find((p) => p.pack_id === 'versioned-a' && p.version === '2.0.0');
    expect(v1Row?.active).toBe(false);
    expect(v2Row?.active).toBe(true);
  });

  itReal('POST /packs/install accepts a zip pack and lists it afterwards', async () => {
    const ws = await makeWorkspace();
    const staged = stageFixture(ws.root, 'bundled-min');
    const zip = await zipPackDir(staged);
    const surfaceMod = await import('../../main/backend/packs/surface.js');
    const { port } = await startServer(() => surfaceMod.createPackSurface(ws.manager as never));

    const boundary = 'c7packsboundary';
    const res = await fetch(`http://127.0.0.1:${port}/packs/install`, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: TOKEN,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: buildMultipartBody(boundary, 'bundled-min.zip', zip),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pack_id: string;
      version: string;
      docs_installed: number;
      chunks_added: number;
      superseded: string[];
      warnings: string[];
    };
    expect(body.pack_id).toBe('bundled-min');
    expect(body.version).toBe('1.0.0');
    expect(body.docs_installed).toBeGreaterThan(0);
    expect(body.chunks_added).toBeGreaterThan(0);

    const list = await get(port, '/packs');
    const listed = (await list.json()) as { packs: Array<{ pack_id: string; active: boolean }> };
    expect(listed.packs.some((p) => p.pack_id === 'bundled-min' && p.active)).toBe(true);
  });

  itReal('POST /packs/install refuses non-zip and guard-violating archives with 409/422', async () => {
    const ws = await makeWorkspace();
    const surfaceMod = await import('../../main/backend/packs/surface.js');
    const { port } = await startServer(() => surfaceMod.createPackSurface(ws.manager as never));
    const boundary = 'c7packsboundary';

    // Not a zip filename.
    const badName = await fetch(`http://127.0.0.1:${port}/packs/install`, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: TOKEN,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: buildMultipartBody(boundary, 'pack.txt', new Uint8Array([1, 2, 3])),
    });
    expect([409, 422]).toContain(badName.status);

    // Zip with a traversal entry path.
    const JSZip = (await import('jszip')).default;
    const evil = new JSZip();
    evil.file('../escape.txt', 'nope');
    const evilBytes = await evil.generateAsync({ type: 'uint8array' });
    const evilRes = await fetch(`http://127.0.0.1:${port}/packs/install`, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: TOKEN,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: buildMultipartBody(boundary, 'evil.zip', evilBytes),
    });
    expect([409, 422]).toContain(evilRes.status);

    // Zip without a root manifest.
    const manifestless = new JSZip();
    manifestless.file('docs/readme.txt', 'no manifest here');
    const manifestlessBytes = await manifestless.generateAsync({ type: 'uint8array' });
    const manifestlessRes = await fetch(`http://127.0.0.1:${port}/packs/install`, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: TOKEN,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: buildMultipartBody(boundary, 'manifestless.zip', manifestlessBytes),
    });
    expect([409, 422]).toContain(manifestlessRes.status);
  });

  itReal('rollback + remove wrap the pack lifecycle', async () => {
    const ws = await makeWorkspace();
    const v1 = stageFixture(ws.root, 'versioned-a-1.0.0');
    await ws.manager.install(v1);
    const v2 = stageFixture(ws.root, 'versioned-a-2.0.0');
    await ws.manager.install(v2);
    const surfaceMod = await import('../../main/backend/packs/surface.js');
    const { port } = await startServer(() => surfaceMod.createPackSurface(ws.manager as never));

    const rb = await postJson(port, '/packs/rollback', {
      pack_id: 'versioned-a',
      to_version: '1.0.0',
    });
    expect(rb.status).toBe(200);
    expect(await rb.json()).toEqual({ ok: true });

    const list = await get(port, '/packs');
    const listed = (await list.json()) as { packs: Array<{ version: string; active: boolean }> };
    const v1Row = listed.packs.find((p) => p.version === '1.0.0');
    const v2Row = listed.packs.find((p) => p.version === '2.0.0');
    expect(v1Row?.active).toBe(true);
    expect(v2Row?.active).toBe(false);

    const rmOne = await postJson(port, '/packs/remove', {
      pack_id: 'versioned-a',
      version: '2.0.0',
    });
    expect(rmOne.status).toBe(200);
    expect(await rmOne.json()).toEqual({ removed: 1 });

    const rmAll = await postJson(port, '/packs/remove', { pack_id: 'versioned-a' });
    expect(rmAll.status).toBe(200);
    expect(await rmAll.json()).toEqual({ removed: 1 });
  });

  itReal('validation and method mismatches follow the frozen contract', async () => {
    const ws = await makeWorkspace();
    const surfaceMod = await import('../../main/backend/packs/surface.js');
    const { port } = await startServer(() => surfaceMod.createPackSurface(ws.manager as never));

    const badRollback = await postJson(port, '/packs/rollback', { pack_id: '' });
    expect(badRollback.status).toBe(422);
    const badRemove = await postJson(port, '/packs/remove', { to_version: 3 });
    expect(badRemove.status).toBe(422);
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/packs`, {
      method: 'DELETE',
      headers: { [TOKEN_HEADER]: TOKEN },
    });
    expect(wrongMethod.status).toBe(405);
  });

  itReal('unwired hosts degrade to the contract-safe 503', async () => {
    const { port } = await startServer(undefined);
    const res = await get(port, '/packs');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { detail?: string };
    expect(typeof body.detail).toBe('string');
  });
});
