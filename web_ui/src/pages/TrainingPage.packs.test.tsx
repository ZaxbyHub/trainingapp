/**
 * TrainingPage.packs.test.tsx — #133 feedback round 3: the Training tab is
 * the ARTICULATE/STORYLINE course player only. Knowledge-document packs are
 * a different product (Chat/Documents) and must NOT appear here.
 *
 * Pins:
 *   1. A documents pack (sourceClass 'bundled') is NOT listed; with only it
 *      installed the tab shows the articulate empty state.
 *   2. A training pack is listed, auto-selected when sole, and renders the
 *      player (iframe to app://training/<id>/<version>/story.html).
 *   3. The picker switches courses (?pack= follows the <id>/<version> key).
 *   4. Reviewer R3 F3: with a session present and the list still loading, a
 *      stale ?pack= renders the LOADING state, not a player flash.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const listPacks = vi.hoisted(() => vi.fn());
// STABLE session object — the real DesktopSessionProvider memoizes its
// context value, so the component's effects may safely depend on the
// identity.
const stableSession = vi.hoisted(() => ({
  apiClient: { listPacks: null as unknown as ReturnType<typeof listPacks.call> },
}));

vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: () => ({ session: stableSession }),
}));

import { TrainingPage } from './TrainingPage';

const originalPathname = window.location.pathname;
const originalSearch = window.location.search;

const DOC_PACK = {
  packId: 'opmed-initial',
  version: '1.0.0',
  name: 'OpMed Initial Knowledge Pack',
  sourceClass: 'bundled',
  publishedAt: null,
  active: true,
  supersedes: [],
};

const TRAINING_PACK = {
  packId: 'opmed-course',
  version: '1.0.0',
  name: 'OpMed CDP Course',
  sourceClass: 'training',
  publishedAt: null,
  active: true,
  supersedes: [],
};

beforeEach(() => {
  stableSession.apiClient.listPacks = listPacks as unknown as ReturnType<typeof listPacks.call>;
  listPacks.mockReset();
  window.localStorage.clear();
  const url = new URL(window.location.href);
  url.searchParams.delete('pack');
  window.history.replaceState({}, '', url);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', originalPathname + originalSearch);
});

describe('TrainingPage is the articulate course surface only (#133 feedback round 3)', () => {
  it('does NOT list document packs; shows the articulate empty state when only docs are installed', async () => {
    listPacks.mockResolvedValue([DOC_PACK]);
    render(<TrainingPage />);
    expect(await screen.findByTestId('training-empty-state')).toBeTruthy();
    expect(screen.getByText('No training course is installed yet.')).toBeTruthy();
    const select = screen.getByTestId('training-pack-select') as HTMLSelectElement;
    expect(select.value).toBe('');
    // The documents pack is nowhere in the picker.
    expect(select.textContent).not.toContain('opmed-initial');
  });

  it('lists and auto-plays the sole training pack via the versioned dir key', async () => {
    listPacks.mockResolvedValue([DOC_PACK, TRAINING_PACK]);
    render(<TrainingPage />);
    const select = await screen.findByTestId('training-pack-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe('opmed-course/1.0.0');
    });
    const frame = screen.getByTestId('training-player-frame') as HTMLIFrameElement;
    expect(frame.src.startsWith('app://training/opmed-course/1.0.0/story.html')).toBe(true);
    // Documents pack stays out of the picker.
    expect(select.textContent).not.toContain('opmed-initial');
  });

  it('switches courses from the picker (?pack= follows id/version)', async () => {
    const second = { ...TRAINING_PACK, packId: 'field-course', version: '2.0.0', name: 'Field Course' };
    listPacks.mockResolvedValue([TRAINING_PACK, second]);
    render(<TrainingPage />);
    const select = await screen.findByTestId('training-pack-select') as HTMLSelectElement;
    expect(select.value).toBe(''); // two courses, no stored choice
    fireEvent.change(select, { target: { value: 'field-course/2.0.0' } });
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('pack')).toBe('field-course/2.0.0');
    });
    const frame = screen.getByTestId('training-player-frame') as HTMLIFrameElement;
    expect(frame.src.startsWith('app://training/field-course/2.0.0/story.html')).toBe(true);
  });

  it('resolves a BARE pack-id deep link (Learn panel form) to the versioned dir', async () => {
    listPacks.mockResolvedValue([DOC_PACK, TRAINING_PACK]);
    render(<TrainingPage initialPackId="opmed-course" />);
    const frame = await screen.findByTestId('training-player-frame');
    expect((frame as HTMLIFrameElement).src.startsWith('app://training/opmed-course/1.0.0/story.html')).toBe(true);
  });

  it('renders the LOADING state (not a player flash) while the pack list resolves', () => {
    listPacks.mockReturnValue(new Promise(() => undefined)); // never resolves
    window.history.pushState({}, '', '/?pack=stale-pack');
    render(<TrainingPage />);
    expect(screen.getByText('Loading installed training packs…')).toBeTruthy();
    expect(screen.queryByTestId('training-player-frame')).toBeNull();
  });
});

describe('bundled-course upgrade state: retired + active rows for ONE course id (#133 round 7)', () => {
  // The boot-ensure upgrade deactivates the old version but keeps its row
  // (listInstalled orders by id, then version — the RETIRED row sorts first).
  const RETIRED = { ...TRAINING_PACK, version: '1.0.0', active: false };
  const ACTIVE = { ...TRAINING_PACK, version: '1.0.1', active: true };

  it('the picker shows ONE course and auto-selects the ACTIVE version', async () => {
    listPacks.mockResolvedValue([RETIRED, ACTIVE]);
    render(<TrainingPage />);
    const select = await screen.findByTestId('training-pack-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe('opmed-course/1.0.1');
    });
    const options = Array.from(select.options).filter((o) => o.value !== '');
    expect(options.map((o) => o.value)).toEqual(['opmed-course/1.0.1']);
    const frame = screen.getByTestId('training-player-frame') as HTMLIFrameElement;
    expect(frame.src.startsWith('app://training/opmed-course/1.0.1/story.html')).toBe(true);
  });

  it('a BARE-id deep link resolves to the ACTIVE version, not the first (retired) row', async () => {
    listPacks.mockResolvedValue([RETIRED, ACTIVE]);
    render(<TrainingPage initialPackId="opmed-course" />);
    const frame = await screen.findByTestId('training-player-frame');
    // Round-7 finding 1 regression pin: through activePacks.find this played
    // the retired 1.0.0 (it sorts first for the id).
    expect((frame as HTMLIFrameElement).src.startsWith('app://training/opmed-course/1.0.1/story.html')).toBe(true);
  });

  it('an EXPLICIT <id>/<version> URL still honors the named (retired) version', async () => {
    listPacks.mockResolvedValue([RETIRED, ACTIVE]);
    window.history.pushState({}, '', '/?pack=opmed-course/1.0.0');
    render(<TrainingPage />);
    const frame = await screen.findByTestId('training-player-frame');
    expect((frame as HTMLIFrameElement).src.startsWith('app://training/opmed-course/1.0.0/story.html')).toBe(true);
  });

  it('picking a course persists it for the next visit (LAST_PACK_KEY)', async () => {
    listPacks.mockResolvedValue([RETIRED, ACTIVE]);
    render(<TrainingPage />);
    const select = await screen.findByTestId('training-pack-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe('opmed-course/1.0.1');
    });
    // Auto-select does not persist; an explicit pick does (the write that was
    // missing made the selection memo's localStorage read dead code).
    fireEvent.change(select, { target: { value: 'opmed-course/1.0.1' } });
    expect(window.localStorage.getItem('training.lastPackDir')).toBe('opmed-course/1.0.1');
  });
});
