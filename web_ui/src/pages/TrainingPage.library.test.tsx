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

    fireEvent.click(screen.getByRole('button', { name: 'All courses' }));
    expect(screen.queryByTestId('training-player-frame')).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: 'Pin slide to Chat' }));
    expect(onSlideChange).toHaveBeenCalledTimes(2);
    expect(onSlideChange.mock.calls[1][0]).toBe(emitted);
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
});
