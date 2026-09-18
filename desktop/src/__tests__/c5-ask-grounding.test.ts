// c5-ask-grounding.test.ts — grounded/general provenance on the desktop
// backend (issue #72, C5). Wires the same openStore + createRetrievalSurface
// + StubEngine harness as c4-ask-citations/d6-learn-server, then asserts:
//   - /ask JSON and the stream done terminal carry grounding
//   - non-empty post-floor evidence => "grounded"; empty => "general"
//   - a reranker-floor drop (score < CALIBRATED_RELEVANCE_FLOOR) empties the
//     evidence set and the answer resolves "general" (the floor gates
//     grounding exactly as it gates retrieval)
//   - cancelled terminals resolve "general" (nothing was delivered)
//   - engine doubles without a grounding stamp serialize "general"
//   - the learn assembler suppresses to [] when grounding is "general"
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
import {
  createRetrievalSurface,
  type RerankerSurface,
} from '../../main/backend/retrieval/hybrid';
import { CALIBRATED_RELEVANCE_FLOOR } from '../../main/backend/retrieval/config';
import type { EngineQueryResult, Grounding } from '../../main/backend/types';

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
const TOKEN = 'c5-grounding-spec-token';
const SEEDED_TEXT = 'groundingzebra pack ledger reimbursement quantum falcon';

const tempDirs: string[] = [];
const stores: StoreHandle[] = [];
const servers: Server[] = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    server?.close();
  }
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
  port: number;
}

async function startServerWith(
  engine: ConstructorParameters<typeof createBackendServer>[0]['engine'],
  opts: {
    seed?: boolean;
    reranker?: RerankerSurface | null;
    surfaceConfig?: Parameters<typeof createRetrievalSurface>[0]['config'];
  } = {},
): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-ask-grounding-'));
  tempDirs.push(dir);
  const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: DIMS, repoRoot: REPO_ROOT });
  stores.push(store);

  if (opts.seed) {
    const embedder = new HashEmbedder({ dims: DIMS });
    const seed = (sql: string, ...params: unknown[]): void => {
      store.db.prepare(sql).run(...params);
    };
    seed(
      "INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      'doc-ground', 'general', 'docs/ground.txt', 'sha-ground', 'Ground', null, null,
    );
    seed(
      'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
      'ch-ground', 'doc-ground', 0, SEEDED_TEXT, 'hash-ground',
    );
    const vectors = await embedder.embed([SEEDED_TEXT]);
    seed('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)', 'ch-ground', JSON.stringify(vectors[0]));
    seed('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)', 'ch-ground', SEEDED_TEXT);
    engine.attachRetrievalSurface?.(
      createRetrievalSurface({ store, embedder, reranker: opts.reranker ?? null, config: opts.surfaceConfig }),
    );
  }

  const server = createBackendServer({
    guard: createLoopbackGuard({ token: TOKEN }),
    tokenHeaderName: 'X-Desktop-Token',
    engine,
  });
  const port = await listenOnRandomPort(server);
  servers.push(server);
  return { port };
}

function guardedHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-desktop-token': TOKEN };
}

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function askJson(port: number, question: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${base(port)}/ask`, {
    method: 'POST',
    headers: guardedHeaders(),
    body: JSON.stringify({ question }),
  });
  expect(resp.status).toBe(200);
  return (await resp.json()) as Record<string, unknown>;
}

function parseSse(raw: string): Array<Record<string, unknown>> {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
      return dataLine ? (JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>) : {};
    });
}

async function askStreamTerminals(port: number, question: string): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(`${base(port)}/ask/stream`, {
    method: 'POST',
    headers: guardedHeaders(),
    body: JSON.stringify({ question }),
  });
  expect(resp.status).toBe(200);
  const events = parseSse(await resp.text());
  return events.filter((p) => 'done' in p || 'error' in p);
}

describe('c5 /ask grounding (issue #72)', () => {
  itReal('emits grounding "grounded" when floor-qualified evidence survives', async () => {
    // Grounded requires the calibrated-floor (rerank) path: reranker scores
    // above CALIBRATED_RELEVANCE_FLOOR qualify the evidence.
    const engine = new StubEngine();
    const reranker: RerankerSurface = { score: async () => [CALIBRATED_RELEVANCE_FLOOR + 0.01] };
    const { port } = await startServerWith(engine, {
      seed: true,
      reranker,
      surfaceConfig: { relevanceFloor: CALIBRATED_RELEVANCE_FLOOR },
    });
    const body = await askJson(port, SEEDED_TEXT);
    expect(body['grounding']).toBe('grounded');

    const terminals = await askStreamTerminals(port, SEEDED_TEXT);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]['done']).toBe(true);
    expect(terminals[0]['grounding']).toBe('grounded');
  });

  itReal('emits grounding "general" on the fused (rerank-less) path even with retrieved rows', async () => {
    // No reranker attached -> no relevance floor ever gated the raw-RRF
    // scores, so a non-empty result must NOT claim "grounded" (final-critic
    // revision: floor-qualified evidence only).
    const engine = new StubEngine();
    const { port } = await startServerWith(engine, { seed: true });
    const body = await askJson(port, SEEDED_TEXT);
    expect(body['grounding']).toBe('general');
  });

  itReal('emits grounding "general" when the store yields no evidence', async () => {
    const engine = new StubEngine();
    const { port } = await startServerWith(engine, { seed: false });
    const body = await askJson(port, 'unrelated nonsense query text');
    expect(body['grounding']).toBe('general');

    const terminals = await askStreamTerminals(port, 'unrelated nonsense query text');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]['grounding']).toBe('general');
  });

  itReal('a reranker-floor drop empties the evidence set and resolves "general"', async () => {
    // The floor only gates reranker-scale scores: score the single seeded
    // chunk below CALIBRATED_RELEVANCE_FLOOR so the final post-floor set is
    // empty even though retrieval found it. The grounding value must follow
    // the same decision the floor made.
    const engine = new StubEngine();
    const reranker: RerankerSurface = {
      score: async () => [CALIBRATED_RELEVANCE_FLOOR - 0.01],
    };
    const { port } = await startServerWith(engine, {
      seed: true,
      reranker,
      // Production wiring (NodeBackendHost) resolves the frozen defaults into
      // the surface config; a bare surface carries no floor. Pin the floor
      // explicitly so this test exercises the calibrated-floor interaction.
      surfaceConfig: { relevanceFloor: CALIBRATED_RELEVANCE_FLOOR },
    });
    const body = await askJson(port, SEEDED_TEXT);
    expect(body['grounding']).toBe('general');
  });

  itReal('a reranker score above the floor keeps the answer "grounded"', async () => {
    const engine = new StubEngine();
    const reranker: RerankerSurface = {
      score: async () => [CALIBRATED_RELEVANCE_FLOOR + 0.01],
    };
    const { port } = await startServerWith(engine, {
      seed: true,
      reranker,
      surfaceConfig: { relevanceFloor: CALIBRATED_RELEVANCE_FLOOR },
    });
    const body = await askJson(port, SEEDED_TEXT);
    expect(body['grounding']).toBe('grounded');
  });

  itReal('engine doubles without a grounding stamp serialize "general"', async () => {
    const legacyEngine = {
      async query(): Promise<EngineQueryResult> {
        // Deliberately omits `grounding` (pre-C5 engine double shape).
        return {
          answer: 'legacy engine answer',
          sources: ['some-doc.md'],
          context_length: 42,
          inference_time: 0.01,
        };
      },
    };
    const { port } = await startServerWith(legacyEngine as never);
    const body = await askJson(port, 'any question');
    expect(body['grounding']).toBe('general');
  });

  itReal('cancelled stream terminals resolve grounding "general"', async () => {
    const cancelledEngine = {
      async query(): Promise<EngineQueryResult> {
        return {
          answer: '',
          sources: [],
          context_length: 0,
          inference_time: 0.01,
          cancelled: true,
          grounding: 'general',
        };
      },
    };
    const { port } = await startServerWith(cancelledEngine as never);
    const terminals = await askStreamTerminals(port, 'cancel me');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]['cancelled']).toBe(true);
    expect(terminals[0]['grounding']).toBe('general');
  });
});

describe('c5 learn suppression (issue #72)', () => {
  itReal('assembleLearnResults yields [] when grounding is "general"', async () => {
    const { assembleLearnResults } = await import('../../main/backend/learn');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-learn-'));
    tempDirs.push(dir);
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: DIMS, repoRoot: REPO_ROOT });
    stores.push(store);
    const rows = assembleLearnResults({
      db: store.db,
      cited: [{ chunkId: 'ch-x', score: 0.9 }],
      grounding: 'general' as Grounding,
    });
    expect(rows).toEqual([]);
  });
});
