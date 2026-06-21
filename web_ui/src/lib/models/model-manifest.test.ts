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
  it('uses same-origin absolute paths under /models', () => {
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
});
