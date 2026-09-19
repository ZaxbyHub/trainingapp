/**
 * PacksPanel.display.test.tsx — C7 (issue #74) renderer display and failure
 * path assertions that complement the frozen acceptance checks:
 *   - published_at date rendering and the name→packId fallback
 *     (final-critic finding: the frozen AC1 e2e asserts name/version/
 *     source_class/status but not the rendered date);
 *   - the two-step remove flow removing the row from the DOM after a
 *     confirmed remove (review round: the frozen AC4 check asserts the API
 *     call + refresh, and the frozen fixture list never drops the row);
 *   - failure paths: a failing listPacks leaves the panel in its empty state
 *     with an error toast (review round: zero failure-path coverage).
 * Lives OUTSIDE the frozen acceptance files so the frozen blobs stay stable.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { PacksPanel } from './PacksPanel';
import { ToastProvider } from './ToastProvider';
import type { ApiClient, PackInfo } from '../lib/api';

const PACKS: PackInfo[] = [
  {
    packId: 'bundled-min',
    version: '1.0.0',
    name: 'Bundled Minimum Fixture',
    sourceClass: 'bundled',
    publishedAt: '2026-09-16T00:00:00Z',
    active: true,
    supersedes: [],
  },
  {
    packId: 'legacy-pack',
    version: '0.9.0',
    name: null,
    sourceClass: 'user',
    publishedAt: null,
    active: false,
    supersedes: [],
  },
];

function renderPanel(apiClient: Partial<ApiClient>) {
  render(
    <ToastProvider>
      <PacksPanel apiClient={apiClient as ApiClient} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PacksPanel display contract (issue #74)', () => {
  it('renders the published_at date for a pack row', async () => {
    renderPanel({ listPacks: vi.fn(async () => PACKS) });
    const row = await screen.findByTestId('pack-row-bundled-min-1.0.0');
    // UTC rendering: a UTC-midnight timestamp must not shift a day.
    await waitFor(() => expect(row).toHaveTextContent('2026'));
    expect(row).toHaveTextContent('9/16/2026');
  });

  it('falls back to the pack id as the display name when name is null', async () => {
    renderPanel({ listPacks: vi.fn(async () => PACKS) });
    const row = await screen.findByTestId('pack-row-legacy-pack-0.9.0');
    await waitFor(() => expect(row).toHaveTextContent('legacy-pack'));
    expect(row).toHaveTextContent('user');
    expect(screen.getByTestId('pack-status-legacy-pack-0.9.0')).toHaveTextContent('superseded');
  });

  it('removes the row from the DOM after a confirmed remove', async () => {
    // First listPacks call returns both packs; the post-remove refresh
    // returns the list WITHOUT the removed row (the frozen AC4 check's
    // fixture never drops the row, so the DOM assertion lives here).
    const listPacks = vi
      .fn(async () => PACKS)
      .mockImplementationOnce(async () => PACKS)
      .mockImplementationOnce(async () => PACKS.filter((p) => p.packId !== 'legacy-pack'));
    renderPanel({ listPacks, removePack: vi.fn(async () => undefined) });

    const row = await screen.findByTestId('pack-row-legacy-pack-0.9.0');
    fireEvent.click(screen.getByTestId('pack-remove-legacy-pack-0.9.0'));
    fireEvent.click(await screen.findByTestId('pack-remove-confirm'));

    await waitFor(() =>
      expect(screen.queryByTestId('pack-row-legacy-pack-0.9.0')).toBeNull(),
    );
    expect(listPacks).toHaveBeenCalledTimes(2);
  });

  it('shows the error state when listPacks fails', async () => {
    renderPanel({
      listPacks: vi.fn(async () => {
        throw new Error('packs backend unreachable');
      }),
    });
    // The panel still mounts (empty state) and the failure is surfaced.
    await screen.findByTestId('packs-panel');
    await screen.findByText(/No knowledge packs installed/);
    await screen.findByText('packs backend unreachable');
  });

  it('surfaces an install failure without adding rows', async () => {
    renderPanel({
      listPacks: vi.fn(async () => []),
      installPack: vi.fn(async () => {
        throw new Error('install refused: downgrade');
      }),
    });
    await screen.findByTestId('packs-panel');

    const input = document.querySelector(
      'input[data-testid="pack-install-input"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    const zip = new File(['PK\x03\x04'], 'pack.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [zip] } });

    await screen.findByText('install refused: downgrade');
    expect(screen.queryByTestId('pack-row-user-sample-1.0.0')).toBeNull();
  });
});
