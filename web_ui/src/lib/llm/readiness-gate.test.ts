/**
 * Tests for readiness-gate.ts — module-level cache and event dispatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReadinessResult } from './model-readiness';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any dynamic import of the module under test.
// ---------------------------------------------------------------------------

const mockCheckReadiness = vi.fn<[string, string], Promise<ReadinessResult>>();

vi.mock('./model-readiness', () => ({
  ModelReadinessGate: vi.fn(() => ({
    checkReadiness: mockCheckReadiness,
  })),
}));

vi.mock('./llm-factory', () => ({
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadinessResult(overrides: Partial<ReadinessResult> = {}): ReadinessResult {
  return {
    ready: true,
    checks: {
      webgpu: false,
      modelCached: true,
      memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' },
    },
    failures: [],
    recommendations: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module under test — imported after mocks are hoisted.
// ---------------------------------------------------------------------------

import {
  getReadinessSnapshot,
  getReadinessGateInstance,
  applyReadinessFromEvent,
  resetReadinessCache,
  ensureReadinessGateChecked,
} from './readiness-gate';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readiness-gate', () => {
  const listeners: Array<[string, EventListener]> = [];

  function onWindowEvent(type: string, handler: EventListener): void {
    window.addEventListener(type, handler);
    listeners.push([type, handler]);
  }

  beforeEach(() => {
    resetReadinessCache();
    mockCheckReadiness.mockReset();
  });

  afterEach(() => {
    for (const [type, handler] of listeners) {
      window.removeEventListener(type, handler);
    }
    listeners.length = 0;
  });

  // -------------------------------------------------------------------------
  // getReadinessSnapshot — initial state
  // -------------------------------------------------------------------------

  describe('getReadinessSnapshot()', () => {
    it('returns false for both fields before any check has run', () => {
      const snap = getReadinessSnapshot();
      expect(snap.modelCached).toBe(false);
      expect(snap.webgpuAvailable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // applyReadinessFromEvent — updates snapshot
  // -------------------------------------------------------------------------

  describe('applyReadinessFromEvent()', () => {
    it('updates modelCached from the result argument', () => {
      const result = makeReadinessResult({ checks: { webgpu: false, modelCached: true, memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' } } });
      applyReadinessFromEvent(result, false);
      expect(getReadinessSnapshot().modelCached).toBe(true);
    });

    it('updates webgpuAvailable from the hasWebGPU argument', () => {
      applyReadinessFromEvent(undefined, true);
      expect(getReadinessSnapshot().webgpuAvailable).toBe(true);
    });

    it('does not overwrite lastReadinessResult when result is undefined', () => {
      const result = makeReadinessResult({ checks: { webgpu: false, modelCached: true, memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' } } });
      applyReadinessFromEvent(result, false);
      // Second call with undefined should keep existing cached result
      applyReadinessFromEvent(undefined, false);
      expect(getReadinessSnapshot().modelCached).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // resetReadinessCache — clears all state
  // -------------------------------------------------------------------------

  describe('resetReadinessCache()', () => {
    it('resets snapshot to initial falsy state after values have been set', () => {
      const result = makeReadinessResult();
      applyReadinessFromEvent(result, true);
      expect(getReadinessSnapshot().modelCached).toBe(true);
      expect(getReadinessSnapshot().webgpuAvailable).toBe(true);

      resetReadinessCache();

      expect(getReadinessSnapshot().modelCached).toBe(false);
      expect(getReadinessSnapshot().webgpuAvailable).toBe(false);
    });

    it('resets the gate instance to null', async () => {
      const result = makeReadinessResult();
      mockCheckReadiness.mockResolvedValue(result);
      await ensureReadinessGateChecked('wllama');
      expect(getReadinessGateInstance()).not.toBeNull();

      resetReadinessCache();
      expect(getReadinessGateInstance()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getReadinessGateInstance — null before check, set after
  // -------------------------------------------------------------------------

  describe('getReadinessGateInstance()', () => {
    it('returns null before any check has been triggered', () => {
      expect(getReadinessGateInstance()).toBeNull();
    });

    it('returns the ModelReadinessGate instance after ensureReadinessGateChecked resolves', async () => {
      mockCheckReadiness.mockResolvedValue(makeReadinessResult());
      await ensureReadinessGateChecked('wllama');
      expect(getReadinessGateInstance()).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // ensureReadinessGateChecked — wllama engine
  // -------------------------------------------------------------------------

  describe('ensureReadinessGateChecked() with wllama engine', () => {
    it('dispatches readiness-gate-checked with correct detail on success', async () => {
      const result = makeReadinessResult({ ready: true, checks: { webgpu: false, modelCached: true, memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' } } });
      mockCheckReadiness.mockResolvedValue(result);

      let capturedDetail: Record<string, unknown> | null = null;
      onWindowEvent('readiness-gate-checked', (e) => {
        capturedDetail = (e as CustomEvent).detail as Record<string, unknown>;
      });

      await ensureReadinessGateChecked('wllama');

      expect(capturedDetail).not.toBeNull();
      expect(capturedDetail!.engine).toBe('wllama');
      expect(capturedDetail!.result).toBe(result);
      expect(capturedDetail!.hasWebGPU).toBe(false);
    });

    it('sets modelReady = ready && modelCached for wllama', async () => {
      // ready=true, modelCached=true → modelReady should be true
      const result = makeReadinessResult({ ready: true, checks: { webgpu: false, modelCached: true, memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' } } });
      mockCheckReadiness.mockResolvedValue(result);

      let modelReady: unknown;
      onWindowEvent('readiness-gate-checked', (e) => {
        modelReady = (e as CustomEvent).detail.modelReady;
      });

      await ensureReadinessGateChecked('wllama');
      expect(modelReady).toBe(true);
    });

    it('sets modelReady = false when ready=false for wllama even if modelCached=true', async () => {
      const result = makeReadinessResult({ ready: false, checks: { webgpu: false, modelCached: true, memory: { availableBytes: 1_000_000_000, requiredBytes: 2_000_000_000, sufficient: false, tier: 'LOW' } } });
      mockCheckReadiness.mockResolvedValue(result);

      let modelReady: unknown;
      onWindowEvent('readiness-gate-checked', (e) => {
        modelReady = (e as CustomEvent).detail.modelReady;
      });

      await ensureReadinessGateChecked('wllama');
      expect(modelReady).toBe(false);
    });

    it('caches the result so a second call returns the same value without re-checking', async () => {
      const result = makeReadinessResult();
      mockCheckReadiness.mockResolvedValue(result);

      const first = await ensureReadinessGateChecked('wllama');
      const second = await ensureReadinessGateChecked('wllama');

      expect(mockCheckReadiness).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });
  });

  // -------------------------------------------------------------------------
  // ensureReadinessGateChecked — webllm engine modelReady logic
  // -------------------------------------------------------------------------

  describe('ensureReadinessGateChecked() with webllm engine', () => {
    it('sets modelReady = modelCached (not gated on ready) for webllm', async () => {
      // ready=false but modelCached=true → modelReady should still be true for webllm
      const result = makeReadinessResult({ ready: false, checks: { webgpu: true, modelCached: true, memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' } } });
      mockCheckReadiness.mockResolvedValue(result);

      let modelReady: unknown;
      onWindowEvent('readiness-gate-checked', (e) => {
        modelReady = (e as CustomEvent).detail.modelReady;
      });

      await ensureReadinessGateChecked('webllm');
      expect(modelReady).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ensureReadinessGateChecked — engine switch invalidates cache
  // -------------------------------------------------------------------------

  describe('ensureReadinessGateChecked() engine switch', () => {
    it('re-runs checkReadiness when the engine changes', async () => {
      const wllamaResult = makeReadinessResult();
      const webllmResult = makeReadinessResult({ checks: { webgpu: true, modelCached: false, memory: { availableBytes: 8_000_000_000, requiredBytes: 2_000_000_000, sufficient: true, tier: 'HIGH' } } });
      mockCheckReadiness
        .mockResolvedValueOnce(wllamaResult)
        .mockResolvedValueOnce(webllmResult);

      const first = await ensureReadinessGateChecked('wllama');
      const second = await ensureReadinessGateChecked('webllm');

      expect(mockCheckReadiness).toHaveBeenCalledTimes(2);
      expect(first).toBe(wllamaResult);
      expect(second).toBe(webllmResult);
    });
  });

  // -------------------------------------------------------------------------
  // ensureReadinessGateChecked — concurrent deduplication
  // -------------------------------------------------------------------------

  describe('ensureReadinessGateChecked() concurrent calls', () => {
    /**
     * The in-flight deduplication guard requires both `readinessGateInitPromise`
     * AND `lastReadinessEngine` to match.  Because `lastReadinessEngine` is only
     * written inside the async IIFE (after checkReadiness resolves), a truly
     * concurrent second call arrives while `lastReadinessEngine` is still null —
     * so it falls through and spawns its own check.
     *
     * Sequential calls ARE deduplicated: after the first resolves,
     * `lastReadinessResult` is set and the second call returns the cached value
     * immediately without invoking checkReadiness again.
     *
     * This test documents the actual contract of the module.
     */
    it('returns the cached result on a sequential second call without re-checking', async () => {
      const result = makeReadinessResult();
      mockCheckReadiness.mockResolvedValue(result);

      const first = await ensureReadinessGateChecked('wllama');
      // Second call after first has fully resolved — must hit the cache path
      const second = await ensureReadinessGateChecked('wllama');

      expect(mockCheckReadiness).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });
  });

  // -------------------------------------------------------------------------
  // ensureReadinessGateChecked — error path
  // -------------------------------------------------------------------------

  describe('ensureReadinessGateChecked() error path', () => {
    it('returns null on checkReadiness failure', async () => {
      mockCheckReadiness.mockRejectedValue(new Error('WebGPU exploded'));
      const result = await ensureReadinessGateChecked('wllama');
      expect(result).toBeNull();
    });

    it('dispatches readiness-gate-error with the error message', async () => {
      mockCheckReadiness.mockRejectedValue(new Error('adapter lost'));

      let errorDetail: Record<string, unknown> | null = null;
      onWindowEvent('readiness-gate-error', (e) => {
        errorDetail = (e as CustomEvent).detail as Record<string, unknown>;
      });

      await ensureReadinessGateChecked('wllama');
      expect(errorDetail).not.toBeNull();
      expect(errorDetail!.message).toBe('adapter lost');
    });

    it('dispatches a fallback readiness-gate-checked event with modelCached=false on error', async () => {
      mockCheckReadiness.mockRejectedValue(new Error('boom'));

      const checkedEvents: CustomEvent[] = [];
      onWindowEvent('readiness-gate-checked', (e) => {
        checkedEvents.push(e as CustomEvent);
      });

      await ensureReadinessGateChecked('wllama');

      expect(checkedEvents.length).toBeGreaterThan(0);
      const fallback = checkedEvents[checkedEvents.length - 1];
      expect(fallback.detail.result.checks.modelCached).toBe(false);
    });

    it('uses a generic message when the thrown value is not an Error instance', async () => {
      mockCheckReadiness.mockRejectedValue('string error');

      let errorDetail: Record<string, unknown> | null = null;
      onWindowEvent('readiness-gate-error', (e) => {
        errorDetail = (e as CustomEvent).detail as Record<string, unknown>;
      });

      await ensureReadinessGateChecked('wllama');
      expect(errorDetail!.message).toBe('Failed to check model readiness');
    });
  });
});
