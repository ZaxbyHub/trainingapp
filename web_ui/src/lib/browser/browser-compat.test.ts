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
  BrowserInfo,
  FeatureSupport,
} from './browser-compat';

// Mock global navigator
const originalNavigator = globalThis.navigator;

function createMockNavigator(overrides: Record<string, unknown> = {}) {
  return {
    userAgent: '',
    gpu: undefined,
    storage: undefined,
    ...overrides,
  };
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

  test('Firefox iOS - returns firefox with fxios version', () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121 Mobile/15E148 Safari/604.1',
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
    globalThis.WebAssembly = { validate: () => true } as WebAssembly;

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
    } as unknown as Navigator);

    const result = await checkFeatures();
    expect(result.webgpu).toBe('full');
  });

  test('webgpu returns partial when adapter is null', async () => {
    globalThis.navigator = createMockNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
    } as unknown as Navigator);

    const result = await checkFeatures();
    expect(result.webgpu).toBe('partial');
  });

  test('webgpu returns partial when requestAdapter throws', async () => {
    globalThis.navigator = createMockNavigator({
      gpu: {
        requestAdapter: vi.fn().mockRejectedValue(new Error('GPU error')),
      },
    } as unknown as Navigator);

    const result = await checkFeatures();
    expect(result.webgpu).toBe('partial');
  });

  test('opfs is true when navigator.storage.getDirectory is available', async () => {
    globalThis.navigator = createMockNavigator({
      storage: {
        getDirectory: vi.fn(),
      },
    } as unknown as Navigator);

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
    globalThis.WebAssembly = { validate: () => true } as WebAssembly;

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

  test('Firefox 121 → degraded', () => {
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

    expect(result.level).toBe('degraded');
    expect(result.message).toContain('Firefox 121');
    expect(result.message).toContain('experimental');
    expect(result.recommendations).toContain('For best results, use Chrome 113+ or Edge 113+');
  });

  test('Firefox null version → degraded', () => {
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

    expect(result.level).toBe('degraded');
    expect(result.message).toContain('Firefox');
  });

  test('Safari 17 → degraded', () => {
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

    expect(result.level).toBe('degraded');
    expect(result.message).toContain('Safari 17');
    expect(result.message).toContain('partial');
    expect(result.recommendations).toContain('Consider using API server mode for reliable inference');
  });

  test('Safari null version → degraded', () => {
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

    expect(result.level).toBe('degraded');
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
    expect(result.recommendations).toContain('Use Chrome 113+ or Edge 113+ for full WebGPU support');
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
    } as unknown as Navigator);

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
    } as unknown as Navigator);

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
    } as unknown as Navigator);

    const result = await detectBrowserInfo();

    expect(result.name).toBe('edge');
    expect(result.version).toBe(120);
    expect(result.isSupported).toBe(true);
  });

  test('Firefox with wasm → isSupported true (degraded mode)', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      gpu: undefined,
      storage: undefined,
    } as unknown as Navigator);

    const result = await detectBrowserInfo();

    expect(result.name).toBe('firefox');
    expect(result.version).toBe(121);
    expect(result.isSupported).toBe(true);
    expect(result.features.webgpu).toBe('none');
    expect(result.features.wasm).toBe(true);
  });

  test('Safari with partial webgpu → isSupported true', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
      storage: undefined,
    } as unknown as Navigator);

    const result = await detectBrowserInfo();

    expect(result.name).toBe('safari');
    expect(result.isSupported).toBe(true);
    expect(result.features.webgpu).toBe('partial');
  });

  test('unknown browser with wasm → isSupported true (fallback)', async () => {
    globalThis.navigator = createMockNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 SomeBrowser/1.0',
      gpu: undefined,
      storage: undefined,
    } as unknown as Navigator);

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
    } as unknown as Navigator);

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
