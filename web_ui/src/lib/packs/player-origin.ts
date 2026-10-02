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
//
// Navigation egress (ADR-0012 threat model item 6): CSP on a course document
// does not govern navigation, so course JS could navigate its own frame, or
// the boot frame through its DOM, to any URL and carry data in the address.
// What decides where a frame may navigate is the EMBEDDING page's frame-src.
// When the player origin resolves, the browser app therefore installs ONCE a
// `<meta http-equiv="Content-Security-Policy" content="frame-src <player
// origin>">` in its own document (never in Electron, whose renderer CSP
// already carries frame-src 'self' app:, and never in a framed app). Both
// player frames load a player-origin URL only after that policy is in place
// (getResolvedPlayerOrigin), because a meta CSP can only tighten: the app
// cannot install the loopback alias first and widen it to a configured origin
// later. A host header cannot carry it: policies from several headers
// intersect, and a host cannot know a player origin configured by
// player-origin.json or VITE_TRAININGAPP_PLAYER_ORIGIN.

import { isElectron } from '../desktop-session';

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
/** The app's own host answered that it does not serve the player files. */
let hostUnsupported = false;

/** The boot page every player host serves (TrainingPlayerHost embeds it). */
export const PLAYER_BOOT_PATH = '/training-boot.html';

/**
 * 'policy-failed': the player origin resolved, but the app-shell frame
 * policy could not be installed, so no player frame may load (ADR-0012
 * threat model item 6) — reported instead of a silently blank course frame
 * (review round 4, F2).
 */
export type PlayerOriginStatus = 'ok' | 'framed' | 'no-origin' | 'host-unsupported' | 'policy-failed';

/**
 * The one request resolvePlayerOrigin makes (the same-origin runtime config
 * read). Spelled out instead of `typeof fetch`: the outbound guardrail counts
 * every non-call reference to `fetch`, a type query included.
 */
export type PlayerOriginFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolve the player origin once (steps 1-3) and cache it. The runtime
 * config fetch is bounded; any failure falls through to the next step.
 */
export function resolvePlayerOrigin(fetchImpl: PlayerOriginFetch = (input, init) => fetch(input, init)): Promise<string | null> {
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
    let origin = fromRuntime ?? resolvePlayerOriginStatic(appOrigin);
    // The loopback-alias player is THIS server under its other name. A host
    // that does not serve the player files (the Python api_server never
    // does: it carries an unauthenticated API, final-critic FC1) answers the
    // boot page with a non-HTML error; course playback is then unavailable
    // on this host instead of timing out. A network error proves nothing and
    // keeps the alias.
    if (origin !== null && fromRuntime === null && origin === loopbackAliasOrigin(appOrigin) && validatePlayerOrigin(buildTimeOrigin(), appOrigin) === null) {
      try {
        const probe = await fetchImpl(PLAYER_BOOT_PATH, {
          method: 'HEAD',
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(PLAYER_ORIGIN_FETCH_TIMEOUT_MS),
        });
        if (!probe.ok || !/text\/html/i.test(probe.headers.get('content-type') ?? '')) {
          hostUnsupported = true;
          origin = null;
        }
      } catch {
        /* unknown: keep the alias */
      }
    }
    resolved = origin;
    // Before anyone can observe the resolved origin: the frame policy must be
    // in place before either player frame loads a player-origin URL.
    if (origin !== null) installPlayerFramePolicy(origin);
    pending = null;
    return resolved;
  })();
  return pending;
}

/**
 * The cached player origin, or (before the start-up resolution finished) the
 * synchronous prediction (build time, loopback alias). For STATUS only (no
 * "unavailable" notice flashes while resolution runs): a frame never loads
 * from it, because the prediction can differ from the resolved origin and
 * the frame policy is not installed yet — frames use getResolvedPlayerOrigin.
 */
export function getPlayerOrigin(): string | null {
  if (isFramedContext()) return null;
  if (resolved !== undefined) return resolved;
  const appOrigin = currentAppOrigin();
  return appOrigin === null ? null : resolvePlayerOriginStatic(appOrigin);
}

/** Marks the app-shell frame policy meta (its value is the player origin). */
export const FRAME_POLICY_MARKER = 'data-trainingapp-frame-policy';
/** The player origin the installed frame policy admits; null until installed. */
let framePolicyOrigin: string | null = null;

/** The app-shell frame policy for a player origin. */
export function playerFramePolicy(playerOrigin: string): string {
  return `frame-src ${playerOrigin}`;
}

/**
 * Install the app-shell `frame-src <player origin>` meta CSP, exactly once
 * (navigation egress, ADR-0012 threat model item 6). Browser app only: never
 * under Electron (its renderer CSP has frame-src 'self' app:, and a second
 * policy would intersect with it and block app://training) and never in a
 * framed app (it plays nothing). Returns true when the policy for THIS
 * origin is in place; a second call for another origin installs nothing and
 * answers false (a meta CSP can only tighten, never be replaced).
 */
export function installPlayerFramePolicy(playerOrigin: string): boolean {
  if (typeof document === 'undefined' || isElectron() || isFramedContext()) return false;
  if (framePolicyOrigin !== null) return framePolicyOrigin === playerOrigin;
  const head = document.head;
  if (head === null) return false;
  const meta = document.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', playerFramePolicy(playerOrigin));
  meta.setAttribute(FRAME_POLICY_MARKER, playerOrigin);
  head.appendChild(meta);
  framePolicyOrigin = playerOrigin;
  return true;
}

/**
 * The player origin the course and boot frames may load: set only once
 * start-up resolution settled AND the frame policy for that exact origin is
 * installed. null before that (the course frame stays about:blank and no
 * boot frame is embedded), in a framed app, and when nothing resolved.
 */
export function getResolvedPlayerOrigin(): string | null {
  if (isFramedContext() || resolved === undefined || resolved === null) return null;
  return framePolicyOrigin === resolved ? resolved : null;
}

/** Resolves once start-up resolution settled: true iff `playerOrigin` is resolved and its frame policy installed. */
export async function playerFramePolicyReady(playerOrigin: string): Promise<boolean> {
  await resolvePlayerOrigin();
  return getResolvedPlayerOrigin() === playerOrigin;
}

/** Why course playback can or cannot run in this app instance. */
export function getPlayerOriginStatus(): PlayerOriginStatus {
  if (isFramedContext()) return 'framed';
  if (hostUnsupported) return 'host-unsupported';
  if (typeof resolved === 'string' && framePolicyOrigin !== resolved) return 'policy-failed';
  return getPlayerOrigin() === null ? 'no-origin' : 'ok';
}

/**
 * Tests only. A string value simulates a settled resolution, so the frame
 * policy for it is installed too unless `installPolicy` is false.
 */
export function resetPlayerOriginForTests(value?: string | null, installPolicy = true): void {
  resolved = value;
  pending = null;
  hostUnsupported = false;
  framePolicyOrigin = null;
  if (typeof document !== 'undefined') {
    document.querySelectorAll(`meta[${FRAME_POLICY_MARKER}]`).forEach((meta) => meta.remove());
  }
  if (typeof value === 'string' && installPolicy) installPlayerFramePolicy(value);
}

/** The course frame URL for a pack in the browser app (version-less; the relay serves the active version). */
export function browserTrainingUrl(playerOrigin: string, packId: string, file = 'story.html'): string {
  return `${playerOrigin}/training/${encodeURIComponent(packId)}/${file}`;
}
