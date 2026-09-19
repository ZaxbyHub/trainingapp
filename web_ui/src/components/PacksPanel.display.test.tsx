/**
 * PacksPanel.display.test.tsx — C7 (issue #74) renderer display assertions
 * that complement the frozen acceptance checks: the packs list must render
 * the published_at date (final-critic round-1 finding — the frozen AC1 e2e
 * asserts name/version/source_class/status but not the rendered date), and
 * the fallback display name for legacy rows without a manifest name.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
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

function renderPanel(listPacks: () => Promise<PackInfo[]>) {
  const apiClient = {
    listPacks: vi.fn(listPacks),
    installPack: vi.fn(),
    removePack: vi.fn(async () => undefined),
    rollbackPack: vi.fn(async () => undefined),
  } as unknown as ApiClient;
  render(
    <ToastProvider>
      <PacksPanel apiClient={apiClient} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PacksPanel display contract (issue #74)', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', undefined);
  });

  it('renders the published_at date for a pack row', async () => {
    renderPanel(async () => PACKS);
    const row = await screen.findByTestId('pack-row-bundled-min-1.0.0');
    await waitFor(() => expect(row).toHaveTextContent('2026'));
  });

  it('falls back to the pack id as the display name when name is null', async () => {
    renderPanel(async () => PACKS);
    const row = await screen.findByTestId('pack-row-legacy-pack-0.9.0');
    await waitFor(() => expect(row).toHaveTextContent('legacy-pack'));
    expect(row).toHaveTextContent('user');
    expect(screen.getByTestId('pack-status-legacy-pack-0.9.0')).toHaveTextContent('superseded');
  });
});
