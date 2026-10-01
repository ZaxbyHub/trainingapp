/**
 * Key-origin normalization (universal-provider-settings-overhaul, review
 * round 1 F2). A saved API key is bound to the ORIGIN (scheme://host:port)
 * it was saved for and is sent only there. This is the twin of the desktop
 * `originOf` (desktop/main/backend/inference/external-generator.ts):
 * WHATWG URL origin of the trimmed base URL, so
 *   - scheme and host are lowercased (http://LOCALHOST:1234 == http://localhost:1234);
 *   - a default port is dropped (https://h:443 == https://h, http://h:80 == http://h);
 *   - path, query, `/v1` suffixes and trailing slashes do not matter;
 *   - different schemes, hosts or ports are different origins (127.0.0.1
 *     and localhost are NOT the same origin).
 * Returns '' when the input has no http(s) origin.
 *
 * Leaf module (imports nothing) so the storage layer, the #138 migration
 * and the Settings panel share one normalizer.
 */
export function keyOriginOf(raw: string): string {
  try {
    const url = new URL(String(raw ?? '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}
