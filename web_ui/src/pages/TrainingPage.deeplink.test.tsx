/**
 * TrainingPage.deeplink.test.tsx - PRE-d (PR 150 review, pre-existing): a training
 * deep link (chat "Open in training", or ?pack=) to a course that is not installed,
 * or to a slide the course does not have, used to open a silent blank player. The
 * page now says what is wrong and offers the way back to the course library.
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

describe('deep link to a course that is not installed (PRE-d)', () => {
  it('names the missing course, offers the way back, and the library follows', async () => {
    const onLeaveDeepLink = vi.fn();
    render(<TrainingPage initialPackId="ghost-course" onLeaveDeepLink={onLeaveDeepLink} />);
    const notice = await screen.findByTestId('training-deeplink-missing');
    expect(notice).toHaveTextContent('ghost-course');
    expect(notice).toHaveTextContent(/not installed/i);

    fireEvent.click(within(notice).getByRole('button', { name: 'Show all courses' }));
    expect(onLeaveDeepLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('stub-player')).toBeNull();
    expect(await card('course-a')).toBeTruthy();
  });

  it('a ?pack= URL naming an uninstalled course gets the same notice', async () => {
    window.history.replaceState({}, '', '/?pack=stale-pack');
    render(<TrainingPage />);
    expect(await screen.findByTestId('training-deeplink-missing')).toHaveTextContent('stale-pack');
  });

  it('no notice for an installed course (bare id or versioned dir)', async () => {
    const view = render(<TrainingPage initialPackId="course-a" />);
    await screen.findByTestId('stub-player');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('training-deeplink-missing')).toBeNull();
    view.unmount();
    render(<TrainingPage initialPackId="course-b/1.0.0" />);
    await screen.findByTestId('stub-player');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('training-deeplink-missing')).toBeNull();
  });

  it('no notice before the pack list has loaded (the deep link still plays: frozen D7 contract)', async () => {
    render(<TrainingPage initialPackId="ghost-course" />);
    expect(screen.getByTestId('stub-player')).toHaveTextContent('ghost-course');
    expect(screen.queryByTestId('training-deeplink-missing')).toBeNull();
    await screen.findByTestId('training-deeplink-missing');
  });
});

describe('deep link to a slide the course does not have (PRE-d)', () => {
  it('tells the learner the linked slide was not found, while the course still opens', async () => {
    render(<TrainingPage initialPackId="course-a" pendingSlideId="gone-slide" />);
    const notice = await screen.findByTestId('training-deeplink-slide-missing');
    expect(notice).toHaveTextContent(/linked slide .* not found/i);
    expect(screen.getByTestId('stub-player')).toBeTruthy();
  });

  it('no notice when the slide exists, or when slide positions are unknown (index not ready)', async () => {
    const view = render(<TrainingPage initialPackId="course-a" pendingSlideId="s2" />);
    await screen.findByTestId('stub-player');
    expect(screen.queryByTestId('training-deeplink-slide-missing')).toBeNull();
    view.unmount();
    index.ready = false;
    render(<TrainingPage initialPackId="course-a" pendingSlideId="gone-slide" />);
    await screen.findByTestId('stub-player');
    expect(screen.queryByTestId('training-deeplink-slide-missing')).toBeNull();
  });
});
