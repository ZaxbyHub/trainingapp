/**
 * Browser compatibility detection tests
 * Tests for web_ui/src/lib/browser/browser-compat.ts
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectBrowser,
  checkFeatures,
  getCompatMessage,
  detectBrowserInfo,
  isKnownUnsupportedBrowser,
  BrowserInfo,
  FeatureSupport,
} from './browser-compat';

// Mock global navigator
const originalNavigator = globalThis.navigator;

function createMockNavigator(overrides: Record<string, unknown> = {}): Navigator {
  return {
    userAgent: '',
    gpu: undefined,
    storage: undefined,
    ...overrides,
  } as unknown as Navigator;
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.navigator = originalNavigator;
});

afterEach(() => {
  globalThis.navigator = originalNavigator;
});

// =============================================================================
// detectBrowser tests
// =============================================================================

describe('detectBrowser', () => {
  test('Chrome 120 - returns chrome with version 120', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const result = detectBrowser();
    expect(result.name).toBe('chrome');
    expect(result.version).toBe(120);
  });

  test('Edge 120 - returns edge with version 120 (Edge checked before Chrome)', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    });

    const result = detectBrowser();
    expect(result.name).toBe('edge');
    expect(result.version).toBe(120);
  });

  test('Edge Android - returns edge with version from edgA/ pattern', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0',
    });

    const result = detectBrowser();
    expect(result.name).toBe('edge');
    expect(result.version).toBe(120);
  });

  test('Firefox 121 - returns firefox with version 121', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    });

    const result = detectBrowser();
    expect(result.name).toBe('firefox');
    expect(result.version).toBe(121);
  });

  // PRR-151-030: every iOS/iPadOS browser is WebKit, so it classifies by engine
  // ('safari' = WebKit), never by brand.
  test('Firefox iOS (FxiOS) - WebKit, returns safari', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121 Mobile/15E148 Safari/604.1',
    });

    const result = detectBrowser();
    expect(result.name).toBe('safari');
    expect(result.version).toBeNull();
  });

  test('Chrome iOS (CriOS) - WebKit, returns safari', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
    });

    expect(detectBrowser().name).toBe('safari');
  });

  test('Edge iOS (EdgiOS) - WebKit, returns safari', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/120.0.2210.150 Mobile/15E148 Safari/605.1.15',
    });

    const result = detectBrowser();
    expect(result.name).toBe('safari');
    expect(result.version).toBe(17);
  });

  test('iPad Safari - returns safari', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    });

    expect(detectBrowser().name).toBe('safari');
  });

  test('Firefox on Android stays firefox (Gecko, not WebKit)', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
    });

    const result = detectBrowser();
    expect(result.name).toBe('firefox');
    expect(result.version).toBe(121);
  });

  test('Safari 17 - returns safari with version 17', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    });

    const result = detectBrowser();
    expect(result.name).toBe('safari');
    expect(result.version).toBe(17);
  });

  test('Unknown browser - returns unknown with null version', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 SomeBrowser/1.0',
    });

    const result = detectBrowser();
    expect(result.name).toBe('unknown');
    expect(result.version).toBe(null);
  });

  test('Empty userAgent - returns unknown', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: '',
    });

    const result = detectBrowser();
    expect(result.name).toBe('unknown');
    expect(result.version).toBe(null);
  });

  test('Chrome 112 - version extraction returns 112', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
    });

    const result = detectBrowser();
    expect(result.name).toBe('chrome');
    expect(result.version).toBe(112);
  });

  test('Edge 113 - edge version extraction returns 113', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.0.0',
    });

    const result = detectBrowser();
    expect(result.name).toBe('edge');
    expect(result.version).toBe(113);
  });

  test('navigator undefined - returns unknown', () => {
    globalThis.navigator = undefined as unknown as Navigator;

    const result = detectBrowser();
    expect(result.name).toBe('unknown');
    expect(result.version).toBe(null);
  });

  test('navigator.userAgent undefined - returns unknown', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: undefined as unknown as string,
    });

    const result = detectBrowser();
    expect(result.name).toBe('unknown');
    expect(result.version).toBe(null);
  });
});

// =============================================================================
// checkFeatures tests
// =============================================================================

describe('checkFeatures', () => {
  test('returns all feature flags as object with indexedDB property', async () => {
    // Mock WebAssembly
    const originalWebAssembly = globalThis.WebAssembly;
    globalThis.WebAssembly = { validate: () => true } as unknown as typeof WebAssembly;

    const result = await checkFeatures();

    expect(result).toHaveProperty('webgpu');
    expect(result).toHaveProperty('opfs');
    expect(result).toHaveProperty('indexedDB');
    expect(result).toHaveProperty('sharedArrayBuffer');
    expect(result).toHaveProperty('wasm');
    expect(result).toHaveProperty('workers');

    globalThis.WebAssembly = originalWebAssembly;
  });

  test('webgpu is none when navigator.gpu is undefined', async () => {
    const result = await checkFeatures();
    expect(result.webgpu).toBe('none');
  });

  test('webgpu returns full when adapter is available', async () => {
    const mockAdapter = {};
    globalThis.navigator = createMockNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
      },
    });

    const result = await checkFeatures();
    expect(result.webgpu).toBe('full');
  });

  test('webgpu returns partial when adapter is null', async () => {
    globalThis.navigator = createMockNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await checkFeatures();
    expect(result.webgpu).toBe('partial');
  });

  test('webgpu returns partial when requestAdapter throws', async () => {
    globalThis.navigator = createMockNavigator({
      gpu: {
        requestAdapter: vi.fn().mockRejectedValue(new Error('GPU error')),
      },
    });

    const result = await checkFeatures();
    expect(result.webgpu).toBe('partial');
  });

  test('opfs is true when navigator.storage.getDirectory is available', async () => {
    globalThis.navigator = createMockNavigator({
      storage: {
        getDirectory: vi.fn(),
      },
    });

    const result = await checkFeatures();
    expect(result.opfs).toBe(true);
  });

  test('opfs is false when navigator.storage is undefined', async () => {
    globalThis.navigator = createMockNavigator({
      storage: undefined,
    });

    const result = await checkFeatures();
    expect(result.opfs).toBe(false);
  });

  test('indexedDB is true when global indexedDB exists', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = {} as IDBFactory;

    const result = await checkFeatures();

    expect(result.indexedDB).toBe(true);
    globalThis.indexedDB = originalIndexedDB;
  });

  test('indexedDB is false when global indexedDB does not exist', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = undefined as unknown as IDBFactory;

    const result = await checkFeatures();

    expect(result.indexedDB).toBe(false);
    globalThis.indexedDB = originalIndexedDB;
  });

  test('sharedArrayBuffer is true when global SharedArrayBuffer exists', async () => {
    const originalSAB = globalThis.SharedArrayBuffer;
    globalThis.SharedArrayBuffer = SharedArrayBuffer as unknown as typeof SharedArrayBuffer;

    const result = await checkFeatures();

    expect(result.sharedArrayBuffer).toBe(true);
    globalThis.SharedArrayBuffer = originalSAB;
  });

  test('sharedArrayBuffer is false when global SharedArrayBuffer does not exist', async () => {
    const originalSAB = globalThis.SharedArrayBuffer;
    globalThis.SharedArrayBuffer = undefined as unknown as typeof SharedArrayBuffer;

    const result = await checkFeatures();

    expect(result.sharedArrayBuffer).toBe(false);
    globalThis.SharedArrayBuffer = originalSAB;
  });

  test('wasm is true when global WebAssembly exists', async () => {
    const originalWebAssembly = globalThis.WebAssembly;
    globalThis.WebAssembly = { validate: () => true } as unknown as typeof WebAssembly;

    const result = await checkFeatures();

    expect(result.wasm).toBe(true);
    globalThis.WebAssembly = originalWebAssembly;
  });

  test('wasm is false when global WebAssembly does not exist', async () => {
    const originalWebAssembly = globalThis.WebAssembly;
    globalThis.WebAssembly = undefined as unknown as typeof WebAssembly;

    const result = await checkFeatures();

    expect(result.wasm).toBe(false);
    globalThis.WebAssembly = originalWebAssembly;
  });

  test('workers is true when global Worker exists', async () => {
    const originalWorker = globalThis.Worker;
    globalThis.Worker = class Worker {} as unknown as typeof Worker;

    const result = await checkFeatures();

    expect(result.workers).toBe(true);
    globalThis.Worker = originalWorker;
  });

  test('workers is false when global Worker does not exist', async () => {
    const originalWorker = globalThis.Worker;
    globalThis.Worker = undefined as unknown as typeof Worker;

    const result = await checkFeatures();

    expect(result.workers).toBe(false);
    globalThis.Worker = originalWorker;
  });

  test('handles navigator undefined gracefully', async () => {
    const originalNavigator2 = globalThis.navigator;
    globalThis.navigator = undefined as unknown as Navigator;

    const result = await checkFeatures();

    expect(result.webgpu).toBe('none');
    expect(result.opfs).toBe(false);
    globalThis.navigator = originalNavigator2;
  });
});

// =============================================================================
// getCompatMessage tests
// =============================================================================

describe('getCompatMessage', () => {
  test('Chrome 120 → full support', () => {
    const info: BrowserInfo = {
      name: 'chrome',
      version: 120,
      isSupported: true,
      features: {
        webgpu: 'full',
        opfs: true,
        indexedDB: true,
        sharedArrayBuffer: true,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('full');
    expect(result.message).toContain('Chrome 120');
    expect(result.message).toContain('full WebGPU support');
    expect(result.recommendations).toEqual([]);
  });

  test('Edge 120 → full support', () => {
    const info: BrowserInfo = {
      name: 'edge',
      version: 120,
      isSupported: true,
      features: {
        webgpu: 'full',
        opfs: true,
        indexedDB: true,
        sharedArrayBuffer: true,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('full');
    expect(result.message).toContain('Microsoft Edge 120');
    expect(result.recommendations).toEqual([]);
  });

  test('Chrome 112 → unsupported', () => {
    const info: BrowserInfo = {
      name: 'chrome',
      version: 112,
      isSupported: false,
      features: {
        webgpu: 'none',
        opfs: false,
        indexedDB: true,
        sharedArrayBuffer: true,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('unsupported');
    expect(result.message).toContain('Chrome 112');
    expect(result.message).toContain('requires Chrome or Edge 113+');
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations).toContain('Update your browser to the latest version');
  });

  test('Firefox 121 without WebGPU → full (supported), with a WebGPU note', () => {
    const info: BrowserInfo = {
      name: 'firefox',
      version: 121,
      isSupported: true,
      features: {
        webgpu: 'partial',
        opfs: false,
        indexedDB: true,
        sharedArrayBuffer: true,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('full');
    expect(result.message).toContain('Firefox 121');
    expect(result.message).toContain('supported');
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toContain('WebGPU is not available');
  });

  test('Firefox with full WebGPU → full, no recommendations', () => {
    const info: BrowserInfo = {
      name: 'firefox',
      version: 141,
      isSupported: true,
      features: { webgpu: 'full', opfs: true, indexedDB: true, sharedArrayBuffer: true, wasm: true, workers: true },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('full');
    expect(result.message).toContain('WebGPU available');
    expect(result.recommendations).toEqual([]);
  });

  test('Firefox null version → full (supported)', () => {
    const info: BrowserInfo = {
      name: 'firefox',
      version: null,
      isSupported: true,
      features: {
        webgpu: 'partial',
        opfs: false,
        indexedDB: true,
        sharedArrayBuffer: true,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('full');
    expect(result.message).toContain('Firefox');
  });

  test('Safari 17 → unsupported (PRR-151-030)', () => {
    const info: BrowserInfo = {
      name: 'safari',
      version: 17,
      isSupported: true,
      features: {
        webgpu: 'partial',
        opfs: false,
        indexedDB: true,
        sharedArrayBuffer: false,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('unsupported');
    expect(result.message).toContain('Safari 17');
    expect(result.message).toContain('not supported');
    expect(result.recommendations).toContain('Use Chrome 113+, Edge 113+ or Firefox on a desktop computer');
    // No advice to switch to another iOS browser: they are all WebKit.
    expect(result.recommendations.join(' ')).not.toMatch(/iOS/);
  });

  test('Safari takes the same level as every other unsupported browser, whatever its WebGPU', () => {
    const features = { webgpu: 'full', opfs: true, indexedDB: true, sharedArrayBuffer: true, wasm: true, workers: true } as const;
    const safari = getCompatMessage({ name: 'safari', version: 26, isSupported: false, features });
    const unknown = getCompatMessage({ name: 'unknown', version: null, isSupported: false, features });
    const oldChrome = getCompatMessage({ name: 'chrome', version: 100, isSupported: false, features });
    expect(safari.level).toBe('unsupported');
    expect(safari.level).toBe(unknown.level);
    expect(safari.level).toBe(oldChrome.level);
  });

  test('Safari null version → unsupported', () => {
    const info: BrowserInfo = {
      name: 'safari',
      version: null,
      isSupported: true,
      features: {
        webgpu: 'partial',
        opfs: false,
        indexedDB: true,
        sharedArrayBuffer: false,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('unsupported');
    expect(result.message).toContain('Safari');
  });

  test('Unknown browser → unsupported', () => {
    const info: BrowserInfo = {
      name: 'unknown',
      version: null,
      isSupported: false,
      features: {
        webgpu: 'none',
        opfs: false,
        indexedDB: true,
        sharedArrayBuffer: true,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('unsupported');
    expect(result.message).toContain('Unable to detect browser');
    expect(result.message).toContain('Firefox');
    expect(result.recommendations).toContain('Use Chrome 113+ or Edge 113+ for full WebGPU support, or Firefox');
  });

  test('Edge 113 exactly → full (boundary test)', () => {
    const info: BrowserInfo = {
      name: 'edge',
      version: 113,
      isSupported: true,
      features: {
        webgpu: 'full',
        opfs: true,
        indexedDB: true,
        sharedArrayBuffer: true,
        wasm: true,
        workers: true,
      },
    };

    const result = getCompatMessage(info);

    expect(result.level).toBe('full');
  });
});

// =============================================================================
// detectBrowserInfo tests
// =============================================================================

describe('detectBrowserInfo', () => {
  test('Chrome 120 with full features → isSupported true', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({}),
      },
      storage: {
        getDirectory: vi.fn(),
      },
    });

    const result = await detectBrowserInfo();

    expect(result.name).toBe('chrome');
    expect(result.version).toBe(120);
    expect(result.isSupported).toBe(true);
    expect(result.features.webgpu).toBe('full');
  });

  test('Chrome 112 → isSupported false (version too low)', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
      gpu: undefined,
      storage: undefined,
    });

    const result = await detectBrowserInfo();

    expect(result.name).toBe('chrome');
    expect(result.version).toBe(112);
    expect(result.isSupported).toBe(false);
  });

  test('Edge Android → isSupported true with full features', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({}),
      },
      storage: {
        getDirectory: vi.fn(),
      },
    });

    const result = await detectBrowserInfo();

    expect(result.name).toBe('edge');
    expect(result.version).toBe(120);
    expect(result.isSupported).toBe(true);
  });

  test('Firefox without WebGPU → isSupported true (supported browser)', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      gpu: undefined,
      storage: undefined,
    });

    const result = await detectBrowserInfo();

    expect(result.name).toBe('firefox');
    expect(result.version).toBe(121);
    expect(result.isSupported).toBe(true);
    expect(result.features.webgpu).toBe('none');
    expect(result.features.wasm).toBe(true);
  });

  test('Safari with partial webgpu → isSupported false (WebKit is unsupported)', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
      storage: undefined,
    });

    const result = await detectBrowserInfo();

    expect(result.name).toBe('safari');
    expect(result.isSupported).toBe(false);
    expect(result.features.webgpu).toBe('partial');
  });

  test('Firefox on iOS (WebKit) → isSupported false even with full WebGPU', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121 Mobile/15E148 Safari/604.1',
      gpu: { requestAdapter: vi.fn().mockResolvedValue({}) },
      storage: undefined,
    });

    const result = await detectBrowserInfo();

    expect(result.name).toBe('safari');
    expect(result.isSupported).toBe(false);
    expect(result.features.webgpu).toBe('full');
  });

  test('unknown browser with wasm → isSupported true (fallback)', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 SomeBrowser/1.0',
      gpu: undefined,
      storage: undefined,
    });

    const result = await detectBrowserInfo();

    expect(result.name).toBe('unknown');
    expect(result.isSupported).toBe(true);
    expect(result.features.wasm).toBe(true);
  });

  test('returns complete BrowserInfo with all features', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({}),
      },
      storage: {
        getDirectory: vi.fn(),
      },
    });

    const result = await detectBrowserInfo();

    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('version');
    expect(result).toHaveProperty('isSupported');
    expect(result).toHaveProperty('features');
    expect(result.features).toHaveProperty('webgpu');
    expect(result.features).toHaveProperty('opfs');
    expect(result.features).toHaveProperty('indexedDB');
    expect(result.features).toHaveProperty('sharedArrayBuffer');
    expect(result.features).toHaveProperty('wasm');
    expect(result.features).toHaveProperty('workers');
  });
});

describe('isKnownUnsupportedBrowser', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Chrome 120', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', false],
    ['Chrome 112', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36', true],
    ['Edge 120', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', false],
    ['Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', false],
    ['Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15', true],
    ['FxiOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121 Mobile/15E148 Safari/604.1', true],
    ['an unrecognised engine (not claimed unsupported)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 SomeBrowser/1.0', false],
  ];
  test.each(cases)('%s -> %s', (_name, userAgent, expected) => {
    globalThis.navigator = createMockNavigator({ userAgent });
    expect(isKnownUnsupportedBrowser()).toBe(expected);
  });
});
