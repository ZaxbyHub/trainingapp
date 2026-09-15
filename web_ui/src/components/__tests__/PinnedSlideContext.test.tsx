/**
 * Component tests for PinnedSlideContext (issue #83, D7) — the frozen
 * acceptance checks (C1/C4/C5) drive it through ChatPage; these pin the
 * component's own rendering contract directly: label rules, staleness
 * marking (attribute AND visible text), and the control callbacks.
 */
import React from 'react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PinnedSlideContext, pinnedSlideLabel } from '../PinnedSlideContext';

const LIVE_PIN = { slideId: '5rN4PvXJM5d', slideTitle: 'Welcome', section: 'Intro Module' };

afterEach(cleanup);

describe('pinnedSlideLabel', () => {
  test('section present → "Section > Title"', () => {
    expect(pinnedSlideLabel(LIVE_PIN)).toBe('Intro Module > Welcome');
  });
  test('section absent → title only', () => {
    expect(pinnedSlideLabel({ slideId: 'x', slideTitle: 'Roles Menu' })).toBe('Roles Menu');
  });
  test('blank section → title only (never a bare " > ")', () => {
    expect(pinnedSlideLabel({ slideId: 'x', slideTitle: 'Roles Menu', section: '   ' })).toBe('Roles Menu');
  });
});

describe('PinnedSlideContext', () => {
  test('renders "Currently viewing: Section > Slide title" for a resolved section', () => {
    render(<PinnedSlideContext pinnedSlide={LIVE_PIN} onDismiss={() => {}} />);
    const banner = screen.getByTestId('pinned-slide-context');
    expect(banner.textContent).toContain('Currently viewing:');
    expect(banner.textContent).toContain('Intro Module > Welcome');
    expect(banner.getAttribute('data-stale')).toBeNull();
  });

  test('degrades to title-only for an unresolved section (no " > " segment)', () => {
    render(<PinnedSlideContext pinnedSlide={{ slideId: 'x', slideTitle: 'Roles Menu' }} onDismiss={() => {}} />);
    const banner = screen.getByTestId('pinned-slide-context');
    expect(banner.textContent).toContain('Roles Menu');
    expect(banner.textContent).not.toContain(' > ');
    expect(banner.textContent).not.toContain('undefined');
  });

  test('live pin offers "Explain this step"; stale pin hides it', () => {
    const { rerender } = render(<PinnedSlideContext pinnedSlide={LIVE_PIN} onDismiss={() => {}} />);
    expect(screen.getByTestId('pinned-slide-explain')).toBeInTheDocument();
    rerender(<PinnedSlideContext pinnedSlide={{ ...LIVE_PIN, stale: true }} onDismiss={() => {}} />);
    expect(screen.queryByTestId('pinned-slide-explain')).toBeNull();
  });

  test('stale pin carries data-stale="true" AND a visible stale marker (never presents live)', () => {
    render(<PinnedSlideContext pinnedSlide={{ ...LIVE_PIN, stale: true }} onDismiss={() => {}} />);
    const banner = screen.getByTestId('pinned-slide-context');
    expect(banner.getAttribute('data-stale')).toBe('true');
    expect(banner.textContent).toContain('stale');
    expect(banner.textContent).toContain('Welcome');
  });

  test('dismiss fires onDismiss for live and stale pins', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<PinnedSlideContext pinnedSlide={LIVE_PIN} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('pinned-slide-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<PinnedSlideContext pinnedSlide={{ ...LIVE_PIN, stale: true }} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('pinned-slide-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  test('"Explain this step" invokes onExplainThisStep', () => {
    const onExplain = vi.fn();
    render(<PinnedSlideContext pinnedSlide={LIVE_PIN} onDismiss={() => {}} onExplainThisStep={onExplain} />);
    fireEvent.click(screen.getByTestId('pinned-slide-explain'));
    expect(onExplain).toHaveBeenCalledTimes(1);
  });
});
