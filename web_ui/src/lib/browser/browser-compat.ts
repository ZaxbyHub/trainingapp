/**
 * Cross-browser compatibility detection for web-llm v0.2.83
 * FR-015: Graceful degradation support
 *
 * Supported browsers (PR #151 review PRR-151-030, user decision; README "Browser support"):
 * - Chrome/Edge 113+: supported, full WebGPU support
 * - Firefox: supported (CI-verified); WebGPU availability depends on the build and is
 *   reported by checkFeatures(), not assumed
 * - Safari and every other WebKit-engine browser: NOT supported. That includes every
 *   browser on iOS/iPadOS (Firefox FxiOS, Chrome CriOS and Edge EdgiOS there are WebKit),
 *   so they classify by engine as 'safari', not by brand.
 */

/** 'safari' means the WebKit engine: Safari itself and every iOS/iPadOS browser. */
export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari' | 'unknown';

export type WebGpuSupport = 'full' | 'partial' | 'none';

export interface FeatureSupport {
  webgpu: WebGpuSupport;
  opfs: boolean;
  indexedDB: boolean;
  sharedArrayBuffer: boolean;
  wasm: boolean;
  workers: boolean;
}

export interface BrowserInfo {
  name: BrowserName;
  version: number | null;
  isSupported: boolean;
  features: FeatureSupport;
}

export type CompatLevel = 'full' | 'unsupported';

export interface CompatGuidance {
  level: CompatLevel;
  message: string;
  recommendations: string[];
}

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
 * Detect browser from navigator.userAgent
 */
export function detectBrowser(): { name: BrowserName; version: number | null } {
  if (typeof navigator === 'undefined' || !navigator.userAgent) {
    return { name: 'unknown', version: null };
  }
  return parseUserAgent(navigator.userAgent);
}

/**
 * Check WebGPU support level
 */
async function checkWebGpuSupport(): Promise<WebGpuSupport> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return 'none';
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      return 'full';
    }
    return 'partial';
  } catch {
    return 'partial';
  }
}

/**
 * Check all browser features
 */
export async function checkFeatures(): Promise<FeatureSupport> {
  const webgpu = await checkWebGpuSupport();

  const opfs = typeof navigator !== 'undefined' &&
    navigator.storage !== undefined &&
    typeof navigator.storage.getDirectory === 'function';

  const hasIndexedDB = typeof indexedDB !== 'undefined';

  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';

  const wasm = typeof WebAssembly !== 'undefined';

  const workers = typeof Worker !== 'undefined';

  return {
    webgpu,
    opfs,
    indexedDB: hasIndexedDB,
    sharedArrayBuffer,
    wasm,
    workers,
  };
}

/**
 * Check if browser version meets minimum requirement
 */
function meetsMinimumVersion(version: number | null, minimum: number): boolean {
  return version !== null && version >= minimum;
}

/**
 * Generate compatibility guidance based on browser info
 */
export function getCompatMessage(info: BrowserInfo): CompatGuidance {
  const { name, version } = info;

  // Chrome/Edge 113+ = full support
  if ((name === 'chrome' || name === 'edge') && meetsMinimumVersion(version, 113)) {
    return {
      level: 'full',
      message: `${name === 'edge' ? 'Microsoft Edge' : 'Chrome'} ${version} detected with full WebGPU support. All features available.`,
      recommendations: [],
    };
  }

  // Chrome/Edge < 113 = unsupported, needs upgrade
  if (name === 'chrome' || name === 'edge') {
    return {
      level: 'unsupported',
      message: `${name === 'edge' ? 'Edge' : 'Chrome'} ${version ?? 'unknown version'} detected. web-llm requires Chrome or Edge 113+ for WebGPU support.`,
      recommendations: [
        'Update your browser to the latest version',
        'Chrome 113+ or Edge 113+ is required for full WebGPU support',
        'Download latest Chrome: https://www.google.com/chrome/',
        'Download latest Edge: https://www.microsoft.com/edge/',
      ],
    };
  }

  // Firefox = supported. WebGPU is reported from feature detection, not assumed.
  if (name === 'firefox') {
    const webgpu = info.features.webgpu === 'full';
    return {
      level: 'full',
      message: `Firefox${version ? ` ${version}` : ''} detected. Firefox is supported${webgpu ? ', with WebGPU available.' : '.'}`,
      recommendations: webgpu
        ? []
        : ['WebGPU is not available in this Firefox: use the desktop app or an external model server (Settings → Model & connection) for in-app answers'],
    };
  }

  // Safari / WebKit (every iOS/iPadOS browser included) = unsupported, the same
  // level and shape as every other unsupported browser.
  if (name === 'safari') {
    return {
      level: 'unsupported',
      message: `Safari${version ? ` ${version}` : ''} (WebKit) detected. Safari and other WebKit-based browsers, including every browser on iPhone and iPad, are not supported.`,
      recommendations: [
        'Use Chrome 113+, Edge 113+ or Firefox on a desktop computer',
        'Or use the desktop app',
      ],
    };
  }

  // Unknown browser = unsupported
  return {
    level: 'unsupported',
    message: 'Unable to detect browser. Supported browsers are Chrome 113+, Edge 113+ and Firefox.',
    recommendations: [
      'Use Chrome 113+ or Edge 113+ for full WebGPU support, or Firefox',
      'Download Chrome: https://www.google.com/chrome/',
      'Download Edge: https://www.microsoft.com/edge/',
    ],
  };
}

/**
 * Whether this browser's NAME and VERSION make it unsupported (Chrome/Edge below 113,
 * and Safari or any other WebKit engine). An unrecognised engine is NOT reported here:
 * we cannot tell that it is unsupported, so the App shows no upfront notice for it
 * (detectBrowserInfo still lets it through when WebAssembly works). Synchronous and
 * feature-free so the App can ask once at mount.
 */
export function isKnownUnsupportedBrowser(): boolean {
  const { name, version } = detectBrowser();
  if (name === 'unknown') return false;
  if (name === 'chrome' || name === 'edge') return !meetsMinimumVersion(version, 113);
  return name !== 'firefox';
}

/**
 * Combined browser detection and feature check
 * Returns complete BrowserInfo with all capabilities
 */
export async function detectBrowserInfo(): Promise<BrowserInfo> {
  const { name, version } = detectBrowser();
  const features = await checkFeatures();

  // Determine base support level from browser name/version
  let isSupported = false;
  if (name === 'chrome' || name === 'edge') {
    isSupported = meetsMinimumVersion(version, 113);
  } else if (name === 'firefox') {
    // Supported (PRR-151-030), independent of WebGPU (see getCompatMessage).
    isSupported = true;
  }
  // 'safari' (WebKit, every iOS/iPadOS browser) stays unsupported whatever its features.

  // An unrecognised engine with working WebAssembly is let through: nothing says it
  // is unsupported (there is no degraded tier; see CompatLevel).
  if (!isSupported && name === 'unknown' && features.wasm) {
    isSupported = true;
  }

  return {
    name,
    version,
    isSupported,
    features,
  };
}
