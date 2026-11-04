/**
 * Embedding-model staging pre-probe (#268, trace collated-275-268 U8).
 *
 * When the staged embedding-model asset at the config path answers HTTP 200
 * with `text/html` (the SPA fallback serving index.html for a missing
 * `/models/embeddings/<dir>/config.json`), embedder initialisation must fail
 * CLOSED with a staging error naming the probed URL — the worker would
 * otherwise load index.html as config and die with an inscrutable error.
 *
 * The automatic pre-probe in `EmbeddingService.initialize()` runs ONLY when
 * `import.meta.env.PROD` is true (packaged Electron renderer, `vite
 * preview`, `vite build --mode desktop` serve). Dev/test environments skip
 * it entirely; the helper stays directly callable with an injected fetcher.
 */

import {
  probeAsset,
  defaultAssetFetcher,
  type AssetFetcher,
} from '../models/probe';
import {
  EMBEDDING_MODELS_BASE,
  EMBEDDING_MODEL_DIR,
} from '../models/model-manifest';

/** The staged config path this probe checks (module-private helper). */
function embeddingConfigProbePath(): string {
  return `${EMBEDDING_MODELS_BASE}/${EMBEDDING_MODEL_DIR}/config.json`;
}

/**
 * Probe the staged embedding-model config asset; throw when it is NOT
 * staged (SPA-fallback HTML 200, missing 404, or network error).
 *
 * @param fetcher Injectable fetch override (tests inject; production uses
 *   the default same-origin fetcher).
 * @throws Error whose message contains `embedding model not staged` and the
 *   probed URL.
 */
/** PR #285 review (PRR-013): the probe must not hang initialize() past this
 * window — a stalled asset request fails through the same bounded path as
 * any other unstaged outcome. */
export const EMBEDDING_STAGING_PROBE_TIMEOUT_MS = 10_000;

export async function assertEmbeddingModelStaged(
  fetcher: AssetFetcher = defaultAssetFetcher
): Promise<void> {
  const url = embeddingConfigProbePath();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), EMBEDDING_STAGING_PROBE_TIMEOUT_MS);
  });
  let staged: boolean;
  try {
    staged = await Promise.race([probeAsset(url, fetcher), bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!staged) {
    throw new Error(
      `embedding model not staged: ${url} is not reachable as a real asset ` +
        `(SPA fallback, 404, or network error) — check the deployment's static model staging.`
    );
  }
}
