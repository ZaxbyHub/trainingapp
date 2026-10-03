// @vitest-environment node
/**
 * The pack-updates localStorage record is user-writable, so a non-https
 * feedUrl fails CLOSED (PR 144 review F13): the check is refused with a
 * visible error, no request is made, and the default feed is NOT substituted.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserUpdatesController, type BrowserUpdatesDeps } from '../pack-update-controller';
import { PACK_UPDATES_STATE_KEY } from '../../storage/persisted-keys';

function controllerWith(record: unknown) {
  const store = new Map<string, string>([[PACK_UPDATES_STATE_KEY, JSON.stringify(record)]]);
  const fetchFeed = vi.fn(async (_url: string): Promise<string> => '{}');
  const downloadArtifact = vi.fn(async (_url: string, _bytes: number): Promise<Uint8Array> => new Uint8Array());
  const deps: BrowserUpdatesDeps = {
    manager: () => ({ listPacks: async () => [], installPack: async () => { throw new Error('unused'); } }),
    fetchFeed,
    downloadArtifact,
    trustedKeys: () => [],
    storage: () => ({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }),
    airgap: false,
    now: () => new Date(0),
  };
  return { controller: new BrowserUpdatesController(deps), fetchFeed, downloadArtifact };
}

describe('pack-updates feedUrl scheme check', () => {
  it.each([
    'http://mirror.example/feed.json',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://mirror.example/feed.json',
    'not a url',
  ])('refuses %s: no fetch, visible error, opt-in kept', async (feedUrl) => {
    const { controller, fetchFeed, downloadArtifact } = controllerWith({ optIn: true, feedUrl });
    const result = await controller.checkForUpdates();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/must be https/);
    expect(result.status?.error).toMatch(/must be https/);
    expect(result.status?.optIn).toBe(true);
    expect(result.status?.candidates).toEqual([]);
    expect(fetchFeed).not.toHaveBeenCalled();
    expect(downloadArtifact).not.toHaveBeenCalled();
  });

  it('still fetches a configured https feedUrl', async () => {
    const { controller, fetchFeed } = controllerWith({ optIn: true, feedUrl: 'https://mirror.example/feed.json' });
    await controller.checkForUpdates();
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    expect(fetchFeed).toHaveBeenCalledWith('https://mirror.example/feed.json');
  });

  it('falls back to the default feed only when no feedUrl is configured', async () => {
    const { controller, fetchFeed } = controllerWith({ optIn: true });
    await controller.checkForUpdates();
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    expect(String(fetchFeed.mock.calls[0]?.[0])).toMatch(/^https:/);
  });
});
