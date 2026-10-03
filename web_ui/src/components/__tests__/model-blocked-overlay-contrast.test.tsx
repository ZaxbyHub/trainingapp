/**
 * Lumen phase 5 review F1 pin: ModelBlockedOverlay's two lists use Lumen text
 * tokens that pass AA on the overlay card (recommendations --text-secondary,
 * failures --danger). The legacy tokens (--color-text-muted 4.18:1,
 * --color-danger) failed, and axe in the full page can report these nodes as
 * merely "incomplete" (background undeterminable under the chat page), so a
 * regression could hide there. This pins the tokens directly. (Separate file so
 * phase 3's ModelBlockedOverlay.test.tsx edits stay conflict-free.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModelBlockedOverlay } from '../ModelBlockedOverlay';
import type { ReadinessResult } from '../../lib/llm/model-readiness';

const result: ReadinessResult = {
  ready: false,
  checks: {
    webgpu: false,
    memory: { availableBytes: 8e9, requiredBytes: 4e9, sufficient: true, tier: 'HIGH' as const },
    modelCached: false,
  },
  failures: ['This build is missing the packaged browser model.'],
  recommendations: ['WebGPU is unavailable, but the wllama engine runs on the CPU.'],
};

afterEach(() => cleanup());

describe('ModelBlockedOverlay list colours (F1 pin)', () => {
  it('recommendations use --text-secondary and failures use --danger (never the legacy tokens)', () => {
    render(
      <ModelBlockedOverlay
        readinessResult={result}
        browserEngine="wllama"
        modelLoadingProgress={0}
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    const failureList = screen.getByText(result.failures[0]).closest('ul')!;
    const recommendationList = screen.getByText(result.recommendations[0]).closest('ul')!;
    expect(failureList).not.toBe(recommendationList);

    expect(recommendationList.style.color).toBe('var(--text-secondary)');
    expect(failureList.style.color).toBe('var(--danger)');
    for (const list of [failureList, recommendationList]) {
      expect(list.style.color).not.toContain('--color-text-muted');
      expect(list.style.color).not.toContain('--color-danger');
    }
  });
});
