// @vitest-environment node
/**
 * R4 (trace browser-training-parity AC6, plan step 8): installing a pack in
 * the browser ingests its slide documents into the browser keyword index
 * through the REAL ingestion path (BrowserPackManager.installPack -> the
 * production searchIndexHooks -> pack-ingest.ts -> the real FlexSearch
 * KeywordIndex), with `packId` stamped on every chunk — so the Learn kernel
 * emits pack_id and the pinned-slide resolver finds the section. Slide docs
 * are the real packtool output in tests/fixtures/storyline-mini.
 *
 * Mutation probe (08-test-results.md): removing the packId stamp in
 * buildPackChunks turns the packId assertions red.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The vector index (EdgeVec WASM) and the embedding model are not under test:
// keyword ingestion must work before any model loads.
vi.mock('../../search/vector-index', () => ({
  getVectorIndex: () => ({
    initialize: async () => undefined,
    isReady: () => false,
    addBatch: async () => undefined,
    removeByDocId: async () => undefined,
    save: async () => undefined,
  }),
}));
vi.mock('../../embeddings/embedding-service', () => ({
  getEmbeddingService: () => ({ isReady: () => false, encodeBatch: async () => [] }),
}));

import { BrowserPackManager, searchIndexHooks } from '../browser-pack-manager';
import { MemoryPackFileStore, MemoryPackRegistry } from '../pack-store-opfs';
import { getKeywordIndex } from '../../search/keyword-index';
import { buildLearnResults } from '../../rag/learn-kernel';
import { resolveSlideDoc } from '../../training/slide-doc-resolver';
import { buildRawZip } from './zip-fixture';

const SLIDES_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'tests', 'fixtures', 'storyline-mini', 'expected', 'slides');
const PACK_ID = 'storyline-mini-course';

function fixturePack(): File {
  const names = fs.readdirSync(SLIDES_DIR).filter((n) => n.endsWith('.json')).sort();
  const docs = names.map((name) => ({ name: `docs/${name}`, data: fs.readFileSync(path.join(SLIDES_DIR, name)) }));
  const manifest = {
    id: PACK_ID,
    name: 'Storyline Mini Course',
    version: '1.0.0',
    published_at: '2026-10-01T00:00:00Z',
    source_class: 'training',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
    docs: docs.map((d) => ({ path: d.name, sha256: createHash('sha256').update(d.data).digest('hex'), title: d.name, mime: 'application/json' })),
  };
  const zip = buildRawZip([
    { name: 'pack.json', data: JSON.stringify(manifest) },
    ...docs.map((d) => ({ name: d.name, data: new Uint8Array(d.data), method: 8 as const })),
    { name: 'assets/player/story.html', data: '<html></html>' },
  ]);
  return new File([zip], 'storyline-mini.zip');
}

const keywordIndex = getKeywordIndex();

beforeAll(async () => {
  await keywordIndex.initialize();
  // No IndexedDB under node: persistence is not what this test pins.
  vi.spyOn(keywordIndex, 'save').mockResolvedValue(undefined);
  const manager: BrowserPackManager = new BrowserPackManager({
    registry: new MemoryPackRegistry(),
    files: new MemoryPackFileStore(),
    hooks: searchIndexHooks(() => manager),
    storage: { estimate: async () => ({ quota: 1e12, usage: 0 }), persist: async () => true },
    gateConfig: () => ({ requireSignature: false, trustedKeys: [], embeddingModelId: 'bge-small-en-v1.5' }),
    capabilities: () => [],
  });
  await manager.installPack(fixturePack());
});

afterAll(() => {
  keywordIndex.dispose();
});

describe('browser pack ingestion (R4)', () => {
  it('every slide-doc chunk in the keyword index carries the owning packId', () => {
    const slideChunks = keywordIndex.findChunks((meta) => /^docs\/slide-\d+-.+\.json$/.test(meta.source ?? ''), 1000);
    expect(slideChunks.length).toBe(fs.readdirSync(SLIDES_DIR).filter((n) => n.endsWith('.json')).length);
    for (const chunk of slideChunks) {
      expect(chunk.packId, `chunk ${chunk.source} lacks packId`).toBe(PACK_ID);
      expect(chunk.text?.split('\n', 1)[0]).toMatch(/^\[training-slide\] section=.* \| title=.* \| slide_id=\S+$/);
    }
  });

  it('keyword retrieval returns pack chunks whose Learn rows carry pack_id (desktop docs.pack_id parity)', () => {
    const results = keywordIndex.search('Special Instructions information pane', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    const learn = buildLearnResults(results);
    expect(learn.length).toBeGreaterThan(0);
    for (const row of learn) expect(row.pack_id).toBe(PACK_ID);
    expect(learn.map((r) => r.slide_id)).toContain('5b8obQzpBWu');
  });

  it('the pinned-slide resolver finds the slide section from the ingested doc (no model needed)', () => {
    expect(resolveSlideDoc('5b8obQzpBWu')).toMatchObject({ section: 'Course Introduction' });
  });
});
