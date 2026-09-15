// d6-learn-kernel.test.ts — learn assembler unit tests (D6/#82).
//
// Mirrors learn_panel.py's kernel golden cases (tests/test_learn_kernel.py):
// union/dedup/rank, direct-preferred-on-ties, and the cap. The desktop
// cannot import the Python module — repo precedent is mirrored kernels with
// mirrored golden vectors (D4 links compute). Keep both in sync.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

import { openStore } from '../../main/backend/store/sqlite-store.js';
import { assembleLearnResults, MAX_LEARN_RESULTS } from '../../main/backend/learn.js';

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

interface SeedOptions {
  title?: string | null;
  packId?: string | null;
}

function seedTrainingSlide(store: ReturnType<typeof openStore>, slideId: string, opts: SeedOptions = {}): void {
  store.db
    .prepare(
      "INSERT OR IGNORE INTO packs (id, name, version, published_at, source_class, supersedes) VALUES ('p-train', 'Training', '1.0.0', '2026-09-14T00:00:00.000Z', 'training', NULL)",
    )
    .run();
  store.db
    .prepare('INSERT INTO docs (id, source_class, path, sha256, title, pack_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      `doc-slide-${slideId}`,
      'training',
      `docs/slide-001-${slideId}.json`,
      `sha-${slideId}`,
      opts.title ?? null,
      opts.packId === undefined ? 'p-train' : opts.packId,
    );
  store.db
    .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)')
    .run(`ch-slide-${slideId}`, `doc-slide-${slideId}`, 0, `slide ${slideId} text`, `hash-${slideId}`);
}

function seedGeneralDoc(store: ReturnType<typeof openStore>, docId: string, chunkId: string): void {
  store.db
    .prepare('INSERT INTO docs (id, source_class, path, sha256) VALUES (?, ?, ?, ?)')
    .run(docId, 'general', `${docId}.txt`, `sha-${docId}`);
  store.db
    .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)')
    .run(chunkId, docId, 0, `${docId} text`, `hash-${docId}`);
}

function seedLink(store: ReturnType<typeof openStore>, chunkId: string, slideId: string, score: number, rank: number): void {
  store.db
    .prepare("INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, 'p-train', ?, ?, '2026-09-14T00:00:00.000Z')")
    .run(chunkId, slideId, score, rank);
}

describe('d6 learn assembler (issue #82)', () => {
  it('unions direct + linked, dedupes by slide keeping direct on higher score', () => {
    const dir = makeTempDir('d6-learn-');
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    try {
      seedTrainingSlide(store, '5rN4PvXJM5d', { title: 'Welcome' });
      seedGeneralDoc(store, 'doc-policy', 'ch-policy');
      seedLink(store, 'ch-policy', '5rN4PvXJM5d', 0.6, 1);

      const learn = assembleLearnResults({
        db: store.db,
        cited: [
          { chunkId: 'ch-slide-5rN4PvXJM5d', score: 0.91 },
          { chunkId: 'ch-policy', score: 0.5 },
        ],
      });
      expect(learn).not.toBeNull();
      expect(learn).toHaveLength(1);
      expect(learn![0]).toMatchObject({
        slide_id: '5rN4PvXJM5d',
        title: 'Welcome',
        reason: 'direct',
        score: 0.91,
      });
    } finally {
      store.close();
    }
  });

  it('emits linked slides of cited chunks and ranks descending', () => {
    const dir = makeTempDir('d6-learn-');
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    try {
      seedTrainingSlide(store, 'slideA');
      seedTrainingSlide(store, 'slideB');
      seedTrainingSlide(store, 'slideC');
      seedGeneralDoc(store, 'doc-policy', 'ch-policy');
      seedLink(store, 'ch-policy', 'slideB', 0.8, 1);
      seedLink(store, 'ch-policy', 'slideC', 0.4, 2);

      const learn = assembleLearnResults({
        db: store.db,
        cited: [
          { chunkId: 'ch-slide-slideA', score: 0.7 },
          { chunkId: 'ch-policy', score: 0.5 },
        ],
      });
      expect(learn).not.toBeNull();
      expect(learn!.map((r) => [r.slide_id, r.reason])).toEqual([
        ['slideB', 'linked'],
        ['slideA', 'direct'],
        ['slideC', 'linked'],
      ]);
    } finally {
      store.close();
    }
  });

  it('caps results at MAX_LEARN_RESULTS', () => {
    const dir = makeTempDir('d6-learn-');
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    try {
      for (let i = 0; i < 8; i += 1) seedTrainingSlide(store, `s${i}`);
      seedGeneralDoc(store, 'doc-policy', 'ch-policy');
      for (let i = 0; i < 8; i += 1) seedLink(store, 'ch-policy', `s${i}`, 0.9 - i * 0.01, Math.min(i + 1, 3));

      const learn = assembleLearnResults({
        db: store.db,
        cited: [{ chunkId: 'ch-policy', score: 0.5 }],
      });
      expect(learn).toHaveLength(MAX_LEARN_RESULTS);
      const scores = learn!.map((r) => r.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    } finally {
      store.close();
    }
  });

  it('enriches title/section/snippet from the pack slide doc on disk', () => {
    const dir = makeTempDir('d6-learn-');
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
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    try {
      seedTrainingSlide(store, '5rN4PvXJM5d', { title: null });

      const learn = assembleLearnResults({
        db: store.db,
        cited: [{ chunkId: 'ch-slide-5rN4PvXJM5d', score: 0.9 }],
        packsRoot,
      });
      expect(learn).not.toBeNull();
      expect(learn![0]).toMatchObject({
        slide_id: '5rN4PvXJM5d',
        title: 'Welcome',
        section: 'Course Introduction',
        pack_id: 'p-train',
      });
      expect(learn![0].snippet).toBe('Start\nOpMed CDP MicroLearning Companion');
    } finally {
      store.close();
    }
  });

  it('returns null when the store is closed and [] when nothing is cited', () => {
    expect(assembleLearnResults({ db: null, cited: [{ chunkId: 'c', score: 1 }] })).toBeNull();
    const dir = makeTempDir('d6-learn-');
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(assembleLearnResults({ db: store.db, cited: [] })).toEqual([]);
    } finally {
      store.close();
    }
  });
});
