/**
 * Tests for the packaged-model manifest + offline readiness gate.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkPackagedModels,
  EMBEDDING_MODELS_BASE,
  ONNX_RUNTIME_WASM_BASE,
  type PackagedModel,
  type PackagedModelGroup,
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
      group: 'core',
      files: [
        { path: '/models/embeddings/m1/model.onnx', required: true },
        { path: '/models/embeddings/m1/optional.bin', required: false },
      ],
    },
    {
      id: 'm2',
      label: 'Model Two',
      kind: 'runtime',
      group: 'core',
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

describe('checkPackagedModels — excluded groups (--no-llm builds)', () => {
  // Issue #20 feedback F1: an embeddings-only / server-mode build (built with
  // validate-build --no-llm) intentionally omits the llm-group files. Without
  // an exclusion signal, checkPackagedModels would report those required files
  // as missing forever → allReady:false → broken UI on a valid configuration.
  const modelsWithLlm: PackagedModel[] = [
    {
      id: 'embeddings',
      label: 'Embeddings',
      kind: 'embedding',
      group: 'core',
      files: [{ path: '/models/embeddings/m.onnx', required: true }],
    },
    {
      id: 'llm-weights',
      label: 'Browser LLM',
      kind: 'llm',
      group: 'llm',
      files: [{ path: '/models/llm/m.gguf', required: true }],
    },
  ];

  it('excluded-group models are ready:true + excluded:true, NOT counted as missing', async () => {
    // The llm gguf is absent (fetcher returns not-ok). With the llm group
    // excluded, the model should still be ready (not applicable) and absent
    // from the missing list.
    const fetcher: HeadFetcher = vi.fn(async (path: string) => ({
      ok: path.includes('embeddings'), // core present, llm absent
    }));
    const excluded = new Set<PackagedModelGroup>(['llm']);
    const report = await checkPackagedModels(fetcher, modelsWithLlm, excluded);

    expect(report.allReady).toBe(true);
    expect(report.missing).toEqual([]);
    const llmModel = report.models.find((m) => m.id === 'llm-weights');
    expect(llmModel?.ready).toBe(true);
    expect(llmModel?.excluded).toBe(true);
    const embModel = report.models.find((m) => m.id === 'embeddings');
    expect(embModel?.excluded).toBe(false);
    // The excluded llm model is NOT probed; only the core embeddings model is.
    // So the fetcher must never receive the llm path.
    const probedPaths = vi.mocked(fetcher).mock.calls.map((c) => c[0]);
    expect(probedPaths).not.toContain('/models/llm/m.gguf');
    expect(probedPaths).toContain('/models/embeddings/m.onnx');
  });

  it('without the exclusion, the absent llm files correctly fail readiness', async () => {
    // Sanity: the exclusion is what makes the difference — without it, the
    // missing llm weights must fail allReady (the original buggy behavior,
    // now only triggered when the group is NOT excluded).
    const fetcher: HeadFetcher = vi.fn(async (path: string) => ({
      ok: path.includes('embeddings'),
    }));
    const report = await checkPackagedModels(fetcher, modelsWithLlm, new Set());

    expect(report.allReady).toBe(false);
    expect(report.missing).toEqual(['/models/llm/m.gguf']);
    expect(report.models.find((m) => m.id === 'llm-weights')?.excluded).toBe(false);
  });
});

describe('EXCLUDED_MODEL_GROUPS env-var wiring (prepare-models --no-llm → Vite → bundle)', () => {
  // Feedback F1 regression guard: prepare-models --no-llm writes
  // VITE_EXCLUDE_MODEL_GROUPS=llm into .env.production, Vite inlines it at
  // build, and EXCLUDED_MODEL_GROUPS must parse it into Set(['llm']). A bundle
  // grep is fragile under minification, so this test stubs the env var directly
  // and re-imports the module — the same code path the build inlines.
  it('parses VITE_EXCLUDE_MODEL_GROUPS=llm into Set(["llm"])', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_EXCLUDE_MODEL_GROUPS', 'llm');
    try {
      const mod = await import('./model-manifest');
      expect(mod.EXCLUDED_MODEL_GROUPS.has('llm')).toBe(true);
      expect(mod.EXCLUDED_MODEL_GROUPS.has('core')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('is empty when the env var is absent (normal build → no false exclusions)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_EXCLUDE_MODEL_GROUPS', '');
    try {
      const mod = await import('./model-manifest');
      expect(mod.EXCLUDED_MODEL_GROUPS.size).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('drops invalid group names silently (does not throw or pollute the set)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_EXCLUDE_MODEL_GROUPS', 'llm, foo, bar, core');
    try {
      const mod = await import('./model-manifest');
      expect(mod.EXCLUDED_MODEL_GROUPS.has('llm')).toBe(true);
      expect(mod.EXCLUDED_MODEL_GROUPS.has('core')).toBe(true);
      expect(mod.EXCLUDED_MODEL_GROUPS.has('foo' as PackagedModelGroup)).toBe(false);
      expect(mod.EXCLUDED_MODEL_GROUPS.size).toBe(2);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
