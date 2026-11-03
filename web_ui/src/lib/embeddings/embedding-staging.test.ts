/**
 * Frozen check C11 (trace collated-275-268, AC6 of issue #268).
 *
 * When the staged embedding model asset at the config path answers HTTP 200
 * with `text/html` (the SPA fallback serving index.html for a missing
 * `/models/embeddings/.../config.json`), embedder initialisation must fail
 * with an error whose message contains `embedding model not staged` and the
 * probed URL. The helper under test (issue #268 Design 3):
 *
 *   assertEmbeddingModelStaged(fetcher = defaultAssetFetcher): Promise<void>
 *
 * wraps `probeAsset` (`../models/probe`) over
 * `${EMBEDDING_MODELS_BASE}/${EMBEDDING_MODEL_DIR}/config.json` with an
 * INJECTABLE fetcher, so this spec needs no network and no Worker.
 *
 * RED at base (module absent), GREEN after the fix.
 */

import { describe, it, expect, vi } from 'vitest';

import { assertEmbeddingModelStaged } from './embedding-staging';
import type { AssetFetcher } from '../models/probe';

const fetcherFor = (response: { ok: boolean; status?: number; contentType?: string | null }) =>
  vi.fn<AssetFetcher>(async () => response);

const failingFetcher = vi.fn<AssetFetcher>(async () => {
  throw new TypeError('NetworkError when attempting to fetch resource.');
});

describe('assertEmbeddingModelStaged (C11)', () => {
  it('rejects with "embedding model not staged" and the probed URL when the config path serves the SPA fallback (HTTP 200 text/html)', async () => {
    const fetcher = fetcherFor({ ok: true, status: 200, contentType: 'text/html' });

    const error = (await assertEmbeddingModelStaged(fetcher).catch(
      (err: unknown) => err
    )) as Error;

    // The probe targeted the staged config path...
    expect(fetcher).toHaveBeenCalledTimes(1);
    const probedUrl = fetcher.mock.calls[0][0];
    expect(probedUrl).toContain('/models/embeddings/');
    expect(probedUrl).toContain('config.json');

    // ...and the error names both the staging gap and that URL.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('embedding model not staged');
    expect(error.message).toContain(probedUrl);
  });

  it('resolves without throwing when the config path serves a real (non-HTML) asset', async () => {
    const fetcher = fetcherFor({ ok: true, status: 200, contentType: 'application/json' });
    await expect(assertEmbeddingModelStaged(fetcher)).resolves.toBeUndefined();
  });

  it('rejects with the staging error when the probe fetch fails (network error)', async () => {
    await expect(assertEmbeddingModelStaged(failingFetcher)).rejects.toThrow(
      /embedding model not staged/
    );
  });

  it('rejects with the staging error when the config path is missing (non-2xx)', async () => {
    const fetcher = fetcherFor({ ok: false, status: 404, contentType: null });
    await expect(assertEmbeddingModelStaged(fetcher)).rejects.toThrow(
      /embedding model not staged/
    );
  });
});
