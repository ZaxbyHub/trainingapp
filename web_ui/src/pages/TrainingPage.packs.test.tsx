/**
 * TrainingPage.packs.test.tsx — #133 feedback round: the Training tab is a
 * usable surface for the BUILT-IN knowledge content.
 *
 * Pins:
 *   1. A single installed active pack is AUTO-SELECTED (no ?pack= needed).
 *   2. A bundled (document) pack renders the docs reader: the pack manifest
 *      is fetched over the reserved app://training route and its documents
 *      are listed; a PDF renders inline (embed), other formats offer a
 *      download link.
 *   3. The pack picker lists installed packs and switching re-renders.
 *
 * The desktop session hook is mocked (Electron-only surface); fetch is
 * stubbed per-case.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const listPacks = vi.hoisted(() => vi.fn());
// STABLE session object — the real DesktopSessionProvider memoizes its
// context value, so the component's effects may safely depend on the
// identity. Returning a fresh object per render (as an inline factory would)
// thrashes every session-dependent effect.
const stableSession = vi.hoisted(() => ({
  apiClient: { listPacks: null as unknown as ReturnType<typeof listPacks.call> },
}));

vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: () => ({ session: stableSession }),
}));

import { TrainingPage } from './TrainingPage';

const originalFetch = globalThis.fetch;

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
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const DOC_PACK = {
  packId: 'opmed-initial',
  version: '1.0.0',
  name: 'OpMed Initial Knowledge Pack',
  sourceClass: 'bundled',
  publishedAt: null,
  active: true,
  supersedes: [],
};

const manifestBody = {
  id: 'opmed-initial',
  version: '1.0.0',
  docs: [
    { path: 'docs/brief.pdf', title: 'BATDOK Brief', mime: 'application/pdf' },
    { path: 'docs/manual.docx', title: 'Field Manual', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ],
};

const stubManifestFetch = (): void => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => manifestBody,
  }) as unknown as typeof fetch;
};

describe('TrainingPage pack surface (#133 feedback round)', () => {
  it('auto-selects the sole installed pack and lists its documents', async () => {
    listPacks.mockResolvedValue([DOC_PACK]);
    stubManifestFetch();
    render(<TrainingPage />);
    const select = await screen.findByTestId('training-pack-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe('opmed-initial/1.0.0');
    });
    expect(await screen.findByTestId('training-doc-docs/brief.pdf')).toBeTruthy();
    expect(screen.getByTestId('training-doc-docs/manual.docx')).toBeTruthy();
  });

  it('renders a selected PDF inline and offers download for other formats', async () => {
    listPacks.mockResolvedValue([DOC_PACK]);
    stubManifestFetch();
    render(<TrainingPage />);
    await screen.findByTestId('training-doc-docs/brief.pdf');
    fireEvent.click(screen.getByTestId('training-doc-docs/brief.pdf'));
    const embed = await screen.findByTestId('training-doc-viewer');
    expect((embed as HTMLEmbedElement).src).toBe('app://training/opmed-initial/1.0.0/docs/brief.pdf');

    fireEvent.click(screen.getByTestId('training-doc-docs/manual.docx'));
    const link = await screen.findByTestId('training-doc-download');
    expect((link as HTMLAnchorElement).getAttribute('href')).toBe(
      'app://training/opmed-initial/1.0.0/docs/manual.docx',
    );
  });

  it('lists installed packs in the picker and switches on selection', async () => {
    listPacks.mockResolvedValue([DOC_PACK, { ...DOC_PACK, packId: 'field-updates', version: '2.0.0', name: 'Field Updates' }]);
    stubManifestFetch();
    render(<TrainingPage />);
    const select = await screen.findByTestId('training-pack-select') as HTMLSelectElement;
    // Two active packs and no stored choice => nothing auto-selected.
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'field-updates/2.0.0' } });
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('pack')).toBe('field-updates/2.0.0');
    });
  });
});
