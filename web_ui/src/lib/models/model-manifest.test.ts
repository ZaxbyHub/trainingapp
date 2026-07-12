/**
 * Tests for the packaged-model manifest + offline readiness gate.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkPackagedModels,
  EMBEDDING_MODELS_BASE,
  ONNX_RUNTIME_WASM_BASE,
  type PackagedModel,
  type HeadFetcher,
} from './model-manifest';

describe('model-manifest paths', () => {
  it('uses same-origin absolute paths under /models (deploy-aware base)', () => {
    // Under jsdom, document.baseURI resolves to the origin root, so the
    // deploy-aware MODELS_BASE computes to '/models' (identical to the old
    // hardcoded value at origin root, correct under subpaths in real deploys).
    expect(EMBEDDING_MODELS_BASE).toBe('/models/embeddings');
    expect(ONNX_RUNTIME_WASM_BASE).toBe('/models/ort/');
  });
});

describe('checkPackagedModels', () => {
  const sampleModels: PackagedModel[] = [
    {
      id: 'm1',
      label: 'Model One',
      kind: 'embedding',
      files: [
        { path: '/models/embeddings/m1/model.onnx', required: true },
        { path: '/models/embeddings/m1/optional.bin', required: false },
      ],
    },
    {
      id: 'm2',
      label: 'Model Two',
      kind: 'runtime',
      files: [{ path: '/models/ort/ort.wasm', required: true }],
    },
  ];

  it('reports allReady when every required file is present', async () => {
    const fetcher: HeadFetcher = vi.fn(async () => ({ ok: true }));
    const report = await checkPackagedModels(fetcher, sampleModels);

    expect(report.allReady).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.models).toHaveLength(2);
    expect(report.models.every((m) => m.ready)).toBe(true);
  });

  it('flags only REQUIRED missing files (optional absence does not fail)', async () => {
    const fetcher: HeadFetcher = vi.fn(async (path: string) => ({
      // Optional file is absent, but everything required is present.
      ok: !path.endsWith('optional.bin'),
    }));
    const report = await checkPackagedModels(fetcher, sampleModels);

    expect(report.allReady).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('reports a model as not ready when a required file is missing', async () => {
    const fetcher: HeadFetcher = vi.fn(async (path: string) => ({
      ok: !path.endsWith('model.onnx'),
    }));
    const report = await checkPackagedModels(fetcher, sampleModels);

    expect(report.allReady).toBe(false);
    expect(report.missing).toEqual(['/models/embeddings/m1/model.onnx']);
    expect(report.models.find((m) => m.id === 'm1')?.ready).toBe(false);
    expect(report.models.find((m) => m.id === 'm2')?.ready).toBe(true);
  });

  it('treats fetch errors (e.g. 404 throw) as missing, not a crash', async () => {
    const fetcher: HeadFetcher = vi.fn(async () => {
      throw new Error('network down');
    });
    const report = await checkPackagedModels(fetcher, sampleModels);

    expect(report.allReady).toBe(false);
    // Both required files should be reported missing.
    expect(report.missing).toContain('/models/embeddings/m1/model.onnx');
    expect(report.missing).toContain('/models/ort/ort.wasm');
  });

  it('regression: SPA fallback (HTTP 200 + text/html) is NOT treated as present', async () => {
    // Issue #20 finding #3: Vite dev/preview serve index.html with HTTP 200 for
    // any unmatched path. A naive res.ok check would report allReady:true against
    // a build serving ZERO model files. The hardened probe must reject HTML.
    const fetcher: HeadFetcher = vi.fn(async () => ({
      ok: true,
      contentType: 'text/html; charset=utf-8',
    }));
    const report = await checkPackagedModels(fetcher, sampleModels);

    expect(report.allReady).toBe(false);
    expect(report.models.every((m) => m.ready)).toBe(false);
    // Every required file should be reported missing despite the 200 responses.
    expect(report.missing).toContain('/models/embeddings/m1/model.onnx');
    expect(report.missing).toContain('/models/ort/ort.wasm');
  });

  it('regression: real model files (200 + non-HTML content type) ARE present', async () => {
    // Positive control: the hardened probe must not over-reject real files.
    const fetcher: HeadFetcher = vi.fn(async () => ({
      ok: true,
      contentType: 'application/octet-stream',
    }));
    const report = await checkPackagedModels(fetcher, sampleModels);

    expect(report.allReady).toBe(true);
    expect(report.missing).toEqual([]);
  });
});
