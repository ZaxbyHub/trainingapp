/**
 * #265 (AC8, frozen check C6): the blocked-model overlay gains the
 * build:offline developer hint for the wllama missing-packaged-model state —
 * as a SEPARATE element. The live-region statusText concatenation (pinned by
 * ModelBlockedOverlay.test.tsx:225) must stay untouched: the hint must never
 * leak into the announcement text.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ModelBlockedOverlay } from './ModelBlockedOverlay';
import type { ReadinessResult } from '../lib/llm/model-readiness';
import type { BrowserEngine } from '../types/llm';

vi.mock('../ui', () => ({
  // Minimal Dialog/Banner/Button/ProgressBar stand-ins: this spec pins TEXT
  // placement, not the design-system chrome.
  Dialog: ({ children }: { children: React.ReactNode }) => <div role="alertdialog">{children}</div>,
  Banner: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  ProgressBar: () => <div />,
}));

function readiness(failures: string[]): ReadinessResult {
  return {
    ok: false,
    failures,
    recommendations: [],
  } as unknown as ReadinessResult;
}

function renderOverlay(engine: BrowserEngine, result: ReadinessResult | null) {
  return render(
    <ModelBlockedOverlay
      readinessResult={result}
      browserEngine={engine}
      modelLoadingProgress={0}
      onRetry={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
}

describe('ModelBlockedOverlay staged-weights hint (#265 AC8)', () => {
  it('shows the build:offline hint for the wllama missing-model state', () => {
    renderOverlay('wllama', readiness(['Model not downloaded']));
    const hint = screen.getByTestId('model-blocked-build-hint');
    expect(hint).toHaveTextContent('Building from source? Run npm run build:offline to stage the model.');
  });

  it('the hint is a SEPARATE element: the live-region statusText concat stays without it', () => {
    // Mount while "preparing", then transition to the failed state so the
    // assertive live region receives its text (same flow the pinned
    // ModelBlockedOverlay.test.tsx:225 spec uses).
    const { rerender } = renderOverlay('wllama', null);
    rerender(
      <ModelBlockedOverlay
        readinessResult={readiness(['Model not downloaded'])}
        browserEngine="wllama"
        modelLoadingProgress={0}
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    // The pinned live-region concat reads ONLY ['Model not ready.', headline,
    // ...failures] — the hint must not append itself there.
    const alert = screen.getByTestId('model-gate-alert');
    expect(alert).toHaveTextContent(
      'Model not ready. This build is missing the packaged model. Contact your administrator, or use Settings to connect an external model (local server or cloud). Model not downloaded',
    );
    expect(alert.textContent ?? '').not.toMatch(/build:offline/);
    expect(screen.getByTestId('model-blocked-build-hint')).toBeInTheDocument();
  });

  it('no hint for the webllm engine (its state is a download, not staged weights)', () => {
    renderOverlay('webllm', readiness(['WebGPU is not available in this browser.']));
    expect(screen.queryByTestId('model-blocked-build-hint')).not.toBeInTheDocument();
  });
});
