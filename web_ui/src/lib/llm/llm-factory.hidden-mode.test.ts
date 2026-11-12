/**
 * TST-5 (#265 A3-iii, hidden-mode seams): the llm-factory boundary with
 * WEBLLM_VISIBLE = false — the packaged/offline-build behavior. The visible
 * legs live in llm-factory.test.ts (vitest's import.meta.env.DEV is true
 * there, so WEBLLM_VISIBLE is true); this file pins the hidden mode
 * explicitly because the factory + persisted-preference reader are the LAST
 * line of defense keeping a stale 'webllm' preference from the Llama
 * download.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The seam under test: the packaged-build visibility policy.
vi.mock('./engine-visibility', () => ({ WEBLLM_VISIBLE: false }));

// Mock both engines so we can assert which singleton the factory returns
// without constructing real WebGPU/WASM machinery.
const webllmInstance = { __engine: 'webllm' };
const wllamaInstance = { __engine: 'wllama' };

vi.mock('./web-llm-service', () => ({
  WebLLMService: { getInstance: vi.fn(() => webllmInstance) },
}));
vi.mock('./wllama-service', () => ({
  WllamaService: { getInstance: vi.fn(() => wllamaInstance) },
}));

import { getLLMService, getPreferredBrowserEngine } from './llm-factory';

describe('llm-factory hidden mode (WEBLLM_VISIBLE = false, #265 A3-iii)', () => {
  beforeEach(() => localStorage.clear());

  it("getLLMService('webllm') is served by the wllama engine — the hidden engine is unreachable", () => {
    expect(getLLMService('webllm')).toBe(wllamaInstance);
    expect(getLLMService('webllm')).not.toBe(webllmInstance);
  });

  it("getPreferredBrowserEngine() normalizes a persisted 'webllm' to 'wllama'", () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ mode: 'browser-local', serverUrl: '', browserEngine: 'webllm' }),
    );
    expect(getPreferredBrowserEngine()).toBe('wllama');
  });
});
