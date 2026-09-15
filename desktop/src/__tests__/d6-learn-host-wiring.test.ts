// d6-learn-host-wiring.test.ts — the REAL host assembly path (D6/#82, PRR-005).
//
// d6-learn-server.test.ts wires the learn assembler by hand on a bare
// StubEngine; this test boots NodeBackendHost.start() — the production
// wiring closure in backend/index.ts that passes this.store.db and
// config.packsRoot — over a seeded store + on-disk pack slide doc, and
// asserts /ask emits learn enriched from disk (title/section/pack_id).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeBackendHost } from '../../main/backend/index.js';
import { StubEngine } from '../../main/backend/engine.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';

// The host resolves the embedder from TRAININGAPP_DESKTOP_EMBEDDER via env.
process.env.TRAININGAPP_DESKTOP_EMBEDDER = 'hash';

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
const TOKEN = 'd6-host-wiring-token';
const SLIDE_TEXT = 'opmedlearnzebra host wiring companion course';

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

describe('d6 host wiring: NodeBackendHost.start() attaches the learn assembler (issue #82)', () => {
  it(
    'real host boot produces learn rows with disk-enriched metadata on /ask',
    async () => {
      const dir = makeTempDir('d6-host-wiring-');
      const packsRoot = path.join(dir, 'packs');
      const slideDir = path.join(packsRoot, 'p-train', 'docs');
      fs.mkdirSync(slideDir, { recursive: true });
      fs.writeFileSync(
        path.join(slideDir, 'slide-001-5rN4PvXJM5d.json'),
        JSON.stringify({
          slide_id: '5rN4PvXJM5d',
          slide_title: 'Welcome',
          section_title: 'Course Introduction',
          on_screen_text: 'Start\nOpMed CDP MicroLearning Companion',
        }),
        'utf8',
      );

      const dbPath = path.join(dir, 'store.db');
      const embedder = new HashEmbedder({ dims: DIMS });
      // Seed through the store the HOST will open (same file path), so the
      // production retrieval + learn assembly both see the rows.
      const { openStore } = await import('../../main/backend/store/sqlite-store.js');
      const store = openStore({ dbPath, dims: DIMS, repoRoot: REPO_ROOT });
      const vector = (await embedder.embed([SLIDE_TEXT]))[0];
      store.db
        .prepare("INSERT OR IGNORE INTO packs (id, name, version, published_at, source_class, supersedes) VALUES ('p-train', 'Training', '1.0.0', '2026-09-15T00:00:00.000Z', 'training', NULL)")
        .run();
      store.db
        .prepare('INSERT INTO docs (id, source_class, path, sha256, title, pack_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run('doc-slide', 'training', 'docs/slide-001-5rN4PvXJM5d.json', 'sha-slide', 'Welcome', 'p-train');
      store.db
        .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)')
        .run('ch-slide', 'doc-slide', 0, SLIDE_TEXT, 'hash-slide');
      store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run('ch-slide', JSON.stringify(vector));
      store.db.prepare("INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)").run('ch-slide', SLIDE_TEXT);
      store.close();

      const host = new NodeBackendHost({
        token: TOKEN,
        storePath: dbPath,
        storeEmbeddingDims: DIMS,
        packsRoot,
        env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
        engine: new StubEngine(),
      });
      const handle = await host.start();
      try {
        const response = await fetch(`http://127.0.0.1:${handle.port}/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-desktop-token': TOKEN },
          body: JSON.stringify({ question: SLIDE_TEXT }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          learn?: Array<{ slide_id: string; title: string; section: string; pack_id?: string; reason: string }>;
          cited?: unknown;
        };
        expect(Array.isArray(body.learn)).toBe(true);
        const slideRow = body.learn!.find((r) => r.slide_id === '5rN4PvXJM5d');
        expect(slideRow).toBeDefined();
        expect(slideRow!.reason).toBe('direct');
        expect(slideRow!.section).toBe('Course Introduction');
        expect(slideRow!.pack_id).toBe('p-train');
        expect(body.cited).toBeUndefined();
      } finally {
        await host.stop();
      }
    },
    30000,
  );
});
