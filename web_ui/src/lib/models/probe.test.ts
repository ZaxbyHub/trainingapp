/**
 * Tests for the hardened asset presence probe (src/lib/models/probe.ts).
 *
 * Regression coverage for issue #20 finding #3: a HEAD/fetch that treats `res.ok`
 * as "file present" is fooled by the Vite SPA fallback, which serves index.html
 * with HTTP 200 for any unmatched path. The probe must reject HTML responses.
 */
import { describe, it, expect } from 'vitest';
import { probeAsset, type AssetFetcher } from './probe';

describe('probeAsset', () => {
  it('reports present for a real model file (200 + non-HTML content type)', async () => {
    const fetcher: AssetFetcher = async () => ({
      ok: true,
      status: 200,
      contentType: 'application/octet-stream',
    });
    expect(await probeAsset('/models/llm/gemma-4-e2b-it/model.gguf', fetcher)).toBe(true);
  });

  it('reports present for a JSON model config (200 + application/json)', async () => {
    const fetcher: AssetFetcher = async () => ({
      ok: true,
      status: 200,
      contentType: 'application/json',
    });
    expect(await probeAsset('/models/embeddings/snowflake-arctic-embed-m-v1.5/config.json', fetcher)).toBe(true);
  });

  it('reports present for a WASM runtime (200 + application/wasm)', async () => {
    const fetcher: AssetFetcher = async () => ({
      ok: true,
      status: 200,
      contentType: 'application/wasm',
    });
    expect(await probeAsset('/models/ort/ort-wasm-simd-threaded.jsep.wasm', fetcher)).toBe(true);
  });

  it('reports NOT present for the SPA fallback (200 + text/html) — the core regression', async () => {
    // This is exactly what Vite dev/preview returns for a missing model path.
    const fetcher: AssetFetcher = async () => ({
      ok: true,
      status: 200,
      contentType: 'text/html; charset=utf-8',
    });
    expect(await probeAsset('/models/llm/gemma-4-e2b-it/model.gguf', fetcher)).toBe(false);
  });

  it('reports NOT present for XHTML SPA fallback', async () => {
    const fetcher: AssetFetcher = async () => ({
      ok: true,
      status: 200,
      contentType: 'application/xhtml+xml',
    });
    expect(await probeAsset('/models/missing.onnx', fetcher)).toBe(false);
  });

  it('reports NOT present for a 404', async () => {
    const fetcher: AssetFetcher = async () => ({ ok: false, status: 404, contentType: null });
    expect(await probeAsset('/models/missing.onnx', fetcher)).toBe(false);
  });

  it('reports NOT present when the fetch throws', async () => {
    const fetcher: AssetFetcher = async () => {
      throw new Error('network error');
    };
    expect(await probeAsset('/models/missing.onnx', fetcher)).toBe(false);
  });

  it('reports present when Content-Type header is omitted (some static hosts)', async () => {
    // A real file on a host that doesn't set Content-Type should still be present;
    // the only reliable SPA-fallback signal is the PRESENCE of text/html.
    const fetcher: AssetFetcher = async () => ({ ok: true, status: 200, contentType: null });
    expect(await probeAsset('/models/embeddings/snowflake-arctic-embed-m-v1.5/onnx/model_quantized.onnx', fetcher)).toBe(true);
  });
});
