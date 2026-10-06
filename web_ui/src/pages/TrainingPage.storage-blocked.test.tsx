/**
 * TrainingPage.storage-blocked.test.tsx: critic-final-3 L3. With 2+ courses installed the
 * course-selection memo reads the remembered course from localStorage during render. A browser
 * that blocks web storage makes that read throw (SecurityError); the page must fall back to "no
 * remembered course" (the library) instead of crashing into the page-level error boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { LAST_PACK_KEY } from '../lib/storage/persisted-keys';

vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: () => ({ session: null }),
  isElectron: () => false,
}));

const packClient = vi.hoisted(() => ({
  kind: 'browser',
  listPacks: async () => [
    { packId: 'course-a', version: '1.0.0', name: 'Safety Onboarding', sourceClass: 'training', publishedAt: null, active: true, supersedes: [] },
    { packId: 'course-b', version: '1.0.0', name: 'Fire Drill', sourceClass: 'training', publishedAt: null, active: true, supersedes: [] },
  ],
}));
vi.mock('../lib/packs/pack-client', () => ({ usePackClient: () => packClient }));

vi.mock('../lib/training/slide-position', () => ({
  slideDocsAvailable: vi.fn(() => false),
  courseSlideCount: vi.fn(() => null),
  slidePosition: vi.fn(() => null),
}));

import { TrainingPage } from './TrainingPage';

const blocked = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('TrainingPage with blocked web storage (2+ courses)', () => {
  it('a throwing localStorage read falls back to the course library instead of crashing', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    render(<TrainingPage />);
    await waitFor(() => expect(screen.getByTestId('training-course-course-a')).toBeInTheDocument());
    expect(screen.getByTestId('training-course-course-b')).toBeInTheDocument();
    expect(getItem).toHaveBeenCalledWith(LAST_PACK_KEY);
  });

  it('a readable remembered course is still honoured (control for the fallback)', async () => {
    window.localStorage.setItem(LAST_PACK_KEY, 'course-b/1.0.0');
    render(<TrainingPage />);
    // The remembered course opens directly, so the library card grid is not shown.
    await waitFor(() => expect(screen.queryByTestId('training-course-course-a')).not.toBeInTheDocument());
  });
});
