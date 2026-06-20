/**
 * Cross-browser compatibility detection for web-llm v0.2.83
 * FR-015: Graceful degradation support
 *
 * Detects browser capabilities and provides user guidance for:
 * - Chrome/Edge 113+: Full WebGPU support
 * - Firefox: Experimental WebGPU (degraded)
 * - Safari: Partial WebGPU support (degraded)
 */

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

export type CompatLevel = 'full' | 'degraded' | 'unsupported';

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

  if (uaLower.includes('firefox/') || uaLower.includes('fxios/')) {
    const firefoxMatch = uaLower.match(/(?:firefox|fxios)\/(\d+)/);
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

  // Firefox = degraded (experimental WebGPU)
  if (name === 'firefox') {
    return {
      level: 'degraded',
      message: `Firefox${version ? ` ${version}` : ''} detected. WebGPU support is experimental and may be incomplete.`,
      recommendations: [
        'For best results, use Chrome 113+ or Edge 113+',
        'Firefox WebGPU can be enabled via about:config (webgpu.enabled)',
        'Expect potential issues with WASM threading (SharedArrayBuffer)',
        'Consider API server mode as an alternative',
      ],
    };
  }

  // Safari = degraded (partial WebGPU)
  if (name === 'safari') {
    return {
      level: 'degraded',
      message: `Safari${version ? ` ${version}` : ''} detected. WebGPU support is partial and performance may be limited.`,
      recommendations: [
        'For full WebGPU support, use Chrome 113+ or Edge 113+',
        'Safari WebGPU implementation may have limited adapter availability',
        'Consider using API server mode for reliable inference',
        'Alternatively, use Chrome on iOS for better compatibility',
      ],
    };
  }

  // Unknown browser = unsupported
  return {
    level: 'unsupported',
    message: 'Unable to detect browser. web-llm requires a Chromium-based browser for full support.',
    recommendations: [
      'Use Chrome 113+ or Edge 113+ for full WebGPU support',
      'Download Chrome: https://www.google.com/chrome/',
      'Download Edge: https://www.microsoft.com/edge/',
    ],
  };
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
  } else if (name === 'firefox' || name === 'safari') {
    // These are degraded, not unsupported
    isSupported = features.webgpu !== 'none' || features.wasm;
  }

  // But if webgpu is available (even partial) and wasm works, allow degraded mode
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
