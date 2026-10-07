/**
 * Cross-browser compatibility detection for web-llm v0.2.83
 * FR-015: Graceful degradation support
 *
 * Supported browsers (PR #151 review PRR-151-030, user decision; README "Browser support"):
 * - Chrome/Edge 113+: supported
 * - Firefox 112+: supported (CI-verified; 112 is the first with native `inert`); WebGPU availability depends on the
 *   build and is not part of this classification
 * - Safari and every other WebKit-engine browser: NOT supported. That includes every
 *   browser on iOS/iPadOS (Firefox FxiOS, Chrome CriOS and Edge EdgiOS there are WebKit),
 *   so they classify by engine as 'safari', not by brand.
 */

/** 'safari' means the WebKit engine: Safari itself and every iOS/iPadOS browser. */
export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari' | 'unknown';

/**
 * Parse user agent to extract browser name and version
 */
function parseUserAgent(ua: string): { name: BrowserName; version: number | null } {
  const uaLower = ua.toLowerCase();

  // Edge must be checked before Chrome since Edge UA contains "Chrome"
  if (uaLower.includes('edg/') || uaLower.includes('edga/')) {
    const edgeMatch = uaLower.match(/(?:edg|edga)\/(\d+)/i);
    return { name: 'edge', version: edgeMatch ? parseInt(edgeMatch[1], 10) : null };
  }

  if (uaLower.includes('chrome/')) {
    const chromeMatch = uaLower.match(/chrome\/(\d+)/);
    return { name: 'chrome', version: chromeMatch ? parseInt(chromeMatch[1], 10) : null };
  }

  // Gecko Firefox only. Firefox on iOS (FxiOS) is WebKit: like Chrome (CriOS) and
  // Edge (EdgiOS) there, it carries no firefox/, chrome/ or edg/ token and falls
  // through to the Safari/WebKit branch below (engine, not brand).
  if (uaLower.includes('firefox/')) {
    const firefoxMatch = uaLower.match(/firefox\/(\d+)/);
    return { name: 'firefox', version: firefoxMatch ? parseInt(firefoxMatch[1], 10) : null };
  }

  if (uaLower.includes('safari/') && !uaLower.includes('chrome')) {
    // Safari version is not easily extracted from UA, use -1 as sentinel
    const safariMatch = uaLower.match(/version\/(\d+)/);
    return { name: 'safari', version: safariMatch ? parseInt(safariMatch[1], 10) : null };
  }

  return { name: 'unknown', version: null };
}

/**
 * Detect browser from navigator.userAgent.
 *
 * Never throws (PR #151 final review LOW-C): the App classifies the browser at mount for the
 * upfront unsupported-browser notice, so a navigator whose userAgent getter throws (a patched or
 * hostile environment) or returns a non-string must not take the whole app down for a cosmetic
 * notice. Such a browser classifies as 'unknown', which shows no notice.
 */
export function detectBrowser(): { name: BrowserName; version: number | null } {
  let ua: unknown;
  try {
    ua = typeof navigator === 'undefined' ? undefined : navigator.userAgent;
  } catch {
    ua = undefined;
  }
  if (typeof ua !== 'string' || ua === '') {
    return { name: 'unknown', version: null };
  }
  return parseUserAgent(ua);
}

/**
 * Check if browser version meets minimum requirement
 */
function meetsMinimumVersion(version: number | null, minimum: number): boolean {
  return version !== null && version >= minimum;
}

/** Firefox below 112 has no native `inert` (user decision). An unparsable version is not held against it. */
const FIREFOX_MIN = 112;
function isOldFirefox(version: number | null): boolean {
  return version !== null && version < FIREFOX_MIN;
}

/**
 * Whether this browser's NAME and VERSION make it unsupported (Chrome/Edge below 113,
 * Firefox below 112, and Safari or any other WebKit engine). An unrecognised engine is NOT reported here:
 * we cannot tell that it is unsupported, so the App shows no upfront notice for it.
 * Synchronous and feature-free so the App can ask once at mount.
 */
export function isKnownUnsupportedBrowser(): boolean {
  const { name, version } = detectBrowser();
  if (name === 'unknown') return false;
  if (name === 'chrome' || name === 'edge') return !meetsMinimumVersion(version, 113);
  if (name === 'firefox') return isOldFirefox(version);
  return true;
}
