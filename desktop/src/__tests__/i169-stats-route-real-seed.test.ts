// i169-stats-route-real-seed.test.ts — issue #169 Expected Behavior #3:
// after seeding N documents through the REAL store surface, GET /stats
// counts equal the engine's listDocuments totals (and the seeded truth).
//
// Lifecycle: RED at base (dbbd93ca, before the fix), GREEN after the fix.
//
// The frozen i103c spec proves wiring against a fake surface at the engine
// seam; this spec closes the two gaps that fake cannot: a REAL
// StoreDocumentSurface over temp sqlite (seeded through the real
// ingest pipeline with the deterministic HashEmbedder — no model needed)
// and the HTTP GET /stats route itself (b3-server harness idiom).
// Native-deps gate mirrors b6-supplementary: better-sqlite3 is a compiled
// addon, so the spec skips (not fails) where it is absent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackendServer, listenOnRandomPort } from '../../main/backend/server';
import { StubEngine } from '../../main/backend/engine';
import { createLoopbackGuard } from '../../main/security/loopback-guard';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { DEFAULT_INGEST_CONFIG } from '../../main/backend/ingest/config.js';
import { StoreDocumentSurface } from '../../main/backend/store/document-surface.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';

const TOKEN = 'i169-route-spec-token';
const TOKEN_HEADER = 'x-desktop-token';
const DIMS = 8;
const SEEDED_DOCS = 3;
// Two of the three docs exceed the default chunkWordCount (256, overlap
// 100 — ingest/config.ts) so they split into multiple chunks: chunk_count >
// document_count is actually exercised (a symmetric count would pass a
// swapped-fields bug).
const SEED_WORD_COUNTS = [40, 300, 600];

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
const describeReal = NATIVE_DEPS_PRESENT ? describe : describe.skip;

function words(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

let store: StoreHandle | null = null;
let surface: StoreDocumentSurface;
let engine: StubEngine;
let server: import('node:http').Server;
let port: number;
let tempDir: string;

function url(pathname: string): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

beforeAll(async () => {
  if (!NATIVE_DEPS_PRESENT) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i169-real-seed-'));
  store = openStore({ dbPath: path.join(tempDir, 'store.sqlite'), dims: DIMS, repoRoot: REPO_ROOT });
  const handle = store;
  surface = new StoreDocumentSurface({
    getStore: () => handle,
    setStore: () => {
      /* Clear Cache not exercised here. */
    },
    embedder: new HashEmbedder({ dims: DIMS }),
    config: { ...DEFAULT_INGEST_CONFIG },
  });
  // Seed N documents through the REAL ingest pipeline (extract + chunk +
  // embed + store), each with a distinct word count.
  for (let i = 0; i < SEED_WORD_COUNTS.length; i += 1) {
    const name = path.join(tempDir, `doc-${i}.txt`);
    fs.writeFileSync(name, `${words(SEED_WORD_COUNTS[i], `seed${i}`)}\n`, 'utf8');
    const result = await surface.ingestFile({ name, data: fs.readFileSync(name) });
    expect(result.success, `seed doc ${i}: ${result.message ?? ''}`).toBe(true);
  }
  engine = new StubEngine();
  engine.attachDocumentSurface(surface);
  server = createBackendServer({
    guard: createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    engine,
  });
  port = await listenOnRandomPort(server);
});

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (store !== null) {
    store.close();
    store = null;
  }
  if (tempDir !== undefined) fs.rmSync(tempDir, { recursive: true, force: true });
});

describeReal('issue #169: /stats over a REAL seeded store', () => {
  it('GET /stats counts equal the engine listDocuments totals equal the seeded truth', async () => {
    const listed = await engine.listDocuments();
    expect(listed.total).toBe(SEEDED_DOCS);
    const summedChunks = listed.documents.reduce((acc, doc) => acc + doc.chunk_count, 0);
    // Real chunking: every seeded doc produced at least one chunk, and the
    // multi-chunk docs produced more (guards against a degenerate all-zero
    // chunk_count that would still "agree" with itself).
    expect(summedChunks).toBeGreaterThanOrEqual(SEEDED_DOCS);
    expect(listed.documents.some((doc) => doc.chunk_count > 1)).toBe(true);

    const stats = await engine.getStats();
    expect(stats.document_count).toBe(listed.total);
    expect(stats.chunk_count).toBe(summedChunks);

    const response = await fetch(url('/stats'), { headers: { [TOKEN_HEADER]: TOKEN } });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      document_count: number;
      chunk_count: number;
      embedding_model: string;
      llm_backend: string | null;
      documents: string[];
    };
    expect(payload.document_count).toBe(SEEDED_DOCS);
    expect(payload.chunk_count).toBe(summedChunks);
    expect(payload.document_count).toBe(stats.document_count);
    expect(payload.chunk_count).toBe(stats.chunk_count);
  });
});
