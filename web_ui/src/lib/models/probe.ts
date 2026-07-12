/**
 * Hardened same-origin asset presence probe.
 *
 * Why this exists: Vite dev/preview (and most static hosts configured for an SPA)
 * serve `index.html` with HTTP 200 for ANY unmatched path (SPA fallback). A naive
 * `fetch(url, { method: 'HEAD' }).ok` therefore reports a 200 for a missing model
 * file, so readiness gates falsely claim "Packaged Models: Ready" against a build
 * that ships zero model files.
 *
 * The fix: treat HTTP 200 + `Content-Type: text/html` as "not present," because a
 * real model weight (`.onnx`, `.wasm`, `.gguf`, `.json`) is never served as HTML,
 * while the SPA fallback always is. We deliberately do NOT require a known
 * `Content-Type` on positives: some static hosts omit the header on real files,
 * and the one reliable negative signal is the presence of `text/html`. A future
 * hardening can additionally check magic bytes (GGUF `0x46554747`, ONNX protobuf,
 * wasm `\0asm`) via a range GET, at the cost of a second request per probe.
 */

/**
 * Minimal shape of a fetch response that this module needs. Matches the subset
 * of `Response` we read, so callers can pass a real `Response`, a `vi.fn` mock,
 * or any duck-typed object.
 */
export interface ProbeResponse {
  ok: boolean;
  status?: number;
  /** Header getter; may return null when the host omits the header. */
  contentType?: string | null;
}

/**
 * Fetcher signature for {@link probeAsset}. Resolves to a {@link ProbeResponse}.
 * Defaults to the global `fetch`, reading `Content-Type` and status from the
 * real `Response`.
 */
export type AssetFetcher = (path: string) => Promise<ProbeResponse>;

/**
 * Build a {@link ProbeResponse} from a real `Response`.
 */
function fromResponse(res: Response): ProbeResponse {
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get('content-type'),
  };
}

/** Default fetcher: a HEAD request via the global `fetch`. */
export const defaultAssetFetcher: AssetFetcher = async (path) => {
  const res = await fetch(path, { method: 'HEAD' });
  return fromResponse(res);
};

/**
 * Probe whether a packaged asset exists, same-origin, without downloading it.
 *
 * A file is "present" only when the response is OK AND not an HTML document
 * (the SPA-fallback signature). Network errors and non-2xx responses count as
 * "not present" — for an offline static archive a missing file reliably 404s,
 * and an HTML 200 reliably indicates the SPA fallback served `index.html`.
 *
 * @param path     Absolute same-origin path to probe.
 * @param fetcher  Optional fetch override (used in tests).
 */
export async function probeAsset(
  path: string,
  fetcher: AssetFetcher = defaultAssetFetcher
): Promise<boolean> {
  try {
    const res = await fetcher(path);
    if (!res.ok) return false;
    // A real model/wasm/json file is never text/html. An HTML 200 is the SPA
    // fallback serving index.html for an unmatched (missing) route.
    if (res.contentType !== undefined && res.contentType !== null) {
      const ct = res.contentType.toLowerCase();
      if (ct.includes('text/html') || ct.includes('application/xhtml')) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
