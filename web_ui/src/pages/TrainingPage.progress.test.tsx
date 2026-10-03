/**
 * TrainingPage.progress.test.tsx - Lumen phase 6 review B2: course cards show
 * the progress of the learner (k of n slides plus an accessible progress bar):
 * the furthest slide reached per course, persisted locally.
 *
 * Pins: progress persists and updates on slide change; it only moves forward;
 * where the slide count is unknown nothing numeric is shown or recorded; the card
 * announces the progress accessibly. The player itself is stubbed (it only hands
 * its onSlideChange to the test): the page consumes the existing events only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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

const index = vi.hoisted(() => ({
  ready: true,
  counts: { 'course-a': 4, 'course-b': 6 } as Record<string, number>,
  positions: { s1: 1, s2: 2, s3: 3, s4: 4 } as Record<string, number>,
}));
vi.mock('../lib/training/slide-position', () => ({
  slideDocsAvailable: () => index.ready,
  courseSlideCount: (id: string) => (index.ready ? index.counts[id] ?? null : null),
  slidePosition: (id: string, slideId: string) =>
    index.ready && index.positions[slideId] !== undefined
      ? { index: index.positions[slideId], total: index.counts[id] }
      : null,
}));

type SlideEvent = { slideId: string; slideTitle: string };
const player = vi.hoisted(() => ({ emit: null as null | ((event: SlideEvent) => void) }));
vi.mock('../components/TrainingPlayer', async () => {
  const React = await import('react');
  return {
    courseIdOf: (key: string) => key.split('/')[0] ?? '',
    TrainingPlayer: (props: { packId: string; onSlideChange?: (e: SlideEvent) => void }) => {
      player.emit = props.onSlideChange ?? null;
      return React.createElement('div', { 'data-testid': 'stub-player' }, props.packId);
    },
  };
});

import { TrainingPage } from './TrainingPage';
import { TRAINING_PROGRESS_KEY } from '../lib/storage/persisted-keys';

const stored = (): unknown => JSON.parse(window.localStorage.getItem(TRAINING_PROGRESS_KEY) ?? 'null');
const slide = (slideId: string) => act(async () => player.emit?.({ slideId, slideTitle: 'Title ' + slideId }));
const card = (id: string) => screen.findByTestId('training-course-' + id);

beforeEach(() => {
  index.ready = true;
  electron.value = false;
  player.emit = null;
  window.localStorage.clear();
  const url = new URL(window.location.href);
  url.searchParams.delete('pack');
  window.history.replaceState({}, '', url);
});

afterEach(() => {
  cleanup();
});

describe('course-card progress (B2)', () => {
  it('starts as "Not started" with a zero progress bar', async () => {
    render(<TrainingPage />);
    const a = await card('course-a');
    expect(a).toHaveTextContent('Not started');
    const bar = within(a).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    expect(stored()).toBeNull();
  });

  it('persists and updates the furthest slide on slide change', async () => {
    render(<TrainingPage />);
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');

    await slide('s2');
    expect(stored()).toEqual({ 'course-a': 2 });
    await slide('s3');
    expect(stored()).toEqual({ 'course-a': 3 });

    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    const a = await card('course-a');
    expect(a).toHaveTextContent('3 of 4 slides');
    expect(within(a).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    // The other course is untouched.
    expect(await card('course-b')).toHaveTextContent('Not started');
  });

  it('reads saved progress on a fresh mount', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 2 }));
    render(<TrainingPage />);
    expect(await card('course-a')).toHaveTextContent('2 of 4 slides');
  });

  it('only moves forward: going back to an earlier slide keeps the furthest one', async () => {
    render(<TrainingPage />);
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    await slide('s3');
    await slide('s1');
    await slide('s2');
    expect(stored()).toEqual({ 'course-a': 3 });

    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    expect(await card('course-a')).toHaveTextContent('3 of 4 slides');
  });

  it('clamps stale progress to the current slide count and ignores malformed storage', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 9, 'course-b': -1 }));
    render(<TrainingPage />);
    expect(await card('course-a')).toHaveTextContent('4 of 4 slides');
    expect(await card('course-b')).toHaveTextContent('Not started');
    cleanup();
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, 'not json');
    render(<TrainingPage />);
    expect(await card('course-a')).toHaveTextContent('Not started');
  });

  it('unknown slide count: no number, no bar, and nothing is recorded', async () => {
    index.ready = false;
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 2 }));
    render(<TrainingPage />);
    const a = await card('course-a');
    expect(a).toHaveTextContent('Storyline course');
    expect(a.textContent).not.toMatch(/[0-9]+ of [0-9]+|Not started/);
    expect(within(a).queryByRole('progressbar')).toBeNull();

    fireEvent.click(a);
    await screen.findByTestId('stub-player');
    await slide('s3');
    expect(stored()).toEqual({ 'course-a': 2 }); // unchanged: the position is unknown
  });

  it('desktop renderer: no progress UI', async () => {
    electron.value = true;
    render(<TrainingPage />);
    const a = await card('course-a');
    expect(a).toHaveTextContent('Storyline course');
    expect(within(a).queryByRole('progressbar')).toBeNull();
  });

  it('announces the progress accessibly (card name and a labelled progressbar)', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3 }));
    render(<TrainingPage />);
    const a = await card('course-a');
    expect(screen.getByRole('button', { name: /Safety Onboarding.*3 of 4 slides/ })).toBe(a);
    const bar = within(a).getByRole('progressbar', { name: 'Safety Onboarding progress: 3 of 4 slides' });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
  });
});
