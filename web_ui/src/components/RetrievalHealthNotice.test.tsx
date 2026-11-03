/**
 * Frozen check C10 (trace collated-275-268, AC5 of issue #268).
 *
 * While the retrieval-health state is `keyword-only`, the chat view shows
 * EXACTLY ONE persistent status notice (role="status") naming the cause and
 * the remedy, independent of any message's `retrievalDegraded` flag; while
 * the state is `ok`, none is rendered. The component (`RetrievalHealthNotice`,
 * mounted once in ChatPage per issue #268 Design 2) takes no required props
 * and subscribes to the retrieval-health store itself.
 *
 * RED at base (component absent), GREEN after the fix.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import { RetrievalHealthNotice } from './RetrievalHealthNotice';
import { setKeywordOnly, setOk, resetRetrievalHealth } from '../lib/rag/retrieval-health';

describe('RetrievalHealthNotice (C10)', () => {
  beforeEach(() => {
    resetRetrievalHealth();
  });

  afterEach(() => {
    cleanup();
    resetRetrievalHealth();
  });

  it('renders no status notice while the retrieval health is ok', () => {
    const { container } = render(<RetrievalHealthNotice />);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('renders exactly one persistent role="status" notice naming cause and remedy while keyword-only', async () => {
    const { container } = render(<RetrievalHealthNotice />);

    await act(async () => {
      setKeywordOnly('Embedding service unavailable');
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    });

    const notice = container.querySelector('[role="status"]') as HTMLElement;
    // The cause is named verbatim...
    expect(notice.textContent).toContain('Embedding service unavailable');
    // ...and the notice says what degraded (the remedy wording names the
    // semantic-search loss, matching the per-answer line's vocabulary).
    expect(notice.textContent).toMatch(/semantic search/i);
  });

  it('the notice disappears when the embedder recovers (state returns to ok)', async () => {
    const { container } = render(<RetrievalHealthNotice />);

    await act(async () => {
      setKeywordOnly('Embedding service unavailable');
    });
    await waitFor(() => {
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    });

    await act(async () => {
      setOk();
    });
    await waitFor(() => {
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    });
  });
});
