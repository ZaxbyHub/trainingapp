/**
 * TrainingPage.slidecount.test.tsx — Lumen phase 6 review L2: course-card slide
 * counts come from the browser keyword index, which becomes ready AFTER boot.
 * The library must pick the counts up when the index turns ready (no remount),
 * and never query the index in the desktop renderer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const electron = vi.hoisted(() => ({ value: false }));
vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: () => ({ session: null }),
  isElectron: () => electron.value,
}));

const packClient = vi.hoisted(() => ({
  kind: 'browser',
  listPacks: async () => [
    { packId: 'course-a', version: '1.0.0', name: 'Safety Onboarding', sourceClass: 'training', publishedAt: null, active: true, supersedes: [] },
    { packId: 'course-b', version: '1.0.0', name: 'Fire Drill', sourceClass: 'training', publishedAt: null, active: true, supersedes: [] },
  ],
}));
vi.mock('../lib/packs/pack-client', () => ({ usePackClient: () => packClient }));

const index = vi.hoisted(() => ({ ready: false, counts: { 'course-a': 12, 'course-b': 3 } as Record<string, number> }));
vi.mock('../lib/training/slide-position', () => ({
  slideDocsAvailable: vi.fn(() => index.ready),
  courseSlideCount: vi.fn((id: string) => (index.ready ? index.counts[id] ?? null : null)),
  slidePosition: vi.fn(() => null),
}));

import { TrainingPage } from './TrainingPage';
import { courseSlideCount, slideDocsAvailable } from '../lib/training/slide-position';

beforeEach(() => {
  index.ready = false;
  electron.value = false;
  window.localStorage.clear();
  vi.mocked(courseSlideCount).mockClear();
  vi.mocked(slideDocsAvailable).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('course-card slide counts follow the keyword index readiness (L2)', () => {
  it('shows the fallback, then the counts once the index becomes ready', async () => {
    vi.useFakeTimers();
    render(<TrainingPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('training-course-course-a')).toHaveTextContent('Storyline course');

    index.ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByTestId('training-course-course-a')).toHaveTextContent('12 slides');
    expect(screen.getByTestId('training-course-course-b')).toHaveTextContent('3 slides');
  });

  it('never polls or reads the index in the desktop renderer', async () => {
    vi.useFakeTimers();
    electron.value = true;
    index.ready = true; // even if it were ready, desktop has no browser index
    render(<TrainingPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByTestId('training-course-course-a')).toHaveTextContent('Storyline course');
    expect(slideDocsAvailable).not.toHaveBeenCalled();
    expect(courseSlideCount).not.toHaveBeenCalled();
  });

  it('stops polling after the attempt cap when the index never becomes ready', async () => {
    vi.useFakeTimers();
    render(<TrainingPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.mocked(slideDocsAvailable).mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(slideDocsAvailable).toHaveBeenCalledTimes(60);
  });
});
