// player-origin.ts — where the browser app's untrusted course player runs,
// trace browser-training-parity AC3/AC11 (ADR-0012).
//
// Pack player content (third-party Storyline JS) must never share the APP
// origin: it would reach IndexedDB/localStorage/OPFS (documents, settings,
// the external-model API key). It runs on a DEDICATED player origin instead,
// resolved ONCE at app start, in order:
//   1. runtime config: `player-origin.json` next to index.html
//      ({"playerOrigin": "https://player.example"}), fetched same-origin
//      with a 2 s bound — for prebuilt archives hosted behind a server;
//   2. build time: VITE_TRAININGAPP_PLAYER_ORIGIN;
//   3. the loopback alias of the app's own server: localhost <-> 127.0.0.1
//      (same scheme and port; every local server binds 127.0.0.1 and answers
//      both names).
// A configured value must be a bare origin (no path/query/fragment), must
// differ from the app origin, and must be https unless its host is loopback
// (a non-loopback http origin cannot register a service worker and is mixed
// content under an https app); anything else is ignored. If nothing
// resolves, course playback is disabled with an explanation — there is no
// unsafe same-origin fallback.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True when this app document is NOT the top-level browsing context (it was
 * loaded inside a frame). The app shell is never frameable by design (every
 * host sends frame-ancestors 'none' / X-Frame-Options: DENY), and course
 * playback refuses to start in a framed app: the player origin is derived
 * from THIS document's origin, so an app instance nested inside other
 * content would treat a wrong origin as its player (review round 1, F1).
 * A cross-origin top that throws on access counts as framed.
 */
export function isFramedContext(win: Window | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  if (win === undefined) return false;
  try {
    return win.top !== win.self || win.parent !== win.self;
  } catch {
    return true;
  }
}
export const PLAYER_ORIGIN_CONFIG_PATH = 'player-origin.json';
export const PLAYER_ORIGIN_FETCH_TIMEOUT_MS = 2000;

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** The loopback alias origin of a loopback app origin (localhost <-> 127.0.0.1), else null. */
export function loopbackAliasOrigin(appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  let alias: string;
  if (host === 'localhost') alias = '127.0.0.1';
  else if (host === '127.0.0.1' || host === '[::1]') alias = 'localhost';
  else return null;
  return `${url.protocol}//${alias}${url.port ? `:${url.port}` : ''}`;
}

/**
 * Validate a configured player origin against the app origin. Returns the
 * normalized origin, or null when it must be ignored.
 */
export function validatePlayerOrigin(candidate: unknown, appOrigin: string): string | null {
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // A bare origin only: no credentials, path, query or fragment.
  if (url.username !== '' || url.password !== '') return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') return null;
  if (/[?#]/.test(candidate) || /^[a-z]+:\/\/[^/]+\/./i.test(candidate.trim())) return null;
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null;
  const origin = url.origin;
  let app: string;
  try {
    app = new URL(appOrigin).origin;
  } catch {
    return null;
  }
  if (origin === app) return null;
  return origin;
}

const buildTimeOrigin = (): string | undefined =>
  (import.meta.env as Record<string, string | undefined>).VITE_TRAININGAPP_PLAYER_ORIGIN;

function currentAppOrigin(): string | null {
  return typeof window === 'undefined' ? null : window.location.origin;
}

/** Steps 2 and 3 (synchronous). */
export function resolvePlayerOriginStatic(appOrigin: string, buildTime: string | undefined = buildTimeOrigin()): string | null {
  const fromBuild = validatePlayerOrigin(buildTime, appOrigin);
  if (fromBuild !== null) return fromBuild;
  return loopbackAliasOrigin(appOrigin);
}

let resolved: string | null | undefined;
let pending: Promise<string | null> | null = null;

/**
 * Resolve the player origin once (steps 1-3) and cache it. The runtime
 * config fetch is bounded; any failure falls through to the next step.
 */
export function resolvePlayerOrigin(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<string | null> {
  if (isFramedContext()) return Promise.resolve(null);
  if (resolved !== undefined) return Promise.resolve(resolved);
  if (pending !== null) return pending;
  const appOrigin = currentAppOrigin();
  if (appOrigin === null) return Promise.resolve(null);
  pending = (async () => {
    let fromRuntime: string | null = null;
    try {
      const response = await fetchImpl(PLAYER_ORIGIN_CONFIG_PATH, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(PLAYER_ORIGIN_FETCH_TIMEOUT_MS),
      });
      const type = response.headers.get('content-type') ?? '';
      // A static host's SPA fallback answers 200 text/html for a missing
      // file; only a JSON body counts.
      if (response.ok && !/text\/html/i.test(type)) {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null) {
          fromRuntime = validatePlayerOrigin((body as { playerOrigin?: unknown }).playerOrigin, appOrigin);
        }
      }
    } catch {
      fromRuntime = null;
    }
    resolved = fromRuntime ?? resolvePlayerOriginStatic(appOrigin);
    pending = null;
    return resolved;
  })();
  return pending;
}

/**
 * The cached player origin for synchronous consumers (the Training page sets
 * the course frame src from it on first render). Before the start-up
 * resolution finished, the synchronous steps (build time, loopback alias)
 * answer.
 */
export function getPlayerOrigin(): string | null {
  if (isFramedContext()) return null;
  if (resolved !== undefined) return resolved;
  const appOrigin = currentAppOrigin();
  return appOrigin === null ? null : resolvePlayerOriginStatic(appOrigin);
}

/** Tests only. */
export function resetPlayerOriginForTests(value?: string | null): void {
  resolved = value;
  pending = null;
}

/** The course frame URL for a pack in the browser app (version-less; the relay serves the active version). */
export function browserTrainingUrl(playerOrigin: string, packId: string, file = 'story.html'): string {
  return `${playerOrigin}/training/${encodeURIComponent(packId)}/${file}`;
}
