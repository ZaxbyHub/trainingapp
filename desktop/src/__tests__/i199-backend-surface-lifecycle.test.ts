// i199-backend-surface-lifecycle.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #199 sub-defects (d) and (e); trace 199-229-backend-host-lifecycle).
//
// AC7 (DISCRIMINATING): WHEN BackendHost.stop() runs with a document surface
// attached, THE SYSTEM SHALL detach it, so a subsequent getStats() reports
// the no-surface marker and zero counts (not a stale surface's id).
// RED at base, GREEN after the fix.
//
// AC8 (DISCRIMINATING — reclassified from the source issue's NEW-SURFACE
// label): WHEN a detach/teardown lands while StubEngine.retrieveContext() is
// suspended inside the retrieval surface's search, THE SYSTEM SHALL NOT
// null-deref, and the captured surface's fields shall describe the result
// (the #185 capture-once invariant applied to the retrieval path). The
// exercised symbol, StubEngine.retrieveContext, EXISTS at the base revision
// and a RED result is achievable and demonstrated at base, which is strictly
// stronger evidence than a new-surface absence signature — hence the
// reclassification. RED at base, GREEN after the fix.
//
// AC7 drives the REAL NodeBackendHost.start()/stop() with a temp sqlite
// store, a real StubEngine and a real HashEmbedder (resolveEmbedder is
// wrapped ONLY to return the deterministic hash embedder so
// attachStoreSurface() genuinely builds and attaches a StoreDocumentSurface).
// AC8 drives the REAL StubEngine.retrieveContext() with a surface whose
// search signals entry and then suspends on a gate promise the test releases
// — the detach provably lands inside the await window, deterministically.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StubEngine } from '../../main/backend/engine.js';
import type { RetrievalSurface } from '../../main/backend/retrieval/hybrid.js';

// Resolve a deterministic HashEmbedder so attachStoreSurface() really builds
// and attaches a StoreDocumentSurface (without this the real resolver returns
// null on a weights-free checkout and the surface stays detached, which would
// make the dead-guard defect indistinguishable from nothing-to-detach).
vi.mock('../../main/backend/ingest/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/ingest/embedder.js')>();
  return {
    ...actual,
    resolveEmbedder: () => new actual.HashEmbedder({ dims: 8 }),
  };
});

const { NodeBackendHost } = await import('../../main/backend/index.js');

describe('issue 199 backend surface lifecycle', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir !== null) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it(
    'AC7 stop detaches an attached document surface',
    async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i199-surface-'));
      const dbPath = path.join(tmpDir, 'store.sqlite');

      // A StubEngine is passed explicitly so the observed field really is the
      // stub's documentSurface (the default engine is resolveNodeEngine's
      // LlamaEngine, whose surface field is named differently and would make
      // the harness-sanity assertions below vacuously satisfied).
      const engine = new StubEngine();
      const host = new NodeBackendHost({
        token: 'i199-surface-token',
        storePath: dbPath,
        storeEmbeddingDims: 8,
        engine,
      });
      await host.start();

      const attached = (engine as unknown as { documentSurface: unknown }).documentSurface;

      // ANTI-VACUITY GUARD (both clauses required): the surface really is
      // attached after start(). `not.toBeNull()` alone is satisfied by
      // undefined — an earlier probe revision read as a pass while observing
      // nothing; the undefined check pins the field name too.
      expect(
        attached,
        'harness sanity: a document surface must be attached after start',
      ).not.toBeUndefined();
      expect(
        attached,
        'harness sanity: the attached document surface must be non-null',
      ).not.toBeNull();

      await host.stop();

      // THE DEFECT (index.ts stop()): the detach is guarded on this.surface,
      // a field that is never assigned a non-null value (attachStoreSurface
      // builds the surface as a local), so the guard is permanently false and
      // the engine keeps the stale surface after teardown.
      const afterStop = (engine as unknown as { documentSurface: unknown }).documentSurface;
      expect(afterStop, 'stop must detach the attached document surface').toBeNull();

      // Positive contract (AC7): with the surface detached, getStats()
      // reports the no-surface marker and zero counts — never a stale
      // surface's embedder id.
      const stats = await engine.getStats();
      expect(
        stats.embedding_model,
        'getStats reports the no-surface marker after stop',
      ).toBe('desktop-stub (B5 #63)');
      expect(stats.document_count, 'getStats reports zero document count after stop').toBe(0);
    },
    60_000,
  );

  it(
    'AC8 a detach landing inside the search await must not null-deref',
    async () => {
      const engine = new StubEngine();
      let releaseSearch: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      let signalEntered: (() => void) | null = null;
      const enteredSearch = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const surface: RetrievalSurface = {
        floorActive: true,
        rerankDefault: true,
        search: async () => {
          signalEntered?.();
          await gate;
          return [{ text: 'alpha', source: 'a.md', similarity: 0.9 }];
        },
      };
      engine.attachRetrievalSurface(surface);

      // Suspend retrieveContext inside surface.search().
      const pending = engine.retrieveContext('q', 4).then(
        (value) => ({ ok: true as const, value }),
        (err: unknown) => ({
          ok: false as const,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      await enteredSearch; // deterministic: retrieveContext is suspended in search()

      // The teardown detach (index.ts stop() calls attachRetrievalSurface
      // with null) lands inside the await window.
      engine.attachRetrievalSurface(null);

      releaseSearch?.();
      const result = await pending;

      // THE DEFECT (engine.ts retrieveContext): it re-reads
      // this.retrievalSurface.floorActive AFTER the awaited search, so a
      // detach landing in that window null-derefs. The #185 capture-once
      // invariant must hold here too.
      expect(result.ok, 'a detach during the search await must not null-deref').toBe(true);

      // Positive contract: the CAPTURED surface's fields describe the result
      // — floorActive true (the attached surface had it true and the query
      // requested rerank via rerankDefault), not merely did-not-throw.
      expect(
        result.ok && result.value?.floorActive === true,
        'the captured surface fields must describe the result',
      ).toBe(true);
    },
    10_000,
  );
});
