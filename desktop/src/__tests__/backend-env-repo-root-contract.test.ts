// backend-env-repo-root-contract.test.ts — FROZEN ACCEPTANCE SPEC
// (issue #229 sub-defect (c); trace 199-229-backend-host-lifecycle).
//
// AC5 (DISCRIMINATING): WHEN a host injects config.env carrying
// TRAININGAPP_DESKTOP_REPO_ROOT, THEN THE SYSTEM SHALL use the injected value
// for repo model-root selection in BOTH the embedder and reranker model
// resolution paths. RED at base, GREEN after the fix.
//
// AC6 (PRESERVING): THE SYSTEM SHALL keep resolving the effective env record
// as today when config.env is absent (ambient fallback intact) and SHALL keep
// model-root selection behavior for ambient-only hosts. GREEN at base and
// after the fix.
//
// Both tests run the REAL NodeBackendHost.start() against a temp sqlite
// store; resolveEmbedder and resolveRerankerModelDir are wrapped ONLY to
// RECORD the repoRoot they receive (their return values are null, which the
// host's degrade contract handles exactly like a weights-free checkout). The
// ambient sentinel is DELIBERATELY a different value than the injected one,
// so a start() that reads the ambient record fails loudly instead of passing
// vacuously.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Capture the repoRoot each resolver receives, without changing behavior
// beyond the recorded null return (weights-free checkout equivalent).
const seen = vi.hoisted(() => ({ embedder: [] as unknown[], reranker: [] as unknown[] }));

vi.mock('../../main/backend/ingest/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/ingest/embedder.js')>();
  return {
    ...actual,
    resolveEmbedder: (opts: { repoRoot?: string }) => {
      seen.embedder.push(opts.repoRoot);
      return null;
    },
  };
});

vi.mock('../../main/backend/retrieval/reranker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/retrieval/reranker.js')>();
  return {
    ...actual,
    resolveRerankerModelDir: (opts: { repoRoot?: string }) => {
      seen.reranker.push(opts.repoRoot);
      return null;
    },
  };
});

const { NodeBackendHost } = await import('../../main/backend/index.js');

// Anti-vacuity: the two sentinels differ by construction.
const INJECTED = 'X:/i229-injected-repo-root';
const AMBIENT = 'X:/i229-ambient-repo-root';

describe('issue 229 injected env repo-root contract', () => {
  const originalAmbient = process.env.TRAININGAPP_DESKTOP_REPO_ROOT;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (originalAmbient === undefined) delete process.env.TRAININGAPP_DESKTOP_REPO_ROOT;
    else process.env.TRAININGAPP_DESKTOP_REPO_ROOT = originalAmbient;
    if (tmpDir !== null) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it(
    'AC5 an injected config.env repo root must reach both model resolvers',
    async () => {
      seen.embedder.length = 0;
      seen.reranker.length = 0;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i229-envroot-'));
      process.env.TRAININGAPP_DESKTOP_REPO_ROOT = AMBIENT;

      const host = new NodeBackendHost({
        token: 'i229-envroot-token',
        storePath: path.join(tmpDir, 'store.sqlite'),
        storeEmbeddingDims: 8,
        env: { TRAININGAPP_DESKTOP_REPO_ROOT: INJECTED },
      });
      await host.start();
      await host.stop().catch(() => {});

      // BOTH resolvers must have received the INJECTED value — called exactly
      // once each, with the injected root, not the ambient one.
      expect(
        seen.embedder,
        'the embedder resolver must receive the injected repo root',
      ).toEqual([INJECTED]);
      expect(
        seen.reranker,
        'the reranker resolver must receive the injected repo root',
      ).toEqual([INJECTED]);
    },
    60_000,
  );

  it(
    'AC6 ambient fallback and model-root selection stay unchanged when config.env is absent',
    async () => {
      seen.embedder.length = 0;
      seen.reranker.length = 0;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i229-envroot-'));
      process.env.TRAININGAPP_DESKTOP_REPO_ROOT = AMBIENT;

      // config.env is NOT injected: today the effective record IS the ambient
      // process.env, so the ambient repo root must keep reaching both
      // resolvers exactly as before.
      const host = new NodeBackendHost({
        token: 'i229-envroot-token',
        storePath: path.join(tmpDir, 'store.sqlite'),
        storeEmbeddingDims: 8,
      });
      await host.start();
      await host.stop().catch(() => {});

      expect(
        seen.embedder,
        'the ambient repo root still reaches the embedder resolver when config.env is absent',
      ).toEqual([AMBIENT]);
      expect(
        seen.reranker,
        'the ambient repo root still reaches the reranker resolver when config.env is absent',
      ).toEqual([AMBIENT]);

      // Ambient unset AND config.env absent: model-root selection sees no
      // repo root at all, exactly as today.
      seen.embedder.length = 0;
      seen.reranker.length = 0;
      delete process.env.TRAININGAPP_DESKTOP_REPO_ROOT;
      const host2 = new NodeBackendHost({
        token: 'i229-envroot-token',
        storePath: path.join(tmpDir, 'store2.sqlite'),
        storeEmbeddingDims: 8,
      });
      await host2.start();
      await host2.stop().catch(() => {});

      expect(
        seen.embedder,
        'an unset ambient repo root still resolves to no embedder repo root today',
      ).toEqual([undefined]);
      expect(
        seen.reranker,
        'an unset ambient repo root still resolves to no reranker repo root today',
      ).toEqual([undefined]);
    },
    60_000,
  );
});
