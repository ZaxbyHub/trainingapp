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
// Native-deps gate follows the #193 D2 decision: better-sqlite3 is a
// compiled addon, so the real-seed suite FAILS under CI when it is absent
// (never a silent CI skip) and skips locally with the staging instruction.
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
import { nativeDepsDecision, nativeDepsDescribeGroup } from './fixtures/native-deps-gate.js';

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
// issue #193 D2 (trace test-batch-oct2026 Cluster A, AC21): the native-deps
// decision is made by the shared policy predicate and delivered by the shared
// factory (issue #203): 'run' when better-sqlite3 is present; 'skip' locally
// when absent (the repo's sanctioned staged-deps skip, preserved from the
// original gate) with the staging instruction in the skipped suite title
// (AC21: "skip with the staging instruction"); 'fail' under CI when absent
// (a silent CI skip is the silent-degrade class this batch exists to kill).
// The suite-scoped guard inside describeReal executes the 'fail' branch.
// TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT (owned by the factory) lets the
// AC21 wiring checks (i193) exercise the skip/fail branches end-to-end
// without uninstalling the addon; production runs never set it.
const NATIVE_DEPS_GATE = nativeDepsDecision();
const realGroup = nativeDepsDescribeGroup('issue #169: /stats over a REAL seeded store');
const describeReal = realGroup.describeGroup;

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
  if (NATIVE_DEPS_GATE !== 'run') return;
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

describeReal(() => {
  beforeAll(() => {
    // issue #193 D2: under CI with the native deps missing the suite FAILS
    // loudly with the staging instruction — never a silent skip. (The local
    // 'skip' branch is handled by the factory's describe.skip above.)
    realGroup.guard();
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

// ---------------------------------------------------------------------------
// issue #210 AC1 (trace 201-207-208-209-210): the FROZEN chunk-count oracle.
// The rows above certify /stats against values re-derived from the same
// production chunking the server reads (listDocuments totals / a raw count of
// the same ingest) - a chunker behavior change moves oracle and payload
// TOGETHER and the spec stays green (PRR-036). The deterministic truth for
// the seeded 40/300/600-word corpus at the default 256/100 config is the
// FROZEN constants below: per-doc [1, 2, 3], total 6 (verified by direct
// chunkDocument execution; the overlap-100-to-0 mutant claim was corrected
// to a size mutant by the plan critics). Named mutant:
// DEFAULT_INGEST_CONFIG chunkWordCount 256 -> 128 (yields 1/4/8, total 13).
// ---------------------------------------------------------------------------
const FROZEN_CHUNK_COUNTS = [1, 2, 3];
const FROZEN_CHUNK_TOTAL = 6;

describeReal(() => {
  beforeAll(() => {
    // issue #193 D2: this group needs the same suite-scoped guard as group 1.
    // Under CI with the native deps missing the suite must FAIL loudly with
    // the staging instruction - never with a null-store error thrown from the
    // rows themselves (which would hide the real cause).
    realGroup.guard();
  });

  it('chunk-oracle: GET /stats reports the FROZEN document_count 3 and chunk_count 6 for the seeded corpus', async () => {
    if (store === null) throw new Error('store handle unexpectedly null after seed');
    const response = await fetch(url('/stats'), { headers: { [TOKEN_HEADER]: TOKEN } });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { document_count: number; chunk_count: number };
    // The constants are LITERALS, not values summed from listDocuments/the
    // same chunker output (that is the PRR-036 vacuity this row kills).
    expect(payload.document_count).toBe(3);
    expect(payload.chunk_count).toBe(FROZEN_CHUNK_TOTAL);
    const rawChunks = (store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    expect(rawChunks).toBe(FROZEN_CHUNK_TOTAL);
  });

  it('chunk-oracle: per-doc chunk counts are exactly [1, 2, 3] for the 40/300/600-word seeds', async () => {
    if (store === null) throw new Error('store handle unexpectedly null after seed');
    const rows = store.db
      .prepare('SELECT d.path AS path, COUNT(*) AS n FROM chunks c JOIN docs d ON d.id = c.doc_id GROUP BY c.doc_id ORDER BY d.path')
      .all() as Array<{ path: string; n: number }>;
    expect(rows.map((r) => r.n)).toEqual(FROZEN_CHUNK_COUNTS);
    // docs.path stores the absolute seed-file path; compare by basename in
    // seed order (the GROUP BY ORDER BY d.path sorts doc-0 < doc-1 < doc-2).
    expect(rows.map((r) => path.basename(r.path))).toEqual(['doc-0.txt', 'doc-1.txt', 'doc-2.txt']);
  });
});

// ---------------------------------------------------------------------------
// issue #210 AC2 (PRR-037 / PRR-038): negative-auth row and the falsy
// embedder-id payload shape. Both run on the FAKE surface (no native deps),
// top-level on purpose. Named mutants: exempt /stats from the loopback guard
// (row 1 red); add `|| STUB_MARKER` to engine.ts:426 (row 2 red).
// ---------------------------------------------------------------------------
describe('GET /stats negative auth and falsy-embedder-id shape (issue #210 AC2)', () => {
  async function fakeStatsServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const engine = new StubEngine();
    engine.attachDocumentSurface(makeFakeSurface('route-auth'));
    const server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine,
    });
    const port = await listenOnRandomPort(server);
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('auth-negative: GET /stats without and with a wrong token is refused 401/403 by the guard', async () => {
    const { port, close } = await fakeStatsServer();
    try {
      const noToken = await fetch(`http://127.0.0.1:${port}/stats`);
      expect([401, 403], `no-token status: ${noToken.status}`).toContain(noToken.status);
      const wrongToken = await fetch(`http://127.0.0.1:${port}/stats`, {
        headers: { [TOKEN_HEADER]: 'not-the-token' },
      });
      expect([401, 403], `wrong-token status: ${wrongToken.status}`).toContain(wrongToken.status);
      // Positive control: the guard admits exactly the valid-token request.
      const ok = await fetch(`http://127.0.0.1:${port}/stats`, {
        headers: { [TOKEN_HEADER]: TOKEN },
      });
      expect(ok.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('auth-negative falsy-id: falsy embedderModelId/vectorsEmbeddingModelId pin the /stats embedding_model shape', async () => {
    const engine = new StubEngine();
    engine.attachDocumentSurface(makeFakeSurface('', { vectorsEmbeddingModelId: '' }));
    const server = createBackendServer({
      guard: createLoopbackGuard({ token: TOKEN }),
      tokenHeaderName: 'X-Desktop-Token',
      engine,
    });
    const port = await listenOnRandomPort(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/stats`, {
        headers: { [TOKEN_HEADER]: TOKEN },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        embedding_model: string;
        configured_embedding_model: string;
      };
      // engine.ts:426 `vectorsModel.length > 0 ? vectorsModel : configured`:
      // both falsy -> '' EXACTLY (a `|| STUB_MARKER` fallback flips this red;
      // the no-surface marker belongs to the detached path, not this one).
      expect(payload.embedding_model).toBe('');
      expect(payload.configured_embedding_model).toBe('');
      expect(payload.embedding_model).not.toBe(STUB_MARKER);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
