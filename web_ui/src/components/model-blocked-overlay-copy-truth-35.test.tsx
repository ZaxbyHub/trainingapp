/**
 * Frozen acceptance checks (trace 35-residuals-chat-ux) for ZaxbyHub/
 * trainingapp#35 residual C10 — the packaged-model overlay must not point
 * users at a document the installed app does not contain.
 *
 * - C4 / AC4 (DISCRIMINATING), token c4-overlay-copy-truth: with the wllama
 *   engine and a readiness failure, the rendered overlay carries NO
 *   "Packaging guide" / "PACKAGING.md" reference anywhere in its visible
 *   text (headline and failure rows included), while still referencing at
 *   least one affordance the overlay itself provides (Retry / Open Settings /
 *   use a local server or cloud model). At base the wllama headline reads
 *   "... See the Packaging guide or contact your administrator." so this is
 *   RED.
 *
 * - C4 / AC4 (DISCRIMINATING), token c4b-readiness-source: the readiness
 *   gate's own failure strings (which flow into the overlay's failure rows)
 *   contain no PACKAGING.md reference. At base model-readiness.ts pushes
 *   '... rebuild with the weights staged (see PACKAGING.md).' so this is RED.
 *   Grounding: desktop/electron-builder.yml ships installer-resources/docs
 *   with licenses only — PACKAGING.md does not exist in installed builds,
 *   so the pointer is a dead end.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelBlockedOverlay } from './ModelBlockedOverlay';
import type { ReadinessResult } from '../lib/llm/model-readiness';

/** Synthetic failed readiness result — deliberately free of any packaging
 *  reference so the c4 assertions pin the overlay's OWN strings (the
 *  readiness-source truth is pinned separately by c4b). */
const syntheticReadiness: ReadinessResult = {
  ready: false,
  checks: {
    webgpu: false,
    memory: { availableBytes: 8e9, requiredBytes: 4e9, sufficient: true, tier: 'HIGH' },
    modelCached: false,
  },
  failures: ['Synthetic failure row'],
  recommendations: [],
};

describe('#35 C10 overlay copy truth (frozen acceptance)', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('c4-overlay-copy-truth: wllama-failed overlay references no dead doc, and still names a real way out', () => {
    render(
      <ModelBlockedOverlay
        readinessResult={syntheticReadiness}
        browserEngine="wllama"
        modelLoadingProgress={0}
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

    // Full rendered text (headline + failure rows + footer actions), so a
    // portal or nested region cannot hide a stray reference.
    const visible = document.body.textContent ?? '';

    expect(
      visible,
      'overlay still references "Packaging guide" — a document absent from installed builds'
    ).not.toMatch(/packaging\s+guide/i);
    expect(
      visible,
      'overlay still references PACKAGING.md — a document absent from installed builds'
    ).not.toMatch(/PACKAGING\.md/i);
    expect(
      visible,
      'overlay must reference at least one affordance it actually provides (Retry / Open Settings / external model)'
    ).toMatch(/retry|settings|local server|cloud model/i);
  });

  it('c4b-readiness-source: model-readiness failure strings contain no PACKAGING.md reference', () => {
    // vitest always runs with cwd = web_ui (npm --prefix web_ui test), so the
    // source is resolved from the working directory, not import.meta.url
    // (which vitest's transform does not anchor at the spec file).
    const source = readFileSync(join(process.cwd(), 'src/lib/llm/model-readiness.ts'), 'utf8');
    expect(
      source,
      'model-readiness.ts still directs users to PACKAGING.md, which installed builds do not ship'
    ).not.toContain('PACKAGING.md');
  });
});
