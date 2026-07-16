/**
 * Tests for the centralized offline Transformers.js configuration.
 *
 * The critical guarantee: no matter which order Transformers.js consumers are
 * constructed, the shared global `env` always ends up forbidding remote
 * downloads. This is a regression guard for the bug where RerankerService's
 * constructor clobbered the shared env back to `allowRemoteModels` enabled.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// A single shared mock `env`, mirroring the real shared module-global.
vi.mock('@huggingface/transformers', () => {
  const pipelineInstance = Object.assign(vi.fn(), { dispose: vi.fn() });
  return {
    pipeline: vi.fn(() => Promise.resolve(pipelineInstance)),
    env: {
      allowLocalModels: false,
      allowRemoteModels: true,
      localModelPath: '',
      useBrowserCache: true,
      allowBrowserBlobStorage: true,
      backends: { onnx: { wasm: { wasmPaths: '', numThreads: 1 } } },
    },
  };
});

describe('configureOfflineEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('forbids remote downloads and points at local /models', async () => {
    const { configureOfflineEnv } = await import('./offline-env');
    const { env } = await import('@huggingface/transformers');

    configureOfflineEnv();

    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
    expect(env.localModelPath).toBe('/models');
    // Under vitest, import.meta.env.DEV is true (test mode), so wasmPaths
    // points at node_modules for Vite dev compatibility. In production builds
    // (DEV=false), it would be ONNX_RUNTIME_WASM_BASE = '/models/ort/'.
    const expectedWasmPaths = import.meta.env.DEV
      ? '/node_modules/onnxruntime-web/dist/'
      : '/models/ort/';
    expect(env.backends.onnx.wasm?.wasmPaths).toBe(expectedWasmPaths);
  });

  it('stays offline regardless of construction order (embeddings then reranker)', async () => {
    const { env } = await import('@huggingface/transformers');
    // Constructing each service runs its configureEnv() -> configureOfflineEnv().
    const { EmbeddingService } = await import('../embeddings/embedding-service');
    const { RerankerService } = await import('../search/reranker');

    EmbeddingService.getInstance();
    // The dangerous order: reranker last. It must NOT re-enable remote downloads.
    RerankerService.getInstance();

    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);

    // ...and the reverse order is equally safe.
    RerankerService.getInstance().dispose();
    EmbeddingService.getInstance().dispose();
  });

  // PRR-005: numThreads guard — forces numThreads=1 when not cross-origin
  // isolated to prevent the ONNX Runtime proxy-worker silent deadlock.
  it('forces numThreads=1 when not cross-origin isolated', async () => {
    const originalCOI = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;

    vi.resetModules();
    const { configureOfflineEnv } = await import('./offline-env');
    const { env } = await import('@huggingface/transformers');
    configureOfflineEnv();

    expect(env.backends.onnx.wasm?.numThreads).toBe(1);

    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = originalCOI;
  });

  it('allows multi-threading when cross-origin isolated', async () => {
    const originalCOI = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;

    vi.resetModules();
    const { configureOfflineEnv } = await import('./offline-env');
    const { env } = await import('@huggingface/transformers');
    configureOfflineEnv();

    // When isolated, numThreads should be > 1 (capped at 4 by hardwareConcurrency).
    expect(env.backends.onnx.wasm?.numThreads).toBeGreaterThan(1);

    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = originalCOI;
  });
});
