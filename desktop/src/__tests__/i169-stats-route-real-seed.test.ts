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
// Shared fake-surface fixture (issue #193 AC19 / #200 AC2) for the AC15
// out-of-scope-fields pin below, and the #193 D2 native-deps gate policy.
import { makeFakeSurface } from './fixtures/document-surface-fake.js';
import { nativeDepsGate } from './fixtures/native-deps-gate.js';

const TOKEN = 'i169-route-spec-token';
const TOKEN_HEADER = 'x-desktop-token';
const STUB_MARKER = 'desktop-stub (B5 #63)';
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
// issue #193 D2 (trace test-batch-oct2026 Cluster A, AC21): the native-deps
// decision is made by the shared policy predicate — 'run' when
// better-sqlite3 is present; 'skip' locally when absent (the repo's
// sanctioned staged-deps skip, preserved from the original gate); 'fail'
// under CI when absent (a silent CI skip is the silent-degrade class this
// batch exists to kill). The suite-scoped beforeAll inside describeReal
// executes the 'fail' branch.
const NATIVE_DEPS_GATE = nativeDepsGate({
  ci: Boolean(process.env.CI),
  nativeDepsPresent: NATIVE_DEPS_PRESENT,
});
const describeReal = NATIVE_DEPS_GATE === 'skip' ? describe.skip : describe;

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
  beforeAll(() => {
    // issue #193 D2: under CI with the native deps missing the suite FAILS
    // loudly with the staging instruction — never a silent skip. (The local
    // 'skip' branch is handled by describe.skip above.)
    if (NATIVE_DEPS_GATE === 'fail') {
      throw new Error(
        'native deps missing under CI: desktop/node_modules/better-sqlite3 absent — ' +
          'run `npm --prefix desktop ci` to stage it (issue #193 D2: fail, never silently skip)',
      );
    }
  });

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

    // Independent chunk/document oracle (issue-169 feedback): raw table
    // counts straight from sqlite, NOT derived through the same
    // listDocuments() query the engine reads — an under-count in the
    // per-doc GROUP BY aggregation would otherwise leave this spec green
    // while /stats reports fewer chunks than the store holds.
    if (store === null) throw new Error('store handle unexpectedly null after seed');
    const rawDocs = (store.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
    const rawChunks = (store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    expect(rawDocs).toBe(SEEDED_DOCS);
    expect(rawChunks).toBeGreaterThan(0);
    expect(payload.document_count).toBe(rawDocs);
    expect(payload.chunk_count).toBe(rawChunks);
  });

  // issue #200 AC18 (trace test-batch-oct2026 Cluster A): the base spec above
  // TYPES embedding_model in its payload but never asserts it. Through the
  // REAL StoreDocumentSurface (HashEmbedder), /stats must report the real
  // embedder id — NOT the no-surface stub marker.
  it('real-embedder-id', async () => {
    const response = await fetch(url('/stats'), { headers: { [TOKEN_HEADER]: TOKEN } });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { embedding_model: string };
    // The attached surface's real embedder id (HashEmbedder.modelId === 'hash').
    expect(payload.embedding_model).toBe(surface.embedderModelId);
    expect(payload.embedding_model).toBe('hash');
    // Explicitly not the no-surface stub marker.
    expect(payload.embedding_model).not.toBe(STUB_MARKER);
  });
});

// issue #190 AC15, reworded per #197 (trace test-batch-oct2026 Cluster A):
// the OUT-OF-SCOPE /stats fields on the attached-surface path. Top level on
// purpose — the fake surface and the stub-engine route need no native deps,
// so this pin runs even where better-sqlite3 is absent (describeReal above
// gates only the real-store suite). Post-PR-#194 the attached path reports
// the surface's embedderModelId; the 'desktop-stub (B5 #63)' marker belongs
// to the NO-surface path only (pinned in i175).
describe('GET /stats out-of-scope fields on the attached-surface path (issue #190 AC15)', () => {
  it('out-of-scope-fields', async () => {
    const engine = new StubEngine();
    engine.attachDocumentSurface(makeFakeSurface('route-fake-a'));
    const server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine,
    });
    const routePort = await listenOnRandomPort(server);
    try {
      const response = await fetch(`http://127.0.0.1:${routePort}/stats`, {
        headers: { [TOKEN_HEADER]: TOKEN },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        document_count: number;
        chunk_count: number;
        embedding_model: string;
        llm_backend: string | null;
        documents: string[];
      };
      // The counts payload itself (already pinned engine-side by i103c /
      // i169-llama) — the DEFAULT_DOCS corpus through the shared fixture.
      expect(payload.document_count).toBe(2);
      expect(payload.chunk_count).toBe(5);
      // The out-of-scope fields this AC pins:
      // documents stays an EMPTY array (it is not the document listing).
      expect(payload.documents).toEqual([]);
      // llm_backend is null on the stub engine.
      expect(payload.llm_backend).toBeNull();
      // embedding_model is the attached surface's embedderModelId — per
      // #197's rewording of #190 AC1, NOT the no-surface stub marker.
      expect(payload.embedding_model).toBe('route-fake-a');
      expect(payload.embedding_model).not.toBe(STUB_MARKER);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
