/**
 * Browser compatibility detection tests
 * Tests for web_ui/src/lib/browser/browser-compat.ts
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectBrowser,
  isKnownUnsupportedBrowser,
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

describe('isKnownUnsupportedBrowser', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Chrome 120', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', false],
    ['Chrome 112', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36', true],
    ['Edge 120', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', false],
    // The Chrome/Edge minimum is inclusive: 113 itself is supported (WebGPU floor).
    ['Chrome 113 (minimum, inclusive)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36', false],
    ['Edge 113 (minimum, inclusive)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.0.0', false],
    ['Edge 112', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36 Edg/112.0.0.0', true],
    ['Firefox 121', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', false],
    ['Firefox 115', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0', false],
    ['Firefox 112', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:112.0) Gecko/20100101 Firefox/112.0', false],
    ['Firefox 111', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:111.0) Gecko/20100101 Firefox/111.0', true],
    ['Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15', true],
    ['FxiOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121 Mobile/15E148 Safari/604.1', true],
    ['an unrecognised engine (not claimed unsupported)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 SomeBrowser/1.0', false],
  ];
  test.each(cases)('%s -> %s', (_name, userAgent, expected) => {
    globalThis.navigator = createMockNavigator({ userAgent });
    expect(isKnownUnsupportedBrowser()).toBe(expected);
  });
});

// PR #151 final review LOW-C: a throwing userAgent getter (patched or hostile navigator) must not
// crash the classifier; it reads as an unknown browser (no upfront notice).
describe('a userAgent read that throws or is not a string', () => {
  function throwingNavigator(): Navigator {
    const nav = createMockNavigator();
    Object.defineProperty(nav, 'userAgent', {
      get() {
        throw new Error('userAgent getter blew up');
      },
    });
    return nav;
  }

  test('detectBrowser classifies it as unknown instead of throwing', () => {
    globalThis.navigator = throwingNavigator();
    expect(() => detectBrowser()).not.toThrow();
    expect(detectBrowser()).toEqual({ name: 'unknown', version: null });
  });

  test('isKnownUnsupportedBrowser reports false (no notice) instead of throwing', () => {
    globalThis.navigator = throwingNavigator();
    expect(isKnownUnsupportedBrowser()).toBe(false);
  });

  test('a non-string userAgent classifies as unknown', () => {
    globalThis.navigator = createMockNavigator({ userAgent: { toLowerCase: 1 } });
    expect(detectBrowser()).toEqual({ name: 'unknown', version: null });
    expect(isKnownUnsupportedBrowser()).toBe(false);
  });
});
