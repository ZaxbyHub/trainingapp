/**
 * SettingsStorageSection (issue #34 item 7, AC4, check C4): the
 * storage-pressure indicator. navigator.storage.estimate() and persisted()
 * are mocked; one behavior per test:
 *   1. live quota/usage values render (not static placeholders — a changed
 *      estimate changes the rendered text);
 *   2. near-quota state is classified (>85% of quota warns; below does not);
 *   3. the persist-request control invokes navigator.storage.persist() and
 *      reflects the persisted() result.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsStorageSection } from './SettingsStorageSection';

interface EstimateMock {
  usage: number;
  quota: number;
}

let estimateMock: EstimateMock;
let persistedMock: boolean;
let persistMock: ReturnType<typeof vi.fn>;
let persistGranted: boolean;

beforeEach(() => {
  estimateMock = { usage: 500 * 1024 ** 2, quota: 10 * 1024 ** 3 };
  persistedMock = false;
  persistGranted = true;
  persistMock = vi.fn(async () => persistGranted);
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      estimate: async () => ({ ...estimateMock }),
      persisted: async () => persistedMock,
      persist: persistMock,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('SettingsStorageSection (storage-pressure indicator)', () => {
  it('renders the live usage and quota values from estimate()', async () => {
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-status').textContent).toContain('500.0 MB');
    });
    expect(screen.getByTestId('settings-storage-status').textContent).toContain('10.0 GB');
  });

  it('re-reads on demand: a changed estimate changes the rendered text (no static placeholder)', async () => {
    estimateMock = { usage: 2 * 1024 ** 3, quota: 10 * 1024 ** 3 };
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-status').textContent).toContain('2.0 GB');
    });
    estimateMock = { usage: 300 * 1024 ** 2, quota: 10 * 1024 ** 3 };
    fireEvent.click(screen.getByTestId('settings-storage-recheck'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-status').textContent).toContain('300.0 MB');
    });
    expect(screen.getByTestId('settings-storage-status').textContent).not.toContain('2.0 GB');
  });

  it('classifies near-quota state: usage above 85% of quota renders the warning', async () => {
    estimateMock = { usage: 9 * 1024 ** 3, quota: 10 * 1024 ** 3 }; // 90%
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-near-quota')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-storage-status').textContent).toContain('near quota');
  });

  it('below the threshold renders no near-quota warning', async () => {
    estimateMock = { usage: 5 * 1024 ** 3, quota: 10 * 1024 ** 3 }; // 50%
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-status').textContent).toContain('50%');
    });
    expect(screen.queryByTestId('settings-storage-near-quota')).toBeNull();
    expect(screen.getByTestId('settings-storage-status').textContent).not.toContain('near quota');
  });

  it('shows the persisted() state and the persist control while not persistent', async () => {
    persistedMock = false;
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persisted').textContent).toContain('not persistent');
    });
    expect(screen.getByTestId('settings-storage-persist-btn')).toBeTruthy();
  });

  it('reflects persisted() === true and hides the request control', async () => {
    persistedMock = true;
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persisted').textContent).toContain('persistent');
    });
    expect(screen.queryByTestId('settings-storage-persist-btn')).toBeNull();
  });

  it('the persist control invokes navigator.storage.persist() and reflects the granted result', async () => {
    persistedMock = false;
    persistGranted = true;
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persist-btn')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('settings-storage-persist-btn'));
    await waitFor(() => {
      expect(persistMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persisted').textContent).toContain('persistent (protected');
    });
    expect(screen.queryByTestId('settings-storage-persist-btn')).toBeNull();
  });

  it('a refused persist request keeps the not-persistent state and surfaces the refusal', async () => {
    persistedMock = false;
    persistGranted = false;
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persist-btn')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('settings-storage-persist-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persist-note').textContent).toContain('not granted');
    });
    expect(screen.getByTestId('settings-storage-persisted').textContent).toContain('not persistent');
  });

  // PRR-114(d) (PR #264 review): the five failure branches of the storage
  // section, each asserting the EXACT user-visible copy.
  it('estimate() rejecting surfaces the exact read-failure copy', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => {
          throw new Error('boom');
        },
        persisted: async () => false,
      },
    });
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-section').textContent).toContain(
        'Storage usage could not be read.',
      );
    });
  });

  it('persisted() rejecting leaves the persistence state unknown', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ ...estimateMock }),
        persisted: async () => {
          throw new Error('boom');
        },
        persist: persistMock,
      },
    });
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persisted').textContent).toContain(
        'Persistence state unknown.',
      );
    });
  });

  it('a browser with no persist() surfaces the exact cannot-request copy', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ ...estimateMock }),
        persisted: async () => false,
        // no persist
      },
    });
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persist-btn')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('settings-storage-persist-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persist-note').textContent).toBe(
        'Persistent storage cannot be requested in this browser.',
      );
    });
  });

  it('persist() rejecting surfaces the exact request-failed copy', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ ...estimateMock }),
        persisted: async () => false,
        persist: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
    });
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persist-btn')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('settings-storage-persist-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-persist-note').textContent).toBe(
        'The persistence request failed.',
      );
    });
  });

  it('a browser with no storage API at all surfaces the exact unavailable copy', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: undefined,
    });
    render(<SettingsStorageSection />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-storage-section').textContent).toContain(
        'Storage information is not available in this browser.',
      );
    });
  });
});
