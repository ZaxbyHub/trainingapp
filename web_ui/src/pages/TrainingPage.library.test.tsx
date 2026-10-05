/**
 * TrainingPage.library.test.tsx — Lumen phase 6: the course library grid and
 * the player page's slim header (back, title, slide x of n, pin-slide).
 *
 * Pins:
 *   1. With a SOLE course the picker auto-selects it (player), and Back still
 *      reaches the library (explicit flag); a card click returns to the player.
 *   2. With several courses and none selected, the library lists one card per
 *      course; a card click opens that course and the picker follows.
 *   3. Pin-slide re-forwards the SAME event object the player emitted, exactly
 *      once per click, and is inert before any slide was reported.
 *   4. Without ingested slide docs (desktop renderer / index not ready) the
 *      header shows the slide title, never a guessed "x of n".
 *   5. Back from a lifted chat deep link releases it through onLeaveDeepLink.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const listPacks = vi.hoisted(() => vi.fn());
const stableSession = vi.hoisted(() => ({
  apiClient: { listPacks: null as unknown as ReturnType<typeof listPacks.call> },
}));
vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: () => ({ session: stableSession }),
  isElectron: () => true,
}));

const bridge = vi.hoisted(() => ({ stateQueue: [] as Array<{ slideId: string; slideTitle: string } | null>, readIndex: 0 }));
vi.mock('../components/training-player-bridge', () => ({
  createTrainingPlayerBridge: () => ({
    jumpToSlide: () => Promise.resolve(false),
    readState: () => {
      const value =
        bridge.readIndex < bridge.stateQueue.length
          ? bridge.stateQueue[bridge.readIndex++]
          : bridge.stateQueue[bridge.stateQueue.length - 1] ?? null;
      return Promise.resolve(value ?? null);
    },
  }),
}));

import { TrainingPage } from './TrainingPage';
import { useState } from 'react';
import { LAST_PACK_KEY } from '../lib/storage/persisted-keys';

/** App-like host: onLeaveDeepLink really clears the lifted target (App's setTrainingTarget(null)). */
function DeepLinkHost({ initial }: { initial: string }) {
  const [target, setTarget] = useState<string | undefined>(initial);
  return <TrainingPage initialPackId={target} onLeaveDeepLink={() => setTarget(undefined)} />;
}

const course = (packId: string, name: string, version = '1.0.0') => ({
  packId,
  version,
  name,
  sourceClass: 'training',
  publishedAt: null,
  active: true,
  supersedes: [],
});
const COURSE_A = course('course-a', 'Safety Onboarding');
const COURSE_B = course('course-b', 'Fire Drill Basics', '2.1.0');

beforeEach(() => {
  stableSession.apiClient.listPacks = listPacks as unknown as ReturnType<typeof listPacks.call>;
  listPacks.mockReset();
  bridge.stateQueue = [null];
  bridge.readIndex = 0;
  window.localStorage.clear();
  const url = new URL(window.location.href);
  url.searchParams.delete('pack');
  window.history.replaceState({}, '', url);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Training library and player page (Lumen phase 6)', () => {
  it('a sole course auto-plays, Back shows the library, and its card returns to the player', async () => {
    listPacks.mockResolvedValue([COURSE_A]);
    render(<TrainingPage />);
    expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
    // Slim header on the player view: the H1 stays, the page description goes.
    expect(screen.getByRole('heading', { level: 1, name: 'Training' })).toBeTruthy();
    expect(screen.queryByText('Play the training courses installed on this device.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    expect(screen.queryByTestId('training-player-frame')).toBeNull();
    expect(screen.getByText('Play the training courses installed on this device.')).toBeTruthy();
    const card = screen.getByTestId('training-course-course-a');
    expect(card).toHaveTextContent('Safety Onboarding');
    expect(card).toHaveTextContent('v1.0.0');

    fireEvent.click(card);
    const frame = (await screen.findByTestId('training-player-frame')) as HTMLIFrameElement;
    expect(frame.src.startsWith('app://training/course-a/1.0.0/story.html')).toBe(true);
  });

  it('lists one card per course and opens the clicked course (the picker follows)', async () => {
    listPacks.mockResolvedValue([COURSE_A, COURSE_B]);
    render(<TrainingPage />);
    expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
    expect(screen.getByTestId('training-course-course-b')).toHaveTextContent('v2.1.0');
    expect(screen.queryByTestId('training-player-frame')).toBeNull();

    fireEvent.click(screen.getByTestId('training-course-course-b'));
    const frame = (await screen.findByTestId('training-player-frame')) as HTMLIFrameElement;
    expect(frame.src.startsWith('app://training/course-b/2.1.0/story.html')).toBe(true);
    expect((screen.getByTestId('training-pack-select') as HTMLSelectElement).value).toBe('course-b/2.1.0');
  });

  it('pin-slide re-forwards the SAME event object, and is inert before any slide', async () => {
    vi.useFakeTimers();
    const onSlideChange = vi.fn();
    listPacks.mockResolvedValue([COURSE_A]);
    bridge.stateQueue = [null, null, null, { slideId: 's1', slideTitle: 'Welcome' }];
    render(<TrainingPage onSlideChange={onSlideChange} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const pin = screen.getByRole('button', { name: 'Pin slide to Chat' });
    expect(pin).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(pin);
    expect(onSlideChange).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(onSlideChange).toHaveBeenCalledTimes(1);
    const emitted = onSlideChange.mock.calls[0][0];
    // Index not ready in this renderer: the title, never a guessed position.
    expect(screen.getByText('Slide: Welcome')).toBeTruthy();

    const status = screen.getAllByRole('status').find((el) => el.classList.contains('ui-visually-hidden'));
    expect(status?.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Pin slide to Chat' }));
    expect(onSlideChange).toHaveBeenCalledTimes(2);
    expect(onSlideChange.mock.calls[1][0]).toBe(emitted);
    // Polite confirmation for screen-reader users (review L3).
    expect(status?.textContent).toBe('Slide pinned to Chat');
  });

  it('Back from a lifted deep link releases it (onLeaveDeepLink) and shows the library', async () => {
    const onLeaveDeepLink = vi.fn();
    listPacks.mockResolvedValue([COURSE_A, COURSE_B]);
    render(<TrainingPage initialPackId="course-b" onLeaveDeepLink={onLeaveDeepLink} />);
    expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
    // Deep-linked title is the resolved course name (no picker on this view).
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Fire Drill Basics' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    expect(onLeaveDeepLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('training-player-frame')).toBeNull();
    expect(screen.getByTestId('training-course-course-a')).toBeTruthy();
  });

  // H1 (phase-6 review): App clearing the lifted target after Back must NOT
  // re-open a player (the sole course, or a remembered course that differs).
  describe('Back from a deep link with a host that really clears it', () => {
    it('sole course: Back shows the library and stays there', async () => {
      listPacks.mockResolvedValue([COURSE_A]);
      render(<DeepLinkHost initial="course-a" />);
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
      expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
    });

    it('remembered last course differs from the deep link: Back shows the library, not the remembered course', async () => {
      window.localStorage.setItem(LAST_PACK_KEY, 'course-a/1.0.0');
      listPacks.mockResolvedValue([COURSE_A, COURSE_B]);
      render(<DeepLinkHost initial="course-b" />);
      const frame = (await screen.findByTestId('training-player-frame')) as HTMLIFrameElement;
      expect(frame.src.startsWith('app://training/course-b/2.1.0/story.html')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
      expect(await screen.findByTestId('training-course-course-b')).toBeTruthy();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
    });

    it('nothing remembered: Back shows the library', async () => {
      listPacks.mockResolvedValue([COURSE_A, COURSE_B]);
      render(<DeepLinkHost initial="course-b" />);
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
      expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
    });
  });
  // PRE-c (PR 150 review, pre-existing): choosing "Select a course..." must stay deselected.
  // With a sole course the auto-select used to win straight back (snap-back), reopening
  // the player the user just left.
  describe('deselecting the course in the picker (PRE-c)', () => {
    it('sole course: choosing "Select a course..." in the library keeps the library (no snap-back)', async () => {
      listPacks.mockResolvedValue([COURSE_A]);
      render(<TrainingPage />);
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
      const select = screen.getByTestId('training-pack-select') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: '' } });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
      expect((screen.getByTestId('training-pack-select') as HTMLSelectElement).value).toBe('');
      // The library card still opens the course afterwards.
      fireEvent.click(screen.getByTestId('training-course-course-a'));
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
    });

    it('sole course: deselecting from the player picker returns to the library', async () => {
      listPacks.mockResolvedValue([COURSE_A]);
      render(<TrainingPage />);
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      fireEvent.change(screen.getByTestId('training-pack-select'), { target: { value: '' } });
      expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
    });

    it('history Back to the deselected entry keeps the library (the flag rides the history state)', async () => {
      listPacks.mockResolvedValue([COURSE_A]);
      render(<TrainingPage />);
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      fireEvent.change(screen.getByTestId('training-pack-select'), { target: { value: '' } });
      fireEvent.click(await screen.findByTestId('training-course-course-a'));
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      await act(async () => {
        window.history.back();
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
    });

    it('leaving Training and coming back keeps the library while the history entry says deselected', async () => {
      listPacks.mockResolvedValue([COURSE_A]);
      const first = render(<TrainingPage />);
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      fireEvent.change(screen.getByTestId('training-pack-select'), { target: { value: '' } });
      expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
      expect((window.history.state as { trainingDeselected?: boolean } | null)?.trainingDeselected).toBe(true);
      first.unmount();
      render(<TrainingPage />);
      expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
    });

    it('a remembered last course does not snap back either', async () => {
      window.localStorage.setItem(LAST_PACK_KEY, 'course-b/2.1.0');
      listPacks.mockResolvedValue([COURSE_A, COURSE_B]);
      render(<TrainingPage />);
      expect(await screen.findByTestId('training-player-frame')).toBeTruthy();
      fireEvent.change(screen.getByTestId('training-pack-select'), { target: { value: '' } });
      expect(await screen.findByTestId('training-course-course-a')).toBeTruthy();
      expect(screen.queryByTestId('training-player-frame')).toBeNull();
    });
  });
});
