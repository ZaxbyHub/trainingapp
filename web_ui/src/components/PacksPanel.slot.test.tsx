/**
 * PacksPanel.slot.test.tsx — Lumen phase 6 ("Documents | Training packs" tabs).
 *
 * Pins:
 *   1. With a trainingSlot element, training-class rows render INSIDE the slot
 *      (portal) and knowledge rows stay in the panel; testids are unchanged and
 *      unique, and there is still exactly one pack-install-input.
 *   2. trainingSlot null (slot not mounted yet) renders no training rows; the
 *      prop omitted keeps every row inline (standalone behaviour).
 *   3. onTrainingPackAdded fires when a training row APPEARS after the first
 *      load (here via the client's change subscription), never on the first
 *      load, and not for a new knowledge-class row.
 *   4. refreshToken bumps re-list (the desktop client has no subscription).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { PacksPanel } from './PacksPanel';
import { ToastProvider } from './ToastProvider';
import type { PackClient } from '../lib/packs/pack-client';
import type { PackInfo } from '../lib/api';

const pack = (packId: string, sourceClass: string, version = '1.0.0'): PackInfo => ({
  packId,
  version,
  name: packId,
  sourceClass,
  publishedAt: null,
  active: true,
  supersedes: [],
});
const KNOWLEDGE = pack('handbook', 'bundled');
const COURSE = pack('course-a', 'training');
const COURSE_2 = pack('course-b', 'training');

function makeClient(lists: PackInfo[][]) {
  let call = 0;
  let listener: (() => void) | null = null;
  const client = {
    kind: 'browser',
    listPacks: vi.fn(async () => lists[Math.min(call++, lists.length - 1)]),
    installPack: vi.fn(),
    removePack: vi.fn(),
    rollbackPack: vi.fn(),
    subscribe: (fn: () => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  } as unknown as PackClient;
  return { client, notify: () => listener?.() };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-slot]').forEach((el) => el.remove());
});

function slot(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('data-slot', '');
  document.body.appendChild(el);
  return el;
}

describe('PacksPanel training slot and auto-switch signal (Lumen phase 6)', () => {
  it('portals training rows into the slot and keeps knowledge rows in the panel', async () => {
    const target = slot();
    const { client } = makeClient([[KNOWLEDGE, COURSE]]);
    render(
      <ToastProvider>
        <PacksPanel client={client} trainingSlot={target} />
      </ToastProvider>
    );
    const panel = await screen.findByTestId('packs-panel');
    expect(panel.contains(screen.getByTestId('pack-row-handbook-1.0.0'))).toBe(true);
    const courseRow = screen.getByTestId('pack-row-course-a-1.0.0');
    expect(target.contains(courseRow)).toBe(true);
    expect(panel.contains(courseRow)).toBe(false);
    expect(screen.getAllByTestId('pack-install-input')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Training packs' })).toBeTruthy();
  });

  it('renders no training rows while the slot is null, and every row inline without the prop', async () => {
    const { client } = makeClient([[KNOWLEDGE, COURSE]]);
    const { rerender } = render(
      <ToastProvider>
        <PacksPanel client={client} trainingSlot={null} />
      </ToastProvider>
    );
    await screen.findByTestId('pack-row-handbook-1.0.0');
    expect(screen.queryByTestId('pack-row-course-a-1.0.0')).toBeNull();

    rerender(
      <ToastProvider>
        <PacksPanel client={client} />
      </ToastProvider>
    );
    expect(screen.getByTestId('packs-panel').contains(screen.getByTestId('pack-row-course-a-1.0.0'))).toBe(true);
  });

  it('signals a training pack that appears after the first load, never on it', async () => {
    const onTrainingPackAdded = vi.fn();
    const knowledge2 = pack('policies', 'user');
    const { client, notify } = makeClient([
      [KNOWLEDGE, COURSE], // first load: already-installed course, no signal
      [KNOWLEDGE, COURSE, knowledge2], // a knowledge pack appears: no signal
      [KNOWLEDGE, COURSE, knowledge2, COURSE_2], // a training pack appears: signal
    ]);
    render(
      <ToastProvider>
        <PacksPanel client={client} trainingSlot={slot()} onTrainingPackAdded={onTrainingPackAdded} />
      </ToastProvider>
    );
    await screen.findByTestId('pack-row-course-a-1.0.0');
    expect(onTrainingPackAdded).not.toHaveBeenCalled();

    await act(async () => notify());
    await screen.findByTestId('pack-row-policies-1.0.0');
    expect(onTrainingPackAdded).not.toHaveBeenCalled();

    await act(async () => notify());
    await screen.findByTestId('pack-row-course-b-1.0.0');
    expect(onTrainingPackAdded).toHaveBeenCalledTimes(1);
  });

  it('re-lists when refreshToken changes', async () => {
    const { client } = makeClient([[KNOWLEDGE], [KNOWLEDGE, COURSE]]);
    const target = slot();
    const { rerender } = render(
      <ToastProvider>
        <PacksPanel client={client} trainingSlot={target} refreshToken={0} />
      </ToastProvider>
    );
    await screen.findByTestId('pack-row-handbook-1.0.0');
    expect(client.listPacks).toHaveBeenCalledTimes(1);
    rerender(
      <ToastProvider>
        <PacksPanel client={client} trainingSlot={target} refreshToken={1} />
      </ToastProvider>
    );
    await waitFor(() => expect(screen.getByTestId('pack-row-course-a-1.0.0')).toBeTruthy());
    expect(client.listPacks).toHaveBeenCalledTimes(2);
  });
});
