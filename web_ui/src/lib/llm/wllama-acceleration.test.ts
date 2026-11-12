/**
 * #265 (AC4, frozen check C3): the wllama acceleration state is DERIVED from
 * the environment (cpu | webgpu-eligible) with the installed wllama's own
 * WebGPU semantics — navigator.gpu presence, with Firefox-without-JSPI
 * excluded — and getInferenceMode() maps it to a valid LLMInferenceMode
 * ('webgpu' only when eligible, else 'wasm'), never hard-coded.
 *
 * jsdom ships no navigator.gpu: the no-WebGPU case is the environment's
 * DEFAULT state, exactly like production browsers without WebGPU.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  getWllamaAccelerationState,
  isFirefoxUserAgent,
  isWllamaWebGPUAccelerated,
} from './wllama-acceleration';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';

interface FirefoxOverrides {
  gpu?: boolean;
  userAgent?: string;
  jspi?: boolean;
}

function setEnvironment(opts: FirefoxOverrides): void {
  const nav = navigator as unknown as { gpu?: unknown };
  if (opts.gpu === false) {
    delete nav.gpu;
  } else {
    nav.gpu = {}; // presence is what wllama's own isSupportWebGPU checks
  }
  Object.defineProperty(navigator, 'userAgent', {
    value: opts.userAgent ?? CHROME_UA,
    configurable: true,
  });
  // WebAssembly.Suspending marks JSPI (wllama's isSupportJSPI).
  if (opts.jspi) {
    Object.defineProperty(WebAssembly, 'Suspending', {
      value: class Suspending<F extends (...args: never[]) => unknown> {
        constructor(fn: F) {
          void fn;
        }
      },
      configurable: true,
    });
  } else {
    Object.defineProperty(WebAssembly, 'Suspending', { value: undefined, configurable: true });
  }
}

describe('wllama-acceleration (#265 AC4)', () => {
  const originalUA = navigator.userAgent;
  beforeEach(() => {
    delete (navigator as unknown as { gpu?: unknown }).gpu;
  });
  afterEach(() => {
    delete (navigator as unknown as { gpu?: unknown }).gpu;
    Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
    Object.defineProperty(WebAssembly, 'Suspending', { value: undefined, configurable: true });
  });

  it('derives "cpu" with no WebGPU interface (the jsdom/production default)', () => {
    setEnvironment({ gpu: false, userAgent: CHROME_UA });
    expect(isWllamaWebGPUAccelerated()).toBe(false);
    expect(getWllamaAccelerationState()).toBe('cpu');
  });

  it('derives "webgpu-eligible" when navigator.gpu is present (wllama presence semantics)', () => {
    setEnvironment({ gpu: true, userAgent: CHROME_UA });
    expect(isWllamaWebGPUAccelerated()).toBe(true);
    expect(getWllamaAccelerationState()).toBe('webgpu-eligible');
  });

  it('derives "cpu" on Firefox WITHOUT JSPI even with navigator.gpu present', () => {
    setEnvironment({ gpu: true, userAgent: FIREFOX_UA, jspi: false });
    expect(isFirefoxUserAgent(navigator.userAgent)).toBe(true);
    expect(isWllamaWebGPUAccelerated()).toBe(false);
    expect(getWllamaAccelerationState()).toBe('cpu');
  });

  it('derives "webgpu-eligible" on Firefox WITH JSPI and navigator.gpu present', () => {
    setEnvironment({ gpu: true, userAgent: FIREFOX_UA, jspi: true });
    expect(isWllamaWebGPUAccelerated()).toBe(true);
    expect(getWllamaAccelerationState()).toBe('webgpu-eligible');
  });

  it('matches wllama 3.5.1\'s own Firefox detection', () => {
    expect(isFirefoxUserAgent(FIREFOX_UA)).toBe(true);
    expect(isFirefoxUserAgent(CHROME_UA)).toBe(false);
  });

  describe('WllamaService integration', () => {
    it('getInferenceMode() is derived, never hard-coded: wasm without WebGPU, webgpu when eligible', async () => {
      const { WllamaService } = await import('./wllama-service');
      const svc = WllamaService.getInstance();
      setEnvironment({ gpu: false, userAgent: CHROME_UA });
      expect(svc.getInferenceMode()).toBe('wasm');
      expect(svc.getAccelerationState()).toBe('cpu');
      setEnvironment({ gpu: true, userAgent: CHROME_UA });
      expect(svc.getInferenceMode()).toBe('webgpu');
      expect(svc.getAccelerationState()).toBe('webgpu-eligible');
    });

    it('Firefox without JSPI stays on the wasm mode even with navigator.gpu present', async () => {
      const { WllamaService } = await import('./wllama-service');
      const svc = WllamaService.getInstance();
      setEnvironment({ gpu: true, userAgent: FIREFOX_UA, jspi: false });
      expect(svc.getInferenceMode()).toBe('wasm');
      expect(svc.getAccelerationState()).toBe('cpu');
    });
  });
});
