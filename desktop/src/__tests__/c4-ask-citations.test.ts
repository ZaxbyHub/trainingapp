// c4-ask-citations.test.ts — /ask + /ask/stream pack-attributed citations
// over the real node path (issue #71, AC8). Frozen check driver
// repro/check-c11.sh runs this file. Wires openStore + seeded packs/docs
// rows + createRetrievalSurface + StubEngine exactly as d6-learn-server does,
// then asserts the citations array crosses /ask and the stream done event
// while the internal `cited` field never serializes.
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
const DIMS = 8;
const TOKEN = 'c4-citations-spec-token';
const PACK_PUBLISHED_AT = '2026-09-16T00:00:00.000Z';
const PACK_TEXT = 'citationszebra pack ledger reimbursement quantum falcon';

const tempDirs: string[] = [];
const stores: StoreHandle[] = [];
const servers: Server[] = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    server?.close();
  }
  // Close BEFORE temp-dir removal: Windows locks the open sqlite file.
  while (stores.length > 0) {
    const handle = stores.pop();
    handle?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  server: Server;
  port: number;
}

async function startServer(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-ask-citations-'));
  tempDirs.push(dir);
  const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: DIMS, repoRoot: REPO_ROOT });
  stores.push(store);
  const embedder = new HashEmbedder({ dims: DIMS });

  const seed = (sql: string, ...params: unknown[]): void => {
    store.db.prepare(sql).run(...params);
  };
  seed(
    "INSERT INTO packs (id, name, version, published_at, source_class, active, install_path, supersedes) VALUES ('pack-cite', 'Cite Pack', '2.0.0', ?, 'bundled', 1, NULL, NULL)",
    PACK_PUBLISHED_AT,
  );
  seed(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'doc-cite', 'bundled', 'docs/cite.json', 'sha-cite', 'Cite', PACK_PUBLISHED_AT, 'pack-cite',
  );
  seed(
    'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
    'ch-cite', 'doc-cite', 0, PACK_TEXT, 'hash-cite',
  );
  seed(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'doc-plain', 'general', 'notes.txt', 'sha-plain', 'Notes', null, null,
  );
  seed(
    'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
    'ch-plain', 'doc-plain', 0, 'citationszebra plain unpackaged notes zebra', 'hash-plain',
  );

  const vectors = await embedder.embed([PACK_TEXT, 'citationszebra plain unpackaged notes zebra']);
  seed('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)', 'ch-cite', JSON.stringify(vectors[0]));
  seed('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)', 'ch-plain', JSON.stringify(vectors[1]));
  seed('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)', 'ch-cite', PACK_TEXT);
  seed('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)', 'ch-plain', 'citationszebra plain unpackaged notes zebra');

  const surface = createRetrievalSurface({ store, embedder });
  const engine = new StubEngine();
  engine.attachRetrievalSurface(surface);

  const server = createBackendServer({
    guard: createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    engine,
  });
  const port = await listenOnRandomPort(server);
  servers.push(server);
  return { server, port };
}

function guardedHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-desktop-token': TOKEN };
}

interface CitationWire {
  source: string;
  page: number | null;
  pack_id: string | null;
  pack_version: string | null;
  pack_published_at: string | null;
}

describe('c4 /ask citations (issue #71, AC8)', () => {
  itReal('emits pack-attributed citations on /ask and never serializes cited', async () => {
    const { port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: 'POST',
      headers: guardedHeaders(),
      body: JSON.stringify({ question: 'citationszebra' }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Array.isArray(payload.citations)).toBe(true);
    const citations = payload.citations as CitationWire[];
    expect(citations.length).toBeGreaterThan(0);
    const packed = citations.find((citation) => citation.pack_id === 'pack-cite');
    expect(packed).toBeDefined();
    expect(packed?.pack_version).toBe('2.0.0');
    expect(packed?.pack_published_at).toBe(PACK_PUBLISHED_AT);
    expect(packed?.page).toBeNull();
    // Unpackaged chunks cite with null pack fields instead of being dropped.
    const plain = citations.find((citation) => citation.source.includes('notes.txt'));
    expect(plain).toBeDefined();
    expect(plain?.pack_id).toBeNull();
    // The internal cited chunks must not leak verbatim.
    expect(payload.cited).toBeUndefined();
  });

  itReal('emits citations on the /ask/stream terminal done event', async () => {
    const { port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/ask/stream`, {
      method: 'POST',
      headers: guardedHeaders(),
      body: JSON.stringify({ question: 'citationszebra' }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const frames = body
      .split('\r\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
    const doneFrames = frames.filter((frame) => frame.done === true);
    expect(doneFrames.length).toBeGreaterThan(0);
    const done = doneFrames[doneFrames.length - 1];
    expect(Array.isArray(done.citations)).toBe(true);
    const citations = done.citations as CitationWire[];
    const packed = citations.find((citation) => citation.pack_id === 'pack-cite');
    expect(packed?.pack_version).toBe('2.0.0');
    // Frozen cancellation/terminal keys stay intact (additive key only).
    expect(Array.isArray(done.sources)).toBe(true);
    expect(typeof done.context_length).toBe('number');
  });
});
