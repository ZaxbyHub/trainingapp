/**
 * TrainingPage.cross-tab.test.tsx - PRR-203/206 (PR 150 review): training.progress
 * is shared across tabs through localStorage. A mounted tab must follow another
 * tab's writes (the `storage` event), and must drop its in-memory progress when the
 * key is cleared elsewhere (Clear Cache) instead of showing or re-persisting it.
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
import { TRAINING_PROGRESS_KEY, clearUserSettings } from '../lib/storage/persisted-keys';

const stored = (): unknown => JSON.parse(window.localStorage.getItem(TRAINING_PROGRESS_KEY) ?? 'null');
const slide = (slideId: string) => act(async () => player.emit?.({ slideId, slideTitle: 'Title ' + slideId }));
const card = (id: string) => screen.findByTestId('training-course-' + id);
/** What the browser fires in THIS tab when ANOTHER tab changes the key. */
const otherTabWrote = (newValue: string | null) =>
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: TRAINING_PROGRESS_KEY, newValue, storageArea: window.localStorage })
    );
  });

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
  vi.restoreAllMocks();
});

describe('cross-tab training progress (PRR-203/206)', () => {
  it('an idle tab picks up progress another tab recorded', async () => {
    render(<TrainingPage />);
    expect(await card('course-a')).toHaveTextContent('Not started');
    const next = JSON.stringify({ 'course-a': 3 });
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, next);
    await otherTabWrote(next);
    expect(await card('course-a')).toHaveTextContent('Reached slide 3 of 4');
  });

  it('ignores storage events for other keys and other storage areas', async () => {
    render(<TrainingPage />);
    await card('course-a');
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3 }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme-preference', newValue: 'dark', storageArea: window.localStorage }));
      window.dispatchEvent(
        new StorageEvent('storage', { key: TRAINING_PROGRESS_KEY, newValue: '{"course-a":3}', storageArea: window.sessionStorage })
      );
    });
    expect(await card('course-a')).toHaveTextContent('Not started');
  });

  it('Clear Cache in another tab drops the progress and the next slide change does not resurrect it', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3, 'course-b': 5 }));
    render(<TrainingPage />);
    expect(await card('course-b')).toHaveTextContent('Reached slide 5 of 6');

    window.localStorage.removeItem(TRAINING_PROGRESS_KEY);
    await otherTabWrote(null);
    expect(await card('course-a')).toHaveTextContent('Not started');
    expect(await card('course-b')).toHaveTextContent('Not started');

    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    await slide('s1');
    // Only the fresh position is written; the cleared entries stay gone.
    expect(stored()).toEqual({ 'course-a': 1 });
    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    expect(await card('course-a')).toHaveTextContent('Reached slide 1 of 4');
    expect(await card('course-b')).toHaveTextContent('Not started');
  });

  it('heals a value a simultaneous write from another tab dropped from storage on the next slide change', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-b': 5 }));
    render(<TrainingPage />);
    expect(await card('course-b')).toHaveTextContent('Reached slide 5 of 6');
    // A racing write from another tab replaced the stored map without course-b (no storage
    // event reaches this tab for it, as if the events were coalesced or missed).
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 1 }));
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    await slide('s2');
    expect(stored()).toEqual({ 'course-a': 2, 'course-b': 5 });
  });

  it('P1: another tab clears and a slide write lands BEFORE the storage event is delivered: only the new position is written', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3, 'course-b': 5 }));
    render(<TrainingPage />);
    expect(await card('course-b')).toHaveTextContent('Reached slide 5 of 6');
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    window.localStorage.removeItem(TRAINING_PROGRESS_KEY); // the other tab's Clear Cache; its event is still queued
    await slide('s1');
    expect(stored()).toEqual({ 'course-a': 1 });
    await otherTabWrote(null); // the queued event arrives late: nothing comes back
    expect(stored()).toEqual({ 'course-a': 1 });
    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    expect(await card('course-b')).toHaveTextContent('Not started');
  });

  it('P2: the clear event and a slide event land in the same batch (no re-render between): only the new position is written', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3, 'course-b': 5 }));
    render(<TrainingPage />);
    expect(await card('course-b')).toHaveTextContent('Reached slide 5 of 6');
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    await act(async () => {
      window.localStorage.removeItem(TRAINING_PROGRESS_KEY);
      window.dispatchEvent(
        new StorageEvent('storage', { key: TRAINING_PROGRESS_KEY, newValue: null, storageArea: window.localStorage })
      );
      player.emit?.({ slideId: 's1', slideTitle: 'Title s1' });
    });
    expect(stored()).toEqual({ 'course-a': 1 });
  });

  it('Q1: unwritable storage (setItem throws) keeps in-session progress forward-only and other courses shown', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    render(<TrainingPage />);
    fireEvent.click(await card('course-b'));
    await screen.findByTestId('stub-player');
    await slide('s3');
    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    await slide('s4');
    await slide('s1');
    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    expect(await card('course-a')).toHaveTextContent('Reached slide 4 of 4');
    expect(await card('course-b')).toHaveTextContent('Reached slide 3 of 6');
  });

  it('R1: fresh profile; this tab saved, another tab clears, this tab writes before the event: only the new position', async () => {
    render(<TrainingPage />); // the key is absent at mount
    fireEvent.click(await card('course-b'));
    await screen.findByTestId('stub-player');
    await slide('s3');
    expect(stored()).toEqual({ 'course-b': 3 });
    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    window.localStorage.removeItem(TRAINING_PROGRESS_KEY); // the other tab's clear; its event is still queued
    await slide('s1');
    expect(stored()).toEqual({ 'course-a': 1 });
  });

  it('R2: fresh profile; another tab writes then clears, this tab writes before the clear event: only the new position', async () => {
    render(<TrainingPage />);
    expect(await card('course-b')).toHaveTextContent('Not started');
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-b': 5 }));
    await otherTabWrote(JSON.stringify({ 'course-b': 5 }));
    expect(await card('course-b')).toHaveTextContent('Reached slide 5 of 6');
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    window.localStorage.removeItem(TRAINING_PROGRESS_KEY);
    await slide('s1');
    expect(stored()).toEqual({ 'course-a': 1 });
  });

  it('Clear Cache in this tab: the next write holds only the new position', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3, 'course-b': 5 }));
    render(<TrainingPage />);
    expect(await card('course-b')).toHaveTextContent('Reached slide 5 of 6');
    act(() => {
      clearUserSettings();
    });
    expect(await card('course-b')).toHaveTextContent('Not started');
    fireEvent.click(await card('course-a'));
    await screen.findByTestId('stub-player');
    await slide('s1');
    expect(stored()).toEqual({ 'course-a': 1 });
  });

  it('a whole-storage clear (key === null) also drops the progress', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3 }));
    render(<TrainingPage />);
    expect(await card('course-a')).toHaveTextContent('Reached slide 3 of 4');
    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: window.localStorage }));
    });
    expect(await card('course-a')).toHaveTextContent('Not started');
  });

  it('Clear Cache in this tab (user-settings-cleared event) drops the in-memory progress too', async () => {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ 'course-a': 3 }));
    render(<TrainingPage />);
    expect(await card('course-a')).toHaveTextContent('Reached slide 3 of 4');
    act(() => {
      clearUserSettings();
    });
    expect(await card('course-a')).toHaveTextContent('Not started');
  });
});
