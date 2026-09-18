// d6-learn-server.test.ts — /ask + /ask/stream learn[] emission (D6/#82).
//
// FROZEN acceptance check C6 runs this file. Wires the full node path the
// production host uses: real SQLite store (openStore), hybrid retrieval
// surface (createRetrievalSurface + HashEmbedder), and the learn assembler
// attached to the engine exactly as NodeBackendHost.start() attaches it —
// then asserts the learn rows cross /ask and the /ask/stream terminal done
// event, and that the internal `cited` field never serializes.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

import { createBackendServer, listenOnRandomPort } from '../../main/backend/server';
import { StubEngine } from '../../main/backend/engine';
import { createLoopbackGuard } from '../../main/security/loopback-guard';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store';
import { HashEmbedder } from '../../main/backend/ingest/embedder';
import { createRetrievalSurface } from '../../main/backend/retrieval/hybrid';
import { CALIBRATED_RELEVANCE_FLOOR } from '../../main/backend/retrieval/config';
import { assembleLearnResults } from '../../main/backend/learn';

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
const DIMS = 8;
const TOKEN = 'd6-learn-spec-token';

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

const MARKER_TOKEN = 'opmedlearnzebra';
const SLIDE_TEXT = `${MARKER_TOKEN} learn zebra companion course introduction`;
const POLICY_TEXT = `${MARKER_TOKEN} learn zebra policy reimbursement footnote`;

interface Fixture {
  server: Server;
  port: number;
  engine: StubEngine;
  dbPath: string;
}

async function startServer(withAssembler: boolean): Promise<Fixture> {
  const dir = makeTempDir('d6-learn-server-');
  const dbPath = path.join(dir, 'store.db');
  const store = openStore({ dbPath, dims: DIMS, repoRoot: REPO_ROOT });
  stores.push(store);
  const embedder = new HashEmbedder({ dims: DIMS });

  const seed = (sql: string, ...params: unknown[]): void => {
    store.db.prepare(sql).run(...params);
  };
  // One training-slide doc + chunk (the direct hit) and one general doc +
  // chunk (cited too, with two links rows feeding the "linked" half).
  seed("INSERT OR IGNORE INTO packs (id, name, version, published_at, source_class, active, supersedes) VALUES ('p-train', 'Training', '1.0.0', '2026-09-14T00:00:00.000Z', 'training', 1, NULL)");
  seed("INSERT INTO docs (id, source_class, path, sha256, title, pack_id) VALUES (?, ?, ?, ?, ?, ?)", 'doc-slide-5rN4PvXJM5d', 'training', 'docs/slide-001-5rN4PvXJM5d.json', 'sha-slide', 'Welcome', 'p-train');
  seed('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)', 'ch-slide', 'doc-slide-5rN4PvXJM5d', 0, SLIDE_TEXT, 'hash-slide');
  seed("INSERT INTO docs (id, source_class, path, sha256, title, pack_id) VALUES (?, ?, ?, ?, ?, ?)", 'doc-slide-6RdggQhakWc', 'training', 'docs/slide-002-6RdggQhakWc.json', 'sha-slide-b', 'Slides And Charts', 'p-train');
  seed('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)', 'ch-slide-b', 'doc-slide-6RdggQhakWc', 0, `${MARKER_TOKEN} unrelated body`, 'hash-slide-b');
  seed("INSERT INTO docs (id, source_class, path, sha256) VALUES (?, ?, ?, ?)", 'doc-policy', 'general', 'policy.txt', 'sha-policy');
  seed('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)', 'ch-policy', 'doc-policy', 0, POLICY_TEXT, 'hash-policy');
  seed("INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, 'p-train', ?, ?, '2026-09-14T00:00:00.000Z')", 'ch-policy', '6RdggQhakWc', 0.55, 1);

  // Hybrid retrieval needs both legs: vec0 embeddings AND the FTS index rows.
  const vectors = await embedder.embed([SLIDE_TEXT, `${MARKER_TOKEN} unrelated body`, POLICY_TEXT]);
  seed('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)', 'ch-slide', JSON.stringify(vectors[0]));
  seed('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)', 'ch-slide-b', JSON.stringify(vectors[1]));
  seed('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)', 'ch-policy', JSON.stringify(vectors[2]));
  seed("INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)", 'ch-slide', SLIDE_TEXT);
  seed("INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)", 'ch-slide-b', `${MARKER_TOKEN} unrelated body`);
  seed("INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)", 'ch-policy', POLICY_TEXT);

  // C5 (issue #72): attach a floor-passing reranker so the surface is on
// the calibrated-floor (rerank) path — the production default — keeping
// the evidence floor-qualified (grounding 'grounded') and the D6 learn
// flow unsuppressed.
  const surface = createRetrievalSurface({
    store,
    embedder,
    // Content-aware stub: the two "learn zebra" chunks (slide + policy) are
    // the intended evidence and score above the floor (policy first, so its
    // linked row outranks any same-slide direct row per the dedup rule);
    // the "unrelated body" slide chunk scores below the floor and drops,
    // exactly the ranking the fused-only pipeline produced pre-C5.
    reranker: {
      score: async (_q: string, texts: string[]) =>
        texts.map((t, i) =>
          t.includes('unrelated body')
            ? 0.1
            : (t.includes('policy') ? 0.9 : 0.8) - i * 0.001,
        ),
    },
    config: { relevanceFloor: CALIBRATED_RELEVANCE_FLOOR },
  });

  const engine = new StubEngine();
  engine.attachRetrievalSurface(surface);
  if (withAssembler) {
    engine.attachLearnAssembler((cited) => assembleLearnResults({ db: store.db, cited, packsRoot: null }));
  }

  const server = createBackendServer({
    guard: createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    engine,
  });
  const port = await listenOnRandomPort(server);
  return { server, port, engine, dbPath };
}

function guardedHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-desktop-token': TOKEN };
}

async function postJson(port: number, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: guardedHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
}

const servers: Server[] = [];
const stores: StoreHandle[] = [];
afterEach(() => {
  while (servers.length > 0) {
    const s = servers.pop();
    s?.close();
  }
  // Close BEFORE the temp-dir removal: Windows locks the open sqlite file.
  while (stores.length > 0) {
    const handle = stores.pop();
    handle?.close();
  }
});

describe('d6 /ask learn emission (issue #82)', () => {
  it('emits learn[] on /ask from the attached assembler and never serializes cited', async () => {
    const fixture = await startServer(true);
    servers.push(fixture.server);
    const { status, body } = await postJson(fixture.port, '/ask', { question: MARKER_TOKEN });
    expect(status).toBe(200);
    const payload = body as Record<string, unknown>;
    expect(Array.isArray(payload.learn)).toBe(true);
    const learn = payload.learn as Array<{ slide_id: string; reason: string }>;
    expect(learn.length).toBeGreaterThan(0);
    const slideIds = learn.map((entry) => entry.slide_id);
    expect(slideIds).toContain('5rN4PvXJM5d');
    expect(learn.find((entry) => entry.slide_id === '5rN4PvXJM5d')?.reason).toBe('direct');
    expect(slideIds).toContain('6RdggQhakWc');
    expect(learn.find((entry) => entry.slide_id === '6RdggQhakWc')?.reason).toBe('linked');
    // Internal-only field must never cross the wire.
    expect(payload.cited).toBeUndefined();
  }, 30000);

  it('emits learn[] on the /ask/stream terminal done event', async () => {
    const fixture = await startServer(true);
    servers.push(fixture.server);
    const response = await fetch(`http://127.0.0.1:${fixture.port}/ask/stream`, {
      method: 'POST',
      headers: guardedHeaders(),
      body: JSON.stringify({ question: MARKER_TOKEN }),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const frames = raw
      .split(/\r?\n\r?\n/)
      .map((frame) => frame.trim())
      .filter((frame) => frame.startsWith('data:'));
    const payloads = frames.map((frame) => JSON.parse(frame.slice(5).trim()) as Record<string, unknown>);
    const done = payloads.find((p) => p.done === true);
    expect(done).toBeDefined();
    const learn = done?.learn as Array<{ slide_id: string }>;
    expect(Array.isArray(learn)).toBe(true);
    expect(learn.map((entry) => entry.slide_id)).toContain('5rN4PvXJM5d');
  }, 30000);

  it('emits empty learn when no assembler is attached (contract: emitted on success, possibly [])', async () => {
    const fixture = await startServer(false);
    servers.push(fixture.server);
    const { status, body } = await postJson(fixture.port, '/ask', { question: MARKER_TOKEN });
    expect(status).toBe(200);
    const payload = body as Record<string, unknown>;
    expect(payload.learn).toEqual([]);
    expect(payload.cited).toBeUndefined();
  }, 30000);
});
