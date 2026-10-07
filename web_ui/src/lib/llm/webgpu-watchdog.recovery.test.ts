/**
 * createRecoveryHandler x readiness cache (PRR-152-01).
 *
 * webgpu-watchdog.test.ts is excluded from the vitest run (see vitest.config.ts),
 * so this file pins the recovery handler's readiness-cache contract against the
 * real readiness-gate module with only the model checks mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReadinessResult } from './model-readiness';

const mockCheckReadiness = vi.fn<(modelId: string, engine: string) => Promise<ReadinessResult>>();
const mockCheckWebGPU = vi.fn<() => Promise<boolean>>();

vi.mock('./model-readiness', () => ({
  ModelReadinessGate: vi.fn(() => ({
    checkReadiness: mockCheckReadiness,
    checkWebGPU: mockCheckWebGPU,
  })),
}));

vi.mock('./llm-factory', () => ({
  getPreferredBrowserEngine: vi.fn(() => 'webllm'),
}));

vi.mock('./web-llm-service', () => ({
  WebLLMService: class {},
  WEBLLM_DEFAULT_MODEL_ID: 'test-default-model',
}));

import { createRecoveryHandler } from './webgpu-watchdog';
import { ensureReadinessGateChecked, resetReadinessCache } from './readiness-gate';
import type { WebLLMService } from './web-llm-service';

function readyResult(): ReadinessResult {
  return {
    ready: true,
    checks: {
      webgpu: true,
      modelCached: true,
      memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' },
    },
    failures: [],
    recommendations: [],
  };
}

function fakeService(initialize: () => Promise<void>): WebLLMService {
  return {
    getModelInfo: () => ({ modelId: 'm1' }),
    dispose: vi.fn(),
    initialize: vi.fn(initialize),
  } as unknown as WebLLMService;
}

describe('createRecoveryHandler readiness cache (PRR-152-01)', () => {
  beforeEach(() => {
    resetReadinessCache();
    mockCheckReadiness.mockReset();
    mockCheckWebGPU.mockReset();
    mockCheckReadiness.mockResolvedValue(readyResult());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not leave a stale cached result when WebGPU is gone after the loss', async () => {
    await ensureReadinessGateChecked('webllm');
    expect(mockCheckReadiness).toHaveBeenCalledTimes(1);

    mockCheckWebGPU.mockResolvedValue(false);
    const handler = createRecoveryHandler(fakeService(async () => {}));
    await expect(handler('lost')).rejects.toThrow('no longer available');

    await ensureReadinessGateChecked('webllm');
    expect(mockCheckReadiness).toHaveBeenCalledTimes(2);
  });

  it('does not leave a stale cached result when re-initialization fails', async () => {
    await ensureReadinessGateChecked('webllm');
    expect(mockCheckReadiness).toHaveBeenCalledTimes(1);

    mockCheckWebGPU.mockResolvedValue(true);
    const handler = createRecoveryHandler(
      fakeService(async () => {
        throw new Error('load failed');
      })
    );
    await expect(handler('lost')).rejects.toThrow('WebGPU recovery failed');

    await ensureReadinessGateChecked('webllm');
    expect(mockCheckReadiness).toHaveBeenCalledTimes(2);
  });
});
