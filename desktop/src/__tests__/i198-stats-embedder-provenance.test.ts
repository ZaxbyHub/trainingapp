// i198-stats-embedder-provenance.test.ts — issue #198 AC2.
//
// `/stats.embedding_model` must report the model that actually BUILT THE
// STORED VECTORS, with the configured embedder published beside it as
// `configured_embedding_model`. The two diverge exactly when a prebuilt-index
// pack is installed into an EMPTY store: `importPrebuiltIndex` stamps the
// SHIPPED index's model into `meta.embedding_model_id`, and `readPrebuiltIndex`
// only refuses a model mix once the store already has chunks — so the pack's
// model silently owns the vectors while the configured embedder never ran.
//
// Before this, the route reported the CONFIGURED id, so an eval report
// attributed results to an embedding space that did not produce the vectors.
// That is a wrong measurement with nothing signalling it, which is worse than a
// missing field.
//
// The frozen #185 contract (i175-stub-embedder-marker) pins that a surface-
// attached engine reports the surface's embedder id and NOT the stub marker.
// That spec stays green UNCHANGED because a store with no written vectors has a
// seeded-empty `meta.embedding_model_id` and the route falls back to the
// configured id. The tests below are written so that fallback is explicit
// rather than incidental.
import { describe, expect, it } from 'vitest';

import { StubEngine } from '../../main/backend/engine.js';
import { makeFakeSurface } from './fixtures/document-surface-fake.js';

const STUB_MARKER = 'desktop-stub (B5 #63)';
const CONFIGURED = 'bge-small-en-v1.5';
const PACK_MODEL = 'opmed-cdp-mlc-1.0.1-sent-embedder';

describe('issue #198: /stats embedding_model reports the model that built the vectors', () => {
  describe('StubEngine (the surface-attached path)', () => {
    it('reports the PACK model in embedding_model when a prebuilt index was imported', async () => {
      // The exact divergence: meta holds the pack's model (what built the
      // vectors), the configured embedder is something else entirely.
      const engine = new StubEngine();
      engine.attachDocumentSurface(
        makeFakeSurface(CONFIGURED, { vectorsEmbeddingModelId: PACK_MODEL }),
      );

      const stats = await engine.getStats();

      expect(stats.embedding_model).toBe(PACK_MODEL);
      // ...and the configured id is still published, so the mismatch is visible.
      expect(stats.configured_embedding_model).toBe(CONFIGURED);
      expect(stats.embedding_model).not.toBe(stats.configured_embedding_model);
    });

    it('falls back to the configured id when no vector has ever been written', async () => {
      // The seeded meta value is '' — a store that has never held a vector, and
      // the default for every fake surface. Reporting '' here would be worse
      // than today, so the fallback must hold.
      const engine = new StubEngine();
      engine.attachDocumentSurface(makeFakeSurface(CONFIGURED));

      const stats = await engine.getStats();

      expect(stats.embedding_model).toBe(CONFIGURED);
      expect(stats.embedding_model).not.toBe('');
      expect(stats.configured_embedding_model).toBe(CONFIGURED);
    });

    it('reports both fields as equal when the two models agree (the normal case)', async () => {
      const engine = new StubEngine();
      engine.attachDocumentSurface(
        makeFakeSurface(CONFIGURED, { vectorsEmbeddingModelId: CONFIGURED }),
      );

      const stats = await engine.getStats();

      expect(stats.embedding_model).toBe(CONFIGURED);
      expect(stats.configured_embedding_model).toBe(CONFIGURED);
    });

    it('PRESERVING: a surface-attached engine still never reports the stub marker', async () => {
      // Frozen #185 contract, re-asserted here so a future edit that breaks it
      // fails in THIS spec too rather than only in i175.
      for (const vectorsModel of ['', CONFIGURED, PACK_MODEL]) {
        const engine = new StubEngine();
        engine.attachDocumentSurface(
          makeFakeSurface(CONFIGURED, { vectorsEmbeddingModelId: vectorsModel }),
        );
        const stats = await engine.getStats();
        expect(stats.embedding_model).not.toBe(STUB_MARKER);
        expect(stats.embedding_model.length).toBeGreaterThan(0);
      }
    });

    it('no surface: the frozen B3 marker is unchanged on BOTH fields', async () => {
      const engine = new StubEngine();

      const stats = await engine.getStats();

      expect(stats.embedding_model).toBe(STUB_MARKER);
      // No surface means no store and no configured embedder; claiming a
      // configured model here would be a second guess, not a measurement.
      expect(stats.configured_embedding_model).toBe(STUB_MARKER);
    });

    it('the response shape carries the new field on every branch', async () => {
      // Contract-shape guard: a branch that forgets configured_embedding_model
      // would answer undefined, which the OpenAPI `required` list forbids.
      const attached = new StubEngine();
      attached.attachDocumentSurface(
        makeFakeSurface(CONFIGURED, { vectorsEmbeddingModelId: PACK_MODEL }),
      );
      for (const stats of [await attached.getStats(), await new StubEngine().getStats()]) {
        expect(typeof stats.embedding_model).toBe('string');
        expect(typeof stats.configured_embedding_model).toBe('string');
        expect(stats.configured_embedding_model.length).toBeGreaterThan(0);
      }
    });
  });

  describe('the real store surface reads meta, not config', () => {
    it('StoreDocumentSurface.vectorsEmbeddingModelId reads meta.embedding_model_id', async () => {
      const { StoreDocumentSurface } = await import('../../main/backend/store/document-surface.js');
      const surface = new StoreDocumentSurface({
        getStore: () => ({
          db: {
            prepare: (sql: string) => {
              expect(sql).toContain("key = 'embedding_model_id'");
              return { get: () => ({ value: PACK_MODEL }) };
            },
          },
        }),
        embedder: { modelId: CONFIGURED },
        config: {} as never,
      });

      // The whole point: this is the STORED value, not the configured one.
      expect(surface.vectorsEmbeddingModelId).toBe(PACK_MODEL);
      expect(surface.embedderModelId).toBe(CONFIGURED);
    });

    it('reports "" (unknown) when there is no store, so callers fall back', async () => {
      const { StoreDocumentSurface } = await import('../../main/backend/store/document-surface.js');
      const surface = new StoreDocumentSurface({
        getStore: () => null,
        embedder: { modelId: CONFIGURED },
        config: {} as never,
      });

      expect(surface.vectorsEmbeddingModelId).toBe('');
    });

    it('reports "" when the store has no meta row, rather than throwing', async () => {
      // A pre-schema store mid-migration must not break a REPORTING field; the
      // caller has a correct fallback and the route must not 500 on it.
      const { StoreDocumentSurface } = await import('../../main/backend/store/document-surface.js');
      const surface = new StoreDocumentSurface({
        getStore: () =>
          ({
            db: {
              prepare: () => {
                throw new Error("no such table: meta");
              },
            },
          }) as never,
        embedder: { modelId: CONFIGURED },
        config: {} as never,
      });

      expect(surface.vectorsEmbeddingModelId).toBe('');
    });
  });
});
