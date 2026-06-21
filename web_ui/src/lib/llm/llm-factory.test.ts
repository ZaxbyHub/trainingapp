/**
 * Tests for the LLM engine factory + persisted-preference reader.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import {
  getLLMService,
  getPreferredBrowserEngine,
  DEFAULT_BROWSER_ENGINE,
} from './llm-factory';

describe('getLLMService', () => {
  it('defaults to wllama', () => {
    expect(DEFAULT_BROWSER_ENGINE).toBe('wllama');
    expect(getLLMService()).toBe(wllamaInstance);
  });

  it('returns the WebLLM engine when requested', () => {
    expect(getLLMService('webllm')).toBe(webllmInstance);
  });

  it('returns the wllama engine when requested', () => {
    expect(getLLMService('wllama')).toBe(wllamaInstance);
  });
});

describe('getPreferredBrowserEngine', () => {
  beforeEach(() => localStorage.clear());

  it('returns the default when nothing is stored', () => {
    expect(getPreferredBrowserEngine()).toBe('wllama');
  });

  it('reads a valid persisted preference', () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ mode: 'browser-local', serverUrl: '', browserEngine: 'webllm' })
    );
    expect(getPreferredBrowserEngine()).toBe('webllm');
  });

  it('falls back to default on malformed storage', () => {
    localStorage.setItem('inference-mode', 'not json');
    expect(getPreferredBrowserEngine()).toBe('wllama');
  });

  it('ignores an invalid engine value', () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ mode: 'browser-local', serverUrl: '', browserEngine: 'bogus' })
    );
    expect(getPreferredBrowserEngine()).toBe('wllama');
  });
});
