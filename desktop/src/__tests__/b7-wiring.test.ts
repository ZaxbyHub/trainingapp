// b7-wiring.test.ts — FROZEN ACCEPTANCE SPEC (issue #65 trace, AC5 / check C5).
//
// This file is a frozen acceptance spec authored by the issue-tracer v3 CHECK
// AUTHOR. It pins the host/engine wiring of the hybrid retrieval surface: with
// a real store (openStore + HashEmbedder), the retrieval surface attached
// through the same late-binding seam as attachDocumentSurface makes POST
// /search return store-backed rows (never the B3 'desktop-stub' row) and makes
// the /ask response's sources come from retrieval. It must FAIL at the base
// revision (retrieval/hybrid.js does not exist).
//
// FROZEN WIRING CONTRACT the implementer must provide:
//   1. EngineSurface grows an optional late-binding seam named EXACTLY
//      attachRetrievalSurface, mirroring attachDocumentSurface
//      (desktop/main/backend/types.ts):
//        attachRetrievalSurface?(surface: RetrievalSurface | null): void
//      where RetrievalSurface is the interface exported from
//      desktop/main/backend/retrieval/hybrid.ts (createRetrievalSurface builds it).
//   2. When a retrieval surface is attached, engine.search() delegates to it
//      (both StubEngine and LlamaEngine); attaching null detaches and restores
//      the stub behavior.
//   3. When a retrieval surface is attached, StubEngine.query() populates the
//      /ask response's `sources` from the retrieval results' `source` values
//      (ranked order; empty retrieval => empty sources).
//   4. NodeBackendHost.start(), after opening a configured store, builds the
//      retrieval surface (resolveEmbedder + resolveRetrievalConfig; reranker
//      optional) and attaches it to the engine through the same seam — with the
//      same failure isolation as the document surface. When no reranker weights
//      are resolvable (e.g. TRAININGAPP_DESKTOP_EMBEDDER=hash dev/CI mode) the
//      surface must degrade to RRF-only retrieval WITHOUT applying the
//      relevance floor to RRF-scale scores (an empty response would otherwise
//      masquerade as the stub being gone).
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { NodeBackendHost } from '../../main/backend/index.js';
import { StubEngine } from '../../main/backend/engine.js';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server.js';
import { createLoopbackGuard } from '../../main/security/loopback-guard.js';
import { openStore } from '../../main/backend/store/sqlite-store.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { createRetrievalSurface } from '../../main/backend/retrieval/hybrid.js';
import { LlamaEngine, type LlamaEngineBackend } from '../../main/backend/inference/llama-engine.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'b7-wiring-token';
const DIMS = 8;
const GB = 1024 ** 3;

/** Repo-root discovery via the established contracts marker. */
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

const tempDirs: string[] = [];
const openServers: Server[] = [];

afterEach(() => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    server?.close();
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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const MARKER = 'b7wiringzebra';
const MARKER_TEXT = `${MARKER} unique marker contents for the wiring check`;

interface SeededStore {
  dbPath: string;
  docPath: string;
}

/** One doc, one chunk carrying the marker token; embeddings via HashEmbedder. */
async function seedMarkerStore(): Promise<SeededStore> {
  const dir = makeTempDir('b7-c5-seed-');
  const docPath = path.join(dir, 'docs', 'b7wiring-doc.md');
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  const dbPath = path.join(dir, 'store.sqlite');
  const store = openStore({ dbPath, dims: DIMS, repoRoot: REPO_ROOT });
  const embedder = new HashEmbedder({ dims: DIMS });
  const vector = (await embedder.embed([MARKER_TEXT]))[0];
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db
      .prepare('INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('d1', 'test', docPath, sha256Hex(MARKER_TEXT), 'd1', null, null);
    store.db
      .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('c1', 'd1', 0, MARKER_TEXT, sha256Hex(MARKER_TEXT));
    store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run('c1', MARKER_TEXT);
    store.db.exec('COMMIT');
  } catch (err) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      /* closed below */
    }
    store.close();
    throw err;
  }
  store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run('c1', JSON.stringify(vector));
  store.close();
  return { dbPath, docPath };
}

async function postJson(port: number, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

interface SearchRow {
  text: string;
  source: string;
  similarity: number;
}

/** Shared assertions: store-backed /search and populated /ask sources. */
async function assertStoreBackedRoutes(port: number): Promise<void> {
  const search = await postJson(port, '/search', { query: MARKER, n_results: 5 });
  expect(search.status).toBe(200);
  const rows = search.body as SearchRow[];
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBeGreaterThanOrEqual(1);
  // The seeded doc text is found; NO row is the B3 stub row.
  expect(rows.some((row) => typeof row.text === 'string' && row.text.includes(MARKER))).toBe(true);
  expect(rows.every((row) => typeof row.source === 'string' && !row.source.includes('desktop-stub'))).toBe(true);
  expect(rows.some((row) => typeof row.source === 'string' && row.source.endsWith('b7wiring-doc.md'))).toBe(true);
  for (const row of rows) expect(typeof row.similarity).toBe('number');

  const ask = await postJson(port, '/ask', { question: `What does the ${MARKER} say?`, n_results: 5 });
  expect(ask.status).toBe(200);
  const askBody = ask.body as { sources?: string[] };
  expect(Array.isArray(askBody.sources)).toBe(true);
  expect(askBody.sources?.length).toBeGreaterThanOrEqual(1);
  expect(askBody.sources?.some((source) => source.endsWith('b7wiring-doc.md'))).toBe(true);
}

describe('b7 C5 (AC5): NodeBackendHost wiring — the host attaches the retrieval surface', () => {
  itReal(
    'host with a configured store serves store-backed /search and populated /ask sources for a StubEngine',
    async () => {
      const seeded = await seedMarkerStore();
      const host = new NodeBackendHost({
        token: TOKEN,
        storePath: seeded.dbPath,
        storeEmbeddingDims: DIMS,
        env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
        engine: new StubEngine(),
      });
      const handle = await host.start();
      try {
        await assertStoreBackedRoutes(handle.port);
      } finally {
        await host.stop();

      }
    },
    20000,
  );
});

describe('b7 C5 (AC5): engine seam — attachRetrievalSurface on the guarded server', () => {
  itReal(
    'StubEngine.search delegates to the attached surface; attachRetrievalSurface(null) restores the stub',
    async () => {
      const seeded = await seedMarkerStore();
      const store = openStore({ dbPath: seeded.dbPath, dims: DIMS, repoRoot: REPO_ROOT });
      const surface = createRetrievalSurface({ store, embedder: new HashEmbedder({ dims: DIMS }) });
      const engine = new StubEngine();
      expect(typeof (engine as { attachRetrievalSurface?: unknown }).attachRetrievalSurface).toBe('function');
      (engine as { attachRetrievalSurface: (s: unknown) => void }).attachRetrievalSurface(surface);
      const server = createBackendServer({
        guard: createLoopbackGuard({ token: TOKEN, allowedOrigins: ['null'] }),
        tokenHeaderName: 'X-Desktop-Token',
        allowedOrigins: ['null'],
        engine,
      });
      openServers.push(server);
      const port = await listenOnRandomPort(server);
      try {
        await assertStoreBackedRoutes(port);

        // Detach: the B3 stub row comes back (the seam is a two-way late bind).
        (engine as { attachRetrievalSurface: (s: unknown) => void }).attachRetrievalSurface(null);
        const stubbed = await postJson(port, '/search', { query: MARKER, n_results: 5 });
        expect(stubbed.status).toBe(200);
        const stubRows = stubbed.body as SearchRow[];
        expect(stubRows.length).toBeGreaterThanOrEqual(1);
        expect(stubRows.every((row) => row.source.includes('desktop-stub'))).toBe(true);
      } finally {
        store.close();

      }
    },
    20000,
  );
});

/** Minimal fake generation backend (b4 convention): no native llama, no weights. */
class FakeLlamaBackend implements LlamaEngineBackend {
  async generate(
    _question: string,
    opts: { streamCallback?: (token: string) => void },
  ): Promise<{ answer: string; cancelled: boolean }> {
    opts.streamCallback?.('fake ');
    return { answer: 'fake answer', cancelled: false };
  }

  async dispose(): Promise<void> {}
}

describe('b7 C5 (AC5): LlamaEngine.search delegates to the attached retrieval surface', () => {
  itReal('returns the surface rows once attached, and the stub row once detached', async () => {
    const seeded = await seedMarkerStore();
    const store = openStore({ dbPath: seeded.dbPath, dims: DIMS, repoRoot: REPO_ROOT });
    const dir = makeTempDir('b7-c5-models-');
    const quality = path.join(dir, 'quality-dummy.gguf');
    const fast = path.join(dir, 'fast-dummy.gguf');
    fs.writeFileSync(quality, 'x', 'utf8');
    fs.writeFileSync(fast, 'x', 'utf8');
    try {
      const engine = new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality, fast },
        llamaFactory: async () => new FakeLlamaBackend(),
      });
      const surface = createRetrievalSurface({ store, embedder: new HashEmbedder({ dims: DIMS }) });
      expect(typeof (engine as { attachRetrievalSurface?: unknown }).attachRetrievalSurface).toBe('function');
      (engine as { attachRetrievalSurface: (s: unknown) => void }).attachRetrievalSurface(surface);

      const rows = await engine.search(MARKER, 5);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some((row) => row.text.includes(MARKER))).toBe(true);
      expect(rows.some((row) => row.source.endsWith('b7wiring-doc.md'))).toBe(true);
      expect(rows.every((row) => !row.source.includes('desktop-stub'))).toBe(true);

      (engine as { attachRetrievalSurface: (s: unknown) => void }).attachRetrievalSurface(null);
      const stubRows = await engine.search(MARKER, 5);
      expect(stubRows.every((row) => row.source.includes('desktop-stub'))).toBe(true);
    } finally {
      store.close();
    }
  });
});
